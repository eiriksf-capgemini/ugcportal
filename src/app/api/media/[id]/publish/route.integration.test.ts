import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MediaAuthorship, RightsLayer } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * K1 (ugcportal-gwr), against a REAL database rather than a mocked Prisma
 * client.
 *
 * route.test.ts in this directory already covers the publish route's status
 * codes and its exact write set against a mocked `prisma.media`, including
 * the K1 refusal itself. This file exists for the claim a mock cannot make:
 * that the row ACTUALLY persisted in storage still has `publishedAt: null`
 * after a refused publish, and actually has it set after a successful one —
 * the "DB check" the bead's own verification note asks for. There is no
 * Playwright/e2e harness in this repo yet (grepped: no playwright.config, no
 * @playwright/test dependency, no axe-core dependency) — that is a real,
 * pre-existing gap, not something this bead bootstraps. This is the closest
 * equivalent evidence this repo's existing test infrastructure can produce:
 * a real SQLite database, the real migrations, and the real route handler.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { POST } = await import("@/app/api/media/[id]/publish/route");

const OWNER_ID = "owner-gwr-k1";
const ADMIN_ID = "admin-3ae";
const MEDIA_ID = "media-gwr-k1";

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: OWNER_ID, email: "owner-gwr-k1@example.com" },
  });
  await prisma.user.create({
    data: { id: ADMIN_ID, email: "admin-3ae@example.com", role: "ADMIN" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

afterEach(async () => {
  // MediaListing, MediaAttestation and MediaRightsClearance all cascade from
  // Media, so one delete clears the fixture.
  await prisma.media.deleteMany({});
  authMock.mockReset();
});

type SeedOptions = {
  altText?: string | null;
  /** ugcportal-3ae: write the uploader's declaration. Default true. */
  attested?: boolean;
  /** The uploader's own answer to the people question. */
  showsIdentifiablePeople?: boolean;
  /** The admin's answer, on a MediaListing. `undefined` writes no listing. */
  depictsPeople?: boolean | null;
  /** Record a PEOPLE clearance signed by a current admin. */
  peopleCleared?: boolean;
  published?: boolean;
};

async function seedPublishableMedia(overrides: SeedOptions = {}) {
  const {
    altText = null,
    attested = true,
    showsIdentifiablePeople = false,
    depictsPeople,
    peopleCleared = false,
    published = false,
  } = overrides;

  const media = await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: OWNER_ID,
      kind: "IMAGE",
      key: `media/${OWNER_ID}/original.png`,
      previewKey: `previews/${OWNER_ID}/preview.webp`,
      previewId: "preview-gwr-k1",
      mimeType: "image/png",
      sizeBytes: 2048,
      originalName: "IMG_4821.HEIC",
      altText,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt: published ? new Date("2026-02-01T00:00:00.000Z") : null,
    },
  });

  if (attested) {
    await prisma.mediaAttestation.create({
      data: {
        mediaId: MEDIA_ID,
        attestedByUserId: OWNER_ID,
        attestationVersion: CURRENT_ATTESTATION_VERSION,
        authorship: MediaAuthorship.AUTHOR,
        ownOriginalNotFromWeb: true,
        showsIdentifiablePeople,
        showsMinors: false,
        containsMusicNotOwned: false,
        otherCreativeContributor: false,
        brandOrSponsorship: false,
        aiGenerated: false,
        uploaderIsAdult: true,
      },
    });
  }

  if (depictsPeople !== undefined || peopleCleared) {
    /*
      Seeded DIRECTLY, because nothing in the product writes a
      MediaRightsClearance row yet — that write path is ugcportal-qfy9,
      in flight alongside this. Fail-closed is testable without it; the
      PERMITTING half of K2 is only reachable this way until qfy9 lands,
      and that is stated in this bead's PR rather than implied otherwise.
    */
    await prisma.mediaListing.create({
      data: {
        mediaId: MEDIA_ID,
        depictsPeople: depictsPeople ?? null,
        layerClearances: peopleCleared
          ? {
              create: {
                layer: RightsLayer.PEOPLE,
                reason:
                  "Model release on file; covers online commercial publication.",
                clearedByUserId: ADMIN_ID,
              },
            }
          : undefined,
      },
    });
  }

  return media;
}

const ALT_TEXT = "A fox crossing a snowy field at dawn";

function publishRequest() {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
    method: "POST",
  });
}

function context() {
  return { params: Promise.resolve({ id: MEDIA_ID }) };
}

describe("publishing without alt text, against a real database (ugcportal-gwr K1)", () => {
  it("rejects the publish and leaves the row unpublished in the database", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({ altText: null });

    const response = await POST(publishRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("altText");

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
    });
    expect(row.publishedAt).toBeNull();
  });

  it("publishes and persists publishedAt once alt text is present", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({
      altText: "A fox crossing a snowy field at dawn",
    });

    const response = await POST(publishRequest(), context());
    expect(response.status).toBe(200);

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
    });
    expect(row.publishedAt).not.toBeNull();
    expect(row.altText).toBe("A fox crossing a snowy field at dawn");
    // Never the filename, however the row's own originalName was seeded.
    expect(row.altText).not.toBe(row.originalName);
  });

  it("never persists a publish with blank-only alt text", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({ altText: "   " });

    const response = await POST(publishRequest(), context());
    expect(response.status).toBe(400);

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
    });
    expect(row.publishedAt).toBeNull();
  });
});

/**
 * ugcportal-3ae K1, K2 and K4, against the same real database.
 *
 * The mocked route tests next door already assert the status code and the
 * blocker. What a mock cannot say is what K1 and K4 are actually about: that
 * the `publishedAt` COLUMN in storage is unchanged by a refused publish, and
 * that nothing anywhere grants publishability to a row that predates this
 * change.
 */
describe("publishing requires the uploader's declaration, against a real database (ugcportal-3ae K1)", () => {
  it("refuses with 422 and leaves publishedAt null in the database", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({ altText: ALT_TEXT, attested: false });

    const response = await POST(publishRequest(), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("attestation_missing");

    const row = await prisma.media.findUniqueOrThrow({ where: { id: MEDIA_ID } });
    expect(row.publishedAt).toBeNull();
  });

  it("publishes and persists publishedAt once the declaration is there", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({ altText: ALT_TEXT, attested: true });

    const response = await POST(publishRequest(), context());
    expect(response.status).toBe(200);

    const row = await prisma.media.findUniqueOrThrow({ where: { id: MEDIA_ID } });
    expect(row.publishedAt).not.toBeNull();
  });
});

describe("the PEOPLE clearance, against a real database (ugcportal-3ae K2)", () => {
  it("refuses on `people_uncleared` and leaves the column null", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({
      altText: ALT_TEXT,
      showsIdentifiablePeople: true,
    });

    const response = await POST(publishRequest(), context());
    const body = await response.json();

    expect(response.status).toBe(422);
    // By NAME. "Refused" alone would also be satisfied by the attestation
    // check firing, which is a different failure with a different fix.
    expect(body.blocker).toBe("people_uncleared");

    const row = await prisma.media.findUniqueOrThrow({ where: { id: MEDIA_ID } });
    expect(row.publishedAt).toBeNull();
  });

  it("publishes the same upload once a real PEOPLE clearance row exists", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({
      altText: ALT_TEXT,
      showsIdentifiablePeople: true,
      depictsPeople: true,
      peopleCleared: true,
    });

    const response = await POST(publishRequest(), context());
    expect(response.status).toBe(200);

    const row = await prisma.media.findUniqueOrThrow({ where: { id: MEDIA_ID } });
    expect(row.publishedAt).not.toBeNull();
  });
});

describe("no retroactive grant to rows that predate this change (ugcportal-3ae K4)", () => {
  it("leaves a pre-existing published row with no attestation exactly as it was — unbackfilled", async () => {
    /*
     * The migration half of K4, as a claim about the database rather than
     * about a diff: the row this bead's gate would refuse is one that was
     * ALREADY published, and nothing — no migration, no default, no
     * backfill — may hand it a declaration it never made. If something did,
     * `attestation` here would be non-null and the publish below would
     * answer 200.
     *
     * This bead adds no migration at all; `MediaAttestation` and
     * `MediaRightsClearance` both predate it (ugcportal-15r, ugcportal-qn3).
     * That is exactly why this is worth asserting rather than assuming: "no
     * migration" is only a guarantee of "no retroactive grant" while nobody
     * adds one, and this fails the day somebody does.
     */
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    await seedPublishableMedia({
      altText: ALT_TEXT,
      attested: false,
      published: true,
    });

    const before = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      include: { attestation: true },
    });
    expect(before.publishedAt).not.toBeNull();
    expect(before.attestation).toBeNull();

    const response = await POST(publishRequest(), context());
    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("attestation_missing");

    const after = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      include: { attestation: true },
    });
    // Still no declaration, and the original timestamp untouched: refusing
    // a publish must not quietly unpublish either.
    expect(after.attestation).toBeNull();
    expect(after.publishedAt).toEqual(before.publishedAt);
  });
});
