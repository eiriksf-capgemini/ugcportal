import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

// __dirname, not `fileURLToPath(import.meta.url)`: Playwright loads this
// config through its own CJS transform, where `import.meta` is not
// available at all (confirmed empirically — it threw `SyntaxError: Cannot
// use 'import.meta' outside a module` here).
const REPO_ROOT = path.resolve(__dirname, "..", "..");

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
 * KNOWN CAVEAT (round-3 review): the port is separate but `.next` is NOT —
 * `next build`'s output directory is a property of the checkout, not of
 * which command started the server, so this run and a concurrent or
 * subsequent `npm run dev` share (and overwrite) the same `.next`. Running
 * this suite while a dev server is also running against the same checkout
 * can leave either one looking at build output the other just replaced.
 * Not fixed here (a separate `--outputFileTracingRoot`/`distDir` adds real
 * config surface for a locally-run, on-demand suite); the mitigation today
 * is "don't run both against the same checkout at once" — fine for a
 * single developer, worth revisiting if this ever moves into CI.
 *
 * Also needs a MIGRATED database: `/`, `/about` and `/portfolio` all query
 * Prisma, and this suite's first test asserts every footer-linked target
 * answers exactly 200 — against an unmigrated `dev.db` those 500 instead
 * (`SQLITE_ERROR: no such table`), for a reason that has nothing to do with
 * K3. `npx prisma migrate deploy` runs before every build below:
 * idempotent (a no-op once the schema is current, per Prisma's own docs),
 * so it costs nothing on a checkout that's already migrated, and it fails
 * the whole webServer command — Playwright reports it as a startup
 * failure, not a silent 500 three steps later — on one that genuinely
 * can't reach its database at all.
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
    command: "npx prisma migrate deploy && npm run build && PORT=3100 npm run start",
    // Playwright's webServer defaults `cwd` to the directory the CONFIG
    // file lives in (this directory), not the repo root — harmless for
    // `npm run build`/`npm run start` (npm walks up to find package.json
    // on its own) but fatal for `npx prisma migrate deploy`, which does
    // NOT search upward for prisma/schema.prisma and fails with "Could
    // not find Prisma Schema" the moment it's added without this.
    cwd: REPO_ROOT,
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: "production",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
