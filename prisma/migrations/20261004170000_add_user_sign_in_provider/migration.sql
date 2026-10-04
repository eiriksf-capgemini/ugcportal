-- User.signInProvider (ugcportal-mzr): which provider the identity holding a
-- session got in through, denormalised onto the row the session adapter
-- already loads, so the per-request re-check of the sign-in policy can honour
-- a provider-bound allowlist entry (`google:addr`, ugcportal-1551) without
-- adding a second query to every authenticated request.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "signInProvider" TEXT;

-- Backfill, rather than leaving every existing row NULL.
--
-- NULL is read as "unrecognised provider" (providerId in
-- src/lib/sign-in-policy.ts), which fails closed against a BOUND entry. So
-- without this, the deploy that carries this migration revokes the live
-- session of every already-signed-in person whose allowlist entry names a
-- provider — including the operator's own — and each would have to sign in
-- again for no reason other than that this column was new. Nothing is lost
-- when that happens (signing in rewrites the column and mints a fresh
-- session), but it is an avoidable eviction, and "the revocation feature
-- shipped and logged everyone out" is indistinguishable, from the outside,
-- from the feature misfiring.
--
-- Only for a user whose linked accounts leave no doubt: exactly ONE distinct
-- provider across their Account rows, so every session they hold must have
-- come through it. A user with two linked providers (ugcportal-t33p will
-- make that reachable) is deliberately left NULL — guessing one of the two
-- would be inventing an answer, and NULL fails closed, costing that user one
-- sign-in and nothing else. MIN() is just how the single value is read out
-- of a correlated subquery; the COUNT(DISTINCT ...) = 1 guard is what makes
-- it the only value there could be.
UPDATE "User"
SET "signInProvider" = (
  SELECT MIN(a."provider") FROM "Account" a WHERE a."userId" = "User"."id"
)
WHERE (
  SELECT COUNT(DISTINCT a."provider") FROM "Account" a WHERE a."userId" = "User"."id"
) = 1;
