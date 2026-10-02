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
    exclude: [...defaultExclude, ".claude/**", "e2e/**"],
  },
});
