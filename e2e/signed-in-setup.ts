import { createClient } from "@libsql/client";
import type { FullConfig } from "@playwright/test";

import { assertSessionSeedingPermitted, seedSession } from "../scripts/lib/e2e-session-seeding.mjs";
import { loadDevEnvFiles } from "../scripts/lib/env-files.mjs";

/**
 * The root suite's globalSetup (ugcportal-0wh6): seed ONE signed-in session
 * for the whole run, before any test starts, and remove it after the last
 * one ends. e2e/signed-in-fixture.ts hands its cookie to each test that asks
 * for it.
 *
 * Once per run rather than once per test, because of SQLite. The first
 * version of the fixture wrote a User and a Session per test, and under this
 * suite's `fullyParallel` those writes landed while other workers' pages were
 * reading the same file: in one of three full runs, four or five signed-in
 * tests failed on SQLITE_BUSY in the fixture and "Operation has timed out" on
 * the server's session read, and their cleanup failed the same way, leaving
 * rows behind. Seeded here, the write happens after the dev server is up
 * (Playwright runs its plugin setup, `webServer` included, before
 * globalSetup: `createGlobalSetupTasks` in playwright/lib/runner) but before any test sends
 * it a request, and nothing in the run writes to it again until teardown. A
 * session that lives the full Auth.js maxAge is also never rewritten by the
 * server when it is read (see seedSession's comment).
 *
 * A REFUSAL IS RECORDED, NOT THROWN. seedSession refuses a production
 * NODE_ENV, a remote DATABASE_URL or a non-loopback base URL. Throwing here
 * would fail every spec in the suite, signed-out ones included, for a reason
 * only the signed-in ones care about; instead the reason goes to the workers
 * through the environment and the fixture fails exactly the tests that asked
 * to be signed in, with that reason as the message.
 */

/** How the seeded session reaches the worker processes, which Playwright
 * starts after this setup has run and which inherit its environment. */
export const SIGNED_IN_ENV = "UGCPORTAL_E2E_SIGNED_IN_SESSION";

export type SignedInHandoff =
  | { ok: true; userId: string; cookie: { name: string; value: string; url: string; httpOnly: boolean; sameSite: "Lax" } }
  | { ok: false; reason: string };

export default async function signedInSetup(config: FullConfig) {
  // The same `.env*` precedence `next dev` uses, so the rows land in the file
  // the server under test is reading (as e2e/seeded/alcohol-commerce.spec.ts).
  loadDevEnvFiles({ cwd: process.cwd() });
  const baseURL = config.projects[0]?.use.baseURL;

  try {
    // Before opening a connection at all; seedSession checks again before it
    // writes, and that second check is the one the vitest guard
    // (scripts/lib/e2e-session-seeding.test.mjs) proves.
    assertSessionSeedingPermitted({ env: process.env, baseURL });
  } catch (error) {
    const refused: SignedInHandoff = { ok: false, reason: String(error) };
    process.env[SIGNED_IN_ENV] = JSON.stringify(refused);
    return undefined;
  }

  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
  let seeded: Awaited<ReturnType<typeof seedSession>>;
  try {
    // Wait out a lock rather than fail on it at once: the dev server has
    // just started and may still be reading this file.
    await db.execute("PRAGMA busy_timeout = 10000");
    seeded = await seedSession({ db, env: process.env, baseURL });
  } catch (error) {
    db.close();
    throw error;
  }
  const handoff: SignedInHandoff = { ok: true, userId: seeded.userId, cookie: seeded.cookie };
  process.env[SIGNED_IN_ENV] = JSON.stringify(handoff);

  // Returned function = Playwright's global teardown for this setup.
  return async () => {
    try {
      await seeded.cleanup();
    } finally {
      db.close();
    }
  };
}
