/**
 * Tests for the shared `.env*` precedence resolver (ugcportal-h2yd). Every
 * fixture here is a real temp directory with real files on disk, read
 * through `loadDevEnvFiles` exactly as scripts/check-migrations.mjs and
 * prisma7.config.ts do — not a mocked `fs`, so a change to the file-reading
 * code itself is exercised, not just the merge logic.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envFileNamesForMode, loadDevEnvFiles, resolveDevMode } from "./env-files.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The file list the INSTALLED `@next/env` package itself reports for
 * `loadEnvConfig(targetDir, true)` -- run in a real `node` subprocess with
 * NODE_ENV deleted, because `@next/env` reads `process.env.NODE_ENV`
 * internally and takes its own `mode = "test"` branch (dropping
 * `.env.local`) whenever it is already `"test"` -- which, in this repo's
 * vitest run, it is (see the "resolveDevMode" describe block below, which
 * asserts `process.env.NODE_ENV === "test"` directly). Spawning is what
 * makes this a live comparison against the dependency as installed, not a
 * reading of its source from whenever this comment was written.
 *
 * @param {string} targetDir
 * @returns {string[]}
 */
function loadedFilesFromRealNextEnv(targetDir) {
  const script =
    'const { loadEnvConfig } = require("@next/env");' +
    `const result = loadEnvConfig(${JSON.stringify(targetDir)}, true);` +
    "process.stdout.write(JSON.stringify(result.loadedEnvFiles.map((f) => f.path)));";
  const childEnv = { ...process.env };
  delete childEnv.NODE_ENV;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

/** @type {string} */
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-env-files-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(fileName, contents) {
  fs.writeFileSync(path.join(dir, fileName), contents);
}

describe("envFileNamesForMode", () => {
  it("orders development mode highest-precedence first, matching Next's documented order", () => {
    expect(envFileNamesForMode("development")).toEqual([
      ".env.development.local",
      ".env.local",
      ".env.development",
      ".env",
    ]);
  });

  it("drops .env.local for test mode, matching Next (not checked when NODE_ENV is test)", () => {
    expect(envFileNamesForMode("test")).toEqual([".env.test.local", ".env.test", ".env"]);
  });
});

describe("resolveDevMode", () => {
  it("is development when NODE_ENV is unset -- Next's CLI defaults an UNSET NODE_ENV to development for `next dev`", () => {
    expect(resolveDevMode({})).toBe("development");
  });

  it("is test when NODE_ENV is already test -- Next's CLI does NOT override an already-set NODE_ENV", () => {
    expect(resolveDevMode({ NODE_ENV: "test" })).toBe("test");
  });

  it("is development for any other already-set NODE_ENV, matching @next/env's own dev=true branch", () => {
    // Only "test" changes the file list (@next/env: `const d = c ? "test" :
    // dev ? "development" : "production"`, with `dev` always true for `next
    // dev`) -- "production", "staging", anything else all take the same
    // "development" file list as unset, even though Next's CLI warns about
    // some of these values rather than silently accepting them.
    for (const NODE_ENV of ["production", "development", "staging", ""]) {
      expect(resolveDevMode({ NODE_ENV })).toBe("development");
    }
  });

  it("defaults to reading process.env -- which vitest itself sets to test", () => {
    expect(resolveDevMode()).toBe(process.env.NODE_ENV === "test" ? "test" : "development");
    expect(process.env.NODE_ENV).toBe("test");
  });
});

describe("loadDevEnvFiles", () => {
  it("reads a DATABASE_URL set only in .env.local (the reported bug's exact fixture)", () => {
    write(".env.local", 'DATABASE_URL="file:./local-only.db"\n');
    const { env, loadedFiles } = loadDevEnvFiles({ cwd: dir, envTarget: {} });
    expect(env.DATABASE_URL).toBe("file:./local-only.db");
    expect(loadedFiles).toEqual([".env.local"]);
  });

  it("returns undefined when no .env* file sets the key and none is already present", () => {
    const { env } = loadDevEnvFiles({ cwd: dir, envTarget: {} });
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("never reads a file that isn't there, and doesn't throw for a missing directory entry", () => {
    const { loadedFiles } = loadDevEnvFiles({ cwd: dir, envTarget: {} });
    expect(loadedFiles).toEqual([]);
  });

  it("full precedence order: .env.development.local > .env.local > .env.development > .env", () => {
    write(".env", "DATABASE_URL=file:env.db\n");
    write(".env.development", "DATABASE_URL=file:env-development.db\n");
    write(".env.local", "DATABASE_URL=file:env-local.db\n");
    write(".env.development.local", "DATABASE_URL=file:env-development-local.db\n");

    expect(loadDevEnvFiles({ cwd: dir, envTarget: {} }).env.DATABASE_URL).toBe(
      "file:env-development-local.db",
    );
  });

  it("the non-obvious step: .env.local outranks .env.development, not the other way around", () => {
    // This is the one ordering a naive "later filename in the docs wins"
    // reading gets backwards -- .env.local is step 3 in Next's own list,
    // ahead of .env.development at step 4, even though "development" sounds
    // more specific than "local".
    write(".env", "DATABASE_URL=file:env.db\n");
    write(".env.development", "DATABASE_URL=file:env-development.db\n");
    write(".env.local", "DATABASE_URL=file:env-local.db\n");

    expect(loadDevEnvFiles({ cwd: dir, envTarget: {} }).env.DATABASE_URL).toBe(
      "file:env-local.db",
    );
  });

  it("falls through to .env.development when .env.local is absent", () => {
    write(".env", "DATABASE_URL=file:env.db\n");
    write(".env.development", "DATABASE_URL=file:env-development.db\n");

    expect(loadDevEnvFiles({ cwd: dir, envTarget: {} }).env.DATABASE_URL).toBe(
      "file:env-development.db",
    );
  });

  it("falls through to .env when nothing more specific exists", () => {
    write(".env", "DATABASE_URL=file:env.db\n");
    expect(loadDevEnvFiles({ cwd: dir, envTarget: {} }).env.DATABASE_URL).toBe("file:env.db");
  });

  it("never overrides a key already present in envTarget (process.env always wins)", () => {
    write(".env.local", "DATABASE_URL=file:env-local.db\n");
    const envTarget = { DATABASE_URL: "file:already-set.db" };
    expect(loadDevEnvFiles({ cwd: dir, envTarget }).env.DATABASE_URL).toBe(
      "file:already-set.db",
    );
  });

  it("does not read .env.local at all in test mode", () => {
    write(".env.local", "DATABASE_URL=file:env-local.db\n");
    write(".env", "DATABASE_URL=file:env.db\n");
    const { env, loadedFiles } = loadDevEnvFiles({ cwd: dir, mode: "test", envTarget: {} });
    expect(env.DATABASE_URL).toBe("file:env.db");
    expect(loadedFiles).toEqual([".env"]);
  });

  it("picks test mode from envTarget.NODE_ENV on its own, with no explicit mode passed", () => {
    // Nothing passes `mode` here -- this is the case that matters for
    // scripts/check-migrations.mjs's own resolveDatabaseUrl, which doesn't
    // either: a developer who happens to have NODE_ENV=test set when they
    // run `npm run dev` gets the SAME file list check-migrations.mjs and
    // the `next dev` that follows it both resolve to, because Next's own
    // CLI leaves an already-set NODE_ENV alone rather than overriding it.
    write(".env.local", "DATABASE_URL=file:env-local.db\n");
    write(".env", "DATABASE_URL=file:env.db\n");
    const { env, loadedFiles } = loadDevEnvFiles({ cwd: dir, envTarget: { NODE_ENV: "test" } });
    expect(env.DATABASE_URL).toBe("file:env.db");
    expect(loadedFiles).toEqual([".env"]);
  });

  it("merges keys from multiple files rather than only ever taking the first file's keys", () => {
    write(".env", "DATABASE_URL=file:env.db\nOTHER_KEY=from-env\n");
    write(".env.local", "DATABASE_URL=file:env-local.db\n");
    const { env } = loadDevEnvFiles({ cwd: dir, envTarget: {} });
    expect(env.DATABASE_URL).toBe("file:env-local.db");
    expect(env.OTHER_KEY).toBe("from-env");
  });

  it("re-throws a read failure that isn't just a missing file", () => {
    // A directory named .env.local (not a file) makes readFileSync fail with
    // EISDIR, not ENOENT -- the one error code this function treats as "this
    // file doesn't exist, keep going".
    fs.mkdirSync(path.join(dir, ".env.local"));
    expect(() => loadDevEnvFiles({ cwd: dir, envTarget: {} })).toThrow();
  });
});

describe("against the installed @next/env, not just Next's documented behaviour", () => {
  it("the development-mode file list matches @next/env's own loadEnvConfig(dir, true), in the same order", () => {
    write(".env", "DATABASE_URL=file:env.db\n");
    write(".env.development", "DATABASE_URL=file:env-development.db\n");
    write(".env.local", "DATABASE_URL=file:env-local.db\n");
    write(".env.development.local", "DATABASE_URL=file:env-development-local.db\n");

    expect(loadedFilesFromRealNextEnv(dir)).toEqual(envFileNamesForMode("development"));
  });

  it("agrees with @next/env even when only the reported bug's exact fixture (.env.local alone) is present", () => {
    write(".env.local", 'DATABASE_URL="file:./local-only.db"\n');
    expect(loadedFilesFromRealNextEnv(dir)).toEqual(
      loadDevEnvFiles({ cwd: dir, envTarget: {} }).loadedFiles,
    );
  });
});
