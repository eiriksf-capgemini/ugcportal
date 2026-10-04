import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * The User.signInProvider backfill
 * (prisma/migrations/20261004170000_add_user_sign_in_provider), against a
 * REAL database rather than asserting on the SQL file's text.
 *
 * What it has to get right is not "did a column appear" but who gets a value
 * and who deliberately does not, because NULL is not inert here: it is read
 * as an unrecognised provider and therefore REVOKES the live session of
 * anyone whose allowlist entry is provider-bound (ugcportal-mzr). A backfill
 * that missed would log the operator out of their own instance on the deploy
 * that carried it; one that guessed would hand an ambiguous user a provider
 * they may not have signed in with. Both are silent, and neither is visible
 * in the SQL's own comments.
 *
 * So this file seeds rows the way they existed BEFORE this migration,
 * applies only this migration, and reads the column back.
 */

const MIGRATION_NAME = "20261004170000_add_user_sign_in_provider";

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

/** Seeded before the migration ran: no signInProvider column exists yet. */
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

function providerOf(id: string): Promise<string | null | undefined> {
  return prisma.user
    .findUnique({ where: { id }, select: { signInProvider: true } })
    .then((row) => row?.signInProvider);
}

describe("the signInProvider backfill", () => {
  it("records the provider of a user with exactly one linked account", async () => {
    // The whole point: these two keep their live sessions through the
    // deploy, because a bound entry can still match them.
    await expect(providerOf("user-google")).resolves.toBe("google");
    await expect(providerOf("user-facebook")).resolves.toBe("facebook");
  });

  it("leaves a user with two linked providers unset, rather than guessing", async () => {
    // NULL costs them one sign-in. A guess could keep a session alive
    // through the provider the operator did NOT bind the entry to, which is
    // the thing provider binding exists to prevent.
    await expect(providerOf("user-both")).resolves.toBeNull();
  });

  it("leaves a user with no linked account unset", async () => {
    await expect(providerOf("user-none")).resolves.toBeNull();
  });
});
