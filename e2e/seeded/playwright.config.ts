import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

// __dirname, not `fileURLToPath(import.meta.url)`: Playwright loads this
// config through its own CJS transform, where `import.meta` is not available
// at all — the same note e2e/production/playwright.config.ts carries, found
// the same way.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * A SEPARATE config from the root playwright.config.ts (ugcportal-qnq9.3 K6),
 * for the same reason e2e/production has one: the specs in this directory need
 * a different world from the rest of the suite.
 *
 * WHAT IS DIFFERENT HERE: these specs SEED PUBLISHED MEDIA. The root suite
 * cannot tolerate that — e2e/front-page.spec.ts asserts a genuinely empty
 * gallery, down to a `data-gallery-tile` count of 0 — and the root config runs
 * `fullyParallel`, so a seeding spec sitting beside it would make the two fail
 * each other nondeterministically depending on which worker got there first.
 * The root config therefore ignores `**!/seeded/**`, exactly as it already
 * ignores `**!/production/**`.
 *
 * `fullyParallel: false`, unlike the root config: every spec in this directory
 * reads the one public gallery that the one `beforeAll` seeded, and two
 * workers interleaving their seeds and cleanups over a single SQLite file is
 * not a race worth having for four assertions.
 *
 * ITS OWN PORT (3200), so this can run while a `npm run dev` is already
 * serving the root suite on 3000 — but NOT its own database: the spec writes
 * through Prisma to whatever DATABASE_URL resolves to, which is the same file
 * this server reads. That sharing is the point (it is how the seeded rows
 * reach the page) and also the caveat: this suite adds rows to a developer's
 * working database and removes them again in `afterAll`, including an
 * up-front cleanup so a crashed run does not poison the next one. It does not
 * touch any row it did not create — every id it writes is prefixed
 * `e2e-qnq9-3-`.
 *
 * `npm run dev` rather than a production build, unlike e2e/production: nothing
 * here depends on NODE_ENV, and `next dev` keeps the run to seconds. It also
 * runs `scripts/check-migrations.mjs` first (package.json's `dev` script), so
 * a database missing this bead's own columns fails as a startup error rather
 * than as a 500 three assertions later.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3200",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "PORT=3200 npm run dev",
    // Playwright defaults `cwd` to the config file's own directory; `npm run
    // dev` would still find package.json by walking up, but the dev script
    // spawns `prisma migrate status`, which does not search upward for
    // prisma/schema.prisma. The same trap e2e/production's config documents.
    cwd: REPO_ROOT,
    url: "http://localhost:3200",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
