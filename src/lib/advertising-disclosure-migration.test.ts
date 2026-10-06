import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * The advertising-disclosure migration
 * (prisma/migrations/20261006150000_add_advertising_disclosure), against a
 * REAL database rather than asserting on the SQL file's text.
 *
 * Three claims that file makes about itself, none of which its own comments
 * are evidence for:
 *
 *   1. It touches NO EXISTING ROW. A Media row that existed before it ran has
 *      no disclosure afterwards, is unchanged, and still publishes — the
 *      permissive-unanswered promise the publish gate depends on. The
 *      alt-text migration next door hit the mirror-image trap (a new gate
 *      blocking every pre-existing row) and had to add a backfill to escape
 *      it; this one escapes it by scoping the gate to the answered-yes case,
 *      so "it changes nothing" is the claim most worth checking.
 *   2. `benefitReceived` is genuinely NULLABLE with no default, which is what
 *      keeps "nobody has said" distinguishable from "somebody said no" and
 *      what would let ugcportal-qn3's null-blocks mechanism adopt it later.
 *      A `DEFAULT false` would be invisible through the Prisma client's own
 *      create call and visible only in a raw INSERT.
 *   3. The brand foreign key is ON DELETE RESTRICT, so deleting a brand
 *      cannot silently erase the source of a disclosed benefit.
 */

const MIGRATION_NAME = "20261006150000_add_advertising_disclosure";

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

beforeAll(async () => {
  // Stop one migration short: the disclosure tables do not exist yet, which
  // is the real "before this bead" state.
  await applyMigrations(prisma, { stopBefore: MIGRATION_NAME });

  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "createdAt", "updatedAt")
     VALUES ('user-pre-disclosure', 'owner@example.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Media"
       ("id", "userId", "kind", "key", "previewKey", "previewId",
        "mimeType", "sizeBytes", "originalName", "altText", "createdAt", "publishedAt")
     VALUES
       ('media-pre-disclosure', 'user-pre-disclosure', 'IMAGE',
        'media/user-pre-disclosure/a.png', 'previews/user-pre-disclosure/a.webp',
        'preview-pre-disclosure', 'image/png', 1024, 'a.png',
        'A photograph taken before this bead existed', CURRENT_TIMESTAMP, NULL)`,
  );

  await applyMigration(prisma, MIGRATION_NAME);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("what the migration does to rows that already existed", () => {
  it("leaves the pre-existing Media row with no disclosure at all", async () => {
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: "media-pre-disclosure" },
      select: { publishedAt: true, advertisingDisclosure: true },
    });

    // Unanswered, and therefore publishable — if this ever becomes a row,
    // every item that predates this bead inherits an answer nobody gave.
    expect(row.advertisingDisclosure).toBeNull();
    expect(row.publishedAt).toBeNull();
  });

  it("creates no disclosure rows and no brands", async () => {
    expect(await prisma.mediaAdvertisingDisclosure.count()).toBe(0);
    expect(await prisma.benefitSource.count()).toBe(0);
  });
});

describe("the columns the gate depends on", () => {
  it("stores benefitReceived as NULL when a raw INSERT omits it", async () => {
    // Through a RAW insert, deliberately: the Prisma client would send an
    // explicit NULL, so a `DEFAULT false` on the column would never show. A
    // default here would make every row ever created assert "no benefit was
    // received" — a statement about a commercial relationship that nobody
    // made — and would destroy the unanswered/answered-no distinction
    // ugcportal-qn3 would need.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MediaAdvertisingDisclosure" ("id", "mediaId", "updatedAt")
       VALUES ('disclosure-default-probe', 'media-pre-disclosure', CURRENT_TIMESTAMP)`,
    );

    const row = await prisma.mediaAdvertisingDisclosure.findUniqueOrThrow({
      where: { id: "disclosure-default-probe" },
      select: { benefitReceived: true, benefitKind: true, label: true },
    });

    expect(row.benefitReceived).toBeNull();
    expect(row.benefitKind).toBeNull();
    expect(row.label).toBeNull();

    await prisma.mediaAdvertisingDisclosure.delete({
      where: { id: "disclosure-default-probe" },
    });
  });

  it("allows at most one disclosure per item", async () => {
    await prisma.mediaAdvertisingDisclosure.create({
      data: { id: "disclosure-one", mediaId: "media-pre-disclosure" },
    });

    await expect(
      prisma.mediaAdvertisingDisclosure.create({
        data: { id: "disclosure-two", mediaId: "media-pre-disclosure" },
      }),
    ).rejects.toThrow();

    await prisma.mediaAdvertisingDisclosure.delete({
      where: { id: "disclosure-one" },
    });
  });

  it("refuses to delete a brand that a disclosure still names", async () => {
    await prisma.benefitSource.create({
      data: { id: "brand-restrict", slug: "riedel", name: "Riedel" },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        id: "disclosure-restrict",
        mediaId: "media-pre-disclosure",
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        benefitSourceId: "brand-restrict",
        label: "Advertisement / Reklame",
      },
    });

    await expect(
      prisma.benefitSource.delete({ where: { id: "brand-restrict" } }),
    ).rejects.toThrow();

    // And the disclosure still names it, rather than having been nulled out.
    const row = await prisma.mediaAdvertisingDisclosure.findUniqueOrThrow({
      where: { id: "disclosure-restrict" },
      select: { benefitSourceId: true },
    });
    expect(row.benefitSourceId).toBe("brand-restrict");
  });

  it("removes the disclosure when the item it describes is deleted", async () => {
    // The other half of the pair above: there is nothing left to disclose
    // once the item is gone, so this side cascades rather than restricting.
    await prisma.media.delete({ where: { id: "media-pre-disclosure" } });

    expect(await prisma.mediaAdvertisingDisclosure.count()).toBe(0);
    // The brand survives the item: it is vocabulary, not a property of one
    // photograph.
    expect(await prisma.benefitSource.count()).toBe(1);
  });
});
