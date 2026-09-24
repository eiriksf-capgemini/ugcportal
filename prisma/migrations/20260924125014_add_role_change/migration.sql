-- CreateTable
CREATE TABLE "RoleChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetUserId" TEXT NOT NULL,
    "targetEmail" TEXT,
    "previousRole" TEXT NOT NULL,
    "newRole" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "RoleChange_targetUserId_idx" ON "RoleChange"("targetUserId");

-- CreateIndex
CREATE INDEX "RoleChange_createdAt_idx" ON "RoleChange"("createdAt");
