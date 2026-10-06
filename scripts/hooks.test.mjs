/**
 * Guards the pre-push hook's git-env strip (ugcportal-xxy2).
 *
 * Incident, reproduced below before writing the fix: GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE and GIT_PREFIX were present in the hook's environment (this
 * repo observed them inherited from whatever invoked `git push`, e.g. an
 * agent harness pinning git operations to a worktree), and those four
 * variables override `-C`/cwd for git's OWN repository discovery. A test
 * spawned by `npm test` that shells out to git without pinning its own `-C`
 * or cwd then silently operates on whichever repo GIT_DIR points at instead
 * of its own fixture. Confirmed 2026-10-06, with GIT_DIR pointed at a
 * throwaway fixture repo and no -C/cwd override on the call:
 *   - `git config user.name Test` rewrites that fixture's identity in place;
 *   - `git init -q --bare` (no path argument) flips that fixture's
 *     core.bare to true in place.
 * That is exactly the shape that hit the real shared repo on 2026-10-06
 * (`core.bare=true` and a `Test` identity, repaired by hand).
 *
 * These tests extract `.beads/hooks/pre-push`'s `_ugcportal_run` helper (the
 * one place every mechanical check — lint/test/build/typecheck — is run)
 * and drive it directly with a minimal `sh` harness, rather than running the
 * whole hook (which needs `bd`, a real npm project, and a real push to
 * exercise). Real fixture git repos are used for K2 rather than mocking git,
 * for the same reason `with-local-ca.test.mjs` uses real directories: the
 * behaviour under test IS git's repository-discovery behaviour, and a mock
 * would let the resolver pass while the real thing failed.
 *
 * Fixture-git hygiene (so these tests cannot reach outside their own temp
 * tree, and cannot pick up this machine's real git config): every git call
 * pins an explicit cwd/-C, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null
 * and GIT_CEILING_DIRECTORIES bound every fixture's env, and every git call
 * that needs an identity sets it with its own `-c user.name=... -c
 * user.email=...` rather than relying on anything ambient.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HOOK_PATH = fileURLToPath(new URL("../.beads/hooks/pre-push", import.meta.url));

/** Pull a top-level `name() { ... }` shell function out of a hook source file. */
function extractFunction(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start === -1) {
    throw new Error(`${name}() not found in hook source`);
  }
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") {
      return lines.slice(start, i + 1).join("\n");
    }
  }
  throw new Error(`${name}(): no closing brace found`);
}

/**
 * The mutation this K1/K2 guard exists to catch: the pre-fix hook, with the
 * `env -u ...` strip removed from every branch of `_ugcportal_run` but
 * everything else intact. If this replace matches nothing, the real
 * function's shape has drifted out from under the regex and the "mutation
 * fails" assertions below would pass for the wrong reason -- so this throws
 * rather than silently returning the unmodified source.
 */
function withoutTheStrip(runFnSource) {
  const broken = runFnSource.replaceAll(" env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX", "");
  if (broken === runFnSource) {
    throw new Error("withoutTheStrip: no occurrences removed -- regex or hook source drifted");
  }
  return broken;
}

/**
 * Defines `_ugcportal_run` (from `runFnSource`) in a throwaway `sh` process
 * and immediately calls it with `argv` as the wrapped command. `env` is the
 * full environment for that `sh` process (and so for the command it runs,
 * via `_ugcportal_run`, as a hook's npm/test commands would inherit it).
 */
function runViaHelper(runFnSource, argv, { env, cwd }) {
  const script = `${runFnSource}\n_ugcportal_timeout=5\n_ugcportal_run "$@"\n`;
  return spawnSync("sh", ["-c", script, "sh", ...argv], { env, cwd, encoding: "utf8" });
}

const CLEAN_ENV_BASE = { ...process.env };
delete CLEAN_ENV_BASE.GIT_DIR;
delete CLEAN_ENV_BASE.GIT_WORK_TREE;
delete CLEAN_ENV_BASE.GIT_INDEX_FILE;
delete CLEAN_ENV_BASE.GIT_PREFIX;

describe("pre-push hook: _ugcportal_run strips git's hook-injected repo env (K1)", () => {
  const hookSource = fs.readFileSync(HOOK_PATH, "utf8");
  const runFnSource = extractFunction(hookSource, "_ugcportal_run");

  const pollutedEnv = {
    ...CLEAN_ENV_BASE,
    GIT_DIR: "/tmp/ugcportal-hooks-test-should-not-leak/.git",
    GIT_WORK_TREE: "/tmp/ugcportal-hooks-test-should-not-leak",
    GIT_INDEX_FILE: "/tmp/ugcportal-hooks-test-should-not-leak/.git/index",
    GIT_PREFIX: "sub/dir/",
  };

  const PROBE_ARGV = [
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify({" +
      'gitDir: "GIT_DIR" in process.env, ' +
      'gitWorkTree: "GIT_WORK_TREE" in process.env, ' +
      'gitIndexFile: "GIT_INDEX_FILE" in process.env, ' +
      'gitPrefix: "GIT_PREFIX" in process.env' +
      "}))",
  ];

  it("a command run through _ugcportal_run does not see GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX", () => {
    const result = runViaHelper(runFnSource, PROBE_ARGV, { env: pollutedEnv, cwd: os.tmpdir() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      gitDir: false,
      gitWorkTree: false,
      gitIndexFile: false,
      gitPrefix: false,
    });
  });

  it("mutation: without the strip, the same command DOES see GIT_DIR (proves the above is not decoration)", () => {
    const broken = withoutTheStrip(runFnSource);
    const result = runViaHelper(broken, PROBE_ARGV, { env: pollutedEnv, cwd: os.tmpdir() });
    expect(result.status).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(seen.gitDir).toBe(true);
    expect(seen.gitWorkTree).toBe(true);
    expect(seen.gitIndexFile).toBe(true);
    expect(seen.gitPrefix).toBe(true);
  });
});

describe("pre-push hook: a test run under it cannot mutate the real repo (K2)", () => {
  if (process.platform === "win32") {
    it.skip("POSIX-sh fixture, skipped on win32", () => {});
    return;
  }

  /**
   * Builds a fixture "real" repo with a COMMITTED copy of the current hook
   * file (so the test exercises the artifact as it would actually be
   * checked out, per ugcportal-xxy2's K2 instructions), plus a sibling
   * directory the wayward command below is free to actually create a bare
   * repo in. Returns everything a test needs to drive `_ugcportal_run` as if
   * it were running inside this fixture's own pre-push hook.
   */
  function buildFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-hooks-k2-"));
    const ceiling = path.dirname(root);
    const realRepo = path.join(root, "real-repo");
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(realRepo, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });

    const gitEnv = {
      ...CLEAN_ENV_BASE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: ceiling,
    };
    const gitIn = (cwd, args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    const git = (args) => gitIn(realRepo, args);

    git(["init", "-q"]);
    git(["-c", "user.name=Fixture Setup", "-c", "user.email=setup@example.invalid", "commit", "--allow-empty", "-q", "-m", "init"]);
    git(["config", "user.name", "Fixture-Real-Identity"]);

    const hookDir = path.join(realRepo, ".beads", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "pre-push"), fs.readFileSync(HOOK_PATH, "utf8"));
    git(["add", ".beads/hooks/pre-push"]);
    git(["-c", "user.name=Fixture Setup", "-c", "user.email=setup@example.invalid", "commit", "-q", "-m", "add hook copy"]);

    const committedHookSource = fs.readFileSync(path.join(hookDir, "pre-push"), "utf8");
    const runFnSource = extractFunction(committedHookSource, "_ugcportal_run");

    // elsewhere/ is its own real repo, with its own distinct identity, so
    // the wayward call below has somewhere legitimate to land when the
    // strip works, and so "elsewhere/ was actually touched" is checkable
    // without relying on the GIT_WORK_TREE-vs---bare conflict `git init
    // --bare` hits when GIT_WORK_TREE is simultaneously set (a real git
    // error, not a silent one, and orthogonal to this hook's git-env strip).
    gitIn(elsewhere, ["init", "-q"]);
    gitIn(elsewhere, ["-c", "user.name=x", "-c", "user.email=x@example.invalid", "commit", "--allow-empty", "-q", "-m", "init"]);
    gitIn(elsewhere, ["config", "user.name", "Elsewhere-Original-Identity"]);

    const readUserName = (cwd) => gitIn(cwd, ["config", "user.name"]).trim();

    // The exact shape reproduced above: a wayward test fixture call --
    // `git config user.name ...` with neither -C nor its own cwd override --
    // run in a directory (elsewhere/) that is NOT the repo GIT_DIR/
    // GIT_WORK_TREE point at.
    const waywardScript = path.join(root, "wayward.sh");
    fs.writeFileSync(waywardScript, ["#!/bin/sh", 'git config user.name "Mutated-By-Wayward-Test"', ""].join("\n"));

    const pushEnv = {
      ...CLEAN_ENV_BASE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: ceiling,
      GIT_DIR: path.join(realRepo, ".git"),
      GIT_WORK_TREE: realRepo,
      GIT_INDEX_FILE: path.join(realRepo, ".git", "index"),
      GIT_PREFIX: "",
    };

    return { root, elsewhere, runFnSource, readUserName, waywardScript, pushEnv };
  }

  it("the fixture's identity is unchanged, and the wayward call lands on elsewhere/ instead", () => {
    const { root, elsewhere, runFnSource, readUserName, waywardScript, pushEnv } = buildFixture();
    try {
      expect(readUserName(elsewhere)).toBe("Elsewhere-Original-Identity");

      const result = runViaHelper(runFnSource, ["sh", waywardScript], { env: pushEnv, cwd: elsewhere });
      expect(result.status).toBe(0);

      // Protected: the real/fixture repo's identity never moved.
      expect(readUserName(pushEnv.GIT_WORK_TREE)).toBe("Fixture-Real-Identity");
      // Not vacuous: the wayward call actually ran, against elsewhere/, not
      // silently no-op'd or swallowed by the strip.
      expect(readUserName(elsewhere)).toBe("Mutated-By-Wayward-Test");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mutation: without the strip, the wayward call DOES corrupt the fixture's identity (proves the above is not decoration)", () => {
    const { root, elsewhere, runFnSource, readUserName, waywardScript, pushEnv } = buildFixture();
    try {
      const broken = withoutTheStrip(runFnSource);

      const result = runViaHelper(broken, ["sh", waywardScript], { env: pushEnv, cwd: elsewhere });
      expect(result.status).toBe(0);

      // The exact corruption from the real incident: the wayward call
      // followed GIT_DIR instead of cwd and rewrote the fixture's identity.
      expect(readUserName(pushEnv.GIT_WORK_TREE)).toBe("Mutated-By-Wayward-Test");
      // elsewhere/ -- where the call actually ran -- was untouched instead.
      expect(readUserName(elsewhere)).toBe("Elsewhere-Original-Identity");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
