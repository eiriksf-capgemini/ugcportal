-- Advertising disclosure (ugcportal-qnq9.1): record the benefit behind an item
-- so the publish gate can refuse to make an unlabelled advertisement public.
--
-- Forbrukertilsynet's labelling rule, docs/ugc-research.md §3.2: any item the
-- operator received payment or another benefit for must carry a prominent
-- advertising label that comes first. §5.7 adds that posting in English does
-- not change that, because the site is run from Norway.
--
-- TWO NEW TABLES, NOTHING ALTERED. No column is added to Media and no existing
-- row anywhere is touched or backfilled, which is deliberate rather than
-- incidental: "was a benefit received for this item" is a question only the
-- operator can answer, and there is no value this migration could write that
-- would be true. Every pre-existing item therefore ends up in the UNANSWERED
-- state (no disclosure row at all), which publishes exactly as it did before
-- this migration ran. See the note below on why unanswered is permissive.
--
-- DEPLOY ORDER IS UNCONSTRAINED, unlike 20261005120000_add_user_configured_handle
-- and 20261004180000_add_session_sign_in_identity. Those two added columns to
-- tables the generated client already reads on every request, so an un-migrated
-- database broke every query against them. This one only CREATEs tables, so a
-- previous build that has never heard of them keeps working unchanged, and a
-- new build against an un-migrated database fails only on the disclosure
-- routes rather than on every page. Applying it before the swap is still the
-- right order; it is just not load-bearing here.

-- CreateTable
--
-- The brand behind a benefit. A TABLE rather than free text on the disclosure
-- because ugcportal-qnq9.3 K4 has to hang an alcohol answer off the brand (a
-- brand that produces, imports or sells alcohol may not be the source of any
-- benefit, §3.1a practical rule 1), and that answer is a fact about the brand
-- rather than about one item. This migration does not add that column; it makes
-- the place for it exist, so adding it later is an ALTER on a handful of rows
-- instead of a retroactive reconciliation of every spelling anyone ever typed.
--
-- `slug` is the identity key (unique) and `name` the display form, the same
-- split Tag uses — so an alcohol answer recorded against "Vinmonopolet" is not
-- bypassable by typing "vinmonopolet".
CREATE TABLE "BenefitSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
--
-- One item's disclosure record. 1:1 with Media and OPTIONAL: an item nobody has
-- answered the question for has no row here.
--
-- `benefitReceived` is nullable rather than `BOOLEAN NOT NULL DEFAULT false`,
-- and that is the single most load-bearing choice in this file. A default of
-- false would record "the operator says no benefit was received" for every row
-- ever created, including the ones created by this migration's own absence of a
-- backfill — an assertion about a commercial relationship that nobody made.
-- Keeping "nobody has said" distinguishable from "somebody said no" is also what
-- lets a later bead (ugcportal-qn3's unanswered-question-blocks-publishing
-- mechanism, if it lands) move this field onto that mechanism without a second
-- migration to recover a distinction a default had already destroyed.
--
-- WHAT UNANSWERED DOES TODAY: nothing. The publish gate added by this bead
-- refuses only the `benefitReceived = true` + no-permitted-label pair; a null
-- (or an absent row) publishes as before. That is not a gap left open by
-- accident — making unanswered block would block every item that existed when
-- this ran, with no edit surface in the product able to clear it, which is the
-- exact trap 20261001150000_add_media_alt_text_caption had to add a backfill to
-- escape. Here there is no honest backfill, so the gate is scoped to the
-- answered-yes case instead.
--
-- `benefitSourceId` is ON DELETE RESTRICT, not CASCADE or SET NULL: deleting a
-- brand must not silently erase the source of a benefit that was disclosed
-- publicly. Nothing in the product deletes a BenefitSource, so this makes adding
-- such a path a deliberate act rather than quiet data loss. `mediaId` is ON
-- DELETE CASCADE because the disclosure is a statement about the item, and there
-- is nothing left to disclose once the item is gone.
--
-- `marketValueOre` is integer minor units of NOK (øre), so no float ever touches
-- money — the same rule MediaListing.priceCents states, under a name that says
-- which minor unit it actually holds. §3.3: free and discounted products are
-- taxable income at market value.
CREATE TABLE "MediaAdvertisingDisclosure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaId" TEXT NOT NULL,
    "benefitReceived" BOOLEAN,
    "benefitKind" TEXT,
    "benefitSourceId" TEXT,
    "marketValueOre" INTEGER,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaAdvertisingDisclosure_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaAdvertisingDisclosure_benefitSourceId_fkey" FOREIGN KEY ("benefitSourceId") REFERENCES "BenefitSource" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BenefitSource_slug_key" ON "BenefitSource"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAdvertisingDisclosure_mediaId_key" ON "MediaAdvertisingDisclosure"("mediaId");

-- CreateIndex
--
-- SQLite does not index a child foreign key automatically, and the RESTRICT
-- above is what needs one TODAY: enforcing it means answering "does any
-- disclosure still point at this brand" on every attempted BenefitSource
-- delete, which without this index is a full scan of the disclosure table.
-- It also happens to be the lookup ugcportal-qnq9.3's brand check will want
-- ("which items name this brand as the source of a benefit"), but that is a
-- bonus rather than the justification — an index whose only reader is a bead
-- that has not landed is one nothing exercises.
CREATE INDEX "MediaAdvertisingDisclosure_benefitSourceId_idx" ON "MediaAdvertisingDisclosure"("benefitSourceId");
