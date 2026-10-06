/**
 * Guards against ugcportal-9faa recurring: a test suite that walks the
 * whole tree (via src/lib/design/scan-source.ts's shared `walkSourceFiles`
 * walker) or spawns a real `git` subprocess, with no explicit timeout and
 * no cached-helper mitigation, silently inherits vitest's 5s default --
 * exactly the shape that made the pre-push hook refuse three correct
 * pushes in a row at load average 190 (scripts/claims-audit.test.mjs,
 * src/components/consent/analytics-host.grep.test.ts and
 * src/lib/throttled-log.no-sibling-copy.test.ts all did this; see that
 * bead for the measurements). This does not know whether any SPECIFIC call
 * site is actually slow -- it is a coarse, file-level tripwire: any test
 * file that calls the shared walker or spawns `git` must ALSO, somewhere
 * in the same file, either declare an explicit timeout (a `{ timeout: N }`
 * describe/it option, or the bare `it(name, fn, N)` numeric form already
 * used elsewhere in this repo) or use a `cache* ??=` memoization. Neither
 * check understands whether the call in question is actually slow (a
 * `walkSourceFiles` call over a three-file mkdtemp fixture does not need
 * either), so this will sometimes ask a genuinely cheap new test file to
 * add a token mitigation it doesn't strictly need -- a one-line cost, far
 * cheaper than a silent flake rediscovered at load average 190.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "../src/lib/design/scan-source";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const TEST_FILE_PATTERN = /\.test\.(mjs|ts|tsx)$/;

const WALK_PATTERN = /\bwalkSourceFiles\s*\(/;
const GIT_SPAWN_PATTERN = /\b(?:execFileSync|spawnSync|execSync|spawn)\s*\(\s*["'`]git["'`]/;
// `{ timeout: 15_000 }` (a describe/it options object, this bead's own
// fixes) or the bare `it(name, fn, N)` numeric form already in this repo
// (scripts/sweep-merged-branches.test.mjs's "stateful fake gh" test).
const TIMEOUT_OPTION_PATTERN = /timeout:\s*\d/;
const BARE_NUMERIC_TIMEOUT_PATTERN = /^\s*\},\s*\d{4,}\s*\)\s*;\s*$/m;
// The `let cachedFiles; ... (cachedFiles ??= walkSourceFiles(...))` idiom
// already used by dual-meaning-usage.test.ts and no-raw-hex.test.ts, named
// loosely (any `cach*` identifier near a `??=`) so a differently-named cache
// variable still counts.
const CACHED_HELPER_PATTERN = /\bcach\w*\b[\s\S]{0,80}\?\?=|\?\?=[\s\S]{0,80}\bcach\w*\b/i;

/**
 * @param {string} content a test file's full source
 * @returns {string | null} a violation reason, or null when this file does
 *   neither tree-wide thing, or already declares a mitigation.
 */
export function treeWalkTimeoutViolation(content) {
  const walksTree = WALK_PATTERN.test(content);
  const spawnsGit = GIT_SPAWN_PATTERN.test(content);
  if (!walksTree && !spawnsGit) return null;

  const mitigated =
    TIMEOUT_OPTION_PATTERN.test(content) ||
    BARE_NUMERIC_TIMEOUT_PATTERN.test(content) ||
    CACHED_HELPER_PATTERN.test(content);
  if (mitigated) return null;

  return walksTree
    ? "calls the shared walkSourceFiles() walker with no declared timeout " +
        "(`{ timeout: N }` or `it(name, fn, N)`) and no `cache* ??=` memoization anywhere in the file"
    : "spawns a real `git` subprocess with no declared timeout " +
        "(`{ timeout: N }` or `it(name, fn, N)`) and no `cache* ??=` memoization anywhere in the file";
}

describe("treeWalkTimeoutViolation", () => {
  it("is silent for a file that does neither tree-wide thing", () => {
    expect(
      treeWalkTimeoutViolation("describe('x', () => { it('y', () => { expect(1).toBe(1); }); });"),
    ).toBeNull();
  });

  it("flags a file that walks the tree with no timeout and no cache", () => {
    const content = `
      import { walkSourceFiles } from "./scan-source";
      describe("x", () => {
        const files = walkSourceFiles(ROOT, () => false);
        it("y", () => { expect(files.length).toBeGreaterThan(0); });
      });
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/walkSourceFiles/);
  });

  it("MUTATION: the same file with a describe-level { timeout } is not flagged", () => {
    const content = `
      describe("x", { timeout: 15_000 }, () => {
        const files = walkSourceFiles(ROOT, () => false);
      });
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("MUTATION: the same file using the cached-helper idiom instead is not flagged", () => {
    const content = `
      let cachedFiles;
      function scannedFiles() { return (cachedFiles ??= walkSourceFiles(ROOT, isExcluded)); }
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("flags a file that spawns git with no timeout and no cache", () => {
    const content = 'function fixtureGit(cwd, args) { return execFileSync("git", args, { cwd }); }';
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("MUTATION: the same file with the repo's existing bare it(..., N) timeout form is not flagged", () => {
    const content = `
      it("slow", () => {
        execFileSync("git", ["status"]);
      }, 20000);
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("MUTATION CHECK: an unrelated numeric literal does not count as a timeout", () => {
    // Guards the guard itself: a bare 5-digit constant that is NOT a
    // trailing it(...) timeout must not be read as one, or this check would
    // pass on every file with any large number in it.
    const content = `
      const SOME_UNRELATED_CONSTANT = 20000;
      execFileSync("git", ["status"]);
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("does not match `which`/`gh`/other non-git spawns", () => {
    const content = 'execFileSync("which", ["git"]); execFileSync("gh", ["pr", "list"]);';
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });
});

// ugcportal-9faa: a single real-tree walk, listing test files only (no
// per-file TypeScript parse) -- cheap relative to the suites this guards,
// but still a repo-wide walk, so it gets the same explicit-timeout
// treatment as everything else in this bead rather than an exception.
describe("every test file that walks the tree or spawns git declares a timeout or a cache", { timeout: 15_000 }, () => {
  // Excludes only this file itself: its own fixtures above deliberately
  // contain the literal patterns being matched (as strings, not real
  // calls), and its own real walkSourceFiles call below is given its own
  // timeout rather than being asked to also satisfy its own rule.
  const files = walkSourceFiles(
    REPO_ROOT,
    (file) => path.resolve(file) === path.resolve(THIS_FILE),
    TEST_FILE_PATTERN,
  );

  it("finds test files to check (sanity check on the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("flags none of them", () => {
    const violations = files
      .map((file) => {
        const reason = treeWalkTimeoutViolation(readFileSync(file, "utf8"));
        return reason === null ? null : `${path.relative(REPO_ROOT, file)}: ${reason}`;
      })
      .filter((v) => v !== null);

    expect(
      violations,
      "a test file walks the whole tree or spawns a real git subprocess with " +
        "no declared timeout and no cached-helper mitigation (ugcportal-9faa). " +
        "Either add an explicit { timeout: N } (or it(name, fn, N)) with a " +
        "one-line comment naming why the cost is inherent, or share one cached " +
        "result instead of recomputing it per test (see " +
        "analytics-host.grep.test.ts or dual-meaning-usage.test.ts). " +
        `Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
