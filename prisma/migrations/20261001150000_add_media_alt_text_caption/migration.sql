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
