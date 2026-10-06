import { defineConfig, devices } from "@playwright/test";

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
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
