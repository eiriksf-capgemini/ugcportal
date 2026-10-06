import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { alcoholLinkedBrandRefusal } from "@/lib/alcohol-commerce";
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

/**
 * ugcportal-qnq9.3's second migration, against a real database rather than a
 * reading of the SQL.
 *
 * It makes three claims its own comments are not evidence for:
 *
 *   1. `MediaListing.wineAccessory` BACKFILLS NULL, so every listing that
 *      already existed is untriaged and blocked rather than asserted to be
 *      ordinary content. A `DEFAULT 0` here would not assert anything
 *      dangerous — "not an accessory" permits nothing — but it would destroy
 *      the distinction between an item nobody has classified and one somebody
 *      classified, which is the whole of ugcportal-qn3's mechanism.
 *   2. `BenefitSource.alcoholLinked` BACKFILLS NULL, and NULL REFUSES. This
 *      is the one where a default would be the fail-open direction outright:
 *      `DEFAULT 0` would read as "no brand anyone has ever named sells
 *      alcohol", on the single question §3.1a says to ask before taking money.
 *   3. THE TABLE REDEFINE CARRIES EVERY EXISTING BRAND ACROSS INTACT. SQLite
 *      cannot add a column with a foreign key in place, so the migration
 *      drops and recreates BenefitSource. That is a destructive-looking shape
 *      on a table whose rows are referenced by a compliance record, and the
 *      disclosure's own ON DELETE RESTRICT is declared on a table this
 *      migration does not touch — so whether it survives the rename is a
 *      question about SQLite, and it is asked of SQLite below.
 *
 * Seeded through raw SQL because the generated Prisma client only knows the
 * schema as it is now: it would insist on writing the very columns this
 * fixture must not have.
 */

const MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_wine_accessory_fact_and_brand_alcohol_check"),
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
  expect(MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: MIGRATION! });

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
    // "no", and signed by a current admin. Nothing else is blocking — so the
    // block this file measures can only be the new question.
    `INSERT INTO "MediaListing"
       ("id","mediaId","priceCents","currency","depictsPeople","depictsMinors","containsMusic","thirdPartyCreator","sponsoredContent","depictsAlcohol","triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('listing-1','media-1',24900,'NOK',0,0,0,0,0,0,'admin-1',0,0,0)`,
    // A brand named before anyone thought to ask about alcohol, and the
    // disclosure that names it. Both are what claim 3 is about.
    `INSERT INTO "BenefitSource" ("id","slug","name","createdAt","updatedAt")
     VALUES ('brand-1','riedel','Riedel',0,0)`,
    `INSERT INTO "MediaAdvertisingDisclosure"
       ("id","mediaId","benefitReceived","benefitKind","benefitSourceId","marketValueOre","label","createdAt","updatedAt")
     VALUES ('disc-1','media-1',1,'FREE_PRODUCT','brand-1',49900,'Advertisement / Reklame',0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, MIGRATION!);
  // Anything committed after this migration, so the generated client can read
  // the database at all. A no-op while this is the newest migration; it is
  // here so the next one does not break this file in a way that looks like a
  // defect in the migration under test. "leaves no other triage question
  // unanswered" below is what keeps that catch-up honest — it failed exactly
  // that way in alcohol-triage-migration.test.ts when this migration landed.
  await applyMigrations(prisma, { startAfter: MIGRATION! });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-qnq9.3: adding the wine-accessory fact to an existing database", () => {
  it("backfills NULL rather than a `no`, so the column has no default", async () => {
    // The DDL itself, not just its effect on one row: a DEFAULT added later
    // would make every FUTURE insert answer the question too, which the
    // row-level assertions below would not notice.
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("MediaListing")`);

    const column = columns.find((row) => row.name === "wineAccessory");
    expect(column).toBeTruthy();
    expect(column!.dflt_value).toBeNull();
    expect(column!.notnull).toBe(0);
  });

  it("leaves the existing listing's answer unanswered, and the rest of the row alone", async () => {
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
      select: { wineAccessory: true, depictsAlcohol: true, priceCents: true },
    });

    expect(listing.wineAccessory).toBeNull();
    // The rest survived, which is what makes the blocked result below about
    // the new question rather than about the ALTER TABLE having damaged the
    // listing.
    expect(listing.depictsAlcohol).toBe(false);
    expect(listing.priceCents).toBe(24900);
  });

  it("leaves no other triage question unanswered", async () => {
    // The premise every case below rests on: they attribute the block to
    // `wineAccessory`, which only holds while it is the one fact with no
    // answer.
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
    });

    for (const fact of TRIAGE_FACTS) {
      expect(
        listing[fact.field],
        `${fact.field} is not answered as expected`,
      ).toBe(fact.field === "wineAccessory" ? null : false);
    }
  });

  it("blocks an upload that was sellable until the question existed", async () => {
    expect(evaluateSellability(await gateUpload())).toEqual({
      sellable: false,
      blocker: "triage_incomplete",
    });
  });

  it("sells again on EITHER answer, and only once one is given", async () => {
    // The other half of the same claim, and the one place this fact differs
    // from every other triage column: both answers sell. `true` is K1 at the
    // database level — the empty glass is an accessory and an accessory is
    // monetisable — and `false` is ordinary content. Without this the case
    // above would pass against a migration that had broken the listing
    // outright rather than one that added exactly one unanswered question.
    for (const answer of [true, false]) {
      await prisma.mediaListing.update({
        where: { id: "listing-1" },
        data: { wineAccessory: answer },
      });
      expect(
        evaluateSellability(await gateUpload()),
        `wineAccessory = ${answer} must be sellable`,
      ).toEqual({ sellable: true });
    }

    // Back to unanswered, so this case leaves no row behind that a later one
    // in this process could read as triaged.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { wineAccessory: null },
    });
    expect(evaluateSellability(await gateUpload()).sellable).toBe(false);
  });

  it("accepts WINE_ACCESSORY as a clearance layer, and the clearance changes nothing", async () => {
    // The enum gained a value and the migration emits no DDL for it (Prisma
    // maps enums to TEXT on SQLite). That is a claim about the database, so
    // it is asked of the database. The answer is the same as ALCOHOL's for
    // the opposite reason: the value is writable, and writing it changes
    // nothing, because the fact is registered `settledBy: "recorded"` and
    // there is no blocker for a clearance to lift.
    await prisma.mediaRightsClearance.create({
      data: {
        id: "clearance-accessory-1",
        listingId: "listing-1",
        layer: "WINE_ACCESSORY",
        reason: "It is an empty glass.",
        clearedByUserId: "admin-1",
      },
    });

    // Still blocked, because the question is still unanswered — the clearance
    // did not stand in for an answer.
    expect(evaluateSellability(await gateUpload())).toEqual({
      sellable: false,
      blocker: "triage_incomplete",
    });

    expect(
      await prisma.mediaRightsClearance.findUniqueOrThrow({
        where: { id: "clearance-accessory-1" },
        select: { layer: true },
      }),
    ).toEqual({ layer: "WINE_ACCESSORY" });

    await prisma.mediaRightsClearance.delete({
      where: { id: "clearance-accessory-1" },
    });
  });
});

describe("ugcportal-qnq9.3 K4: adding the brand check to an existing database", () => {
  it("backfills NULL on all three columns, with no default on the answer", async () => {
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("BenefitSource")`);

    for (const name of [
      "alcoholLinked",
      "alcoholAnsweredAt",
      "alcoholAnsweredByUserId",
    ]) {
      const column = columns.find((row) => row.name === name);
      expect(column, `${name} is missing`).toBeTruthy();
      expect(column!.dflt_value, `${name} has a default`).toBeNull();
      expect(column!.notnull, `${name} is NOT NULL`).toBe(0);
    }
  });

  it("leaves the pre-existing brand unchecked, which refuses", async () => {
    // The whole point of having no default, stated as the gate's own answer
    // rather than as a column value: a brand named before the question
    // existed is a brand nobody has asked about, and K4 says an unasked
    // question never passes as a no.
    const brand = await prisma.benefitSource.findUniqueOrThrow({
      where: { slug: "riedel" },
      select: {
        id: true,
        name: true,
        alcoholLinked: true,
        alcoholAnsweredAt: true,
        alcoholAnsweredByUserId: true,
      },
    });

    expect(brand.alcoholLinked).toBeNull();
    expect(brand.alcoholAnsweredAt).toBeNull();
    expect(brand.alcoholAnsweredByUserId).toBeNull();
    // Carried across the table redefine with its identity intact — a new id
    // would orphan the disclosure that names it.
    expect(brand.id).toBe("brand-1");
    expect(brand.name).toBe("Riedel");

    expect(alcoholLinkedBrandRefusal(brand)?.field).toBe("benefitSource");
  });

  it("keeps the disclosure pointing at the brand across the redefine", async () => {
    // Claim 3. The migration DROPs and recreates BenefitSource with foreign
    // keys off; if the INSERT ... SELECT or the rename had lost a row or
    // changed an id, this join would come back null and the compliance record
    // would have forgotten who the benefit came from.
    const disclosure = await prisma.mediaAdvertisingDisclosure.findUniqueOrThrow(
      {
        where: { mediaId: "media-1" },
        select: {
          label: true,
          benefitSource: { select: { slug: true, name: true } },
        },
      },
    );

    expect(disclosure.benefitSource).toEqual({ slug: "riedel", name: "Riedel" });
    expect(disclosure.label).toBe("Advertisement / Reklame");
  });

  it("still refuses to delete a brand a disclosure names", async () => {
    // ON DELETE RESTRICT is declared on MediaAdvertisingDisclosure, which
    // this migration does not touch — but SQLite rewrites other tables' FK
    // clauses when a referenced table is renamed, so whether the constraint
    // still points anywhere is a question for the database. Re-asked here
    // rather than taken on trust from
    // advertising-disclosure-migration.test.ts, which asserts it on a
    // database where this migration has not yet run.
    await expect(
      prisma.benefitSource.delete({ where: { slug: "riedel" } }),
    ).rejects.toThrow();

    expect(await prisma.benefitSource.count()).toBe(1);
  });

  it("keeps a recorded answer when the person who gave it is deleted", async () => {
    // ON DELETE SET NULL on `alcoholAnsweredByUserId`, and the reason for it:
    // the answer is a fact about a company, so deleting the account that
    // recorded it must neither be blocked by it nor take it away. If this
    // were RESTRICT, checking a brand would quietly make a user undeletable;
    // if it were CASCADE, it would delete the brand.
    await prisma.user.create({
      data: { id: "checker-1", email: "checker@example.com" },
    });
    const brand = await prisma.benefitSource.create({
      data: {
        slug: "coravin",
        name: "Coravin",
        alcoholLinked: false,
        alcoholAnsweredAt: new Date("2026-10-06T00:00:00.000Z"),
        alcoholAnsweredByUserId: "checker-1",
      },
      select: { id: true },
    });

    await prisma.user.delete({ where: { id: "checker-1" } });

    const after = await prisma.benefitSource.findUniqueOrThrow({
      where: { id: brand.id },
      select: { alcoholLinked: true, alcoholAnsweredByUserId: true },
    });
    expect(after.alcoholAnsweredByUserId).toBeNull();
    // And it still answers the gate the same way, unattributed.
    expect(after.alcoholLinked).toBe(false);
    expect(alcoholLinkedBrandRefusal(after)).toBeNull();
  });
});
