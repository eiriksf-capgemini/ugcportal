-- CreateTable
CREATE TABLE "ResaleRightsReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instagramAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "route" TEXT,
    "checklistVersion" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "clearedOwnerUserId" TEXT,
    "reviewedAt" DATETIME,
    "validUntil" DATETIME,
    "conditions" TEXT,
    "evidenceKey" TEXT,
    "evidenceSha256" TEXT,
    "productDecisionRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResaleRightsReview_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResaleRightsReview_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ResaleRightsReview_clearedOwnerUserId_fkey" FOREIGN KEY ("clearedOwnerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResaleRightsEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "instagramUsername" TEXT,
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
    "triagedByUserId" TEXT,
    "triagedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CuratedPost_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostRightsClearance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "curatedPostId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "clearedByUserId" TEXT,
    "clearedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostRightsClearance_curatedPostId_fkey" FOREIGN KEY ("curatedPostId") REFERENCES "CuratedPost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PostRightsClearance_clearedByUserId_fkey" FOREIGN KEY ("clearedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ResaleRightsReview_instagramAccountId_key" ON "ResaleRightsReview"("instagramAccountId");

-- CreateIndex
CREATE INDEX "ResaleRightsReview_reviewedByUserId_idx" ON "ResaleRightsReview"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "ResaleRightsEvent_reviewId_createdAt_idx" ON "ResaleRightsEvent"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "ResaleRightsEvent_instagramAccountId_createdAt_idx" ON "ResaleRightsEvent"("instagramAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ResaleRightsEvent_createdAt_idx" ON "ResaleRightsEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CuratedPost_mediaId_key" ON "CuratedPost"("mediaId");

-- CreateIndex
CREATE INDEX "CuratedPost_instagramAccountId_idx" ON "CuratedPost"("instagramAccountId");

-- CreateIndex
CREATE INDEX "PostRightsClearance_clearedByUserId_idx" ON "PostRightsClearance"("clearedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PostRightsClearance_curatedPostId_layer_key" ON "PostRightsClearance"("curatedPostId", "layer");
