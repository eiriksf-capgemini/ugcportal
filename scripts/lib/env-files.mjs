/**
 * Resolve `.env*` files in the exact precedence order Next.js uses for
 * `next dev`, so scripts/check-migrations.mjs and prisma7.config.ts never
 * disagree with `next dev` about which database a bare DATABASE_URL names
 * (ugcportal-h2yd).
 *
 * WHY THIS EXISTS: prisma7.config.ts used to carry a bare
 * `import "dotenv/config"`, which only ever reads `.env` in the current
 * working directory. `next dev` reads `.env`, `.env.local`,
 * `.env.development` and `.env.development.local` together, with later
 * files in that list overriding earlier ones for the same key. A developer
 * whose DATABASE_URL lives only in `.env.local` therefore got migrations
 * applied by `scripts/check-migrations.mjs` (via that bare dotenv/config)
 * to Prisma's own fallback `file:./dev.db`, while `next dev` read
 * `.env.local`'s DATABASE_URL and queried a different, unmigrated database
 * -- "no such table: main.Media" on a tree that had just been migrated,
 * reproduced 2026-10-06.
 *
 * THE ORDER, documented here once and reused by both of this repo's own
 * readers of DATABASE_URL (scripts/check-migrations.mjs, prisma7.config.ts)
 * instead of each hand-rolling it: for `mode = "development"` (what
 * `next dev` always runs as, regardless of any NODE_ENV already in the
 * environment -- Next forces it), highest precedence first, matching
 * https://nextjs.org/docs/app/building-your-application/configuring/environment-variables#environment-variable-load-order:
 *
 *   1. process.env                  (whatever the shell/CI already set)
 *   2. .env.development.local
 *   3. .env.local
 *   4. .env.development
 *   5. .env
 *
 * `.env.local` is skipped entirely when `mode === "test"`, mirroring
 * Next's own behaviour (its docs: ".env.local... Not checked when NODE_ENV
 * is test.").
 *
 * NOT implemented by calling `@next/env`'s own `loadEnvConfig` directly,
 * even though that is the package Next itself uses: that function reads
 * `process.env.NODE_ENV` internally and switches to `mode = "test"`
 * whenever it is already `"test"`, with no way to override it -- which
 * would make this exact precedence untestable from inside vitest (vitest
 * itself sets NODE_ENV=test), silently dropping `.env.local` the moment a
 * test tried to exercise it. Reimplemented instead, directly against the
 * documented order above, taking `mode` as an explicit parameter so a test
 * can assert the "development" precedence `next dev` actually uses no
 * matter which test runner is driving it. scripts/lib/env-files.test.mjs
 * asserts this order, including the one non-obvious step in it: a bare
 * `.env.local` outranks `.env.development`, not the other way around.
 */
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

/** The mode `next dev` always runs as, whatever NODE_ENV says. */
export const DEV_MODE = "development";

/**
 * The `.env*` file names this resolves, highest precedence first, for a
 * given mode. Exported so a test can assert the order directly, not just
 * its effect.
 *
 * @param {string} mode
 * @returns {string[]}
 */
export function envFileNamesForMode(mode) {
  return [
    `.env.${mode}.local`,
    mode !== "test" ? ".env.local" : null,
    `.env.${mode}`,
    ".env",
  ].filter((name) => name !== null);
}

/**
 * Load every `.env*` file for `mode` found in `cwd`, in precedence order,
 * into `envTarget` -- without overwriting a key `envTarget` already has
 * (whether set by the real shell environment or, for the files already
 * processed this call, by a higher-precedence file).
 *
 * Mutates and returns `envTarget` so a caller can pass `process.env`
 * directly and read the result straight back off it, matching how
 * `dotenv/config` and `@next/env`'s `loadEnvConfig` both behave.
 *
 * @param {object} options
 * @param {string} options.cwd directory the `.env*` files are resolved against
 * @param {string} [options.mode]
 * @param {Record<string, string | undefined>} [options.envTarget] defaults to `process.env`
 * @returns {{ env: Record<string, string | undefined>, loadedFiles: string[] }}
 */
export function loadDevEnvFiles({ cwd, mode = DEV_MODE, envTarget = process.env } = {}) {
  const loadedFiles = [];
  for (const fileName of envFileNamesForMode(mode)) {
    let contents;
    try {
      contents = fs.readFileSync(path.join(cwd, fileName), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    loadedFiles.push(fileName);
    const parsed = dotenv.parse(contents);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in envTarget)) {
        envTarget[key] = value;
      }
    }
  }
  return { env: envTarget, loadedFiles };
}
