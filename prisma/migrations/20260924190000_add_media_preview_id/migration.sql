-- Media.previewId (ugcportal-r1d): an opaque public handle for the preview.
--
-- `previewKey` is a storage path of the form `previews/{userId}/{uuid}.webp`,
-- so it cannot be returned to anonymous callers without publishing the
-- uploader's account id. `previewId` is an unrelated random value the public
-- feed exposes instead; resolving it back to an object stays server-side.
--
-- The backfill gives every row that already has a preview a fresh id, so
-- pre-existing rows are covered too, not just new uploads. Rows without a
-- preview (every VIDEO, until ugcportal-pmb) stay NULL on both columns —
-- "has a watermarked preview" remains one fact rather than two that can
-- disagree.
--
-- randomblob(16) is SQLite's CSPRNG-backed source; hex() makes it a 32-char
-- string. Correlating it with previewKey or userId is not possible: nothing
-- about the row is an input to it.

-- AlterTable
ALTER TABLE "Media" ADD COLUMN "previewId" TEXT;

-- Backfill existing previews with opaque ids.
UPDATE "Media" SET "previewId" = lower(hex(randomblob(16))) WHERE "previewKey" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Media_previewId_key" ON "Media"("previewId");
