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
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
