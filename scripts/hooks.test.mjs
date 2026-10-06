/**
 * Guards the pre-push hook's git-env strip (ugcportal-xxy2).
 *
 * Incident, reproduced below before writing the fix: GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE and GIT_PREFIX were present in the hook's environment (this
 * repo observed them inherited from whatever invoked `git push`, e.g. an
 * agent harness pinning git operations to a worktree). GIT_DIR overrides -C
 * and cwd for repository discovery; the other three redirect the work tree
 * and index or carry hook context, and are stripped so a child git sees none
 * of the four variables that would redirect it. A test spawned by `npm
 * test` that shells out to git without pinning its own `-C` or cwd then
 * silently operates on
 * whichever repo GIT_DIR points at instead of its own fixture. Confirmed
 * 2026-10-06, with GIT_DIR (and
 * GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX) pointed at a throwaway fixture
 * repo and no -C/cwd override on the call: `git config user.name Test`
 * rewrites that fixture's identity in place -- the K2 reproduction below.
 * (`git init -q --bare` with no path argument does the same to core.bare,
 * matching the real incident's `core.bare=true`, but errors instead when
 * GIT_WORK_TREE is *also* set alongside GIT_DIR -- `fatal: GIT_WORK_TREE
 * ... not allowed without specifying GIT_DIR` -- a real git restriction,
 * unrelated to this hook's strip, so K2 below reproduces the identity
 * rewrite only.)
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

const STRIP = " env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX";

/**
 * The mutation this K1/K2 guard exists to catch: the pre-fix hook, with the
 * `env -u ...` strip removed from every branch of `_ugcportal_run` but
 * everything else intact. If this replace matches nothing, the real
 * function's shape has drifted out from under the regex and the "mutation
 * fails" assertions below would pass for the wrong reason -- so this throws
 * rather than silently returning the unmodified source.
 */
function withoutTheStrip(runFnSource) {
  const broken = runFnSource.replaceAll(STRIP, "");
  if (broken === runFnSource) {
    throw new Error("withoutTheStrip: no occurrences removed -- regex or hook source drifted");
  }
  return broken;
}

/**
 * Same mutation as `withoutTheStrip`, localised to the one `_ugcportal_run`
 * branch whose line starts with `firstWord` (`timeout`, `gtimeout`, `perl`,
 * or `env` for the plain fallback) -- so a regression that drops the strip
 * from only one branch is caught by that branch's own test, rather than
 * requiring all four to break at once before anything notices.
 */
function withoutTheStripOnBranch(runFnSource, firstWord) {
  let hits = 0;
  const mutated = runFnSource
    .split("\n")
    .map((line) => {
      if (line.trim().split(/\s+/)[0] === firstWord && line.includes(STRIP)) {
        hits += 1;
        return line.replace(STRIP, "");
      }
      return line;
    })
    .join("\n");
  if (hits !== 1) {
    throw new Error(`withoutTheStripOnBranch(${firstWord}): expected exactly 1 matching line, found ${hits}`);
  }
  return mutated;
}

/**
 * Defines `_ugcportal_run` (from `runFnSource`) in a throwaway `sh` process
 * and immediately calls it with `argv` as the wrapped command. `env` is the
 * full environment for that `sh` process (and so for the command it runs,
 * via `_ugcportal_run`, as a hook's npm/test commands would inherit it).
 */
function runViaHelper(runFnSource, argv, { env, cwd }) {
  const script = `${runFnSource}\n_ugcportal_timeout=5\n_ugcportal_run "$@"\n`;
  return spawnSync(SH_PATH, ["-c", script, "sh", ...argv], { env, cwd, encoding: "utf8" });
}

const CLEAN_ENV_BASE = { ...process.env };
delete CLEAN_ENV_BASE.GIT_DIR;
delete CLEAN_ENV_BASE.GIT_WORK_TREE;
delete CLEAN_ENV_BASE.GIT_INDEX_FILE;
delete CLEAN_ENV_BASE.GIT_PREFIX;

/**
 * Resolves `name` on the REAL host PATH (the parent process's own
 * environment, not any restricted one built below) via the shell's own
 * `command -v`, so the branch-forcing tests use the genuine binary rather
 * than assuming a fixed install location. Never throws: if the `sh` used to
 * run `command -v` is itself missing, `spawnSync` leaves `stdout` undefined
 * (or `null` on some versions) rather than a string, which `?? ""` absorbs
 * either way -- the caller sees a plain "not found" (`null`) in every
 * missing-host-binary case, the same as if `command -v` itself had reported
 * nothing.
 */
function resolveOnHostPath(name) {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const resolved = (result.stdout ?? "").trim();
  return resolved === "" ? null : resolved;
}

/**
 * A PATH containing exactly one real binary (`env`, needed by every branch)
 * plus, optionally, a real `perl` -- nothing else. `command -v` for
 * `timeout`/`gtimeout` always fails against this PATH regardless of what the
 * host actually has installed, so which `_ugcportal_run` branch runs is
 * controlled entirely by this PATH plus the shell functions defined in
 * `shellPrelude` below, never by whatever happens to be on the test host.
 * Callers gate on `hostSkipReason` before calling this, so `ENV_PATH`/
 * `PERL_PATH` being unresolved here means that gate was skipped incorrectly
 * -- a thrown error surfaces that loudly rather than this function silently
 * building a PATH with a binary missing from it.
 */
function buildMinimalBinDir({ includeRealPerl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-hooks-bin-"));
  if (!ENV_PATH) {
    throw new Error("`env` not found via `command -v env` on this host -- hostSkipReason() should have skipped this");
  }
  fs.symlinkSync(ENV_PATH, path.join(dir, "env"));
  if (includeRealPerl) {
    if (!PERL_PATH) {
      throw new Error("`perl` not found via `command -v perl` on this host -- hostSkipReason() should have skipped this");
    }
    fs.symlinkSync(PERL_PATH, path.join(dir, "perl"));
  }
  return dir;
}

// Resolved once, at collection time, so every test can decide `it` vs
// `it.skip` before any test body runs: a check made only inside a running
// test body passes vacuously with no assertions -- invisible in the summary
// -- while a throw from a module-level constant evaluated at collection
// time crashes the whole file before a skip can even register.
const SH_PATH = resolveOnHostPath("sh");
const ENV_PATH = resolveOnHostPath("env");
const PERL_PATH = resolveOnHostPath("perl");
const GIT_PATH = resolveOnHostPath("git");

/** Null when `branch` can run on this host; otherwise the reason to skip it, visibly, in the test name. */
function hostSkipReason(branch) {
  if (!SH_PATH) return "no `sh` on this host";
  if (!ENV_PATH) return "no `env` on this host";
  if (branch?.includeRealPerl && !PERL_PATH) return "no `perl` on this host";
  return null;
}

/**
 * One entry per `_ugcportal_run` branch: `firstWord` identifies the branch's
 * line for `withoutTheStripOnBranch`; `shellPrelude` is shell source
 * `runOnThisBranch` below prepends to make `command -v` resolve that branch
 * (and no earlier one) without depending on what the host happens to have
 * installed; `includeRealPerl` adds a real `perl` to the minimal PATH so the
 * perl branch's actual `perl -e '...'` one-liner runs for real rather than
 * being stubbed.
 */
const BRANCHES = [
  { name: "timeout", firstWord: "timeout", shellPrelude: 'timeout() { shift; exec "$@"; }\n', includeRealPerl: false },
  {
    name: "gtimeout",
    firstWord: "gtimeout",
    shellPrelude: 'gtimeout() { shift; exec "$@"; }\n',
    includeRealPerl: false,
  },
  { name: "perl", firstWord: "perl", shellPrelude: "", includeRealPerl: true },
  { name: "none (plain fallback)", firstWord: "env", shellPrelude: "", includeRealPerl: false },
];

// ugcportal-9faa: each branch below spawns real `sh`/`perl`/`git` child
// processes against a fixture repo -- real subprocess latency with no
// shared state to cache (every case needs its own fixture), measured up to
// ~1.4s unloaded already. Explicit timeout, not a bigger global default.
describe("pre-push hook: _ugcportal_run strips git's hook-injected repo env (K1)", { timeout: 20_000 }, () => {
  const hookSource = fs.readFileSync(HOOK_PATH, "utf8");
  const runFnSource = extractFunction(hookSource, "_ugcportal_run");

  const pollutedEnv = {
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

  for (const branch of BRANCHES) {
    describe(`branch: ${branch.name}`, () => {
      const skipReason = hostSkipReason(branch);
      const test = skipReason ? it.skip : it;

      function runOnThisBranch(fnSource) {
        const binDir = buildMinimalBinDir({ includeRealPerl: branch.includeRealPerl });
        try {
          const env = { ...CLEAN_ENV_BASE, ...pollutedEnv, PATH: binDir };
          const script = `${branch.shellPrelude}${fnSource}\n_ugcportal_timeout=5\n_ugcportal_run "$@"\n`;
          // An absolute path for the shell itself: the restricted PATH above
          // (built to control what `_ugcportal_run` can find) would otherwise
          // also hide `sh` from this spawn's own lookup.
          return spawnSync(SH_PATH, ["-c", script, "sh", ...PROBE_ARGV], { env, cwd: os.tmpdir(), encoding: "utf8" });
        } finally {
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      }

      test(
        skipReason
          ? `does not see GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX on this branch (skipped: ${skipReason})`
          : "does not see GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX on this branch",
        () => {
          const result = runOnThisBranch(runFnSource);
          expect(result.status).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({
            gitDir: false,
            gitWorkTree: false,
            gitIndexFile: false,
            gitPrefix: false,
          });
        },
      );

      test(
        skipReason
          ? `mutation: without the strip on just this branch, the same command DOES see GIT_DIR (skipped: ${skipReason})`
          : "mutation: without the strip on just this branch, the same command DOES see GIT_DIR (localises a single-branch regression)",
        () => {
          const broken = withoutTheStripOnBranch(runFnSource, branch.firstWord);
          const result = runOnThisBranch(broken);
          expect(result.status).toBe(0);
          const seen = JSON.parse(result.stdout);
          expect(seen.gitDir).toBe(true);
          expect(seen.gitWorkTree).toBe(true);
          expect(seen.gitIndexFile).toBe(true);
          expect(seen.gitPrefix).toBe(true);
        },
      );
    });
  }
});

// ugcportal-9faa: builds a real fixture git repository (with a committed
// hook file) per case and spawns git/sh against it -- real subprocess
// latency, measured up to ~2.8s unloaded already, with no shared state to
// cache. Explicit timeout, not a bigger global default.
describe("pre-push hook: a test run under it cannot mutate the real repo (K2)", { timeout: 20_000 }, () => {
  if (process.platform === "win32") {
    it.skip("POSIX-sh fixture, skipped on win32", () => {});
    return;
  }
  if (!SH_PATH) {
    it.skip("no `sh` on this host", () => {});
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

// ugcportal-cky9: agent pushes set UGCPORTAL_PREPUSH=skip so the hook exits
// before paying for lint/test/build/typecheck -- CI is authoritative and
// re-verifies every push regardless. Unlike K1/K2 above (which extract one
// helper function), these run the WHOLE hook file, because the behaviour
// under test is the hook's own top-level control flow: does it reach the
// npm commands at all. A minimal PATH shim (real `env`/`git`, a fake `npm`
// that just logs its argv and exits 0 instead of actually linting/testing/
// building/typechecking) plus a real fixture git repo -- same hygiene as
// K1/K2's fixtures -- lets the hook run to completion in well under a
// second either way.
describe("pre-push hook: UGCPORTAL_PREPUSH=skip", { timeout: 20_000 }, () => {
  const hookSource = fs.readFileSync(HOOK_PATH, "utf8");

  /**
   * A real, empty git repo plus the one file the hook unconditionally
   * sources once it reaches the mechanical section (scripts/ci-placeholder-
   * env.sh) -- its actual fallback-env contents are irrelevant here, only
   * its presence is. Returns the hook script (a standalone copy, not run
   * from inside the fixture repo's own .beads/hooks/ -- the hook resolves
   * its repo root from cwd via `git rev-parse --show-toplevel`, not from
   * its own file location, so it doesn't need to live inside the fixture)
   * plus a minimal bin dir and the log file the fake npm appends to.
   */
  function buildFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-hooks-prepush-"));
    const repoDir = path.join(root, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    const gitEnv = {
      ...CLEAN_ENV_BASE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: root,
    };
    execFileSync("git", ["init", "-q"], { cwd: repoDir, env: gitEnv });

    fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "scripts", "ci-placeholder-env.sh"), "");

    const hookScript = path.join(root, "pre-push");
    fs.writeFileSync(hookScript, hookSource);

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-hooks-prepush-bin-"));
    if (!ENV_PATH) throw new Error("`env` not found via `command -v env` -- hostSkipReason() should have skipped this");
    if (!GIT_PATH) throw new Error("`git` not found via `command -v git` -- hostSkipReason() should have skipped this");
    fs.symlinkSync(ENV_PATH, path.join(binDir, "env"));
    fs.symlinkSync(GIT_PATH, path.join(binDir, "git"));
    // Deliberately no `timeout`/`gtimeout`/`perl`/`python3`/`node` in this
    // PATH: `_ugcportal_run` falls through to its plain `env -u ...`
    // fallback (already covered on its own by the K1 "none" branch above),
    // and the advisory harness-cost-controls/sweep-candidates checks further
    // down the hook short-circuit on `command -v python3`/`node` failing,
    // so neither needs a real repo history or real scripts to succeed.

    const npmLog = path.join(root, "npm-calls.log");
    const npmShim = path.join(binDir, "npm");
    fs.writeFileSync(npmShim, ['#!/bin/sh', 'printf \'%s\\n\' "npm $*" >> "$UGCPORTAL_TEST_NPM_LOG"', "exit 0", ""].join("\n"));
    fs.chmodSync(npmShim, 0o755);

    return { root, repoDir, hookScript, binDir, npmLog };
  }

  function runHook(fixture, extraEnv) {
    const env = {
      ...CLEAN_ENV_BASE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: path.dirname(fixture.repoDir),
      PATH: fixture.binDir,
      UGCPORTAL_TEST_NPM_LOG: fixture.npmLog,
    };
    // CLEAN_ENV_BASE inherits the REAL process.env -- harmless for K1/K2 above,
    // but this describe block is the one place a leaked UGCPORTAL_PREPUSH
    // actually changes the outcome under test. If this very test suite is
    // ever run nested inside a real `git push` that itself set
    // UGCPORTAL_PREPUSH=skip (exactly the scenario ugcportal-cky9 adds, and
    // reproduced while authoring this test: `UGCPORTAL_PREPUSH=skip git
    // push` runs the OLD committed hook from whatever `core.hooksPath`
    // points at, which can still shell out to `npm test` against this
    // worktree before the new hook is the one installed), the "unset"
    // case below would silently inherit "skip" instead of truly being
    // unset, and wrongly pass. Deleting here, then applying extraEnv,
    // means the "undefined" case always runs with it genuinely absent.
    delete env.UGCPORTAL_PREPUSH;
    Object.assign(env, extraEnv);
    return spawnSync(SH_PATH, [fixture.hookScript], { cwd: fixture.repoDir, env, encoding: "utf8" });
  }

  function readNpmLog(fixture) {
    return fs.existsSync(fixture.npmLog) ? fs.readFileSync(fixture.npmLog, "utf8") : "";
  }

  function cleanup(fixture) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.binDir, { recursive: true, force: true });
  }

  const skipReason = hostSkipReason() ?? (GIT_PATH ? null : "no `git` on this host");
  const test = skipReason ? it.skip : it;

  test(
    skipReason
      ? `UGCPORTAL_PREPUSH=skip prints exactly one line, exits 0, and never invokes npm (skipped: ${skipReason})`
      : "UGCPORTAL_PREPUSH=skip prints exactly one line, exits 0, and never invokes npm",
    () => {
      const fixture = buildFixture();
      try {
        const result = runHook(fixture, { UGCPORTAL_PREPUSH: "skip" });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("pre-push suite skipped by UGCPORTAL_PREPUSH=skip; CI is authoritative\n");
        expect(readNpmLog(fixture)).toBe("");
      } finally {
        cleanup(fixture);
      }
    },
  );

  // Default behaviour for a human push is unchanged: unset, or set to
  // anything other than the exact string "skip", still runs the full
  // mechanical suite (here: the fake npm, so this stays fast and doesn't
  // actually lint/test/build/typecheck this repo).
  for (const value of [undefined, "", "1", "true", "SKIP", "Skip", "no"]) {
    test(
      skipReason
        ? `UGCPORTAL_PREPUSH=${JSON.stringify(value)} still runs the mechanical suite (skipped: ${skipReason})`
        : `UGCPORTAL_PREPUSH=${JSON.stringify(value)} still runs the mechanical suite (default behaviour unchanged)`,
      () => {
        const fixture = buildFixture();
        try {
          const result = runHook(fixture, value === undefined ? {} : { UGCPORTAL_PREPUSH: value });
          expect(result.status).toBe(0);
          expect(result.stdout).not.toContain("pre-push suite skipped by UGCPORTAL_PREPUSH=skip");
          expect(result.stdout).toContain("running local mechanical checks");
          const npmLog = readNpmLog(fixture);
          expect(npmLog).toContain("npm run lint");
          expect(npmLog).toContain("npm test");
          expect(npmLog).toContain("npm run build");
          expect(npmLog).toContain("npm run typecheck");
        } finally {
          cleanup(fixture);
        }
      },
    );
  }
});
