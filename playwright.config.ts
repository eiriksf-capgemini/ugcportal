import { defineConfig, devices } from "@playwright/test";

import { E2E_SIGNED_IN_EMAIL } from "./scripts/lib/e2e-session-seeding.mjs";

/**
 * Browser verification for the petrol palette (ugcportal-rw9j), K1/K2.
 *
 * Not wired into the `quality` CI job in this PR: that job runs lint/test/
 * build/typecheck against no running server and no database, and this suite
 * needs both (`npm run dev` against a real `prisma db push`'d SQLite file,
 * per the bead's own verification plan: "npm run dev mot localhost:3000").
 * It is a locally (and manually, for now) run check, same as the bead
 * describes — a CI job for it is a reasonable fase-2-or-later follow-up, not
 * something this phase's scope requires.
 */
export default defineConfig({
  testDir: "./e2e",
  // e2e/production/* is a DIFFERENT suite with its own config and its own
  // real `next start` server on a different port (ugcportal-akv6's K3
  // check) — testDir's default recursive scan would otherwise also pick up
  // those specs here and run them against this config's `npm run dev`
  // server, which is a different NODE_ENV and would make a production-only
  // assertion fail for the wrong reason. Run that suite explicitly with
  // `npm run test:e2e:footer-draft-guard` instead.
  //
  // e2e/seeded/* is a THIRD suite, ignored here for a different reason
  // (ugcportal-qnq9.3 K6): those specs seed PUBLISHED media, and
  // e2e/front-page.spec.ts below asserts a genuinely empty gallery. With
  // `fullyParallel` on, leaving them in this suite would make the two fail
  // each other depending on worker order. Run that one explicitly with
  // `npm run test:e2e:alcohol-commerce`.
  testIgnore: ["**/production/**", "**/seeded/**"],
  // ugcportal-0wh6: seeds the one signed-in session e2e/signed-in-fixture.ts
  // hands to the tests that ask for it, and removes it after the run.
  globalSetup: "./e2e/signed-in-setup.ts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    /**
     * ugcportal-6uxr K3: `true` unconditionally (as this shipped originally)
     * means Playwright never checks whose server is already answering at
     * `url` before reusing it — on a machine where several agents run e2e
     * concurrently against the same port, that is attaching to a FOREIGN dev
     * server (a different worktree's checkout, a different branch) rather
     * than this suite's own, which produces spurious mass failures with no
     * indication the server under test was ever the wrong one. Gated behind
     * `UGCPORTAL_E2E_REUSE_SERVER` so the default is the safe one (always
     * start this config's own server, on this config's own command) and
     * reuse is an explicit opt-in (`UGCPORTAL_E2E_REUSE_SERVER=1`) for a
     * solo developer who already has `npm run dev` running and wants a
     * faster local rerun. playwright.config.test.ts asserts both states.
     */
    reuseExistingServer: process.env["UGCPORTAL_E2E_REUSE_SERVER"] === "1",
    timeout: 60_000,
    /**
     * ugcportal-0wh6: the dev server this config starts gets an
     * ALLOWED_SIGNIN_EMAILS of exactly the identity e2e/signed-in-setup.ts
     * seeds once per run (ADMIN_BOOTSTRAP_EMAILS and src/config/users.ts still apply as
     * they always do). The
     * live-session check (src/lib/live-session.ts) re-judges every request
     * against ALLOWED_SIGNIN_EMAILS, so without this a seeded session would
     * be refused and its spec would see a signed-out page. Set here, on the
     * spawned process, it outranks any value in the developer's `.env*`
     * files for this one spawned server and no other process. A REUSED server
     * (above) does not get it, which is the safe direction to be wrong in:
     * signed-in specs then fail rather than pass. playwright.config.test.ts
     * asserts the value.
     */
    env: { ALLOWED_SIGNIN_EMAILS: E2E_SIGNED_IN_EMAIL },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
