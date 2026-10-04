import { defineConfig, devices } from "@playwright/test";

/**
 * A SEPARATE config from the root playwright.config.ts, on purpose
 * (ugcportal-akv6): K3 ("never link a draft page in production") is only
 * real evidence if it runs against an actual `next start` server —
 * `next dev` hard-codes NODE_ENV=development and cannot exercise the
 * production branch of src/components/site-footer.tsx's
 * `blockedInProduction` at all. Bundling that into the root config's single
 * `npm run dev` webServer would either weaken every other spec's dev-mode
 * assumptions or force a slow rebuild+restart on every e2e run in this repo,
 * for the sake of one check. A dedicated config, run on demand
 * (`npm run test:e2e:footer-draft-guard`), keeps the two concerns apart.
 *
 * Builds and starts the real production server on its own port (3100, so it
 * cannot collide with a `npm run dev` already running on 3000 for the other
 * suite) every run — this is deliberately not "start whatever `.next` is
 * already on disk": the whole point is to test the CODE THIS BRANCH SHIPS,
 * not a stale build from an earlier checkout.
 *
 * LEGAL_* variables are deliberately left UNSET here (see
 * src/lib/legal/publishable.ts): that is today's actual deployment
 * reality — nothing sets them in this worktree — and it is the harder of
 * the two cases for K3 to get right (/privacy and /licence 500 outright;
 * the footer must still not have linked them before that failure). See the
 * spec file for the easier case (signed-off legal pages) documented as a
 * known gap.
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
