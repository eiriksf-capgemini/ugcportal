import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * The Session.signInProvider backfill
 * (prisma/migrations/20261004180000_add_session_sign_in_identity), against a
 * REAL database rather than asserting on the SQL file's text.
 *
 * What it has to get right is not "did a column appear" but which sessions
 * get a value and which deliberately do not, because NULL is not inert here:
 * it is read as an unrecognised provider and therefore REVOKES the session
 * on its next request if the allowlist entry that permits it is
 * provider-bound (ugcportal-mzr). A backfill that missed would log the
 * operator out of their own instance on the deploy that carried it; one that
 * guessed would keep a session alive through a provider the operator did not
 * name. Both are silent, and neither is visible in the SQL's own comments.
 *
 * So this file seeds rows the way they existed BEFORE this migration,
 * applies only this migration, and reads the columns back.
 */

const MIGRATION_NAME = "20261004180000_add_session_sign_in_identity";

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

/**
 * A user with `providers` linked accounts and one session, seeded the way
 * they existed before this migration: no identity columns on Session yet.
 */
async function seedUser(id: string, providers: string[]): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "createdAt", "updatedAt")
     VALUES ('${id}', '${id}@example.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  for (const provider of providers) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Account"
         ("id", "userId", "type", "provider", "providerAccountId")
       VALUES ('account-${id}-${provider}', '${id}', 'oauth', '${provider}',
               'sub-${id}-${provider}')`,
    );
  }
  // Two sessions each, because the backfill is per SESSION: a user with one
  // linked provider must have both of theirs attributed, not just the one
  // some `LIMIT 1` happened to reach.
  for (const suffix of ["a", "b"]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Session" ("id", "sessionToken", "userId", "expires")
       VALUES ('session-${id}-${suffix}', 'token-${id}-${suffix}', '${id}',
               '2026-12-01 00:00:00')`,
    );
  }
}

beforeAll(async () => {
  // Stop one migration short: the real "before this bead" state.
  await applyMigrations(prisma, { stopBefore: MIGRATION_NAME });

  await seedUser("user-google", ["google"]);
  await seedUser("user-facebook", ["facebook"]);
  // Two linked providers. Reachable once ugcportal-t33p lands; already
  // reachable today by linking the same address at both providers.
  await seedUser("user-both", ["google", "facebook"]);
  // No Account row at all — a user whose provider link was removed.
  await seedUser("user-none", []);

  await applyMigration(prisma, MIGRATION_NAME);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

function identitiesOf(userId: string) {
  return prisma.session.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: { signInProvider: true, signInEmail: true },
  });
}

describe("the session identity backfill", () => {
  it("attributes every session of a user with exactly one linked account", async () => {
    // The whole point: these keep their sessions through the deploy, because
    // a bound entry can still match them.
    await expect(identitiesOf("user-google")).resolves.toEqual([
      { signInProvider: "google", signInEmail: null },
      { signInProvider: "google", signInEmail: null },
    ]);
    await expect(identitiesOf("user-facebook")).resolves.toEqual([
      { signInProvider: "facebook", signInEmail: null },
      { signInProvider: "facebook", signInEmail: null },
    ]);
  });

  it("leaves a user with two linked providers unattributed, rather than guessing", async () => {
    // NULL costs them one sign-in per device. A guess could keep a session
    // alive through the provider the operator did NOT bind the entry to,
    // which is the thing provider binding exists to prevent.
    await expect(identitiesOf("user-both")).resolves.toEqual([
      { signInProvider: null, signInEmail: null },
      { signInProvider: null, signInEmail: null },
    ]);
  });

  it("leaves a user with no linked account unattributed", async () => {
    await expect(identitiesOf("user-none")).resolves.toEqual([
      { signInProvider: null, signInEmail: null },
      { signInProvider: null, signInEmail: null },
    ]);
  });

  it("writes no address at all, leaving that to the fallback", async () => {
    // `signInEmail` is deliberately not backfilled: a null address falls
    // back to `User.email` in src/lib/live-session.ts, which is the exact
    // address the check judged before this column existed. Asserted rather
    // than only commented, because "the migration quietly filled it in too"
    // would make the fallback dead code nobody notices is dead.
    const rows = await prisma.session.findMany({
      select: { signInEmail: true },
    });
    expect(rows).not.toHaveLength(0);
    expect(rows.every((row) => row.signInEmail === null)).toBe(true);
  });
});
