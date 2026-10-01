import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * The altText/caption backfill migration
 * (prisma/migrations/20261001150000_add_media_alt_text_caption), against a
 * REAL database rather than asserting on the SQL file's text.
 *
 * Review round 4 found a real regression in this migration's first version:
 * it stamped the identical literal string onto every pre-existing row,
 * which — because real (non-empty) altText is rendered VERBATIM with no
 * per-position disambiguation (see galleryItemAlt's own docstring in
 * gallery-items.ts) — collapsed every pre-existing photograph's accessible
 * name onto one indistinguishable string, reintroducing the exact
 * same-day-batch collision bug this codebase had already fixed once before
 * this bead existed. This file seeds rows the way they would have existed
 * BEFORE this migration ever ran, applies only this migration, and checks
 * the backfilled values directly — the SQL file's own comments are not
 * evidence that the UPDATE actually behaves as claimed.
 */

const MIGRATION_NAME = "20261001150000_add_media_alt_text_caption";

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

beforeAll(async () => {
  // Stop one migration short, so Media has no altText/caption column yet —
  // the real "before this bead" state.
  await applyMigrations(prisma, { stopBefore: MIGRATION_NAME });

  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "createdAt", "updatedAt")
     VALUES ('user-backfill', 'owner@example.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  // Two pre-existing rows, inserted the way POST /api/media always has —
  // no altText/caption column exists yet at this point in migration history.
  for (const id of ["media-a", "media-b"]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Media"
         ("id", "userId", "kind", "key", "previewKey", "previewId",
          "mimeType", "sizeBytes", "originalName", "createdAt", "publishedAt")
       VALUES
         ('${id}', 'user-backfill', 'IMAGE', 'media/user-backfill/${id}.png',
          'previews/user-backfill/${id}.webp', 'preview-${id}',
          'image/png', 1024, '${id}.png', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
  }

  // Now run the migration under test, and only it.
  await applyMigration(prisma, MIGRATION_NAME);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("the altText backfill (review round 4, finding 3)", () => {
  it("gives every pre-existing row a non-null, non-blank altText", async () => {
    const rows = await prisma.media.findMany({
      where: { id: { in: ["media-a", "media-b"] } },
      select: { id: true, altText: true },
    });
    for (const row of rows) {
      expect(row.altText).not.toBeNull();
      expect(row.altText?.trim()).not.toBe("");
    }
  });

  it("gives DIFFERENT rows DIFFERENT backfilled altText — the regression this test exists for", async () => {
    const a = await prisma.media.findUniqueOrThrow({
      where: { id: "media-a" },
      select: { altText: true },
    });
    const b = await prisma.media.findUniqueOrThrow({
      where: { id: "media-b" },
      select: { altText: true },
    });
    // Real (non-empty) altText is rendered verbatim with no per-position
    // disambiguation (galleryItemAlt). If this backfill ever stamps the
    // same literal string on every row again, every pre-existing
    // photograph's accessible name collapses onto one indistinguishable
    // string — exactly the bug this assertion exists to catch.
    expect(a.altText).not.toBe(b.altText);
  });

  it("never backfills alt text equal to the row's own filename (K2)", async () => {
    const rows = await prisma.media.findMany({
      where: { id: { in: ["media-a", "media-b"] } },
      select: { id: true, altText: true, originalName: true },
    });
    for (const row of rows) {
      expect(row.altText).not.toBe(row.originalName);
    }
  });
});
