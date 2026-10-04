-- User.configuredHandle (ugcportal-t33p): which configured person this row
-- is, as the stable handle derived from `name` in src/config/users.ts. It is
-- the only key a configured person's user row is looked up by at sign-in,
-- and deliberately not their e-mail address — one person with two providers
-- has two addresses, which is the split this column exists to remove.
--
-- SCHEMA ONLY. Moving rows that are already split is the separate, re-runnable
-- migration that follows this one (20261005120500_reconcile_configured_users),
-- kept apart so that one can be re-applied to prove it changes nothing on a
-- second run while this one — an ADD COLUMN — cannot be.
--
-- RUN THIS MIGRATION BEFORE DEPLOYING THE CODE THAT READS IT, the same order
-- 20261004180000_add_session_sign_in_identity documents and for the same
-- reason: the Prisma client generated from the current schema selects every
-- scalar column it knows about, so a new client against an un-migrated
-- database fails every `User` read — which includes every `auth()` call, for
-- everybody, including the operator.
--
-- WHAT HAPPENS TO ROWS THAT ALREADY EXIST: they get NULL, and NULL is the
-- ordinary, permanent state for anyone who is not in the users array. SQLite
-- permits any number of NULLs under a UNIQUE index, so "unique among
-- configured people, absent for everyone else" needs no partial index.
--
-- A user who IS in the array and already has a row keeps NULL until the
-- reconciliation migration below adopts them. Until that runs, their next
-- sign-in through a NEW provider creates a second user — exactly today's
-- behaviour, nothing worse — and the reconciliation then merges it.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "configuredHandle" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_configuredHandle_key" ON "User"("configuredHandle");
