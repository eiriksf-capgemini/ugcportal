import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CURRENT_CHECKLIST_VERSION,
  MEDIA_GATE_SELECT,
  evaluateSellability,
} from "@/lib/resale-rights";
import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
  migrationNames,
} from "@/lib/test-support/db";

/**
 * ugcportal-qn3 K2, against a real database rather than a reading of the
 * SQL: the migration that adds `MediaListing.depictsMinors` must leave
 * every listing that already existed BLOCKED, not quietly asserted to show
 * no children.
 *
 * This is the one thing about the change that a unit test on the gate
 * cannot cover, because it is a property of the DDL. `ADD COLUMN
 * "depictsMinors" BOOLEAN` backfills NULL, which the gate reads as "not
 * triaged"; `ADD COLUMN ... BOOLEAN DEFAULT 0` — the version a later hand
 * could write to "fix" a screen full of blocked uploads — backfills false,
 * which is the system asserting, about every upload anyone has ever
 * listed, that no minor is shown in it. No human made that assertion, and
 * on this particular question the consequence of being wrong is selling a
 * photograph of a child without the guardian consent Datatilsynet requires
 * (docs/legal/manual-upload-rights-review.md § 3.5).
 *
 * So the fixture is a listing that was FULLY SELLABLE before the migration
 * — cleared uploader, every other fact answered, triage signed by a
 * current admin — and the test asserts it stops being sellable and starts
 * again only once someone answers the new question.
 *
 * Seeded through raw SQL because the generated Prisma client only knows
 * the schema as it is now: it would insist on writing the very column this
 * fixture must not have.
 */

const MINORS_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_minors_triage_fact"),
);

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

/** The listing under test, as the gate sees it. */
async function gateUpload() {
  return prisma.media.findUniqueOrThrow({
    where: { id: "media-1" },
    select: MEDIA_GATE_SELECT,
  });
}

beforeAll(async () => {
  // Derived rather than hard-coded, but still asserted: a renamed
  // migration must fail loudly instead of silently applying everything and
  // proving nothing.
  expect(MINORS_MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: MINORS_MIGRATION! });

  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('admin-1','admin@example.com','ADMIN',0,0),
            ('owner-1','owner@example.com','USER',0,0)`,
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-1','owner-1','IMAGE','uploads/owner-1/a.jpg','image/jpeg',10,'a.jpg',0)`,
    `INSERT INTO "ResaleRightsReview"
       ("id","uploaderUserId","status","route","checklistVersion","reviewedByUserId","reviewedAt","validUntil","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','owner-1','CLEARED','CONTRACT','${CURRENT_CHECKLIST_VERSION}','admin-1',0,NULL,'ugcportal-2eh',0,0)`,
    // Every triage question that existed before this migration, answered
    // "no", and signed by a current admin. Nothing else is blocking.
    `INSERT INTO "MediaListing"
       ("id","mediaId","priceCents","currency","depictsPeople","containsMusic","thirdPartyCreator","sponsoredContent","triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('listing-1','media-1',24900,'NOK',0,0,0,0,'admin-1',0,0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, MINORS_MIGRATION!);
  // Anything committed after this migration, so the generated client can
  // read the database at all. A no-op while this is the newest migration;
  // it is here so the next one does not break this file in a way that
  // looks like a defect in the migration under test.
  await applyMigrations(prisma, { startAfter: MINORS_MIGRATION! });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-qn3: adding the minors fact to an existing database", () => {
  it("backfills NULL rather than a `no`, so the column has no default", async () => {
    // The DDL itself, not just its effect on one row: a DEFAULT added
    // later would make every FUTURE insert answer the question too, which
    // the row-level assertions below would not notice.
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("MediaListing")`);

    const column = columns.find((row) => row.name === "depictsMinors");
    expect(column).toBeTruthy();
    expect(column!.dflt_value).toBeNull();
    expect(column!.notnull).toBe(0);
  });

  it("leaves the existing listing's answer unanswered", async () => {
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
      select: { depictsMinors: true, depictsPeople: true },
    });

    expect(listing.depictsMinors).toBeNull();
    // The rest of the triage survived the migration, which is what makes
    // the blocked result below about the new question and not about the
    // ALTER TABLE having damaged the row.
    expect(listing.depictsPeople).toBe(false);
  });

  it("blocks an upload that was sellable until the question existed", async () => {
    expect(evaluateSellability(await gateUpload())).toEqual({
      sellable: false,
      blocker: "triage_incomplete",
    });
  });

  it("sells again once an admin answers it, and only then", async () => {
    // The other half of the same claim. Without this the test above would
    // pass against a migration that had broken the listing outright —
    // dropped the triage, detached the review — rather than one that added
    // exactly one unanswered question.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsMinors: false },
    });

    expect(evaluateSellability(await gateUpload())).toEqual({ sellable: true });

    // Back to unanswered, so the file leaves no row behind that a later
    // test in this process could read as triaged.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsMinors: null },
    });
    expect(evaluateSellability(await gateUpload()).sellable).toBe(false);
  });

  it("accepts a MINORS clearance on the existing clearance table", async () => {
    // The enum gained a value and the migration emits no DDL for it
    // (Prisma maps enums to TEXT on SQLite). That is a claim about the
    // database, so it is asked of the database: the value has to be
    // writable to MediaRightsClearance.layer, and readable back, against a
    // table this migration did not touch.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsMinors: true },
    });
    await prisma.mediaRightsClearance.create({
      data: {
        id: "clearance-minors-1",
        listingId: "listing-1",
        layer: "MINORS",
        reason: "Guardian consent on file, naming online commercial use.",
        clearedByUserId: "admin-1",
      },
    });

    expect(evaluateSellability(await gateUpload())).toEqual({ sellable: true });
  });
});
