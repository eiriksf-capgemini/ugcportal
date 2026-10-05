import { defineConfig, devices } from "@playwright/test";

/**
 * A SEPARATE config from the root playwright.config.ts, on purpose
 * (ugcportal-akv6): K3 ("never link a draft page in production") is only
 * real evidence if it runs against an actual `next start` server —
 * `next dev` hard-codes NODE_ENV=development and cannot exercise the
 * production branch of src/lib/legal/publishable.ts's
 * `linkBlockedInProduction` at all (round-2 review: this comment named
 * `blockedInProduction`, a function that lived in src/components/
 * site-footer.tsx before round 1 moved the rule to publishable.ts).
 * Bundling that into the root config's single `npm run dev` webServer
 * would either weaken every other spec's dev-mode assumptions or force a
 * slow rebuild+restart on every e2e run in this repo, for the sake of one
 * check. A dedicated config, run on demand
 * (`npm run test:e2e:footer-draft-guard`), keeps the two concerns apart.
 *
 * Builds and starts the real production server on its own port (3100, so it
 * cannot collide with a `npm run dev` already running on 3000 for the other
 * suite) every run — this is deliberately not "start whatever `.next` is
 * already on disk": the whole point is to test the CODE THIS BRANCH SHIPS,
 * not a stale build from an earlier checkout.
 *
 * This config does NOT set or unset any LEGAL_* variable (see
 * src/lib/legal/publishable.ts) — `webServer.env` below only adds
 * NODE_ENV, so the spawned server inherits whatever the real environment
 * already has (round-2 review finding: an earlier version of this comment
 * claimed they were "deliberately left unset", which nothing here actually
 * enforces). The spec file's own tests are written to follow whatever that
 * turns out to be — reading each legal page's real draft status live
 * rather than assuming it — so this suite stays correct whether or not a
 * future run configures them.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && PORT=3100 npm run start",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: "production",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
