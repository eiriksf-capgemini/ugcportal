-- ugcportal-aqw: time-scope a clearance to the material its reviewer could
-- examine.
--
-- docs/legal/manual-upload-rights-review.md §1 Gap 1 and §4 item 6. Until
-- this, `evaluateSellability` never read `Media.createdAt` at all, so a
-- clearance signed in March covered a file uploaded the following December
-- identically to one uploaded the previous November — material nobody had
-- looked at, cleared by a decision taken before it existed. åvl § 67(2)'s
-- specialty principle says nothing transfers beyond what clearly follows
-- from the agreement, so "covers everything from now on" has to be written
-- down by the reviewer rather than assumed by the gate.
--
-- TWO `ALTER TABLE ... ADD COLUMN` STATEMENTS, NOT THE TABLE REBUILD
-- `prisma migrate diff` emits for SQLite, and that is a deliberate
-- hand-edit of the generated script. The logical result is identical —
-- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema
-- prisma/schema.prisma --exit-code` (the `migration-drift` CI job) reports
-- no difference after this runs — but a rebuild reads the whole column list
-- of `ResaleRightsReview` into one `CREATE TABLE` plus one `INSERT ...
-- SELECT`. ugcportal-paa is adding a column to this same table, so two
-- rebuilds would be two conflicting copies of the full column list, and
-- resolving that conflict by taking one side silently drops the other
-- bead's column. Two independent `ADD COLUMN`s compose instead.
--
-- NEITHER COLUMN IS BACKFILLED FROM `reviewedAt` AT WRITE TIME, which is
-- the entire reason `coversUploadsBefore` is a column rather than a reuse
-- of `reviewedAt`: `adminFields` in src/lib/resale-rights-review.ts
-- re-stamps `reviewedAt` on EVERY admin transition, so anchoring scope to it
-- would widen a clearance every time somebody fixed a typo in `conditions`.
-- The one-off `UPDATE` below is a different thing: it runs once, over rows
-- written before this column existed, and `reviewedAt` is the honest
-- reading of when those reviewers signed.
--
-- DEPLOY ORDER: apply before the swap. This only ADDs, so a build that has
-- never heard of these columns keeps working; the reverse is not free,
-- because `REVIEW_GATE_SELECT` (src/lib/resale-rights.ts) names both and
-- every gate read would fail on a database without them.

-- AlterTable
ALTER TABLE "ResaleRightsReview" ADD COLUMN "coversUploadsBefore" DATETIME;

-- AlterTable
ALTER TABLE "ResaleRightsReview" ADD COLUMN "coversFutureUploads" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing rows get the instant their reviewer actually signed.
--
-- `reviewedAt` is NULL on a row no admin has ever decided on (a SYSTEM
-- revoke on an uploader nobody reviewed), so `createdAt` is the fallback —
-- NOT `CURRENT_TIMESTAMP`, which is what a `NOT NULL DEFAULT` would have
-- stamped and which would silently widen every pre-existing clearance to
-- cover everything uploaded up to the moment this migration ran. Neither
-- source can be NULL: `createdAt` is `NOT NULL DEFAULT CURRENT_TIMESTAMP`.
--
-- `coversFutureUploads` is deliberately NOT backfilled to anything but its
-- `false` default. No reviewer of an existing row ever recorded that their
-- instrument was a framework licence over future works, and inventing that
-- record on their behalf is exactly the assumption åvl § 67(2) forbids.
UPDATE "ResaleRightsReview"
   SET "coversUploadsBefore" = COALESCE("reviewedAt", "createdAt")
 WHERE "coversUploadsBefore" IS NULL;
