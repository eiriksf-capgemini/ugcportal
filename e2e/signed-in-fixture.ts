import { createClient } from "@libsql/client";
import { test as base } from "@playwright/test";

import { assertSessionSeedingPermitted, seedSession } from "../scripts/lib/e2e-session-seeding.mjs";
import { loadDevEnvFiles } from "../scripts/lib/env-files.mjs";

/**
 * A Playwright `test` whose specs can ask to start signed in (ugcportal-0wh6).
 *
 *   import { expect, signedInTest as test } from "./signed-in-fixture";
 *   test("...", async ({ page, signedIn }) => { ... });
 *
 * Requesting `signedIn` is what signs the test in: the fixture writes a
 * throwaway User and Session to the dev server's database, puts the session
 * cookie into the test's browser context before the test body runs, and
 * deletes both rows afterwards. A test that does not name `signedIn` stays
 * signed out, so importing this file changes nothing for one that does not
 * ask. How the mechanism works, and why it is not a route, is
 * scripts/lib/e2e-session-seeding.mjs's comment.
 *
 * Needs the dev server THIS config started: the root playwright.config.ts
 * allowlists the seeded identity for it. Against a reused server
 * (UGCPORTAL_E2E_REUSE_SERVER=1) the session is refused and the page renders
 * signed out.
 */

// The same `.env*` precedence `next dev` uses, so the rows land in the file
// the server under test is reading (as e2e/seeded/alcohol-commerce.spec.ts).
loadDevEnvFiles({ cwd: process.cwd() });

export const signedInTest = base.extend<{ signedIn: { userId: string } }>({
  // The second argument is Playwright's `use`, named `provide` here only because
  // eslint's React rules-of-hooks reads a function called `use` as a hook.
  signedIn: async ({ context, baseURL }, provide) => {
    // Refuse before even opening a connection; seedSession checks again
    // before it writes, and that second check is the one the vitest guard
    // (scripts/lib/e2e-session-seeding.test.mjs) proves.
    assertSessionSeedingPermitted({ env: process.env, baseURL });
    const db = createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
    try {
      // This suite runs `fullyParallel`, so several workers write here at
      // once while the dev server reads the same file. Without a busy
      // timeout the second writer fails at once with SQLITE_BUSY (observed
      // on the first parallel run of this fixture) instead of waiting its
      // turn.
      await db.execute("PRAGMA busy_timeout = 10000");
      const seeded = await seedSession({ db, env: process.env, baseURL });
      try {
        await context.addCookies([seeded.cookie]);
        await provide({ userId: seeded.userId });
      } finally {
        await seeded.cleanup();
      }
    } finally {
      db.close();
    }
  },
});

export { expect } from "@playwright/test";
