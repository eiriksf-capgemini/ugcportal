-- Media.altText / Media.caption (ugcportal-gwr): accessibility and
-- discoverability text collected in the upload flow.
--
-- Both nullable with no DEFAULT, so every existing row gets NULL. `altText`
-- is enforced only at PUBLISH time (POST /api/media/[id]/publish), not at
-- upload and not at this layer — the same "null means not yet decided" idiom
-- MediaListing's triage booleans already use. `caption` is always optional.

-- AlterTable
ALTER TABLE "Media" ADD COLUMN "altText" TEXT;
ALTER TABLE "Media" ADD COLUMN "caption" TEXT;

-- Backfill, not left at NULL (review round 1, finding 1).
--
-- Without this, every row that existed before this migration — published or
-- not — has altText = NULL, and there is no edit surface anywhere in the
-- product that can ever set one (ugcportal-1wz, the owner media library
-- that would carry it, is not built yet). The publish gate this bead adds
-- refuses to set publishedAt while altText is null or blank, with nothing
-- in the product able to clear that block: an owner who unpublishes an
-- existing item can never republish it, and an existing unpublished draft
-- can never be published at all, through any screen this product has.
--
-- The fix is a one-time backfill with an honest, generic placeholder —
-- never derived from originalName (K2 forbids alt text equal to the
-- filename) and never blank. This is the same "untitled" idiom
-- sanitizeOriginalName already uses in src/lib/media.ts for exactly the
-- same shape of problem: real information is unavailable, and a fixed,
-- honest placeholder beats either blocking forever or inventing a
-- description nobody wrote. It unblocks EXISTING content; every upload
-- through the new form still collects real alt text from here on.
UPDATE "Media" SET "altText" = 'No description provided.' WHERE "altText" IS NULL;
