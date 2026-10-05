/**
 * Git plumbing shared by the advisory pre-push / pre-review scripts
 * (scripts/sweep-candidates.mjs, scripts/claims-audit.mjs): which files a
 * branch changed against a base ref, which added lines, and a file's content
 * at HEAD. Extracted (ugcportal-wzgw) when a second script needed the same
 * four functions, so there is one implementation to fix rather than two
 * copies -- the shape scripts/with-local-ca.mjs and scripts/sweep-candidates.mjs
 * once had with their entry-point check (see scripts/lib/is-main.mjs).
 *
 * KNOWN LIMITATION (ugcportal-lykb): the "HEAD" half of every comparison
 * here is the currently CHECKED-OUT HEAD, not necessarily the content of
 * whatever is being pushed. Both callers are advisory-only and never block a
 * push or a merge on their own, so the blast radius of inspecting the wrong
 * ref is a missed local hint, not a bypassed gate. See the KNOWN LIMITATION
 * notes in .beads/hooks/pre-push and scripts/sweep-candidates.mjs.
 *
 * Not unit-tested directly: it shells out to git. The pure analysis
 * functions in each caller are what the test files exercise.
 */

import { execFileSync } from "node:child_process";

/**
 * `origin/main` when that ref resolves, else `HEAD~1` (no network, or a
 * shallow/fresh clone).
 */
export function resolveDefaultBase() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: ["ignore", "ignore", "ignore"] });
    return "origin/main";
  } catch {
    return "HEAD~1";
  }
}

/**
 * Paths changed on HEAD relative to the merge base with `base` (three-dot
 * diff), including deleted files -- callers that read content must tolerate
 * `git show` failing for those.
 *
 * @param {string} base
 * @returns {string[]}
 */
export function getChangedFiles(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/**
 * One `git diff -U0` for the whole branch, parsed into added/changed line
 * numbers per file (post-image numbering). One subprocess, not one per file.
 *
 * @param {string} base
 * @returns {Map<string, Set<number>>} filePath -> changed absolute line numbers at HEAD
 */
export function getChangedLineNumbersByFile(base) {
  const out = execFileSync("git", ["diff", "-U0", `${base}...HEAD`], { encoding: "utf8" });
  return parseUnifiedDiffAddedLines(out);
}

/**
 * The parser behind getChangedLineNumbersByFile, exported so a test can feed
 * it a literal diff without a git repository.
 *
 * @param {string} unifiedDiff output of `git diff -U0`
 * @returns {Map<string, Set<number>>}
 */
export function parseUnifiedDiffAddedLines(unifiedDiff) {
  const result = new Map();
  let currentFile = null;
  let newLine = null;
  for (const line of unifiedDiff.split("\n")) {
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileHeader) {
      currentFile = fileHeader[1];
      if (!result.has(currentFile)) result.set(currentFile, new Set());
      newLine = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (currentFile === null || newLine === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.get(currentFile).add(newLine);
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return result;
}

/**
 * A file's content at checked-out HEAD (not the working tree), so the scan
 * matches what a push would carry rather than an unsaved editor buffer.
 * Throws for a path HEAD does not have (a deleted file).
 *
 * @param {string} filePath repo-relative
 * @returns {string}
 */
export function readFileAtHead(filePath) {
  return execFileSync("git", ["show", `HEAD:${filePath}`], { encoding: "utf8" });
}

/**
 * Every tracked path, for "does the file this comment points at exist"
 * checks. One subprocess; callers should cache the result.
 *
 * @returns {string[]}
 */
export function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}
