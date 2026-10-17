import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  MEDIA_ATTESTATION_VERSION_FIELD,
  attestationFieldName,
  attestationFormParts,
  type AttestationAnswers,
} from "@/lib/attestation";
import {
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";
import { FIXTURE_CLEARANCE_SCOPE } from "@/lib/test-support/resale-rights";

/**
 * POST /api/media/[id]/attestation (ugcportal-gkax), against a REAL database:
 * the real migrations, the real ownership gate, the real `@unique` on
 * `MediaAttestation.mediaId`, and the real sale gate read back afterwards.
 *
 * What is faked: the session (`auth`), and the configured-users array, which
 * gets the fixture person appended so the owner below is a CONFIGURED
 * uploader — the population K1 is about. The route itself does not ask.
 *
 * `@/lib/prisma`, the route and every module that reaches the client are
 * imported AFTER `createTemporaryDatabase`, dynamically: a static import
 * would build the client against whatever DATABASE_URL was set before this
 * file ran (ugcportal-e95r).
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

vi.mock("@/config/users", async (importOriginal) => {
  const { withFixtureConfiguredUser } = await import(
    "@/lib/test-support/fixture-configured-user"
  );
  return withFixtureConfiguredUser(await importOriginal());
});

const { POST } = await import("@/app/api/media/[id]/attestation/route");
const { evaluateSellability, attestationBlocker, MEDIA_GATE_SELECT, CURRENT_CHECKLIST_VERSION } =
  await import("@/lib/resale-rights");
const { PUBLIC_MEDIA_SCOPE } = await import("@/lib/public-media");
const { FIXTURE_CONFIGURED_HANDLE } = await import(
  "@/lib/test-support/fixture-configured-user"
);

/** A configured uploader, an ORDINARY user (not ADMIN), as ho7j leaves them. */
const OWNER = "owner-gkax";
/** An operator. Owns nothing below except where a case seeds it. */
const ADMIN = "admin-gkax";
/** Somebody else entirely. */
const STRANGER = "stranger-gkax";

const MEDIA_ID = "media-gkax";
const OTHER_MEDIA_ID = "media-gkax-other";

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset();
  await prisma.user.createMany({
    data: [
      {
        id: OWNER,
        email: "owner-gkax@example.com",
        role: "USER",
        configuredHandle: FIXTURE_CONFIGURED_HANDLE,
      },
      { id: ADMIN, email: "admin-gkax@example.com", role: "ADMIN" },
      { id: STRANGER, email: "stranger-gkax@example.com", role: "USER" },
    ],
  });
  // The owner's standing clearance, so the sale gate gets past the
  // uploader-level steps and reaches the attestation step at all. Without
  // it `evaluateSellability` answers `no_review` both before and after, and
  // the K1 assertion "no longer attestation_missing" would pass on a gate
  // that never looked at the attestation.
  await prisma.resaleRightsReview.create({
    data: {
      uploaderUserId: OWNER,
      status: "CLEARED",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      ...FIXTURE_CLEARANCE_SCOPE,
      reviewedByUserId: ADMIN,
      reviewedAt: new Date("2026-03-01T00:00:00.000Z"),
      validUntil: null,
    },
  });
});

afterEach(async () => {
  await prisma.resaleRightsReview.deleteMany({});
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
});

function signedInAs(userId: string, role: "USER" | "ADMIN" = "USER") {
  authMock.mockResolvedValue({ user: { id: userId, role } });
}

/**
 * A configured uploader's auto-published image as ho7j stores it: published,
 * with a preview, and NO attestation row.
 */
async function seedMedia(id: string = MEDIA_ID, userId: string = OWNER) {
  await prisma.media.create({
    data: {
      id,
      userId,
      kind: "IMAGE",
      key: `media/${userId}/${id}.png`,
      previewKey: `previews/${userId}/${id}.webp`,
      previewId: `preview-${id}`,
      mimeType: "image/png",
      sizeBytes: 2048,
      originalName: "IMG_0001.HEIC",
      altText: "A fox crossing a snowy field at dawn",
      caption: "Dawn",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  });
}

function cleanAnswers(overrides: Partial<AttestationAnswers> = {}): AttestationAnswers {
  return {
    authorship: "AUTHOR",
    ...(Object.fromEntries(
      ATTESTATION_QUESTIONS.map(({ field }) => [field, field === "uploaderIsAdult"]),
    ) as Omit<AttestationAnswers, "authorship">),
    ...overrides,
  };
}

/** The body the browser sends: the upload's own multipart parts, as JSON. */
function attestationBody(
  answers: AttestationAnswers = cleanAnswers(),
  version: string = CURRENT_ATTESTATION_VERSION,
): Record<string, string> {
  return Object.fromEntries(attestationFormParts({ version, answers }));
}

function attest(body: unknown, id: string = MEDIA_ID) {
  return POST(
    new Request(`http://localhost/api/media/${id}/attestation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** Every scalar column of the Media row — `findUnique` with no `select`. */
function mediaRow(id: string = MEDIA_ID) {
  return prisma.media.findUniqueOrThrow({ where: { id } });
}

async function gate(id: string = MEDIA_ID) {
  return evaluateSellability(
    await prisma.media.findUniqueOrThrow({
      where: { id },
      select: MEDIA_GATE_SELECT,
    }),
  );
}

describe("K1: the owner attests their own un-attested upload", () => {
  it("creates the row, as the session user, at the current version — and the sale gate stops answering attestation_missing", async () => {
    await seedMedia();
    signedInAs(OWNER);
    // Measured before, on the same gate, so the change below is a change.
    expect(await gate()).toEqual({ sellable: false, blocker: "attestation_missing" });

    const response = await attest(attestationBody());

    expect(response.status).toBe(201);
    const echoed = await response.json();
    expect(echoed).toMatchObject({
      mediaId: MEDIA_ID,
      attestationVersion: CURRENT_ATTESTATION_VERSION,
      authorship: "AUTHOR",
    });
    expect(echoed).not.toHaveProperty("attestedByUserId");

    const row = await prisma.mediaAttestation.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
    });
    expect(row.attestedByUserId).toBe(OWNER);
    expect(row.attestationVersion).toBe(CURRENT_ATTESTATION_VERSION);
    for (const [field, value] of Object.entries(cleanAnswers())) {
      expect(row[field as keyof typeof row], field).toBe(value);
    }

    // The gate reads it exactly as an at-upload attestation: the attestation
    // step passes (including `attestation_not_by_uploader`, since the actor
    // is `Media.userId`), and the next thing missing is the sale record.
    const media = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: MEDIA_GATE_SELECT,
    });
    expect(attestationBlocker(media.attestation, media.userId)).toBeNull();
    expect(await gate()).toEqual({ sellable: false, blocker: "not_listed_for_sale" });
  });

  it("records the answers as given, a `yes` included", async () => {
    await seedMedia();
    signedInAs(OWNER);

    const response = await attest(
      attestationBody(cleanAnswers({ brandOrSponsorship: true, aiGenerated: true })),
    );

    expect(response.status).toBe(201);
    const row = await prisma.mediaAttestation.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
    });
    expect(row.brandOrSponsorship).toBe(true);
    expect(row.aiGenerated).toBe(true);
    expect(row.showsMinors).toBe(false);
  });

  it("an admin may attest their OWN upload — the rule is ownership, not role", async () => {
    await seedMedia(MEDIA_ID, ADMIN);
    signedInAs(ADMIN, "ADMIN");

    const response = await attest(attestationBody());

    expect(response.status).toBe(201);
    const row = await prisma.mediaAttestation.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
    });
    expect(row.attestedByUserId).toBe(ADMIN);
  });
});

describe("K2: never someone else's file, never on someone's behalf, never twice", () => {
  it("an ADMIN who does not own the file: 403, and no row", async () => {
    /*
     * The §4 item 7 case, and the reason the session here is an admin rather
     * than an ordinary stranger: a route that let operators through would
     * pass a stranger test and fail this one.
     */
    await seedMedia();
    signedInAs(ADMIN, "ADMIN");

    const response = await attest(attestationBody());

    expect(response.status).toBe(403);
    expect(await prisma.mediaAttestation.count()).toBe(0);
    expect(await gate()).toEqual({ sellable: false, blocker: "attestation_missing" });
  });

  it("an ordinary user who does not own the file: 403, and no row", async () => {
    await seedMedia();
    signedInAs(STRANGER);

    expect((await attest(attestationBody())).status).toBe(403);
    expect(await prisma.mediaAttestation.count()).toBe(0);
  });

  it("no such file: 404; not signed in: 401 — and no row either way", async () => {
    await seedMedia();
    signedInAs(OWNER);
    expect((await attest(attestationBody(), "no-such-media")).status).toBe(404);

    authMock.mockResolvedValue(null);
    expect((await attest(attestationBody())).status).toBe(401);

    expect(await prisma.mediaAttestation.count()).toBe(0);
  });

  it("a file that already has a row: 409, and that row is unchanged", async () => {
    await seedMedia();
    signedInAs(OWNER);
    expect((await attest(attestationBody())).status).toBe(201);
    const first = await prisma.mediaAttestation.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
    });

    // Different answers, so an overwrite would be visible.
    const response = await attest(
      attestationBody(cleanAnswers({ authorship: "NEITHER", showsMinors: true })),
    );

    expect(response.status).toBe(409);
    expect(await prisma.mediaAttestation.count()).toBe(1);
    expect(
      await prisma.mediaAttestation.findUniqueOrThrow({ where: { mediaId: MEDIA_ID } }),
    ).toEqual(first);
  });

  it("two at once: exactly one row", async () => {
    await seedMedia();
    signedInAs(OWNER);

    const statuses = (
      await Promise.all([attest(attestationBody()), attest(attestationBody())])
    )
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([201, 409]);
    expect(await prisma.mediaAttestation.count()).toBe(1);
  });

  it("the actor is always the session user: an actor key (or mediaId) in the body is ignored", async () => {
    await seedMedia();
    await seedMedia(OTHER_MEDIA_ID, STRANGER);
    signedInAs(OWNER);

    // The behavioural check, for the keys listed here and no others: the
    // route's own local name `userId`, the column name `attestedByUserId`,
    // `uploaderUserId` (read straight off a request in
    // src/app/api/admin/rights/decision/route.ts), three of them also under
    // the `attestation.` prefix, and a few other plausible actor names. A
    // list can only cover what it lists. That no natural read of a body key other
    // than the ten `parseAttestation` reads reaches the write is the
    // structural case in src/lib/attestation-write-paths.test.ts
    // (`rawBodyLeaksIn`), which holds the route's source to reading the body
    // only through that parser.
    const response = await attest({
      ...attestationBody(),
      attestedByUserId: STRANGER,
      [attestationFieldName("attestedByUserId")]: STRANGER,
      userId: STRANGER,
      [attestationFieldName("userId")]: STRANGER,
      attestedBy: STRANGER,
      actorUserId: STRANGER,
      ownerId: STRANGER,
      uploaderUserId: STRANGER,
      [attestationFieldName("uploaderUserId")]: STRANGER,
      mediaId: OTHER_MEDIA_ID,
    });

    expect(response.status).toBe(201);
    const rows = await prisma.mediaAttestation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].mediaId).toBe(MEDIA_ID);
    expect(rows[0].attestedByUserId).toBe(OWNER);
  });
});

describe("the answers are refused exactly as at upload", () => {
  it("a missing answer: 400 naming the field, and no row", async () => {
    await seedMedia();
    signedInAs(OWNER);
    const body = attestationBody();
    delete body[attestationFieldName("showsMinors")];

    const response = await attest(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      field: attestationFieldName("showsMinors"),
    });
    expect(await prisma.mediaAttestation.count()).toBe(0);
  });

  it("a retired or unknown version: 400, and no row", async () => {
    await seedMedia();
    signedInAs(OWNER);

    const response = await attest(attestationBody(cleanAnswers(), "2000-01-01.1"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      field: MEDIA_ATTESTATION_VERSION_FIELD,
    });
    expect(await prisma.mediaAttestation.count()).toBe(0);
  });

  it("a non-object body: 400, and no row", async () => {
    await seedMedia();
    signedInAs(OWNER);

    expect((await attest([attestationBody()])).status).toBe(400);
    expect((await attest("yes")).status).toBe(400);
    expect(await prisma.mediaAttestation.count()).toBe(0);
  });
});

describe("K3: the Media row is never written", () => {
  it("every column is identical before and after a 201", async () => {
    await seedMedia();
    signedInAs(OWNER);
    const before = await mediaRow();

    expect((await attest(attestationBody())).status).toBe(201);

    expect(await mediaRow()).toEqual(before);
    expect(before.publishedAt).not.toBeNull();
  });

  it("…and before and after a 409, a 403 and a 400", async () => {
    await seedMedia();
    signedInAs(OWNER);
    // A 400 needs a row still un-attested: once one exists the pre-check
    // refuses with a 409 before the body is read.
    const unattested = await mediaRow();
    expect((await attest({})).status).toBe(400);
    expect(await prisma.mediaAttestation.count()).toBe(0);
    expect(await mediaRow()).toEqual(unattested);

    expect((await attest(attestationBody())).status).toBe(201);
    const before = await mediaRow();

    expect((await attest(attestationBody())).status).toBe(409);
    signedInAs(ADMIN, "ADMIN");
    expect((await attest(attestationBody())).status).toBe(403);
    signedInAs(OWNER);
    expect((await attest({})).status).toBe(409);

    expect(await mediaRow()).toEqual(before);
  });

  it("…even when the answers take a published file off the public pages", async () => {
    /*
     * The consequence this route does not cause but does expose, pinned so
     * it is a decision rather than a surprise: the public scope READS the
     * attestation (`PUBLIC_MEDIA_RIGHTS_SCOPE`), so a configured uploader
     * who declares an identifiable person with no PEOPLE clearance takes
     * the file off the public surfaces — exactly as the same answer at
     * upload would have kept it off — while `publishedAt` itself is never
     * touched.
     */
    await seedMedia();
    signedInAs(OWNER);
    const publicCount = () =>
      prisma.media.count({ where: { id: MEDIA_ID, ...PUBLIC_MEDIA_SCOPE } });
    expect(await publicCount()).toBe(1);
    const before = await mediaRow();

    const response = await attest(
      attestationBody(cleanAnswers({ showsIdentifiablePeople: true })),
    );

    expect(response.status).toBe(201);
    expect(await mediaRow()).toEqual(before);
    expect(await publicCount()).toBe(0);
  });

  it("…and, the other way, a clean answer puts back a published file that was off them only for want of one", async () => {
    /*
     * A NON-configured uploader's published file with no attestation — one
     * published before ugcportal-3ae — is off the public pages, because only
     * a configured uploader's undeclared file is let through. The route does
     * not ask who is configured, so its owner may answer for it, and the
     * scope then reads the answer like any other.
     */
    await seedMedia(MEDIA_ID, STRANGER);
    signedInAs(STRANGER);
    const publicCount = () =>
      prisma.media.count({ where: { id: MEDIA_ID, ...PUBLIC_MEDIA_SCOPE } });
    expect(await publicCount()).toBe(0);
    const before = await mediaRow();

    expect((await attest(attestationBody())).status).toBe(201);

    expect(await mediaRow()).toEqual(before);
    expect(await publicCount()).toBe(1);
  });

  it("…and the same for an answer of NEITHER, which disclaims the rights", async () => {
    await seedMedia();
    signedInAs(OWNER);
    const publicCount = () =>
      prisma.media.count({ where: { id: MEDIA_ID, ...PUBLIC_MEDIA_SCOPE } });
    expect(await publicCount()).toBe(1);
    const before = await mediaRow();

    const response = await attest(
      attestationBody(cleanAnswers({ authorship: "NEITHER" })),
    );

    expect(response.status).toBe(201);
    expect(await mediaRow()).toEqual(before);
    expect(await publicCount()).toBe(0);
    expect(await gate()).toEqual({
      sellable: false,
      blocker: "attestation_rights_disclaimed",
    });
  });
});
