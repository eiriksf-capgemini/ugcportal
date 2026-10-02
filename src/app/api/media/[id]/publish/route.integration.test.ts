import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
const MEDIA_ID = "media-gwr-k1";

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: OWNER_ID, email: "owner-gwr-k1@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

afterEach(async () => {
  await prisma.media.deleteMany({});
  authMock.mockReset();
});

async function seedPublishableMedia(overrides: { altText?: string | null } = {}) {
  return prisma.media.create({
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
      altText: overrides.altText ?? null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt: null,
    },
  });
}

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
