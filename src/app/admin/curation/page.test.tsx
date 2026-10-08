import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TRIAGE_FACTS } from "@/lib/resale-rights";
import { mediaPreviewPath } from "@/lib/routes";
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
const {
  default: AdminCurationPage,
  ERROR_BANNER_ID,
  MAX_UPLOADS,
  UPLOAD_LIST_ID,
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
    // demoted is void. Surfaced here since no render-time gate exists yet
    // (ugcportal-yzo7, K4).
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
