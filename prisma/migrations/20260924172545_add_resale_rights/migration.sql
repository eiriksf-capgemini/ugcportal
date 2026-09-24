-- CreateTable
CREATE TABLE "ResaleRightsReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instagramAccountId" TEXT NOT NULL,
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
    CONSTRAINT "ResaleRightsReview_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResaleRightsReview_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResaleRightsEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "reason" TEXT NOT NULL,
    "selfReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResaleRightsEvent_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ResaleRightsReview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CuratedPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instagramAccountId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "instagramPermalink" TEXT,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'NOK',
    "depictsPeople" BOOLEAN,
    "modelReleaseKey" TEXT,
    "containsMusic" BOOLEAN,
    "thirdPartyCreator" BOOLEAN,
    "sponsoredContent" BOOLEAN,
    "postClearedByUserId" TEXT,
    "postClearedAt" DATETIME,
    "postClearanceReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CuratedPost_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ResaleRightsReview_instagramAccountId_key" ON "ResaleRightsReview"("instagramAccountId");

-- CreateIndex
CREATE INDEX "ResaleRightsReview_reviewedByUserId_idx" ON "ResaleRightsReview"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "ResaleRightsEvent_reviewId_createdAt_idx" ON "ResaleRightsEvent"("reviewId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CuratedPost_mediaId_key" ON "CuratedPost"("mediaId");

-- CreateIndex
CREATE INDEX "CuratedPost_instagramAccountId_idx" ON "CuratedPost"("instagramAccountId");
