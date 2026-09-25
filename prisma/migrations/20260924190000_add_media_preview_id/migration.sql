-- Media.previewId (ugcportal-r1d): an opaque public handle for the preview.
--
-- `previewKey` is a storage path of the form `previews/{userId}/{uuid}.webp`,
-- so it cannot be returned to anonymous callers without publishing the
-- uploader's account id. `previewId` is an unrelated random value the public
-- feed exposes instead; resolving it back to an object stays server-side.
--
-- The backfill gives every row that already has a preview a fresh id, so
-- pre-existing rows are covered too, not just new uploads. Rows without a
-- preview (every VIDEO, until ugcportal-pmb) stay NULL on both columns --
-- "has a watermarked preview" remains one fact rather than two that can
-- disagree.
--
-- The generated value is a v4 UUID, byte-for-byte the same shape as the
-- randomUUID() that mediaPreviewColumns (src/lib/media.ts) mints for new
-- uploads. That matching matters for two reasons:
--
--   1. ugcportal-a2l, the preview delivery route, routes on previewId. If it
--      validates a UUID shape -- the obvious thing to do -- then a 32-char
--      hex string would 404 for every pre-existing row while new uploads
--      worked, and the breakage would look like a delivery bug rather than a
--      migration one.
--   2. previewId's whole purpose is to carry no information. Two
--      distinguishable formats would let anyone holding a handful of ids sort
--      them into "uploaded before the migration" and "after", which is
--      precisely the kind of inference an opaque id exists to deny.
--
-- src/lib/media.test.ts executes this expression against an in-memory SQLite
-- database and asserts it agrees with randomUUID(), so the two cannot drift.
--
-- randomblob() is SQLite's CSPRNG-backed source. Nothing about the row is an
-- input, so the value cannot be correlated with previewKey, userId or anything
-- else in the table.

-- AlterTable
ALTER TABLE "Media" ADD COLUMN "previewId" TEXT;

-- Backfill existing previews with opaque v4 UUIDs.
UPDATE "Media"
SET "previewId" = lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-4' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89AB', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
)
WHERE "previewKey" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Media_previewId_key" ON "Media"("previewId");
