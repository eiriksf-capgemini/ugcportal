import { test as base } from "@playwright/test";

import { SIGNED_IN_ENV, type SignedInHandoff } from "./signed-in-setup";

/**
 * A Playwright `test` whose specs can ask to start signed in (ugcportal-0wh6).
 *
 *   import { signedInTest as test } from "./signed-in-fixture";
 *   test("...", async ({ page, signedIn }) => { ... });
 *
 * Requesting `signedIn` is what signs the test in: the fixture puts the
 * session cookie into the test's browser context before the test body runs.
 * The session itself is a real database row, seeded once for the run by the
 * root config's globalSetup (e2e/signed-in-setup.ts); how that works, and why
 * it is not a route, is scripts/lib/e2e-session-seeding.mjs's comment. A test
 * that does not name `signedIn` stays signed out, so importing this file
 * changes nothing for one that does not ask.
 *
 * Needs the dev server THIS config started: the root playwright.config.ts
 * allowlists the seeded identity for it. Against a reused server
 * (UGCPORTAL_E2E_REUSE_SERVER=1) the session is refused and the page renders
 * signed out, so the signed-in assertions fail.
 */
export const signedInTest = base.extend<{ signedIn: { userId: string } }>({
  // The second argument is Playwright's `use`, named `provide` here only because
  // eslint's React rules-of-hooks reads a function called `use` as a hook.
  signedIn: async ({ context }, provide) => {
    const raw = process.env[SIGNED_IN_ENV];
    if (raw === undefined) {
      throw new Error(
        `${SIGNED_IN_ENV} is not set: signedIn needs e2e/signed-in-setup.ts as the config's globalSetup (the root playwright.config.ts has it).`,
      );
    }
    const handoff = JSON.parse(raw) as SignedInHandoff;
    if (!handoff.ok) {
      throw new Error(`no signed-in session for this run: ${handoff.reason}`);
    }
    await context.addCookies([handoff.cookie]);
    await provide({ userId: handoff.userId });
  },
});
