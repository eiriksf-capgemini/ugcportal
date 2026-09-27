import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
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
 * ugcportal-vsm K2, against a real database rather than a reading of the
 * SQL: stand the schema up as it was *before* the re-anchoring, seed it with
 * the rows a live deployment would have — a connected Instagram account, a
 * CLEARED review naming a rights holder, an audit trail, a curated post —
 * and then run the migration and look at what is left.
 *
 * Two things have to be true afterwards, and they pull in opposite
 * directions:
 *
 *   1. NOTHING is sellable. An account-level clearance said "posts from this
 *      connected account may be sold". Re-pointing it at the user it named
 *      would silently promote it to "everything this person has ever
 *      uploaded, and everything they upload next" — a larger claim than the
 *      reviewer made. So no clearance is carried over at all.
 *   2. The history SURVIVES. ResaleRightsEvent has never had a foreign key,
 *      precisely so that the record of who cleared what outlives its
 *      subject; a refactor deleting those rows would be the same failure by
 *      another route.
 *
 * Seeded through raw SQL because the generated Prisma client only knows the
 * schema as it is *now* — it cannot write an `instagramAccountId` on a
 * review, which is the whole point of the fixture.
 */

const REANCHOR_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_reanchor_resale_rights_to_uploads"),
);

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

/**
 * The pre-change audit row is dated EARLY ON THE SAME UTC DAY the migration
 * runs, and that is load-bearing rather than incidental.
 *
 * `createdAt` is TEXT and SQLite orders TEXT lexicographically. SQLite's
 * `CURRENT_TIMESTAMP` renders `YYYY-MM-DD HH:MM:SS` while the Prisma libsql
 * adapter writes ISO with a `T`, and `' ' < 'T'` — so a migration row stamped
 * the naive way sorted *before* every Prisma row on the same date, however
 * much later it actually happened. An earlier revision of this test dated the
 * fixture two days back, which made the collision unreachable: it asserted the
 * right outcome while never constructing the case that breaks it. Same shape
 * as the harness problems that ran through ugcportal-0ss.
 */
const CLEARED_AT = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

beforeAll(async () => {
  // Derived rather than hard-coded, but still asserted: if the migration is
  // ever renamed, this test must fail loudly instead of silently migrating
  // everything and proving nothing.
  expect(REANCHOR_MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: REANCHOR_MIGRATION! });

  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('admin-1','admin@example.com','ADMIN',0,0),
            ('owner-1','owner@example.com','USER',0,0)`,
    `INSERT INTO "InstagramAccount"
       ("id","instagramUserId","username","accessTokenEncrypted","tokenExpiresAt","scopes","connectedByUserId","createdAt","updatedAt")
     VALUES ('acc-1','ig-1','ownerhandle','sealed',0,'instagram_business_basic','admin-1',0,0),
            ('acc-2','ig-2','untouched','sealed',0,'instagram_business_basic','admin-1',0,0),
            ('acc-3','ig-3','partway','sealed',0,'instagram_business_basic','admin-1',0,0)`,
    // A file the cleared party uploaded. After the migration it must not be
    // sellable, which is the concrete form of "no row silently becomes
    // CLEARED for any uploader or upload".
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-1','owner-1','IMAGE','uploads/owner-1/a.jpg','image/jpeg',10,'a.jpg',0)`,
    `INSERT INTO "ResaleRightsReview"
       ("id","instagramAccountId","status","route","checklistVersion","reviewedByUserId","clearedOwnerUserId","reviewedAt","validUntil","conditions","evidenceKey","evidenceSha256","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','acc-1','CLEARED','CONTRACT','2026-09-24.1','admin-1','owner-1',0,NULL,'Editorial use only.','rights-evidence/acc-1/contract.pdf','deadbeef','ugcportal-2eh',0,0)`,
    // A review that never recorded a decision. Deleting it changes nothing a
    // reader could care about — a missing row reads as UNREVIEWED to the gate
    // — so it must NOT produce a discard event claiming one was discarded.
    `INSERT INTO "ResaleRightsReview"
       ("id","instagramAccountId","status","checklistVersion","evidenceKey","createdAt","updatedAt")
     VALUES ('rev-2','acc-2','UNREVIEWED','2026-09-24.1','rights-evidence/acc-2/stray.pdf',0,0)`,
    // A review part-way through. Something WAS recorded, so this one does.
    `INSERT INTO "ResaleRightsReview"
       ("id","instagramAccountId","status","checklistVersion","createdAt","updatedAt")
     VALUES ('rev-3','acc-3','IN_REVIEW','2026-09-24.1',0,0)`,
    `INSERT INTO "ResaleRightsEvent"
       ("id","reviewId","instagramAccountId","instagramUsername","fromStatus","toStatus","actorUserId","actorEmail","reason","selfReview","checklistVersion","evidenceKey","evidenceSha256","createdAt")
     VALUES ('ev-1','rev-1','acc-1','ownerhandle','UNREVIEWED','CLEARED','admin-1','admin@example.com','Signed assignment on file.',0,'2026-09-24.1','rights-evidence/acc-1/contract.pdf','deadbeef','${CLEARED_AT}')`,
    // A curated post that was priced under the old anchor.
    `INSERT INTO "CuratedPost"
       ("id","instagramAccountId","mediaId","priceCents","currency","depictsPeople","containsMusic","thirdPartyCreator","sponsoredContent","triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('post-1','acc-1','media-1',24900,'NOK',0,0,0,0,'admin-1',0,0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, REANCHOR_MIGRATION!);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-vsm K2: nothing becomes sellable", () => {
  it("carries no review row forward, so every uploader is UNREVIEWED", async () => {
    expect(await prisma.resaleRightsReview.count()).toBe(0);
  });

  it("leaves the previously cleared party's upload unsellable", async () => {
    // The sharp end of K2, asked of the gate rather than of the row count:
    // owner-1 is the user the old clearance named, and their file is still
    // there.
    const upload = await prisma.media.findUniqueOrThrow({
      where: { id: "media-1" },
      select: MEDIA_GATE_SELECT,
    });

    expect(upload.userId).toBe("owner-1");
    expect(evaluateSellability(upload)).toEqual({
      sellable: false,
      blocker: "no_review",
    });
  });

  it("drops the priced listings rather than re-pointing them", async () => {
    // CuratedPost had a required foreign key to InstagramAccount, so under
    // the deferred Instagram integration there is no row worth keeping —
    // and dropping takes every price and triage flag with it, which is the
    // fail-closed direction.
    expect(await prisma.mediaListing.count()).toBe(0);
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
  });

  it("leaves nothing sellable anywhere in the database", async () => {
    const uploads = await prisma.media.findMany({ select: MEDIA_GATE_SELECT });

    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      expect(evaluateSellability(upload).sellable).toBe(false);
    }
  });
});

describe("ugcportal-vsm K2: the audit trail survives intact", () => {
  it("keeps the pre-change event with every snapshotted field", async () => {
    const event = await prisma.resaleRightsEvent.findUniqueOrThrow({
      where: { id: "ev-1" },
    });

    expect(event).toMatchObject({
      reviewId: "rev-1",
      // The subject was a connected account, and the row still says so
      // rather than being rewritten into something it was not about.
      subjectKind: "INSTAGRAM_ACCOUNT",
      subjectId: "acc-1",
      subjectLabel: "ownerhandle",
      fromStatus: "UNREVIEWED",
      toStatus: "CLEARED",
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      reason: "Signed assignment on file.",
      selfReview: false,
      checklistVersion: "2026-09-24.1",
      evidenceKey: "rights-evidence/acc-1/contract.pdf",
      evidenceSha256: "deadbeef",
    });
    expect(event.createdAt.toISOString()).toBe(CLEARED_AT);
  });

  it("records why the clearance stopped applying, rather than losing it", async () => {
    // A clearance that vanishes with no entry is an audit trail with a hole
    // exactly where someone would look.
    const trail = await prisma.resaleRightsEvent.findMany({
      where: { reviewId: "rev-1" },
      orderBy: { createdAt: "asc" },
    });

    expect(trail).toHaveLength(2);
    const discard = trail.at(-1)!;
    expect(discard).toMatchObject({
      subjectKind: "INSTAGRAM_ACCOUNT",
      subjectId: "acc-1",
      subjectLabel: "ownerhandle",
      // Whatever the row actually said, not a hard-coded status.
      fromStatus: "CLEARED",
      toStatus: "UNREVIEWED",
      // A migration is not a person.
      actorUserId: null,
      actorEmail: null,
      // The decision's own terms travel with the row, so it still reads
      // sensibly with the review gone.
      checklistVersion: "2026-09-24.1",
      evidenceKey: "rights-evidence/acc-1/contract.pdf",
      evidenceSha256: "deadbeef",
    });
    expect(discard.reason).toContain("ugcportal-vsm");
  });

  /**
   * THE ORDERING, asked of a trail whose two rows land on the same UTC date.
   *
   * This is the assertion the earlier fixture could not make, because it
   * dated the pre-change row two days back and the lexicographic collision
   * never arose. A migration row stamped with SQLite's `CURRENT_TIMESTAMP`
   * sorts before every Prisma-written row on the same date — leaving the
   * trail's last word as the clearance the discard row exists to retire,
   * which is exactly the failure that row was added to prevent.
   */
  it("sorts after the clearance it retires, on the same UTC date", async () => {
    const trail = await prisma.resaleRightsEvent.findMany({
      where: { reviewId: "rev-1" },
      orderBy: { createdAt: "asc" },
    });

    // The fixture really is on today's date, so the collision is reachable
    // rather than assumed away.
    expect(trail[0].createdAt.toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );
    expect(trail.map((event) => event.toStatus)).toEqual([
      "CLEARED",
      "UNREVIEWED",
    ]);
    expect(trail[1].createdAt.getTime()).toBeGreaterThan(
      trail[0].createdAt.getTime(),
    );
  });

  it("stamps the discard in the same format every other writer uses", async () => {
    // Read as plain text rather than as a date: concatenating with '' strips
    // the column's affinity, so this sees the bytes on disk instead of
    // whatever the driver would coerce them to. The naive
    // `YYYY-MM-DD HH:MM:SS` form is also read back as LOCAL time, so on a
    // server east of UTC it claimed to have happened hours before it did —
    // invisible to a wall-clock assertion running in UTC, visible here.
    const [row] = await prisma.$queryRawUnsafe<{ raw: string }[]>(
      `SELECT "createdAt" || '' AS raw FROM "ResaleRightsEvent"
       WHERE "toStatus" = 'UNREVIEWED' AND "reviewId" = 'rev-1'`,
    );

    expect(row.raw).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  /**
   * An audit row has to describe something that happened. A review still
   * sitting at UNREVIEWED recorded nothing, and `fromStatus = toStatus =
   * UNREVIEWED` with a reason asserting a discarded decision — plus a copied
   * evidence pointer — is the trail claiming an event that never occurred.
   */
  it("writes no discard event for a review that never decided anything", async () => {
    expect(
      await prisma.resaleRightsEvent.count({ where: { reviewId: "rev-2" } }),
    ).toBe(0);
  });

  it("does write one for a review that was part-way through", async () => {
    // The other half, so the WHERE is not simply excluding everything: a
    // review someone had started IS a record, and it stopped applying.
    const [event, ...rest] = await prisma.resaleRightsEvent.findMany({
      where: { reviewId: "rev-3" },
    });

    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      subjectId: "acc-3",
      fromStatus: "IN_REVIEW",
      toStatus: "UNREVIEWED",
    });
    // It named nobody, and the row says so rather than implying a holder.
    expect(event.reason).toContain("named no rights holder");
  });

  /**
   * The link back to a person. These rows are genuinely about a connected
   * account — stamping them `UPLOADER` would claim that user had been cleared
   * as an uploader, which never happened — but an auditor starting from a
   * user still needs a way to reach the history, and the reason is the only
   * field that can carry it without misstating the subject.
   */
  it("names the rights holder the discarded clearance covered", async () => {
    const found = await prisma.resaleRightsEvent.findMany({
      where: { reason: { contains: "[rights-holder:owner-1]" } },
    });

    expect(found).toHaveLength(1);
    expect(found[0].reviewId).toBe("rev-1");
    // The snapshotted email too, so the row reads without the User table.
    expect(found[0].reason).toContain("owner@example.com");
  });

  it("gives the new audit table no foreign key to cascade from", async () => {
    // Asked of the live database rather than the schema file: deleting the
    // uploader must take the current-state row and leave the history.
    const before = await prisma.resaleRightsEvent.count();
    expect(before).toBeGreaterThan(0);

    await prisma.user.delete({ where: { id: "owner-1" } });

    // Derived rather than hard-coded: adding a fixture above must not turn
    // this into a number nobody rechecks.
    expect(await prisma.resaleRightsEvent.count()).toBe(before);
    expect(
      await prisma.media.findUnique({ where: { id: "media-1" } }),
    ).toBeNull();
  });
});
