-- Media.publishedAt (ugcportal-r1d): the visibility switch.
--
-- Added nullable with no DEFAULT, so every existing row gets NULL and stays
-- private. Publishing is only ever a deliberate write by the row's owner.

-- AlterTable
ALTER TABLE "Media" ADD COLUMN "publishedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Media_createdAt_id_idx" ON "Media"("createdAt", "id");
