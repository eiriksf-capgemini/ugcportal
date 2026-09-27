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

const CLEARED_AT = "2026-09-25T09:00:00.000Z";

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
     VALUES ('acc-1','ig-1','ownerhandle','sealed',0,'instagram_business_basic','admin-1',0,0)`,
    // A file the cleared party uploaded. After the migration it must not be
    // sellable, which is the concrete form of "no row silently becomes
    // CLEARED for any uploader or upload".
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-1','owner-1','IMAGE','uploads/owner-1/a.jpg','image/jpeg',10,'a.jpg',0)`,
    `INSERT INTO "ResaleRightsReview"
       ("id","instagramAccountId","status","route","checklistVersion","reviewedByUserId","clearedOwnerUserId","reviewedAt","validUntil","conditions","evidenceKey","evidenceSha256","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','acc-1','CLEARED','CONTRACT','2026-09-24.1','admin-1','owner-1',0,NULL,'Editorial use only.','rights-evidence/acc-1/contract.pdf','deadbeef','ugcportal-2eh',0,0)`,
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

  it("gives the new audit table no foreign key to cascade from", async () => {
    // Asked of the live database rather than the schema file: deleting the
    // uploader must take the current-state row and leave the history.
    await prisma.user.delete({ where: { id: "owner-1" } });

    expect(await prisma.resaleRightsEvent.count()).toBe(2);
    expect(
      await prisma.media.findUnique({ where: { id: "media-1" } }),
    ).toBeNull();
  });
});
