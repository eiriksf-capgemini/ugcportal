-- Session.signInProvider / Session.signInEmail (ugcportal-mzr): which
-- identity minted this session, denormalised onto the row the session query
-- already loads, so the per-request re-check of the sign-in policy can judge
-- a provider-bound allowlist entry (`google:addr`, ugcportal-1551) without a
-- second query.
--
-- On the SESSION rather than on `User`, because that is the question being
-- asked: one person can hold several sessions at once, minted through
-- different providers, and the check looks at the one session in front of it
-- (PR #91 review, round 1, finding 1).

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "signInProvider" TEXT;
ALTER TABLE "Session" ADD COLUMN "signInEmail" TEXT;

-- RUN THIS MIGRATION BEFORE DEPLOYING THE CODE THAT READS IT. The Prisma
-- client generated from the current schema selects every scalar column it
-- knows about, so a new client against an un-migrated database fails
-- `getSessionAndUser` — which is every `auth()` call, for everybody,
-- including the operator. See docs/access-control.md.
--
-- WHAT HAPPENS TO SESSIONS THAT ALREADY EXIST, stated plainly because the
-- answer is not "nothing":
--
--   * A session whose user has exactly ONE linked provider is backfilled
--     below. Every session that user holds must have come through that
--     provider, so this is a reading of the data, not a guess. Those
--     sessions survive the deploy untouched, bound entry or not.
--   * Any other session — a user with two linked providers, or none — keeps
--     NULL here. NULL is read as an unrecognised provider, which an UNBOUND
--     allowlist entry (`a@b.com`) ignores: those sessions also survive. A
--     BOUND entry (`google:a@b.com`) refuses them, and the per-request check
--     then deletes that session. The person signs in again, which records
--     the identity properly, and they are back — one sign-in, once.
--   * `signInEmail` is deliberately NOT backfilled. A null (or blank)
--     address falls back to `User.email` in src/lib/live-session.ts, which
--     is the exact address the check judged before this column existed;
--     writing the same value into the column would add a second place for
--     it to be wrong.
--
-- From here on both columns are written by the INSERT that creates the row
-- (the adapter wrapper in src/lib/live-session.ts), so every session a
-- SIGN-IN mints after this migration is attributed as it is created. A row
-- written by anything else — a fixture, a manual INSERT — still gets NULL,
-- and is refused by a bound entry exactly as the rows above are.
--
-- ONE MORE THING ABOUT MIGRATION DAY, and it is the case most likely to
-- surprise: the backfill above fills in the PROVIDER and deliberately not
-- the address, so every pre-existing session is judged on `User.email` —
-- the address stored when the account was linked, which @auth/core never
-- refreshes. If you ALSO change which address is listed on this same deploy
-- (rebinding `old@x.com` to `new@x.com` because someone changed their
-- provider address, say), those backfilled sessions are judged on the stale
-- stored address, found not permitted, and revoked — including the
-- operator's own. Nothing is lost: everyone affected signs in again, the
-- new session records the fresh address, and from then on the two agree.
-- But if you would rather not explain an unexpected logout to anybody, ship
-- this migration on one deploy and change the allowlist on the next.
--
-- The alternative to the backfill is evicting every signed-in person with a
-- bound entry, including the operator, on the deploy that carries this —
-- recoverable, but indistinguishable from the outside from the new check
-- misfiring on its first day.
-- The two correlated subqueries below are deliberately left as they are:
-- `Account.userId` carries no index, so each one is a scan, but this runs
-- ONCE over a table with a handful of rows on an instance with a handful of
-- users. Adding an index for a one-time migration would be a permanent
-- schema change bought for a single statement.
UPDATE "Session"
SET "signInProvider" = (
  SELECT MIN(a."provider") FROM "Account" a WHERE a."userId" = "Session"."userId"
)
WHERE (
  SELECT COUNT(DISTINCT a."provider") FROM "Account" a WHERE a."userId" = "Session"."userId"
) = 1;
