-- One-off reconciliation for people who already have more than one user
-- (ugcportal-t33p K4).
--
-- WHY A MIGRATION AND NOT A SCRIPT UNDER scripts/. The bead allows either.
-- This repo has no way to RUN a TypeScript script: `src/generated/prisma` is
-- a TypeScript client, every first-party module imports through the `@/*`
-- tsconfig path alias, and nothing in devDependencies resolves either from
-- Node (`scripts/*.mjs` are plain ESM with relative imports and no Prisma).
-- A migration, by contrast, is the mechanism this repo has already used
-- twice for moving data — 20261004180000_add_session_sign_in_identity's
-- backfill and 20261004150000_seed_portfolio_tag's conflict-aware seed — and
-- it comes with a test convention (apply the real .sql against a temporary
-- database) that a hand-run script does not.
--
-- The cost, stated rather than hidden: the identities below are a COPY of
-- src/config/users.ts as of this commit, not a reference to it, because SQL
-- cannot read a TypeScript module. That copy is deliberate and safe to let
-- age — a migration is history, and re-running history with a later array
-- would be a different operation. Adding a person later does not mean
-- editing this file; see "Adding a person who already has an account" in
-- docs/access-control.md for what to do instead.
-- src/lib/configured-user-reconciliation-migration.test.ts checks the one
-- thing that CAN drift silently: that each (name, handle) pair below is what
-- `configuredUserHandle` derives, and each identity is what
-- `parsePermittedEntry` parses.
--
-- IDEMPOTENT BY CONSTRUCTION, and tested by applying it twice. Every
-- statement is driven off the candidate set computed at the top, which after
-- a successful run contains one user per person — so the adoption writes the
-- values that are already there, and there are no strays left for the moves
-- or the delete to act on.
--
-- WHAT IT CANNOT DO: it never creates a user. Somebody in the array who has
-- never signed in has no row here and does not need one; their first sign-in
-- creates it with the handle already set.

-- ---------------------------------------------------------------------------
-- 1. The array, as of this commit. One row per (person, identity).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "_ConfiguredIdentitySeed";

CREATE TABLE "_ConfiguredIdentitySeed" (
    "handle"   TEXT NOT NULL,
    "name"     TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email"    TEXT NOT NULL
);

INSERT INTO "_ConfiguredIdentitySeed" ("handle", "name", "provider", "email") VALUES
    ('eirik',  'Eirik',  'google',   'eiriksanderfjeld@gmail.com'),
    ('eirik',  'Eirik',  'facebook', 'eirik@sander-fjeld.com'),
    ('gry',    'Gry',    'facebook', 'gry@sander-fjeld.no'),
    ('august', 'August', 'google',   'augustsanderfjeld@gmail.com');

-- ---------------------------------------------------------------------------
-- 2. Which existing users are each person.
--
-- Matched on the EXACT pair — the address stored on the user row AND an
-- Account row for that identity's provider — never on the address alone and
-- never on the domain (K5).
--
-- `lower(trim(...))` on BOTH halves, not only the address: `normalizeString`
-- in src/lib/sign-in-policy.ts canonicalises the provider id exactly as it
-- canonicalises the address, and normalising one here and not the other
-- would make this query answer a slightly different question from the gate's.
-- Neither is expected to matter for rows @auth/core wrote itself; both are
-- one function call.
--
-- A user with a NULL email matches nothing, because `lower(trim(NULL))` is
-- NULL and `NULL = 'addr'` is not true. That is the right answer — a row
-- with no address is not an identity anybody listed — and it is the fail-
-- closed direction.
--
-- Requiring the Account row is what keeps two different people apart when
-- they share an address at two providers: a Facebook-only user holding
-- `a@b.com` is not the person listed as `google:a@b.com`.
--
-- Unioned with any row that already carries the handle, so a second run (or
-- a partially-applied first one) sees the adopted row as a candidate too.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "_ConfiguredCandidate";

CREATE TABLE "_ConfiguredCandidate" (
    "handle" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    PRIMARY KEY ("handle", "userId")
);

INSERT INTO "_ConfiguredCandidate" ("handle", "userId")
SELECT s."handle", u."id"
FROM "_ConfiguredIdentitySeed" s
JOIN "User" u
  ON lower(trim(u."email")) = s."email"
JOIN "Account" a
  ON a."userId" = u."id" AND lower(trim(a."provider")) = s."provider"
UNION
SELECT u."configuredHandle", u."id"
FROM "User" u
WHERE u."configuredHandle" IN (SELECT "handle" FROM "_ConfiguredIdentitySeed");

-- THE K5 GUARD, and the reason this is a separate statement rather than a
-- clause: a user row that somehow matches two different people is dropped
-- from the candidate set entirely rather than assigned to whichever person
-- sorted first. Merging two humans into one account is the failure this
-- whole feature is built to prevent, and "do nothing and leave it for a
-- person to look at" is the only safe answer an automated merge can give.
DELETE FROM "_ConfiguredCandidate"
WHERE "userId" IN (
    SELECT "userId" FROM "_ConfiguredCandidate"
    GROUP BY "userId" HAVING COUNT(DISTINCT "handle") > 1
);

-- ---------------------------------------------------------------------------
-- 3. The surviving row for each person: the one that already carries the
--    handle if there is one, otherwise the oldest candidate.
--
-- Oldest rather than newest, so the account with the longest history is the
-- one that keeps its id — ids appear in `previews/{userId}/...` object keys
-- and in audit rows that are not rewritten anywhere else.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "_ConfiguredTarget";

CREATE TABLE "_ConfiguredTarget" (
    "handle" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL
);

INSERT INTO "_ConfiguredTarget" ("handle", "userId")
SELECT c."handle",
       COALESCE(
           (SELECT u."id" FROM "User" u WHERE u."configuredHandle" = c."handle"),
           (SELECT u2."id"
            FROM "User" u2
            JOIN "_ConfiguredCandidate" c2 ON c2."userId" = u2."id"
            WHERE c2."handle" = c."handle"
            ORDER BY u2."createdAt" ASC, u2."id" ASC
            LIMIT 1)
       )
FROM "_ConfiguredCandidate" c
GROUP BY c."handle";

-- Every candidate that is NOT the survivor, with the row it merges into.
DROP TABLE IF EXISTS "_ConfiguredStray";

CREATE TABLE "_ConfiguredStray" (
    "strayId"  TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL
);

INSERT INTO "_ConfiguredStray" ("strayId", "targetId")
SELECT c."userId", t."userId"
FROM "_ConfiguredCandidate" c
JOIN "_ConfiguredTarget" t ON t."handle" = c."handle"
WHERE c."userId" <> t."userId";

-- ---------------------------------------------------------------------------
-- 4. Adopt the survivor: stamp the handle and the configured display name.
--
-- Unconditional over the target set, which is what makes a second run a
-- no-op rather than a skipped branch: it writes the values that are already
-- there. (`User.updatedAt` is Prisma's `@updatedAt`, applied by the client,
-- not by a database trigger — raw SQL does not touch it, so even that column
-- is unchanged by a re-run.)
-- ---------------------------------------------------------------------------
UPDATE "User"
SET "configuredHandle" = (
        SELECT t."handle" FROM "_ConfiguredTarget" t WHERE t."userId" = "User"."id"
    ),
    "name" = (
        SELECT s."name"
        FROM "_ConfiguredIdentitySeed" s
        JOIN "_ConfiguredTarget" t ON t."handle" = s."handle"
        WHERE t."userId" = "User"."id"
        LIMIT 1
    )
WHERE "id" IN (SELECT "userId" FROM "_ConfiguredTarget");

-- ---------------------------------------------------------------------------
-- 5. Move everything the stray owns onto the survivor.
--
-- The bead names Media, Account and RoleChange. The rest of this list is the
-- sibling-omission sweep: every other column in the schema that holds a user
-- id, moved for the same reason, because a merge that moves three of ten
-- leaves the other seven pointing at a row step 6 deletes.
--
--   Account      the point of the exercise: both providers on one user
--   Session      moved rather than left to cascade, so nobody is signed out
--                by the merge. Each row carries its own signInProvider /
--                signInEmail (ugcportal-mzr) and is still judged on those
--   Media        the upload history
--   RoleChange   targetUserId AND actorUserId — the audit trail reads as
--                the person, from both directions
--   ResaleRightsEvent  the same two kinds of reference: actorUserId, and
--                subjectId when the subject is an uploader (it is a plain
--                string column, so the subjectKind guard is what keeps it
--                from rewriting an Instagram account's id)
--   InstagramAccount, ResaleRightsReview.reviewedByUserId,
--   MediaListing.triagedByUserId, MediaRightsClearance.clearedByUserId —
--                the remaining foreign keys. The three nullable ones are
--                ON DELETE SET NULL, so leaving them would not fail loudly;
--                it would silently blank the reviewer on a rights decision.
--
-- ResaleRightsReview.uploaderUserId is UNIQUE per user, so it can only move
-- when the survivor has no standing review of their own; when both have one
-- the stray's is left alone, which leaves a row pointing at the stray and so
-- blocks the delete in step 6. Two standing rights positions for one person
-- is a decision for a human, not for a migration.
-- ---------------------------------------------------------------------------
UPDATE "Account"
SET "userId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "Account"."userId")
WHERE "userId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "Session"
SET "userId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "Session"."userId")
WHERE "userId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "Media"
SET "userId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "Media"."userId")
WHERE "userId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "RoleChange"
SET "targetUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "RoleChange"."targetUserId")
WHERE "targetUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "RoleChange"
SET "actorUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "RoleChange"."actorUserId")
WHERE "actorUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "ResaleRightsEvent"
SET "actorUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "ResaleRightsEvent"."actorUserId")
WHERE "actorUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "ResaleRightsEvent"
SET "subjectId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "ResaleRightsEvent"."subjectId")
WHERE "subjectKind" = 'UPLOADER'
  AND "subjectId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "InstagramAccount"
SET "connectedByUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "InstagramAccount"."connectedByUserId")
WHERE "connectedByUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "ResaleRightsReview"
SET "reviewedByUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "ResaleRightsReview"."reviewedByUserId")
WHERE "reviewedByUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "MediaListing"
SET "triagedByUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "MediaListing"."triagedByUserId")
WHERE "triagedByUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "MediaRightsClearance"
SET "clearedByUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "MediaRightsClearance"."clearedByUserId")
WHERE "clearedByUserId" IN (SELECT "strayId" FROM "_ConfiguredStray");

UPDATE "ResaleRightsReview"
SET "uploaderUserId" = (SELECT s."targetId" FROM "_ConfiguredStray" s WHERE s."strayId" = "ResaleRightsReview"."uploaderUserId")
WHERE "uploaderUserId" IN (
    -- The strays whose survivor has no standing review of its own. Written
    -- as an uncorrelated set rather than a NOT EXISTS correlated back to
    -- `ResaleRightsReview` itself, which would have had two tables of the
    -- same name in scope and resolved to whichever SQLite preferred.
    SELECT s."strayId"
    FROM "_ConfiguredStray" s
    WHERE NOT EXISTS (
        SELECT 1 FROM "ResaleRightsReview" r WHERE r."uploaderUserId" = s."targetId"
    )
);

-- ---------------------------------------------------------------------------
-- 6. Delete the stray — but ONLY when nothing points at it any more.
--
-- The guard is not belt-and-braces. Account, Session, Media, InstagramAccount
-- and ResaleRightsReview.uploaderUserId all cascade, so deleting a stray that
-- still owns any of them destroys data silently rather than failing. A stray
-- that survives this step is inert (its accounts have moved, so nobody can
-- sign in as it) and visible — docs/access-control.md gives the query that
-- lists leftovers and says what to do about them.
-- ---------------------------------------------------------------------------
DELETE FROM "User"
WHERE "id" IN (SELECT "strayId" FROM "_ConfiguredStray")
  AND NOT EXISTS (SELECT 1 FROM "Account" x               WHERE x."userId"            = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "Session" x               WHERE x."userId"            = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "Media" x                 WHERE x."userId"            = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "InstagramAccount" x      WHERE x."connectedByUserId" = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "ResaleRightsReview" x    WHERE x."uploaderUserId"    = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "ResaleRightsReview" x    WHERE x."reviewedByUserId"  = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "MediaListing" x          WHERE x."triagedByUserId"   = "User"."id")
  AND NOT EXISTS (SELECT 1 FROM "MediaRightsClearance" x  WHERE x."clearedByUserId"   = "User"."id");

-- ---------------------------------------------------------------------------
-- 7. Clean up the working tables.
-- ---------------------------------------------------------------------------
DROP TABLE "_ConfiguredStray";
DROP TABLE "_ConfiguredTarget";
DROP TABLE "_ConfiguredCandidate";
DROP TABLE "_ConfiguredIdentitySeed";
