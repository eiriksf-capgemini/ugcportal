/**
 * Tests for the shared `.env*` precedence resolver (ugcportal-h2yd). Every
 * fixture here is a real temp directory with real files on disk, read
 * through `loadDevEnvFiles` exactly as scripts/check-migrations.mjs and
 * prisma7.config.ts do — not a mocked `fs`, so a change to the file-reading
 * code itself is exercised, not just the merge logic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEV_MODE, envFileNamesForMode, loadDevEnvFiles } from "./env-files.mjs";

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

  it("defaults to development", () => {
    expect(DEV_MODE).toBe("development");
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
