-- ugcportal-vsm: re-anchor the resale-rights gate from connected Instagram
-- accounts to uploaders and uploads.
--
-- Generated with `prisma migrate diff` and then hand-edited in three places,
-- each marked HAND-EDITED below. The generated script would have failed on
-- two NOT NULL columns and would have destroyed the audit trail on a third;
-- none of that is a formatting preference.
--
--  1. ResaleRightsEvent keeps every row it has. The table has never had a
--     foreign key (ugcportal-lu7's lesson), precisely so that the record of
--     who cleared what outlives its subject — and a refactor deleting it
--     would be the same failure by another route. Existing rows are stamped
--     subjectKind = 'INSTAGRAM_ACCOUNT' and keep their snapshotted account
--     id and @handle, now under the generic subject columns.
--
--  2. NO ResaleRightsReview ROW IS CARRIED FORWARD. Every uploader starts
--     with no review, which the gate reads as UNREVIEWED and refuses. This
--     is deliberate and it is the whole point of ugcportal-vsm K2/K4: an
--     account-level clearance said "posts from this connected account may be
--     sold". Re-pointing it at a user would silently promote it to
--     "everything this person has ever uploaded, and everything they upload
--     next, may be sold" — a different and much larger claim than any human
--     reviewer actually made. Some old rows even name a rights holder
--     (`clearedOwnerUserId`), which makes the re-point look safe; it is not,
--     for the same reason.
--
--     Rather than let those decisions vanish without explanation, each one
--     is written into the append-only trail as a transition to UNREVIEWED
--     before the table is rebuilt, carrying its own checklist version and
--     evidence pointer. The trail therefore says why the clearance stopped
--     applying, which is the question an auditor asks.
--
--  3. CuratedPost / PostRightsClearance are dropped rather than migrated.
--     They had a required foreign key to InstagramAccount, so under the
--     deferred Instagram integration no row can exist that is worth keeping;
--     nothing in the application has ever created one (ugcportal-0ss shipped
--     the schema, ugcportal-74w was to ship the writer). Dropping them takes
--     every price and every triage flag with it, which is the fail-closed
--     direction: afterwards nothing at all is sellable.

-- DropIndex
DROP INDEX "CuratedPost_triagedByUserId_idx";

-- DropIndex
DROP INDEX "CuratedPost_instagramAccountId_idx";

-- DropIndex
DROP INDEX "CuratedPost_mediaId_key";

-- DropIndex
DROP INDEX "PostRightsClearance_curatedPostId_layer_key";

-- DropIndex
DROP INDEX "PostRightsClearance_clearedByUserId_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "PostRightsClearance";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "CuratedPost";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "MediaListing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaId" TEXT NOT NULL,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'NOK',
    "depictsPeople" BOOLEAN,
    "modelReleaseKey" TEXT,
    "containsMusic" BOOLEAN,
    "thirdPartyCreator" BOOLEAN,
    "sponsoredContent" BOOLEAN,
    "triagedByUserId" TEXT,
    "triagedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaListing_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaListing_triagedByUserId_fkey" FOREIGN KEY ("triagedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaRightsClearance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "clearedByUserId" TEXT,
    "clearedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MediaRightsClearance_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MediaListing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaRightsClearance_clearedByUserId_fkey" FOREIGN KEY ("clearedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ResaleRightsEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "reason" TEXT NOT NULL,
    "selfReview" BOOLEAN NOT NULL DEFAULT false,
    "checklistVersion" TEXT,
    "evidenceKey" TEXT,
    "evidenceSha256" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- HAND-EDITED (1): the generated INSERT omitted subjectKind/subjectId, which
-- are NOT NULL, so it would have failed outright on any database with a
-- single audit row — and "fixing" it by dropping the rows would delete the
-- history this table exists to keep. Every existing row is about a connected
-- Instagram account, so it is stamped as such and keeps its snapshots.
INSERT INTO "new_ResaleRightsEvent" ("id", "reviewId", "subjectKind", "subjectId", "subjectLabel", "fromStatus", "toStatus", "actorUserId", "actorEmail", "reason", "selfReview", "checklistVersion", "evidenceKey", "evidenceSha256", "createdAt")
SELECT "id", "reviewId", 'INSTAGRAM_ACCOUNT', "instagramAccountId", "instagramUsername", "fromStatus", "toStatus", "actorUserId", "actorEmail", "reason", "selfReview", "checklistVersion", "evidenceKey", "evidenceSha256", "createdAt" FROM "ResaleRightsEvent";
DROP TABLE "ResaleRightsEvent";
ALTER TABLE "new_ResaleRightsEvent" RENAME TO "ResaleRightsEvent";
CREATE INDEX "ResaleRightsEvent_reviewId_createdAt_idx" ON "ResaleRightsEvent"("reviewId", "createdAt");
CREATE INDEX "ResaleRightsEvent_subjectKind_subjectId_createdAt_idx" ON "ResaleRightsEvent"("subjectKind", "subjectId", "createdAt");
CREATE INDEX "ResaleRightsEvent_createdAt_idx" ON "ResaleRightsEvent"("createdAt");
-- HAND-EDITED (2a): record the discard before the old review table goes.
-- Runs against the rebuilt event table (above) while the old review table is
-- still in its pre-migration shape, which is the only window where both are
-- readable. `fromStatus` is the column, not a literal, so this says whatever
-- each row actually said. The id needs a value because Prisma generates
-- cuids client-side and the column has no default; randomblob is opaque and
-- unique, which is all an audit id has to be.
INSERT INTO "ResaleRightsEvent" ("id", "reviewId", "subjectKind", "subjectId", "subjectLabel", "fromStatus", "toStatus", "actorUserId", "actorEmail", "reason", "selfReview", "checklistVersion", "evidenceKey", "evidenceSha256", "createdAt")
SELECT 'vsm' || lower(hex(randomblob(14))), r."id", 'INSTAGRAM_ACCOUNT', r."instagramAccountId", a."username", r."status", 'UNREVIEWED', NULL, NULL, 'ugcportal-vsm: the resale-rights gate moved from connected Instagram accounts to uploaders and uploads. This account-level decision was discarded rather than re-pointed at a user, because a decision about one connected account is not a decision about everything that person has ever uploaded. Nothing from this subject is sellable until an admin records a new decision against the uploader.', false, r."checklistVersion", r."evidenceKey", r."evidenceSha256", CURRENT_TIMESTAMP
FROM "ResaleRightsReview" r LEFT JOIN "InstagramAccount" a ON a."id" = r."instagramAccountId";
CREATE TABLE "new_ResaleRightsReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploaderUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "route" TEXT,
    "checklistVersion" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" DATETIME,
    "validUntil" DATETIME,
    "conditions" TEXT,
    "evidenceKey" TEXT,
    "evidenceSha256" TEXT,
    "productDecisionRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResaleRightsReview_uploaderUserId_fkey" FOREIGN KEY ("uploaderUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResaleRightsReview_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- HAND-EDITED (2b): no INSERT here, on purpose. The generated script copied
-- every old row across with no uploaderUserId, which is NOT NULL and would
-- have failed; the repair that looks obvious — fill it from
-- `clearedOwnerUserId` — is the one this bead must not make. See the header.
DROP TABLE "ResaleRightsReview";
ALTER TABLE "new_ResaleRightsReview" RENAME TO "ResaleRightsReview";
CREATE UNIQUE INDEX "ResaleRightsReview_uploaderUserId_key" ON "ResaleRightsReview"("uploaderUserId");
CREATE INDEX "ResaleRightsReview_reviewedByUserId_idx" ON "ResaleRightsReview"("reviewedByUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "MediaListing_mediaId_key" ON "MediaListing"("mediaId");

-- CreateIndex
CREATE INDEX "MediaListing_triagedByUserId_idx" ON "MediaListing"("triagedByUserId");

-- CreateIndex
CREATE INDEX "MediaRightsClearance_clearedByUserId_idx" ON "MediaRightsClearance"("clearedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaRightsClearance_listingId_layer_key" ON "MediaRightsClearance"("listingId", "layer");
