import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import {
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  attestationFormParts,
} from "@/lib/attestation";
import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { FIXTURE_CLEARANCE_SCOPE } from "@/lib/test-support/resale-rights";

/**
 * ugcportal-ho7j K2, K3, K6, K7 and K8, against a REAL database: the real
 * migrations, the real upload route, the real watermark pipeline, and the
 * real public feed (GET /api/public/media) read on the next request.
 *
 * What is faked: the session (`auth`) and object storage (`getS3Client`),
 * neither of which these criteria are about. src/app/api/media/route.test.ts
 * covers the same branches against a mocked client, where the write set and
 * the transaction can be asserted call by call; this file is for the claims
 * a mock cannot make — what is actually stored, and what the public site
 * actually serves.
 */

// Real image work: every image upload below runs the real watermark
// pipeline (sharp/libvips), the same inherent cost as route.test.ts, so each
// describe declares an explicit timeout rather than relying on the default.
const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

// The configured row below carries the fixture handle "fixture-handle", which
// is configured only while the checked array derives it (ugcportal-lskg):
// append the fixture person to the real CONFIGURED_USERS rather than seed a
// real name.
vi.mock("@/config/users", async (importOriginal) => {
  const { withFixtureConfiguredUser } = await import(
    "@/lib/test-support/fixture-configured-user"
  );
  return withFixtureConfiguredUser(await importOriginal());
});

vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...actual,
    getS3Client: () => ({ send: vi.fn(async () => ({})) }),
    getBucketName: () => "test-bucket",
  };
});

const { POST } = await import("@/app/api/media/route");
const { GET: publicGET } = await import("@/app/api/public/media/route");
const { evaluateSellability, MEDIA_GATE_SELECT } = await import(
  "@/lib/resale-rights"
);
const { FORMER_CONFIGURED_HANDLE } = await import(
  "@/lib/test-support/fixture-configured-user"
);

/**
 * A configured person: a `configuredHandle` the checked array derives (the
 * fixture person the `@/config/users` mock appends), as configured-user-link
 * leaves them.
 */
const CONFIGURED = "configured-ho7j";
/** Somebody allowed to sign in who is not one of the configured people. */
const ORDINARY = "ordinary-ho7j";
const ADMIN = "admin-ho7j";
/**
 * Somebody REMOVED from the array after signing in (ugcportal-lskg): their
 * row still carries a handle — nothing clears the column — but no person in
 * the checked CONFIGURED_USERS derives it any more.
 */
const FORMER = "former-lskg";

const ALT_TEXT = "A fox crossing a snowy field at dawn";

const REAL_PNG = await sharp({
  create: { width: 320, height: 240, channels: 3, background: { r: 40, g: 90, b: 110 } },
})
  .png()
  .toBuffer();

// ISO base media container: an `ftyp` box at offset 4 is what sniffKind
// looks for. Videos get no watermarked preview yet (ugcportal-pmb).
const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypmp42", "ascii"),
]);

function attestation(authorship: MediaAuthorship): [string, string][] {
  return attestationFormParts({
    version: CURRENT_ATTESTATION_VERSION,
    answers: {
      authorship,
      ...Object.fromEntries(
        ATTESTATION_QUESTIONS.map(({ field }) => [field, field === "uploaderIsAdult"]),
      ),
    } as Parameters<typeof attestationFormParts>[0]["answers"],
  });
}

function upload(
  file: File,
  { attestationParts = [] as [string, string][], altText = ALT_TEXT } = {},
) {
  const form = new FormData();
  form.set("file", file);
  form.set("altText", altText);
  for (const [name, value] of attestationParts) form.append(name, value);
  return POST(new Request("http://localhost/api/media", { method: "POST", body: form }));
}

const image = () => new File([REAL_PNG], "fox.png", { type: "image/png" });
const video = () => new File([MP4_HEADER], "clip.mp4", { type: "video/mp4" });

function signedInAs(userId: string) {
  authMock.mockResolvedValue({ user: { id: userId, role: "USER" } });
}

/** The previewIds GET /api/public/media serves, read fresh. */
async function publicPreviewIds(): Promise<string[]> {
  const response = await publicGET(new Request("http://localhost/api/public/media"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { previewId: string }[] };
  return body.items.map((item) => item.previewId);
}

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset();
  await prisma.resaleRightsReview.deleteMany({});
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.createMany({
    data: [
      // Not ADMIN on purpose: auto-publish does not ask the operator
      // question, so a configured person who is an ordinary USER still
      // publishes. This proves the role is not what decides.
      {
        id: CONFIGURED,
        email: "configured-ho7j@example.com",
        role: "USER",
        configuredHandle: "fixture-handle",
      },
      { id: ORDINARY, email: "ordinary-ho7j@example.com", role: "USER" },
      { id: ADMIN, email: "admin-ho7j@example.com", role: "ADMIN" },
      {
        id: FORMER,
        email: "former-lskg@example.com",
        role: "USER",
        configuredHandle: FORMER_CONFIGURED_HANDLE,
      },
    ],
  });
});

describe("a configured uploader's image publishes on upload (ugcportal-ho7j K2)", { timeout: 15_000 }, () => {
  it("201, publishedAt set, previewId minted, no attestation row, and on the public feed", async () => {
    signedInAs(CONFIGURED);
    // Presence measured on the same reader first, so the listing below is a
    // change and not a feed that serves everything.
    expect(await publicPreviewIds()).toEqual([]);

    const response = await upload(image());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.publishRefusal).toBeNull();
    expect(typeof body.publishedAt).toBe("string");

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: body.id },
      include: { attestation: true },
    });
    // Fails if publishedAt is left null.
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.previewId).toEqual(expect.any(String));
    expect(row.previewKey).toEqual(expect.any(String));
    expect(row.attestation).toBeNull();
    expect(await prisma.mediaAttestation.count()).toBe(0);

    expect(await publicPreviewIds()).toEqual([row.previewId]);
  });

  it("stays unsellable: attestation_missing, configured or not (K8)", async () => {
    /*
     * K8's new assertion. src/lib/resale-rights.test.ts is untouched by this
     * bead, and still asserts that `attestation_missing` refuses sale; this
     * is the same gate over a real auto-published row. The uploader is given
     * a CLEARED standing review so that the gate gets as far as the
     * declaration (step 6) rather than stopping at `no_review` — if the
     * configured exemption had leaked into `evaluateSellability`, the answer
     * here would move on to `not_listed_for_sale`.
     */
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: CONFIGURED,
        status: "CLEARED",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        ...FIXTURE_CLEARANCE_SCOPE,
        reviewedByUserId: ADMIN,
        reviewedAt: new Date("2026-02-01T00:00:00.000Z"),
        validUntil: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    signedInAs(CONFIGURED);
    const body = await (await upload(image())).json();

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: body.id },
      select: { ...MEDIA_GATE_SELECT, publishedAt: true },
    });
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(evaluateSellability(row)).toEqual({
      sellable: false,
      blocker: "attestation_missing",
    });
  });
});

describe("a configured uploader's upload with no watermarked preview stays private (ugcportal-ho7j K3, K7)", { timeout: 15_000 }, () => {
  it("stores a VIDEO unpublished, with the preview blocker in the 201, off the public feed", async () => {
    signedInAs(CONFIGURED);

    const response = await upload(video());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.publishedAt).toBeNull();
    expect(body.publishRefusal).toEqual({
      error: "This item has no watermarked preview yet, so it cannot be published.",
    });
    const row = await prisma.media.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.publishedAt).toBeNull();
    expect(row.previewKey).toBeNull();
    expect(await publicPreviewIds()).toEqual([]);
  });
});

describe("a configured uploader who DOES answer is held to the answer (ugcportal-ho7j K7)", { timeout: 15_000 }, () => {
  it("a NEITHER-authorship declaration: stored, unpublished, blocker in the body, not public", async () => {
    signedInAs(CONFIGURED);

    const response = await upload(image(), {
      attestationParts: attestation(MediaAuthorship.NEITHER),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.publishedAt).toBeNull();
    expect(body.publishRefusal).toMatchObject({
      blocker: "attestation_rights_disclaimed",
    });
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: body.id },
      include: { attestation: true },
    });
    expect(row.publishedAt).toBeNull();
    expect(row.attestation?.authorship).toBe(MediaAuthorship.NEITHER);
    expect(await publicPreviewIds()).toEqual([]);
  });

  it("a clean declaration from a configured uploader publishes as well", async () => {
    signedInAs(CONFIGURED);

    const body = await (
      await upload(image(), { attestationParts: attestation(MediaAuthorship.AUTHOR) })
    ).json();

    expect(body.publishRefusal).toBeNull();
    const row = await prisma.media.findUniqueOrThrow({ where: { id: body.id } });
    expect(await publicPreviewIds()).toEqual([row.previewId]);
  });
});

describe("an upload by anybody else is never published automatically (ugcportal-ho7j K6)", { timeout: 15_000 }, () => {
  it("without attestation fields: 400, and no Media row", async () => {
    signedInAs(ORDINARY);

    const response = await upload(image());

    expect(response.status).toBe(400);
    expect(await prisma.media.count()).toBe(0);
  });

  it("with a complete attestation: 201, publishedAt null, and not on the public feed", async () => {
    signedInAs(ORDINARY);

    const response = await upload(image(), {
      attestationParts: attestation(MediaAuthorship.AUTHOR),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.publishedAt).toBeNull();
    // The ordinary uploader's body is unchanged by this bead: no new key.
    expect(body).not.toHaveProperty("publishRefusal");
    const row = await prisma.media.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.publishedAt).toBeNull();
    expect(await publicPreviewIds()).toEqual([]);
  });

  it("an ADMIN who is not configured is not auto-published either", async () => {
    // Auto-publish is decided by the configured handle, not by role.
    authMock.mockResolvedValue({ user: { id: ADMIN, role: "ADMIN" } });

    const body = await (
      await upload(image(), { attestationParts: attestation(MediaAuthorship.AUTHOR) })
    ).json();

    expect(body.publishedAt).toBeNull();
    expect(await publicPreviewIds()).toEqual([]);
  });
});

describe("a person removed from CONFIGURED_USERS is not configured, whatever their row says (ugcportal-lskg K1)", { timeout: 15_000 }, () => {
  it("the stale handle really is on the row, and really is not in the checked list", async () => {
    // Both halves of the premise measured, so the two cases below cannot
    // pass because the seed silently lost the handle (that row would be an
    // ORDINARY uploader, and pass for the wrong reason).
    const { CURRENT_CONFIGURED_HANDLES } = await import("@/lib/sign-in-policy");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: FORMER } });
    expect(row.configuredHandle).toBe(FORMER_CONFIGURED_HANDLE);
    expect(CURRENT_CONFIGURED_HANDLES).not.toContain(FORMER_CONFIGURED_HANDLE);
  });

  it("without attestation fields: 400, and no Media row — exactly the non-configured answer", async () => {
    signedInAs(FORMER);

    const response = await upload(image());

    expect(response.status).toBe(400);
    expect(await prisma.media.count()).toBe(0);
  });

  it("with a complete attestation: 201, publishedAt null, no publishRefusal key, not on the public feed", async () => {
    signedInAs(FORMER);

    const response = await upload(image(), {
      attestationParts: attestation(MediaAuthorship.AUTHOR),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.publishedAt).toBeNull();
    // The configured path always carries `publishRefusal` (null or a
    // blocker); the ordinary path never does. Its absence is what says
    // which branch the route took.
    expect(body).not.toHaveProperty("publishRefusal");
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: body.id },
      include: { attestation: true },
    });
    expect(row.publishedAt).toBeNull();
    expect(row.attestation?.authorship).toBe(MediaAuthorship.AUTHOR);
    expect(await publicPreviewIds()).toEqual([]);
  });
});
