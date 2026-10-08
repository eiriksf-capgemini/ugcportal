import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRIAGE_ANSWER_NO,
  TRIAGE_ANSWER_UNANSWERED,
  TRIAGE_ANSWER_YES,
  type TriageAnswers,
} from "@/lib/curation-triage";
import { TRIAGE_FACTS } from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The curation triage write path (ugcportal-vq3z K1–K4), as an integration
 * test: a real SQLite database with the committed migrations applied, the
 * real Prisma client over the real libsql driver, and the real server action.
 * Only the session and Next's navigation/cache helpers are faked.
 *
 * Done this way rather than with a mocked Prisma for the same reason the
 * price endpoint's test gives: the claim under test is partly a claim about
 * the SCHEMA — that a MediaListing can be created for a Media row that had
 * none, that these columns start null, that `triagedByUserId` really is a
 * foreign key to User — and partly about the driver, that the write happens
 * or is skipped. A mock would agree with whatever this file asserted.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { recordTriage } = await import("@/app/admin/curation/actions");
const { recordTriageFacts } = await import("@/lib/curation-triage-write");

const FIELDS = TRIAGE_FACTS.map((fact) => fact.field);

/**
 * A mixed answer set — alternating yes/no across the registry — so a writer
 * hard-wired to `false`, or one that wrote the first answer to every column,
 * fails instead of passing on a uniform fixture.
 */
const MIXED_ANSWERS: TriageAnswers = Object.fromEntries(
  FIELDS.map((field, index) => [field, index % 2 === 0]),
) as TriageAnswers;

const MEDIA_1_PREVIEW_KEY = "previews/owner-1/media-1.webp";

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};
const SECOND_ADMIN_SESSION = {
  user: { id: "admin-2", email: "admin2@example.com", role: "ADMIN" },
};

/** The form the triage screen submits, as a FormData. */
function triageForm(
  answers: Readonly<Record<string, boolean>> = MIXED_ANSWERS,
  extra: Record<string, string> = {},
  mediaId: string | null = "media-1",
): FormData {
  const data = new FormData();
  if (mediaId !== null) data.set("mediaId", mediaId);
  for (const [field, answer] of Object.entries(answers)) {
    data.set(field, answer ? TRIAGE_ANSWER_YES : TRIAGE_ANSWER_NO);
  }
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
}

async function listingFor(mediaId: string) {
  return prisma.mediaListing.findUnique({ where: { mediaId } });
}

/** The single `?error=` code the action last redirected with, or null. */
function redirectedError(): string | null {
  const target = redirectMock.mock.calls.at(-1)?.[0];
  if (typeof target !== "string") return null;
  return new URL(target, "http://localhost").searchParams.get("error");
}

/**
 * Every string that was actually persisted about one curated record: the
 * MediaListing row and the Media row it points at, all scalars.
 *
 * Walks the values rather than naming columns, so a column added to either
 * table later is scanned without anyone remembering. Non-string scalars are
 * skipped because a Boolean, an Int or a DateTime cannot hold a URL; the
 * strings are where one could hide.
 */
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  return Object.values(value).flatMap(stringValues);
}

/**
 * The ugcportal-2eh Option A boundary, as a pattern: an instagram.com or
 * graph.instagram.com URL, with or without a scheme.
 */
const INSTAGRAM_URL = /(?:https?:)?\/\/(?:[a-z0-9-]+\.)*instagram\.com/i;

async function instagramUrlsOnRecord(mediaId: string): Promise<string[]> {
  const [media, listing] = await Promise.all([
    prisma.media.findUniqueOrThrow({ where: { id: mediaId } }),
    prisma.mediaListing.findUniqueOrThrow({ where: { mediaId } }),
  ]);
  return [...stringValues(media), ...stringValues(listing)].filter((text) =>
    INSTAGRAM_URL.test(text),
  );
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
      { id: "admin-2", email: "admin2@example.com", role: "ADMIN" },
      { id: "user-1", email: "user@example.com", role: "USER" },
      { id: "owner-1", email: "owner@example.com", role: "USER" },
    ],
  });
  await prisma.media.createMany({
    data: [
      {
        id: "media-1",
        userId: "owner-1",
        kind: "IMAGE",
        key: "media/owner-1/original.jpg",
        previewKey: MEDIA_1_PREVIEW_KEY,
        previewId: "preview-media-1",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        originalName: "original.jpg",
        altText: "A glass on a table",
      },
      {
        // No watermarked preview — today that is every VIDEO, since poster
        // frames are ugcportal-pmb. K4's subject.
        id: "media-no-preview",
        userId: "owner-1",
        kind: "VIDEO",
        key: "media/owner-1/clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 5678,
        originalName: "clip.mp4",
      },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset().mockResolvedValue(ADMIN_SESSION);
  revalidatePathMock.mockReset();
  redirectMock.mockReset();
  await prisma.mediaListing.deleteMany({});
  // Fixture state the individual tests mutate, put back explicitly rather
  // than left to run order.
  await prisma.media.update({
    where: { id: "media-1" },
    data: { previewKey: MEDIA_1_PREVIEW_KEY, caption: null },
  });
  await prisma.media.update({
    where: { id: "media-no-preview" },
    data: { previewKey: null },
  });
});

describe("K1: an admin records the triage facts", () => {
  it("writes every registered fact, the acting admin and the time", async () => {
    const before = Date.now();
    await recordTriage(triageForm());
    const after = Date.now();

    const listing = await listingFor("media-1");
    expect(listing).not.toBeNull();
    if (!listing) return;

    // Column by column, against the mixed answer set, so a writer that got
    // the mapping wrong — or wrote one answer everywhere — fails here.
    for (const field of FIELDS) {
      expect(listing[field], field).toBe(MIXED_ANSWERS[field]);
    }
    expect(listing.triagedByUserId).toBe("admin-1");
    expect(listing.triagedAt).not.toBeNull();
    // A window rather than an exact instant: the claim is "the current
    // time", and the only way to make that mechanical is to bracket the call.
    expect(listing.triagedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(listing.triagedAt?.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("creates the listing for an upload that had none", async () => {
    // The state every upload is in before this screen exists: nothing in the
    // application wrote a MediaListing at all, so the first triage is a
    // create and not an update.
    expect(await listingFor("media-1")).toBeNull();
    await recordTriage(triageForm());
    expect(await listingFor("media-1")).not.toBeNull();
  });

  /*
    K1's named FIXTURE MUTATION: act as a SECOND admin and confirm
    `triagedByUserId` follows the actor rather than a constant. Without this,
    an implementation that hard-coded the first admin's id — or that read the
    actor from the form instead of the session — would pass every assertion
    above.
  */
  it("records whichever admin acted, not a constant", async () => {
    await recordTriage(triageForm());
    expect((await listingFor("media-1"))?.triagedByUserId).toBe("admin-1");

    authMock.mockResolvedValue(SECOND_ADMIN_SESSION);
    await recordTriage(triageForm());
    expect((await listingFor("media-1"))?.triagedByUserId).toBe("admin-2");
  });

  it("re-stamps the actor and the time when a triage is revised", async () => {
    await recordTriage(triageForm());
    const first = await listingFor("media-1");

    authMock.mockResolvedValue(SECOND_ADMIN_SESSION);
    await recordTriage(
      triageForm(Object.fromEntries(FIELDS.map((f) => [f, false]))),
    );
    const second = await listingFor("media-1");

    // Same row, revised — not a second listing, and not a row still
    // attributing someone else's answers to the first admin.
    expect(second?.id).toBe(first?.id);
    expect(second?.triagedByUserId).toBe("admin-2");
    expect(second?.triagedAt?.getTime()).toBeGreaterThanOrEqual(
      first?.triagedAt?.getTime() ?? 0,
    );
    for (const field of FIELDS) {
      expect(second?.[field], field).toBe(false);
    }
  });

  it("revalidates the screen and redirects with no error", async () => {
    await recordTriage(triageForm());
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/curation");
    expect(redirectMock).toHaveBeenCalledWith("/admin/curation?triage=recorded");
    expect(redirectedError()).toBeNull();
  });

  it("writes the triage facts and the attribution, and nothing else", async () => {
    // A listing that already carries a price, so the claim "this screen does
    // not set a price" is about a value that really is there to clobber.
    await prisma.mediaListing.create({
      data: { mediaId: "media-1", priceCents: 4200, currency: "EUR" },
    });
    const before = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
    });

    await recordTriage(triageForm());

    const after = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
    });
    const changed = Object.keys(after).filter(
      (key) =>
        String(after[key as keyof typeof after]) !==
        String(before[key as keyof typeof before]),
    );
    const mustChange = [...FIELDS, "triagedAt", "triagedByUserId"];
    // `updatedAt` is allowed to change but not required to: Prisma sets it on
    // every update, and a create followed by an update inside the same
    // millisecond leaves it identical. Asserting it changed would be a
    // clock-dependent flake, so it is in the permitted set and not the
    // required one.
    const mayChange = [...mustChange, "updatedAt"];
    expect(changed.sort()).toEqual(expect.arrayContaining(mustChange.sort()));
    for (const key of changed) expect(mayChange).toContain(key);
    expect(after.priceCents).toBe(4200);
    expect(after.currency).toBe("EUR");
  });

  it("ignores form fields outside the registry, including a forged actor", async () => {
    // The mechanical half of the claim above: a crafted form really does
    // carry these, and they really do not land.
    await prisma.mediaListing.create({
      data: { mediaId: "media-1", priceCents: 4200, currency: "EUR" },
    });

    await recordTriage(
      triageForm(MIXED_ANSWERS, {
        priceCents: "1",
        currency: "USD",
        modelReleaseKey: "releases/forged.pdf",
        triagedByUserId: "user-1",
        triagedAt: "1999-01-01T00:00:00.000Z",
      }),
    );

    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
    });
    expect(listing.priceCents).toBe(4200);
    expect(listing.currency).toBe("EUR");
    expect(listing.modelReleaseKey).toBeNull();
    // The session's admin, not the form's claim.
    expect(listing.triagedByUserId).toBe("admin-1");
    expect(listing.triagedAt?.getFullYear()).toBeGreaterThan(2020);
  });
});

describe("K2: nobody but an admin may record a triage fact", () => {
  /*
    K2's named FIXTURE MUTATION, and the reason it is the one to be most
    careful with. "It threw" is not the assertion — the action would also
    throw on a missing fixture or a bad import, and the test would pass while
    proving nothing. So: the SAME call, the same form, the same user id, with
    only the session's role changed. The first half must refuse with the
    specific message and write nothing; the second must succeed. That pair is
    what connects the refusal to the role.
  */
  it("refuses a signed-in non-admin, and the same call succeeds once they are an admin", async () => {
    const form = () => triageForm();

    authMock.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", role: "USER" },
    });
    await expect(recordTriage(form())).rejects.toThrow("Forbidden");
    expect(await listingFor("media-1")).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();

    // The one thing that changes.
    authMock.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", role: "ADMIN" },
    });
    await recordTriage(form());
    const listing = await listingFor("media-1");
    expect(listing).not.toBeNull();
    expect(listing?.triagedByUserId).toBe("user-1");
  });

  it("refuses an unauthenticated caller without writing", async () => {
    authMock.mockResolvedValue(null);
    await expect(recordTriage(triageForm())).rejects.toThrow("Forbidden");
    expect(await listingFor("media-1")).toBeNull();
  });

  it("refuses a session with no user on it", async () => {
    // Since ugcportal-mzr a revoked identity resolves to a session with no
    // user; `requireAdmin` answers that the same way as signed out.
    authMock.mockResolvedValue({});
    await expect(recordTriage(triageForm())).rejects.toThrow("Forbidden");
    expect(await listingFor("media-1")).toBeNull();
  });

  it("refuses a session that carries no role at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    await expect(recordTriage(triageForm())).rejects.toThrow("Forbidden");
    expect(await listingFor("media-1")).toBeNull();
  });

  it("refuses a role that is not ADMIN even when it looks like one", async () => {
    for (const role of ["admin", "ADMINISTRATOR", "SUPERADMIN", ""]) {
      authMock.mockResolvedValue({ user: { id: "user-1", role } });
      await expect(recordTriage(triageForm())).rejects.toThrow("Forbidden");
      expect(await listingFor("media-1")).toBeNull();
    }
  });

  it("checks the role before it looks at the form at all", async () => {
    // A non-admin submitting a malformed form must still get "Forbidden" —
    // otherwise the error message tells them which of the two checks they
    // tripped, and a future reordering could let a validation failure take
    // precedence over the gate.
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });
    await expect(
      recordTriage(triageForm({}, {}, null)),
    ).rejects.toThrow("Forbidden");
  });
});

describe("K3: the curated record is the uploaded original, never an Instagram URL", () => {
  it("points the listing at the ugcportal-8wa Media row by id", async () => {
    await recordTriage(triageForm());
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
    });
    const media = await prisma.media.findUniqueOrThrow({
      where: { id: "media-1" },
    });
    expect(listing.mediaId).toBe(media.id);
    // Storage keys, not URLs: no scheme and no host anywhere in the pointer
    // the record is built on, which is what "the artefact is our own object"
    // means in the data rather than in prose.
    expect(media.key).not.toMatch(/:\/\//);
    expect(media.previewKey).not.toMatch(/:\/\//);
  });

  it("persists no instagram.com URL on the curated record", async () => {
    await recordTriage(triageForm());
    expect(await instagramUrlsOnRecord("media-1")).toEqual([]);
  });

  /*
    The scan above could pass by being broken. So: FIXTURE MUTATION — put a
    real Instagram permalink into a persisted, writable text column
    (`Media.caption`) and confirm the same scan finds it, then take it out
    again and confirm it goes quiet. Without this pair the assertion is
    "a regex found nothing", which is also what a wrong regex returns.
  */
  it("would find an Instagram URL if one were persisted", async () => {
    await recordTriage(triageForm());
    await prisma.media.update({
      where: { id: "media-1" },
      data: { caption: "Originally posted at https://www.instagram.com/p/XYZ/" },
    });
    expect(await instagramUrlsOnRecord("media-1")).toEqual([
      "Originally posted at https://www.instagram.com/p/XYZ/",
    ]);

    await prisma.media.update({
      where: { id: "media-1" },
      data: { caption: null },
    });
    expect(await instagramUrlsOnRecord("media-1")).toEqual([]);
  });

  it("also recognises a graph.instagram.com host and a scheme-relative one", async () => {
    // The two other shapes K3 names, so the pattern is not pinned to exactly
    // one spelling of the needle it is supposed to catch.
    for (const caption of [
      "https://graph.instagram.com/v21.0/123/media",
      "//instagram.com/p/XYZ/",
    ]) {
      await recordTriage(triageForm());
      await prisma.media.update({
        where: { id: "media-1" },
        data: { caption },
      });
      expect(await instagramUrlsOnRecord("media-1")).toEqual([caption]);
      await prisma.media.update({
        where: { id: "media-1" },
        data: { caption: null },
      });
    }
  });
});

describe("K4: no watermarked preview, no listing", () => {
  /*
    K4's named FIXTURE MUTATION: the same call against the same Media row,
    first with `previewKey` null and then with one set. The refusal half
    proves the screen cannot put an unprotected original into the curation
    flow; the success half proves the refusal is about the preview and not
    about something else wrong with the fixture.
  */
  it("refuses a Media row with no previewKey, and accepts it once one is set", async () => {
    const form = () => triageForm(MIXED_ANSWERS, {}, "media-no-preview");

    await recordTriage(form());
    expect(redirectedError()).toBe("no_preview");
    expect(await listingFor("media-no-preview")).toBeNull();

    // The one thing that changes.
    await prisma.media.update({
      where: { id: "media-no-preview" },
      data: { previewKey: "previews/owner-1/clip-poster.webp" },
    });
    await recordTriage(form());
    expect(redirectedError()).toBeNull();
    expect(await listingFor("media-no-preview")).not.toBeNull();
  });

  it("treats a blank previewKey as absent rather than as a working preview", async () => {
    // A blank path is a writer-side bug, not "no preview" and not a usable
    // one — the same reading the publish endpoint uses, so the screen and
    // that endpoint agree about which rows are curatable.
    await prisma.media.update({
      where: { id: "media-1" },
      data: { previewKey: "   " },
    });
    await recordTriage(triageForm());
    expect(redirectedError()).toBe("no_preview");
    expect(await listingFor("media-1")).toBeNull();
  });

  it("does not create a listing for a Media row that does not exist", async () => {
    await recordTriage(triageForm(MIXED_ANSWERS, {}, "no-such-media"));
    expect(redirectedError()).toBe("media_not_found");
    expect(await prisma.mediaListing.count()).toBe(0);
  });
});

describe("a half-filled triage is refused rather than signed", () => {
  it("refuses a form that leaves one question blank, writing nothing", async () => {
    for (const field of FIELDS) {
      const data = triageForm();
      data.set(field, TRIAGE_ANSWER_UNANSWERED);
      await recordTriage(data);
      expect(redirectedError(), field).toBe("unanswered");
      expect(await listingFor("media-1"), field).toBeNull();
    }
  });

  it("stops before the write rather than carrying on past the redirect", async () => {
    // `redirect` throws in production and returns under test. If the action
    // called it without returning, the write below it would still run and
    // only the suite would fail to notice — so this asserts on the thing a
    // missing `return` would reveal: that nothing was written and no
    // revalidation happened.
    await recordTriage(triageForm({}));
    expect(redirectedError()).toBe("unanswered");
    expect(await prisma.mediaListing.count()).toBe(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("sends the admin back to the row they were triaging", async () => {
    await recordTriage(triageForm({}));
    const target = redirectMock.mock.calls.at(-1)?.[0] as string;
    expect(new URL(target, "http://localhost").searchParams.get("edit")).toBe(
      "media-1",
    );
  });

  it("throws on a form with no media id, which the UI never submits", async () => {
    await expect(recordTriage(triageForm(MIXED_ANSWERS, {}, null))).rejects.toThrow(
      "Missing media id",
    );
    expect(await prisma.mediaListing.count()).toBe(0);
  });

  it("refuses an incomplete answer object handed straight to the writer", async () => {
    /*
      The chokepoint's own last line of defence. `parseTriageAnswers` carries
      one type assertion, so a future caller building an answer object by
      hand is the one way an unanswered fact could reach Prisma. It is
      refused there, not trusted to the parser.
    */
    const incomplete = Object.fromEntries(
      FIELDS.slice(1).map((field) => [field, false]),
    ) as TriageAnswers;
    await expect(
      recordTriageFacts({
        mediaId: "media-1",
        answers: incomplete,
        actorUserId: "admin-1",
      }),
    ).rejects.toThrow(FIELDS[0]);
    expect(await prisma.mediaListing.count()).toBe(0);
  });
});
