import path from "node:path";

import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Removes host environment variables that would otherwise change how
    // the watermark concurrency gate sizes itself, and so whether unrelated
    // tests pass (ugcportal-e86). See the file for the specific failures.
    setupFiles: ["./vitest.setup.ts"],
    // Vitest's defaultExclude covers node_modules, dist, cypress and a short
    // list of dot-directories — none of which match .claude/, where agent
    // worktrees live. Without this, a local `vitest run` also collects those
    // sibling checkouts and reports their stale failures as if they were
    // yours (ugcportal-97y). eslint.config.mjs ignores .claude/worktrees/**
    // for the same reason; this is deliberately broader, since no
    // first-party test lives anywhere under .claude/.
    //
    // Left as an exclude rather than a narrow `include` on purpose: an
    // `include` of src/** would silently stop collecting any future test
    // outside src/ (prisma/seed.test.ts, scripts/, a root tests/ dir) and,
    // because src/ still matches, `passWithNoTests` would never fire to
    // tell anyone — CI would go green with that suite never having run.
    //
    // CI is unaffected either way: it checks out a clean tree with no
    // worktrees in it.
    // e2e/** holds Playwright specs (ugcportal-rw9j's axe-core checks),
    // which use @playwright/test's own `test()`/`expect()` and a real
    // browser + dev server (see playwright.config.ts) - vitest's default
    // test-file glob would otherwise try to collect and run them itself.
    //
    // .next/** is Next's build output. A local `npm run build` makes
    // Turbopack trace the whole project (schema-mismatch.ts's readdirSync
    // over the migrations dir defeats its static analysis - see that file)
    // and copies every src/**/*.test.* into .next/standalone. Without this,
    // a `vitest run` in the same tree after a build collects that copy as a
    // second, broken suite - double-counting real tests and failing ones
    // that depend on dev-only tooling absent from the production-shaped
    // .next/standalone (ugcportal-l99p). Nothing first-party ever lives
    // under .next/, so the same "exclude the whole directory" reasoning
    // above applies here too, not just a narrower .next/standalone/**.
    exclude: [...defaultExclude, ".claude/**", "e2e/**", ".next/**"],
  },
});
