/**
 * Resolve `.env*` files in the precedence order Next.js documents for
 * `next dev`, so scripts/check-migrations.mjs and prisma7.config.ts agree
 * with `next dev` about which database a bare DATABASE_URL names
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
 * instead of each hand-rolling it: for the mode `next dev` resolves to
 * (see `resolveDevMode` below -- "development" in the overwhelmingly common
 * case, but not unconditionally), highest precedence first, matching
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
 * `.env.local` outranks `.env.development`, not the other way around --
 * and, separately, spawns a real `node` subprocess (NODE_ENV unset, so
 * `@next/env` cannot take its own test-mode branch) to confirm the file
 * list below still matches what the installed `@next/env` itself reports
 * for `loadEnvConfig(dir, true)`. That subprocess check is what stands
 * behind "matches Next's order" as a live fact about the installed
 * dependency rather than a one-time reading of its source: a future Next
 * upgrade that changes this order would fail it, not silently drift past
 * a reimplementation nothing re-checks against the real package.
 */
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

/**
 * The mode `next dev` resolves `.env*` files under, for a given
 * environment -- mirroring `@next/env`'s own `processEnv`/`loadEnvConfig`
 * (`const c = process.env.NODE_ENV === "test"; const d = c ? "test" : dev
 * ? "development" : "production";`, called with `dev = true` for `next
 * dev`) rather than the common but WRONG assumption that `next dev` always
 * forces NODE_ENV to `"development"`.
 *
 * It does not: Next's own CLI (`node_modules/next/dist/bin/next`) only
 * fills in `NODE_ENV` when it is unset --
 * `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv` -- and warns
 * rather than override it otherwise. scripts/check-migrations.mjs and the
 * `next dev` it starts afterwards inherit the same shell environment, so
 * whatever NODE_ENV check-migrations.mjs sees (unset, "test", or anything
 * else) is exactly what `next dev`'s own env resolution sees too, modulo
 * Next's own unset -> "development" default -- which this function
 * reproduces so the two stay aligned in that case as well as the ordinary
 * one. The one value that changes the file list rather than just the
 * label is `"test"`: anything else behaves as "development" here, the same
 * as it does in `@next/env` for `dev = true`.
 *
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @returns {"development" | "test"}
 */
export function resolveDevMode(env = process.env) {
  return env.NODE_ENV === "test" ? "test" : "development";
}

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
 * `mode` defaults from `envTarget` itself (via `resolveDevMode`), not from
 * `process.env` unconditionally -- so a caller that passes its own
 * `envTarget` (a test fixture, or a resolved copy of `process.env`) gets a
 * mode computed from THAT environment, matching what `next dev` would
 * resolve to if it inherited the same one.
 *
 * @param {object} options
 * @param {string} options.cwd directory the `.env*` files are resolved against
 * @param {Record<string, string | undefined>} [options.envTarget] defaults to `process.env`
 * @param {string} [options.mode] defaults to `resolveDevMode(envTarget)`
 * @returns {{ env: Record<string, string | undefined>, loadedFiles: string[] }}
 */
export function loadDevEnvFiles({ cwd, envTarget = process.env, mode = resolveDevMode(envTarget) } = {}) {
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
