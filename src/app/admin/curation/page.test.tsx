import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ResaleRightsStatus, RightsLayer } from "@/generated/prisma/enums";
import type { AttestationAnswers } from "@/lib/attestation";
import { TRIAGE_FACT_ATTESTATION_FIELD } from "@/lib/curation-attestation";
import { TRIAGE_ANSWER_NO, TRIAGE_ANSWER_YES } from "@/lib/curation-triage";
import {
  CLEARABLE_LAYERS,
  CURRENT_CHECKLIST_VERSION,
  TRIAGE_FACTS,
} from "@/lib/resale-rights";
import { mediaPreviewPath } from "@/lib/routes";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The curation triage screen (ugcportal-vq3z), against a real database.
 *
 * The rendering half of the admin surface. The write side — the server
 * action the form posts to, and K1/K2/K4's fixture mutations — is covered in
 * actions.test.ts next to it, the same split the resale-rights screen and
 * its decision route use.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const notFoundMock = vi.fn(() => {
  // next/navigation's notFound() throws so the caller stops; a stand-in that
  // returned would let the page carry on rendering an admin screen to a
  // non-admin, which is the opposite of what the test should prove.
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: notFoundMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
/*
  DYNAMIC, like the two imports above it and for a reason this file learned
  the hard way: `@/lib/curation-clearance-write` imports `@/lib/prisma`,
  which builds its adapter from DATABASE_URL AT IMPORT TIME. A static import
  of it at the top of this file would bind the client before
  `createTemporaryDatabase()` had pointed the variable at a temp file, and
  `applyMigrations` below would then run against whatever database the
  environment happened to name.
*/
const { CLEARANCE_WRITE_REFUSALS } = await import(
  "@/lib/curation-clearance-write"
);
const {
  default: AdminCurationPage,
  ERROR_BANNER_ID,
  MAX_UPLOADS,
  UPLOAD_LIST_ID,
  priceSectionId,
  rightsLayersSectionId,
  triageFactAttestationId,
  triageFactDisagreementId,
} = await import("@/app/admin/curation/page");

const ADMIN = { user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" } };

const FIELDS = TRIAGE_FACTS.map((fact) => fact.field);

/**
 * Renders the page the way Next would: it is an async server component, so it
 * is awaited for its element tree and then rendered.
 */
async function renderPage(
  searchParams: Record<string, string> = {},
): Promise<string> {
  const element = await AdminCurationPage({
    searchParams: Promise.resolve(searchParams),
  } as Parameters<typeof AdminCurationPage>[0]);
  return renderToStaticMarkup(element);
}

/**
 * One upload row's own markup, depth-aware.
 *
 * Matched by the list's id rather than as "the first `<ul>`", and tracking
 * nesting rather than stopping at the first closing tag — the two mistakes
 * the sibling admin screens' tests record (ugcportal-qn3 measured the wrong
 * list; the brands test's comment explains the nesting half).
 */
function uploadRows(markup: string): string[] {
  expect(markup).toContain(`id="${UPLOAD_LIST_ID}"`);
  const list =
    new RegExp(
      `<ul\\b[^>]*id="${UPLOAD_LIST_ID}"[^>]*>([\\s\\S]*)</ul>`,
    ).exec(markup)?.[1] ?? "";
  const rows: string[] = [];
  const tagPattern = /<li\b[^>]*>|<\/li>/g;
  let depth = 0;
  let rowStart = -1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(list))) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0 && rowStart !== -1) {
        rows.push(list.slice(rowStart, match.index));
        rowStart = -1;
      }
    } else {
      if (depth === 0) rowStart = match.index + match[0].length;
      depth += 1;
    }
  }
  return rows;
}

/**
 * The five characters `react-dom/server` escapes in a text child, so a
 * question containing an apostrophe or an ampersand can still be matched
 * against the rendered markup. Measured, not assumed — the first case in
 * the sibling rights page.test.tsx pins React's actual output.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * `escapeHtml` plus regex escaping, for matching one rendered question
 * against the markup around it. Several of the registry's questions contain a
 * literal "?" — a quantifier if dropped into a pattern unescaped, which made
 * the first version of the `<dt>`/`<dd>` assertions below fail to match the
 * markup they were looking at.
 */
function questionPattern(question: string): string {
  return escapeHtml(question).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type UploadOptions = {
  previewKey?: string | null;
  previewId?: string | null;
  createdAt?: Date;
  originalName?: string;
};

async function createUpload(id: string, options: UploadOptions = {}) {
  const {
    previewKey = `previews/owner-1/${id}.webp`,
    previewId = `preview-${id}`,
    createdAt = new Date("2026-10-01T12:00:00.000Z"),
    originalName = `${id}.jpg`,
  } = options;
  await prisma.media.create({
    data: {
      id,
      userId: "owner-1",
      kind: "IMAGE",
      key: `media/owner-1/${id}.jpg`,
      previewKey,
      previewId,
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      originalName,
      createdAt,
    },
  });
}

/** A fully triaged listing, signed by `triagedByUserId`. */
async function triage(mediaId: string, triagedByUserId: string | null) {
  await prisma.mediaListing.create({
    data: {
      mediaId,
      ...Object.fromEntries(FIELDS.map((field, i) => [field, i % 2 === 0])),
      triagedByUserId,
      triagedAt: new Date("2026-10-02T09:30:00.000Z"),
    },
  });
}

/**
 * The uploader's own rights attestation (ugcportal-15r) for a fixture
 * upload, attested by the upload's own owner (`owner-1`, matching
 * `createUpload`'s default). `overrides` take the attestation's OWN field
 * names (`showsIdentifiablePeople`, not `depictsPeople`) since this is the
 * uploader's row, not the admin's.
 */
async function attest(
  mediaId: string,
  overrides: Partial<AttestationAnswers> = {},
) {
  await prisma.mediaAttestation.create({
    data: completeAttestationRow(mediaId, "owner-1", overrides),
  });
}

/**
 * The value of the pre-selected `<option>` in one triage question's
 * `<select>`, or `null` when none is — the same measured regex
 * triage-form.test.tsx uses for the same reason: a React version that
 * swapped the order `selected`/`value` render in would otherwise fail every
 * caller for a reason that has nothing to do with this page.
 */
function selectedValue(markup: string, name: string): string | null {
  const block = new RegExp(
    `<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`,
  ).exec(markup)?.[1];
  if (block === undefined) {
    throw new Error(`no select named ${name} in the rendered form`);
  }
  const match =
    /<option selected(?:=""|)\s+value="([^"]*)"/.exec(block) ??
    /<option value="([^"]*)"\s+selected/.exec(block);
  return match?.[1] ?? null;
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
      { id: "admin-2", email: "admin2@example.com", role: "ADMIN" },
      { id: "demoted-1", email: "demoted@example.com", role: "USER" },
      { id: "owner-1", email: "owner@example.com", role: "USER" },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset().mockResolvedValue(ADMIN);
  notFoundMock.mockClear();
  await prisma.mediaListing.deleteMany({});
  await prisma.media.deleteMany({});
});

describe("admin only", () => {
  it("is not found for a signed-out visitor", async () => {
    authMock.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("is not found for a signed-in non-admin, and renders for an admin", async () => {
    // The pair, so the refusal is connected to the role rather than to
    // something else wrong with the fixture.
    await createUpload("media-1");

    authMock.mockResolvedValue({ user: { id: "owner-1", role: "USER" } });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");

    authMock.mockResolvedValue(ADMIN);
    expect(await renderPage()).toContain("Curation triage");
  });

  it("is not found for a session that carries no role", async () => {
    authMock.mockResolvedValue({ user: { id: "owner-1" } });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the upload list", () => {
  it("says so when there is nothing to triage", async () => {
    const markup = await renderPage();
    expect(markup).toContain("Nobody has uploaded anything yet");
    expect(markup).not.toContain(`id="${UPLOAD_LIST_ID}"`);
  });

  it("lists every upload, newest first", async () => {
    await createUpload("older", {
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await createUpload("newer", {
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const rows = uploadRows(await renderPage());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("newer.jpg");
    expect(rows[1]).toContain("older.jpg");
  });

  it("names the uploader on each row", async () => {
    await createUpload("media-1");
    expect(uploadRows(await renderPage())[0]).toContain("owner@example.com");
  });
});

describe("the preview, and only the preview", () => {
  it("builds the thumbnail from the opaque handle", async () => {
    await createUpload("media-1", { previewId: "handle-one" });
    expect(await renderPage()).toContain(
      `src="${mediaPreviewPath("handle-one")}"`,
    );
  });

  it("follows the row's own handle rather than a fixed path", async () => {
    // The fixture mutation that makes the assertion above non-vacuous: a page
    // that rendered a constant src, or the wrong row's handle, passes the
    // first case and fails this one.
    await createUpload("media-1", { previewId: "handle-two" });
    const markup = await renderPage();
    expect(markup).toContain(`src="${mediaPreviewPath("handle-two")}"`);
    expect(markup).not.toContain(mediaPreviewPath("handle-one"));
  });

  it("never renders the preview's storage path", async () => {
    /*
      `previewKey` is `previews/{userId}/{uuid}`, so rendering it would
      publish the uploader's account id to the page and to every access log
      between here and the browser. The page selects the column — it has to,
      to answer K4's "is there a watermarked object at all" — and drops it
      before the markup can reach it.

      Non-vacuous by construction: the needle is read back out of the row the
      page itself loaded, so it is a string that demonstrably exists in the
      data and is demonstrably absent from the output.
    */
    await createUpload("media-1");
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: "media-1" },
      select: { previewKey: true },
    });
    expect(row.previewKey).toBe("previews/owner-1/media-1.webp");

    const markup = await renderPage();
    expect(markup).not.toContain(row.previewKey as string);
    expect(markup).not.toContain("previews/");
  });

  it("renders no Instagram URL", async () => {
    /*
      ugcportal-2eh Option A, as a regression guard rather than a test that
      could fail today, and the difference is worth stating plainly: there is
      no synced-post table in the schema, so this screen has no data source
      that could supply an instagram.com URL and the needle CANNOT currently
      be present. The mechanical version of K3 — a scan that is proved able
      to find the needle — is in actions.test.ts, over the persisted record.
      This one exists so that adding the discovery context ugcportal-vq3z's
      scope describes, when there is something to add, has to stay inside the
      boundary.
    */
    await createUpload("media-1");
    await triage("media-1", "admin-1");
    const markup = await renderPage({ edit: "media-1" });
    expect(markup).not.toMatch(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)*instagram\.com/i);
  });
});

describe("the recorded triage, read back", () => {
  it("shows every registered question and its stored answer", async () => {
    await createUpload("media-1");
    await triage("media-1", "admin-1");

    const row = uploadRows(await renderPage())[0];
    TRIAGE_FACTS.forEach((fact, index) => {
      expect(row, fact.field).toContain(escapeHtml(fact.question));
      // Alternating yes/no in the fixture, so a page that printed one answer
      // against every question fails instead of passing on a uniform row.
      expect(
        new RegExp(
          `${questionPattern(fact.question)}\\s*</dt><dd[^>]*>${index % 2 === 0 ? "Yes" : "No"}</dd>`,
        ).test(row),
        fact.field,
      ).toBe(true);
    });
  });

  it("names the admin who recorded it, and when", async () => {
    await createUpload("media-1");
    await triage("media-1", "admin-1");
    const row = uploadRows(await renderPage())[0];
    // Element-scoped, not a bare substring: "Triaged" alone would also match
    // inside a heading that said something else about the triage.
    expect(row).toMatch(/<p[^>]*>Triaged<\/p>/);
    expect(row).toContain("admin@example.com");
    expect(row).toContain("2 Oct 2026");
  });

  it("marks an untriaged upload as untriaged, with every answer blank", async () => {
    await createUpload("media-1");
    const row = uploadRows(await renderPage())[0];
    expect(row).toContain("Not triaged");
    for (const fact of TRIAGE_FACTS) {
      expect(
        new RegExp(
          `${questionPattern(fact.question)}\\s*</dt><dd[^>]*>Not answered</dd>`,
        ).test(row),
        fact.field,
      ).toBe(true);
    }
  });

  it("warns when the signer is no longer an admin", async () => {
    // The gate re-reads the signer's CURRENT role (`triagedBy?.role !==
    // "ADMIN"` in triageBlocker), so a triage signed by someone since
    // demoted is void. Surfaced here beside the triage, with the full
    // verdict in the price well (ugcportal-yzo7).
    await createUpload("media-1");
    await triage("media-1", "demoted-1");
    const row = uploadRows(await renderPage())[0];
    expect(row).toContain("Triage not signed by a current admin");
  });

  it("does not claim a current admin signed a listing with no signer at all", async () => {
    await createUpload("media-1");
    await triage("media-1", null);
    const row = uploadRows(await renderPage())[0];
    expect(row).toContain("Triage not signed by a current admin");
    // Scoped to the definition value, not a bare "nobody": the page's intro
    // prose uses the word too, and a row-wide substring match would start
    // passing for the wrong reason if that copy ever moved into the row.
    expect(row).toMatch(/Recorded by:\s*<\/dt><dd[^>]*>nobody/);
  });
});

describe("ugcportal-vlnn: the uploader's attestation beside the admin's flag", () => {
  // The TRIAGE_FACTS fields the attestation also asks about, read off the
  // shared registry rather than hand-listed — the single source of truth
  // both page.tsx and triage-form.tsx read, so this file cannot test a
  // mapping the implementation does not actually use.
  const MAPPED_FACTS = Object.entries(TRIAGE_FACT_ATTESTATION_FIELD) as [
    string,
    keyof AttestationAnswers,
  ][];

  it("K1: renders the uploader's own answer beside the admin's flag for every fact the attestation asks about", async () => {
    await createUpload("media-1");
    const overrides = Object.fromEntries(
      MAPPED_FACTS.map(([, attestationField], i) => [
        attestationField,
        i % 2 === 0,
      ]),
    ) as Partial<AttestationAnswers>;
    await attest("media-1", overrides);

    const markup = await renderPage();
    for (const [triageField, attestationField] of MAPPED_FACTS) {
      const label = overrides[attestationField] ? "Yes" : "No";
      const needle = `id="${triageFactAttestationId("media-1", triageField)}"`;
      expect(markup, triageField).toContain(needle);
      expect(
        new RegExp(`${needle}[^>]*>\\(uploader: ${label}\\)`).test(markup),
        triageField,
      ).toBe(true);
    }

    // A triage fact the attestation never asks about — the registry's own
    // comment names `depictsAlcohol` and `wineAccessory` — renders no
    // uploader column at all, rather than a column that happens to say
    // nothing useful.
    expect(markup).not.toContain(
      `id="${triageFactAttestationId("media-1", "depictsAlcohol")}"`,
    );
  });

  it("K1: an untriaged admin flag defaults to the uploader's attested answer", async () => {
    await createUpload("media-1");
    await attest("media-1", {
      showsIdentifiablePeople: true,
      showsMinors: false,
    });
    const markup = await renderPage({ edit: "media-1" });
    expect(selectedValue(markup, "depictsPeople")).toBe(TRIAGE_ANSWER_YES);
    expect(selectedValue(markup, "depictsMinors")).toBe(TRIAGE_ANSWER_NO);
  });

  it("K1: a recorded admin answer is never replaced by the uploader's, even where they disagree", async () => {
    await createUpload("media-1");
    // The uploader says no; `triage()` records depictsPeople (FIELDS[0]) as
    // `true`, so these two disagree — the case where silently preferring
    // either the stored or the attested value would be easiest to miss.
    await attest("media-1", { showsIdentifiablePeople: false });
    await triage("media-1", "admin-1");
    const markup = await renderPage({ edit: "media-1" });
    expect(selectedValue(markup, "depictsPeople")).toBe(TRIAGE_ANSWER_YES);
  });

  it("K2: warns when the admin's flag disagrees with the uploader's, and not when they agree", async () => {
    await createUpload("media-1");
    await attest("media-1", { showsIdentifiablePeople: true });
    await prisma.mediaListing.create({
      data: {
        mediaId: "media-1",
        ...Object.fromEntries(FIELDS.map((field) => [field, false])),
        triagedByUserId: "admin-1",
        triagedAt: new Date("2026-10-02T09:30:00.000Z"),
      },
    });

    const disagreementId = triageFactDisagreementId(
      "media-1",
      "depictsPeople",
    );
    let markup = await renderPage();
    expect(markup).toContain(`id="${disagreementId}"`);

    // Both directions required by K2: the same fixture, with the two facts
    // made to agree, must show no warning.
    await prisma.mediaListing.update({
      where: { mediaId: "media-1" },
      data: { depictsPeople: true },
    });
    markup = await renderPage();
    expect(markup).not.toContain(`id="${disagreementId}"`);
  });

  it("K3: an upload with no attestation renders as 'not asked', distinct from a stored no and from silent agreement", async () => {
    await createUpload("media-1"); // no attestation at all
    await createUpload("media-2");
    await attest("media-2", { showsIdentifiablePeople: false }); // explicit no
    await triage("media-1", "admin-1"); // admin recorded every fact

    const markup = await renderPage();
    const row1 = uploadRows(markup).find((row) => row.includes("media-1.jpg"));
    const row2 = uploadRows(markup).find((row) => row.includes("media-2.jpg"));
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    const noAttestationId = triageFactAttestationId(
      "media-1",
      "depictsPeople",
    );
    expect(
      new RegExp(
        `id="${noAttestationId}"[^>]*>\\(uploader: no attestation on file\\)`,
      ).test(row1 as string),
    ).toBe(true);

    const explicitNoId = triageFactAttestationId("media-2", "depictsPeople");
    expect(
      new RegExp(`id="${explicitNoId}"[^>]*>\\(uploader: No\\)`).test(
        row2 as string,
      ),
    ).toBe(true);

    // The fixture mutation that makes the two assertions above non-vacuous:
    // the rows actually render differently rather than happening to share a
    // passing regex.
    expect(row1).not.toEqual(row2);

    // No disagreement is ever shown where there is nothing to compare
    // against — an implementation that defaulted the missing uploader
    // answer to the admin's own value would show no warning for the wrong
    // reason (false agreement) rather than the right one (nothing asked).
    for (const fact of TRIAGE_FACTS) {
      expect(row1).not.toContain(
        `id="${triageFactDisagreementId("media-1", fact.field)}"`,
      );
    }
  });
});

describe("K4: an upload with no watermarked preview offers no form", () => {
  /*
    The UI half of K4, with its named FIXTURE MUTATION: the same row, first
    with no `previewKey` and then with one. The server refuses the write
    either way (actions.test.ts); this is about the screen not inviting it.
  */
  it("explains instead of offering the form, and offers it once a preview exists", async () => {
    await createUpload("media-1", { previewKey: null, previewId: null });

    let row = uploadRows(await renderPage({ edit: "media-1" }))[0];
    expect(row).toContain("No watermarked preview yet");
    expect(row).not.toContain("<form");

    // The one thing that changes.
    await prisma.media.update({
      where: { id: "media-1" },
      data: { previewKey: "previews/owner-1/media-1.webp" },
    });
    row = uploadRows(await renderPage({ edit: "media-1" }))[0];
    expect(row).not.toContain("No watermarked preview yet");
    expect(row).toContain("<form");
  });

  it("treats a blank previewKey the same as none", async () => {
    await createUpload("media-1", { previewKey: "   ", previewId: null });
    const row = uploadRows(await renderPage({ edit: "media-1" }))[0];
    expect(row).toContain("No watermarked preview yet");
    expect(row).not.toContain("<form");
  });
});

describe("opening one upload's form", () => {
  it("renders no form until one is asked for", async () => {
    await createUpload("media-1");
    expect(await renderPage()).not.toContain("<form");
  });

  it("renders the form for the upload named by ?edit=, and only that one", async () => {
    await createUpload("media-1");
    await createUpload("media-2");
    const markup = await renderPage({ edit: "media-1" });
    const forms = [...markup.matchAll(/<form\b/g)];
    expect(forms).toHaveLength(1);
    const rows = uploadRows(markup);
    const edited = rows.find((row) => row.includes("media-1.jpg"));
    expect(edited).toContain("<form");
    expect(rows.find((row) => row.includes("media-2.jpg"))).not.toContain(
      "<form",
    );
  });

  it("pre-selects the stored answers in the opened form", async () => {
    await createUpload("media-1");
    await triage("media-1", "admin-1");
    const markup = await renderPage({ edit: "media-1" });
    // The form's own round-trip is asserted exhaustively in
    // triage-form.test.tsx; this is the page actually handing it the row it
    // loaded rather than `null`.
    expect(markup).toMatch(
      new RegExp(`<select[^>]*name="${FIELDS[0]}"[^>]*>[\\s\\S]*?selected`),
    );
  });

  it("says so when ?edit= names nothing at all", async () => {
    await createUpload("media-1");
    const markup = await renderPage({ edit: "ghost" });
    expect(markup).toContain("That upload no longer exists");
  });
});

describe("the listing cap", () => {
  /** `count` uploads, newest last by id so the ordering is deterministic. */
  async function createUploads(count: number) {
    await prisma.media.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        id: `media-${String(index).padStart(3, "0")}`,
        userId: "owner-1",
        kind: "IMAGE" as const,
        key: `media/owner-1/${index}.jpg`,
        previewKey: `previews/owner-1/${index}.webp`,
        previewId: `preview-${index}`,
        mimeType: "image/jpeg",
        sizeBytes: 10,
        originalName: `${index}.jpg`,
        createdAt: new Date(2026, 0, 1, 0, 0, index),
      })),
    });
  }

  it("shows no truncation notice at exactly the cap", async () => {
    await createUploads(MAX_UPLOADS);
    const markup = await renderPage();
    expect(uploadRows(markup)).toHaveLength(MAX_UPLOADS);
    expect(markup).not.toContain("most recent uploads");
  });

  it("shows the notice once there is one more than the cap", async () => {
    // "There are more" is a fact the database answered — the query asks for
    // cap + 1 — not a length compared against the cap, which cannot tell
    // "exactly cap" from "cut off" (ugcportal-gkj).
    await createUploads(MAX_UPLOADS + 1);
    const markup = await renderPage();
    expect(uploadRows(markup)).toHaveLength(MAX_UPLOADS);
    expect(markup).toContain("most recent uploads");
  });

  it("still opens the form for an upload beyond the cap", async () => {
    /*
      Not a convenience. This screen is the only path in the codebase that
      can write a triage fact, so an upload whose form cannot be opened is an
      upload that can never be sold — and ranking past the cap by date would
      do that silently.
    */
    await createUploads(MAX_UPLOADS + 1);
    // The OLDEST row, which the newest-first slice leaves out.
    const markup = await renderPage({ edit: "media-000" });
    const rows = uploadRows(markup);
    expect(rows[0]).toContain("0.jpg");
    expect(rows[0]).toContain("<form");
    expect(markup).toContain("falls outside the");
  });

  it("does not duplicate a row that is already inside the slice", async () => {
    await createUploads(MAX_UPLOADS + 1);
    const markup = await renderPage({ edit: "media-050" });
    const rows = uploadRows(markup);
    expect(rows).toHaveLength(MAX_UPLOADS);
    expect(markup).not.toContain("falls outside the");
  });
});

describe("outcome banners", () => {
  it("confirms a recorded triage", async () => {
    await createUpload("media-1");
    expect(await renderPage({ triage: "recorded" })).toContain(
      "Triage recorded.",
    );
  });

  it("renders the message for a known error code", async () => {
    await createUpload("media-1");
    const markup = await renderPage({ error: "no_preview" });
    expect(markup).toContain(`id="${ERROR_BANNER_ID}"`);
    expect(markup).toContain("no watermarked preview yet");
  });

  it("renders nothing for an unknown or inherited error code", async () => {
    // Asserted on the banner's id, not on destructive styling: an untriaged
    // upload renders the same destructive well, so the styling is present on
    // every page and could never tell the two apart.
    await createUpload("media-1");
    for (const error of ["whatever", "toString", "__proto__", "constructor"]) {
      const markup = await renderPage({ error });
      expect(markup, error).not.toContain(`id="${ERROR_BANNER_ID}"`);
    }
  });
});

describe("the rights-layer well (ugcportal-qfy9)", () => {
  /**
   * A listing presenting EVERY clearable layer at once, so "one form per
   * blocking layer" is measurable. The shared `triage` helper above
   * alternates its answers, which would leave some layers absent and make
   * a count of the rendered forms mean nothing.
   */
  async function triageWithEveryLayerPresent(mediaId: string) {
    await prisma.mediaListing.create({
      data: {
        mediaId,
        ...Object.fromEntries(
          TRIAGE_FACTS.map((fact) => [
            fact.field,
            fact.settledBy === "clearance",
          ]),
        ),
        modelReleaseKey: `releases/${mediaId}/release.pdf`,
        triagedByUserId: "admin-1",
        triagedAt: new Date("2026-10-02T09:30:00.000Z"),
      },
    });
  }

  /**
   * One upload's rights-layer well, by its own id.
   *
   * Named by id rather than taken as "the first well", because the page
   * renders one per listed upload and the triage well above it looks the
   * same — and DEPTH-AWARE rather than cut at the next closing tag, which
   * is the mistake the `uploadRows` helper at the top of this file records.
   * A slice that ran to the end of the document would make every
   * "contains" assertion below true for content belonging to another
   * upload, and every "does not contain" one a coincidence; "isolates one
   * upload's well from another's" asserts it does not.
   */
  function layerWell(markup: string, mediaId: string): string {
    const id = rightsLayersSectionId(mediaId);
    expect(markup).toContain(`id="${id}"`);
    const open = markup.lastIndexOf("<div", markup.indexOf(`id="${id}"`));
    const tagPattern = /<div\b[^>]*>|<\/div>/g;
    tagPattern.lastIndex = open;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(markup))) {
      depth += match[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        return markup.slice(open, match.index + match[0].length);
      }
    }
    throw new Error(`unbalanced markup around ${id}`);
  }

  /** The `value` of every `name="layer"` hidden input in some markup. */
  function submittedLayers(markup: string): string[] {
    return [...markup.matchAll(/<input[^>]*name="layer"[^>]*>/g)].map(
      (match) => /value="([^"]*)"/.exec(match[0])?.[1] ?? "",
    );
  }

  it("isolates one upload's well from another's", async () => {
    /*
      The helper above is load-bearing: every assertion in this block is
      "this well contains / does not contain a layer", and a slice that ran
      past the end of one well would read the next upload's forms as part
      of it. So the helper is tested on the input that would expose that —
      two triaged uploads, one of which has a layer the other does not.
    */
    await createUpload("media-1");
    await createUpload("media-2", {
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await triageWithEveryLayerPresent("media-1");
    await prisma.mediaListing.create({
      data: {
        mediaId: "media-2",
        ...Object.fromEntries(TRIAGE_FACTS.map((fact) => [fact.field, false])),
        triagedByUserId: "admin-1",
        triagedAt: new Date("2026-10-02T09:30:00.000Z"),
      },
    });

    const markup = await renderPage({ edit: "media-1" });
    // Both wells are on the page...
    expect(markup).toContain(`id="${rightsLayersSectionId("media-1")}"`);
    expect(markup).toContain(`id="${rightsLayersSectionId("media-2")}"`);
    // ...and neither slice reaches into the other.
    expect(layerWell(markup, "media-1")).not.toContain(
      `id="${rightsLayersSectionId("media-2")}"`,
    );
    expect(layerWell(markup, "media-2")).not.toContain(
      `id="${rightsLayersSectionId("media-1")}"`,
    );
    expect(submittedLayers(layerWell(markup, "media-2"))).toEqual([]);
  });

  it("renders no well at all for an upload nobody has triaged", async () => {
    // There is no MediaListing to hang a clearance off, and the write
    // refuses one. A well full of forms that could only be refused would be
    // the screen contradicting the server.
    await createUpload("media-1");
    expect(await renderPage({ edit: "media-1" })).not.toContain(
      `id="${rightsLayersSectionId("media-1")}"`,
    );

    // The positive control, in the same test rather than inferred from
    // another: triage the same upload and the well appears. Without it a
    // renamed id, or a section that stopped rendering entirely, would make
    // the assertion above pass for the wrong reason.
    await triageWithEveryLayerPresent("media-1");
    expect(await renderPage({ edit: "media-1" })).toContain(
      `id="${rightsLayersSectionId("media-1")}"`,
    );
  });

  it("renders one form per blocking clearable layer, each naming its own layer", async () => {
    await createUpload("media-1");
    await triageWithEveryLayerPresent("media-1");

    const markup = await renderPage({ edit: "media-1" });
    const layers = submittedLayers(layerWell(markup, "media-1"));

    // Exactly the clearable set, once each. A screen that rendered one form
    // for "the upload" rather than one per layer would show a single field,
    // and one that repeated a layer would let the same justification be
    // submitted twice.
    expect([...layers].sort()).toEqual([...CLEARABLE_LAYERS].sort());
    expect(new Set(layers).size).toBe(layers.length);
  });

  it("drops only the cleared layer's form when a layer is cleared", async () => {
    /*
      THE RENDERING HALF of K1, with the same mutation the write path's
      test uses: clear ONE layer and count. A screen that read "has any
      clearance" rather than "has this layer's clearance" would drop every
      form at once.
    */
    await createUpload("media-1");
    await triageWithEveryLayerPresent("media-1");
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
      select: { id: true },
    });
    await prisma.mediaRightsClearance.create({
      data: {
        listingId: listing.id,
        layer: RightsLayer.MUSIC,
        reason: "Licence purchased, ref 4412",
        clearedByUserId: "admin-1",
      },
    });

    const markup = await renderPage({ edit: "media-1" });
    const well = layerWell(markup, "media-1");
    expect([...submittedLayers(well)].sort()).toEqual(
      CLEARABLE_LAYERS.filter((layer) => layer !== RightsLayer.MUSIC).sort(),
    );
    // And the recorded one is shown as a record, with its reason and signer.
    expect(well).toContain("MUSIC cleared");
    expect(well).toContain("Licence purchased, ref 4412");
  });

  it("shows a layer as blocking again when its clearer is no longer an admin", async () => {
    // The gate re-reads the clearer's current role, and this screen has to
    // agree with it: a demoted admin's justification that still read as
    // "cleared" here would send a curator looking for a different reason
    // the upload will not sell.
    await createUpload("media-1");
    await triageWithEveryLayerPresent("media-1");
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
      select: { id: true },
    });
    await prisma.mediaRightsClearance.create({
      data: {
        listingId: listing.id,
        layer: RightsLayer.MUSIC,
        reason: "Licence purchased",
        clearedByUserId: "demoted-1",
      },
    });

    const well = layerWell(await renderPage({ edit: "media-1" }), "media-1");
    expect(submittedLayers(well)).toContain(RightsLayer.MUSIC);
  });

  it("offers no form for a layer no clearance settles", async () => {
    /*
      ALCOHOL blocks forever on a `yes`, and WINE_ACCESSORY blocks on
      neither answer. Neither may be rendered with a box to type a
      justification into: the write refuses both, and a form that can only
      be refused teaches an admin that signing something fixes it.
    */
    await createUpload("media-1");
    await prisma.mediaListing.create({
      data: {
        mediaId: "media-1",
        ...Object.fromEntries(TRIAGE_FACTS.map((fact) => [fact.field, true])),
        modelReleaseKey: "releases/media-1/release.pdf",
        triagedByUserId: "admin-1",
        triagedAt: new Date("2026-10-02T09:30:00.000Z"),
      },
    });

    const layers = submittedLayers(
      layerWell(await renderPage({ edit: "media-1" }), "media-1"),
    );
    expect(layers).not.toContain(RightsLayer.ALCOHOL);
    expect(layers).not.toContain(RightsLayer.WINE_ACCESSORY);
    expect([...layers].sort()).toEqual([...CLEARABLE_LAYERS].sort());
  });

  it("renders no clearance form on a row the admin has not opened", async () => {
    // One upload's forms at a time, like the triage form: a page of open
    // reason boxes invites typing a justification into the wrong row.
    await createUpload("media-1");
    await triageWithEveryLayerPresent("media-1");
    const markup = await renderPage();
    expect(submittedLayers(layerWell(markup, "media-1"))).toEqual([]);
    expect(markup).toContain("is not settled yet");
  });

  it("says so when nothing is left to clear", async () => {
    await createUpload("media-1");
    await prisma.mediaListing.create({
      data: {
        mediaId: "media-1",
        ...Object.fromEntries(TRIAGE_FACTS.map((fact) => [fact.field, false])),
        triagedByUserId: "admin-1",
        triagedAt: new Date("2026-10-02T09:30:00.000Z"),
      },
    });
    const well = layerWell(await renderPage({ edit: "media-1" }), "media-1");
    expect(well).toContain("No layer is blocking this upload.");
    expect(submittedLayers(well)).toEqual([]);
  });

  it("confirms a recorded clearance, and says it settled one layer", async () => {
    await createUpload("media-1");
    expect(await renderPage({ clearance: "recorded" })).toContain(
      "Clearance recorded for that one layer",
    );
    // And not on an ordinary page load, so the banner is reporting the
    // `?clearance=` parameter rather than being part of the screen.
    expect(await renderPage()).not.toContain(
      "Clearance recorded for that one layer",
    );
  });

  it("renders a DISTINCT message for each clearance refusal code", async () => {
    /*
      Not just "a banner appeared". Five codes that all resolved to the same
      sentence would satisfy a per-code `toContain(ERROR_BANNER_ID)` and
      still tell an admin something true about a refusal that did not
      happen — so the banner's own text is collected and the five are
      required to differ.
    */
    await createUpload("media-1");
    const banners: string[] = [];
    for (const code of CLEARANCE_WRITE_REFUSALS) {
      const markup = await renderPage({ error: code });
      const banner = new RegExp(
        `<p[^>]*id="${ERROR_BANNER_ID}"[^>]*>([\\s\\S]*?)</p>`,
      ).exec(markup)?.[1];
      expect(banner, code).toBeTruthy();
      banners.push(banner ?? "");
    }
    expect(banners).toHaveLength(CLEARANCE_WRITE_REFUSALS.length);
    expect(new Set(banners).size).toBe(banners.length);
  });
});

/**
 * The price well (ugcportal-yzo7 K1/K4), on the admin side.
 *
 * TWO THINGS ARE ASSERTED TOGETHER AND MUST STAY TOGETHER: the stored
 * amount, and the gate's CURRENT verdict on the same row. An admin shown an
 * amount with no verdict would read the amount as permission, which is the
 * exact misreading K5's repository scan exists to make impossible in code —
 * this is the same rule at the surface a human looks at.
 */
describe("the price well (ugcportal-yzo7)", () => {
  async function clearUploader(
    status: ResaleRightsStatus = ResaleRightsStatus.CLEARED,
  ) {
    await prisma.resaleRightsReview.upsert({
      where: { uploaderUserId: "owner-1" },
      create: {
        uploaderUserId: "owner-1",
        status,
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        reviewedByUserId: "admin-1",
        reviewedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      update: { status },
    });
  }

  /** Fully triaged with every fact answered NO, which needs no clearance. */
  async function sellableListing(mediaId: string, priceCents: number | null) {
    await prisma.mediaListing.create({
      data: {
        mediaId,
        ...Object.fromEntries(FIELDS.map((field) => [field, false])),
        priceCents,
        currency: "NOK",
        triagedByUserId: "admin-1",
        triagedAt: new Date("2026-10-02T09:30:00.000Z"),
      },
    });
  }

  beforeEach(async () => {
    await prisma.resaleRightsReview.deleteMany({});
    await createUpload("priced-1");
    await attest("priced-1");
  });

  it("reports a priced, currently sellable upload as both", async () => {
    await sellableListing("priced-1", 125_000);
    await clearUploader();

    const markup = await renderPage();
    const well = new RegExp(
      `<div[^>]*id="${priceSectionId("priced-1")}"[^>]*>([\\s\\S]*?)</div>`,
    ).exec(markup)?.[1];

    expect(well).toBeDefined();
    expect(well).toContain("125000");
    expect(markup).toContain('data-sellability-verdict="sellable"');
  });

  it("keeps showing the amount when the gate refuses, with the blocker beside it", async () => {
    /*
      The admin-side K4. The price is unchanged and still rendered — hiding
      it would leave an admin unable to see what is stranded on the row —
      and the verdict says, in the same well, that nothing public will offer
      it.
    */
    await sellableListing("priced-1", 125_000);
    await clearUploader(ResaleRightsStatus.REVOKED);

    const markup = await renderPage();
    expect(markup).toContain("125000");
    expect(markup).toContain('data-sellability-verdict="status_not_cleared"');
    expect(markup).not.toContain('data-sellability-verdict="sellable"');

    // THE RESTORE: the verdict follows the status, not the fixture.
    await clearUploader(ResaleRightsStatus.CLEARED);
    expect(await renderPage()).toContain('data-sellability-verdict="sellable"');
  });

  it("says an untriaged, unpriced upload is not priced", async () => {
    await sellableListing("priced-1", null);
    await clearUploader();
    expect(await renderPage()).toContain("Not priced");
  });

  it("renders no price well at all for an upload with no triage record", async () => {
    // There is no MediaListing row to put a price on, and offering a form
    // that would answer `price_media_not_found` would be a dead control.
    expect(await renderPage()).not.toContain(`id="${priceSectionId("priced-1")}"`);
  });

  it("renders the price form only for the row named by ?edit=", async () => {
    await createUpload("priced-2", { previewId: "preview-priced-2" });
    await attest("priced-2");
    await sellableListing("priced-1", 125_000);
    await sellableListing("priced-2", 4_200);
    await clearUploader();

    const markup = await renderPage({ edit: "priced-1" });
    expect(markup).toContain('id="price-cents-priced-1"');
    expect(markup).not.toContain('id="price-cents-priced-2"');
  });
});
