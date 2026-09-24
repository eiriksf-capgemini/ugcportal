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
    // Collect only this checkout's own tests. Vitest's defaultInclude globs
    // every *.test.* file under the repo root, and its defaultExclude covers
    // node_modules/dist/cypress and a short list of dot-directories — none of
    // which match .claude/. Agent worktrees live there, so without this a
    // local `vitest run` also collects sibling checkouts and reports their
    // stale failures as if they were yours. eslint.config.mjs already makes
    // the same carve-out for the same reason (ugcportal-97y).
    //
    // CI is unaffected either way: it checks out a clean tree with no
    // worktrees in it.
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...defaultExclude, ".claude/**"],
  },
});
