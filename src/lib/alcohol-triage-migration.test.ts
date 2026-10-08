import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CURRENT_CHECKLIST_VERSION,
  MEDIA_GATE_SELECT,
  TRIAGE_FACTS,
  evaluateSellability,
} from "@/lib/resale-rights";
import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
  migrationNames,
} from "@/lib/test-support/db";
import { completeAttestationRow } from "@/lib/test-support/attestation";

/**
 * ugcportal-qnq9.3, against a real database rather than a reading of the
 * SQL: the migration that adds `MediaListing.depictsAlcohol` must leave
 * every listing that already existed BLOCKED, not quietly asserted to show
 * no alcohol.
 *
 * This is the one thing about the change a unit test on the gate cannot
 * cover, because it is a property of the DDL. `ADD COLUMN "depictsAlcohol"
 * BOOLEAN` backfills NULL, which the gate reads as "not triaged";
 * `ADD COLUMN ... BOOLEAN DEFAULT 0` — the version a later hand could write
 * to clear a screen full of blocked uploads — backfills false, which is the
 * system asserting, about every upload anyone has ever listed, that no
 * alcohol is visible in it. No human made that assertion, and on this
 * question being wrong means an item with a price beside a glass of wine:
 * alcohol appearing in advertising for another product, which is what
 * alkoholloven § 9-2 forbids (docs/ugc-research.md §3.1a).
 *
 * So the fixture is a listing that was FULLY SELLABLE before the migration
 * — cleared uploader, every other fact answered, triage signed by a current
 * admin — and the test asserts it stops being sellable, and starts again
 * only once someone answers the new question with a `no`.
 *
 * Seeded through raw SQL because the generated Prisma client only knows the
 * schema as it is now: it would insist on writing the very column this
 * fixture must not have.
 */

const ALCOHOL_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_alcohol_triage_fact"),
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
  // Derived rather than hard-coded, but still asserted: a renamed migration
  // must fail loudly instead of silently applying everything and proving
  // nothing.
  expect(ALCOHOL_MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: ALCOHOL_MIGRATION! });

  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('admin-1','admin@example.com','ADMIN',0,0),
            ('owner-1','owner@example.com','USER',0,0)`,
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-1','owner-1','IMAGE','uploads/owner-1/glass.jpg','image/jpeg',10,'glass.jpg',0)`,
    `INSERT INTO "ResaleRightsReview"
       ("id","uploaderUserId","status","route","checklistVersion","reviewedByUserId","reviewedAt","validUntil","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','owner-1','CLEARED','CONTRACT','${CURRENT_CHECKLIST_VERSION}','admin-1',0,NULL,'ugcportal-2eh',0,0)`,
    // Every triage question that existed before this migration, answered
    // "no", and signed by a current admin. Nothing else is blocking — so
    // the block this file measures can only be the new question.
    `INSERT INTO "MediaListing"
       ("id","mediaId","priceCents","currency","depictsPeople","depictsMinors","containsMusic","thirdPartyCreator","sponsoredContent","triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('listing-1','media-1',24900,'NOK',0,0,0,0,0,'admin-1',0,0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, ALCOHOL_MIGRATION!);
  // Anything committed after this migration, so the generated client can
  // read the database at all. No longer a no-op, which is the case this
  // comment used to anticipate: 20261006170000 adds `wineAccessory`, and it
  // arrives NULL on this fixture for exactly the reason `depictsAlcohol`
  // does.
  await applyMigrations(prisma, { startAfter: ALCOHOL_MIGRATION! });

  /*
   * The uploader's own rights attestation (ugcportal-15r), which the gate
   * started requiring in 20261008200000 — after the migration under test, so
   * the catch-up above is what brought the table. Seeded here because every
   * case below is about the ONE question the migration under test added: an
   * upload with no attestation blocks on `attestation_missing` before the
   * gate ever reaches the triage, which would make "blocks until answered"
   * pass whether or not that migration did anything.
   *
   * Written through the generated client rather than as raw SQL, unlike the
   * seed above: that one had to predate the migration under test, this one
   * runs after every migration has been applied.
   */
  await prisma.mediaAttestation.create({
    data: completeAttestationRow("media-1", "owner-1"),
  });

  // So every OTHER registered fact is answered `no` here, leaving
  // `depictsAlcohol` the only unanswered question in the row. Without this,
  // `triage_incomplete` below would be true whether or not the migration
  // under test had added anything — overdetermined, and passing for the
  // wrong reason, which is how it actually failed when qnq9.3's second half
  // landed. Answered here rather than in the seed because the later columns
  // do not exist until the catch-up above runs; derived from TRIAGE_FACTS
  // rather than listed, the same way minors-triage-migration.test.ts does
  // it, so the fact after this one needs no edit either. The case named
  // "leaves no other triage question unanswered" checks it rather than
  // taking this comment's word for it.
  await prisma.mediaListing.update({
    where: { id: "listing-1" },
    data: Object.fromEntries(
      TRIAGE_FACTS.filter((fact) => fact.field !== "depictsAlcohol").map(
        (fact) => [fact.field, false],
      ),
    ),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-qnq9.3: adding the alcohol fact to an existing database", () => {
  it("backfills NULL rather than a `no`, so the column has no default", async () => {
    // The DDL itself, not just its effect on one row: a DEFAULT added later
    // would make every FUTURE insert answer the question too, which the
    // row-level assertions below would not notice.
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("MediaListing")`);

    const column = columns.find((row) => row.name === "depictsAlcohol");
    expect(column).toBeTruthy();
    expect(column!.dflt_value).toBeNull();
    expect(column!.notnull).toBe(0);
  });

  it("leaves the existing listing's answer unanswered", async () => {
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
      select: { depictsAlcohol: true, depictsPeople: true, priceCents: true },
    });

    expect(listing.depictsAlcohol).toBeNull();
    // The rest of the row survived the migration, which is what makes the
    // blocked result below about the new question and not about the ALTER
    // TABLE having damaged the listing.
    expect(listing.depictsPeople).toBe(false);
    expect(listing.priceCents).toBe(24900);
  });

  it("leaves no other triage question unanswered", async () => {
    // The premise every case below rests on: they attribute the block to
    // `depictsAlcohol`, which only holds while it is the one fact with no
    // answer. A later migration adding a further triage fact would
    // otherwise make this file pass for its own reason. Written without a
    // count on purpose: an ordinal here is a number that goes stale the
    // next time the registry grows, which is exactly when this comment is
    // read.
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
    });

    for (const fact of TRIAGE_FACTS) {
      expect(
        listing[fact.field],
        `${fact.field} is not answered as expected`,
      ).toBe(fact.field === "depictsAlcohol" ? null : false);
    }
  });

  it("blocks an upload that was sellable until the question existed", async () => {
    expect(evaluateSellability(await gateUpload())).toEqual({
      sellable: false,
      blocker: "triage_incomplete",
    });
  });

  it("sells again once an admin answers `no`, and only then", async () => {
    // The other half of the same claim. Without this the case above would
    // pass against a migration that had broken the listing outright —
    // dropped the triage, detached the review — rather than one that added
    // exactly one unanswered question. It is also ugcportal-qnq9.3's K1 at
    // the database level: an empty glass is an accessory, and answering
    // this question `no` is what keeps it sellable.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsAlcohol: false },
    });

    expect(evaluateSellability(await gateUpload())).toEqual({ sellable: true });

    // Back to unanswered, so this case leaves no row behind that a later
    // one in this process could read as triaged.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsAlcohol: null },
    });
    expect(evaluateSellability(await gateUpload()).sellable).toBe(false);
  });

  it("refuses a `yes` even with an ALCOHOL clearance recorded", async () => {
    // The enum gained a value and the migration emits no DDL for it (Prisma
    // maps enums to TEXT on SQLite). That is a claim about the database, so
    // it is asked of the database — and the answer here is the opposite of
    // the MINORS case: the value is writable to MediaRightsClearance.layer,
    // and writing it changes nothing, because the gate registers this fact
    // as settled by nothing and never looks for a clearance.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsAlcohol: true },
    });
    await prisma.mediaRightsClearance.create({
      data: {
        id: "clearance-alcohol-1",
        listingId: "listing-1",
        layer: "ALCOHOL",
        reason: "It was grape juice, shot to look like wine.",
        clearedByUserId: "admin-1",
      },
    });

    expect(evaluateSellability(await gateUpload())).toEqual({
      sellable: false,
      blocker: "alcohol_depicted",
    });

    // The clearance really is on the row — so the refusal above is the gate
    // declining to consult it, not a write that silently failed.
    expect(
      await prisma.mediaRightsClearance.findUniqueOrThrow({
        where: { id: "clearance-alcohol-1" },
        select: { layer: true },
      }),
    ).toEqual({ layer: "ALCOHOL" });
  });
});
