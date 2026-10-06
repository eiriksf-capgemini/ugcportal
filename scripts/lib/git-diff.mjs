/**
 * Git plumbing shared by the advisory pre-push / pre-review scripts
 * (scripts/sweep-candidates.mjs, scripts/claims-audit.mjs): which files a
 * branch changed against a base ref, which added lines, and a file's content
 * at HEAD. Extracted (ugcportal-wzgw) when a second script needed the same
 * four functions, so there is one implementation to fix rather than two
 * copies -- the shape scripts/with-local-ca.mjs and scripts/sweep-candidates.mjs
 * once had with their entry-point check (see scripts/lib/is-main.mjs).
 *
 * KNOWN LIMITATION (ugcportal-lykb): the base-vs-HEAD comparisons here
 * (getChangedFiles, getChangedLineNumbersByFile, readFileAtHead) inspect the
 * currently CHECKED-OUT HEAD, not necessarily the content of whatever is
 * being pushed. scripts/sweep-candidates.mjs only uses those, so it still
 * has this limitation. scripts/claims-audit.mjs (ugcportal-np1i) additionally
 * reads getWorkingTreeChangedFiles/getWorkingTreeChangedLineNumbersByFile/
 * readFileFromWorkingTree below, which compare the working tree (including
 * untracked files) to HEAD, so it no longer reports a false "0 candidates"
 * on uncommitted work -- see its own file header. Neither caller blocks a
 * push or a merge on its own, so the blast radius of inspecting the wrong
 * ref is a missed local hint, not a bypassed gate. See the KNOWN LIMITATION
 * notes in .beads/hooks/pre-push and scripts/sweep-candidates.mjs.
 *
 * Not unit-tested directly: it shells out to git. The pure analysis
 * functions in each caller are what the test files exercise, plus
 * scripts/claims-audit.test.mjs's temp-fixture-repo tests for the working-
 * tree functions below (ugcportal-np1i K1/K2), since those have no pure
 * parser to test against a literal string.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/**
 * True when `git status --porcelain` reports anything at all: staged or
 * unstaged changes to a tracked file, or an untracked file not excluded by
 * .gitignore. Used by claims-audit.mjs as a backstop -- if it could not read
 * the working tree for some other reason, it checks this before printing
 * "candidates found: 0" (ugcportal-np1i K3).
 *
 * @returns {boolean}
 */
export function isWorkingTreeDirty() {
  const out = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return out.trim().length > 0;
}

/**
 * Paths that differ between the working tree and HEAD: tracked files with a
 * staged or unstaged change (`git diff --name-only HEAD`, which covers both),
 * plus untracked files .gitignore does not exclude. This is the set
 * getChangedFiles cannot see before a commit exists -- a file can be in this
 * list while base...HEAD is empty, which is exactly the "false 0 before the
 * first commit" bug this function exists to close (ugcportal-np1i).
 *
 * @returns {string[]}
 */
export function getWorkingTreeChangedFiles() {
  const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

/**
 * Like getChangedLineNumbersByFile, but for uncommitted work: added/changed
 * line numbers for tracked files with a working-tree diff against HEAD
 * (`git diff -U0 HEAD`, parsed the same way), plus every line of an
 * untracked file, which has no HEAD side to diff against and so counts as
 * entirely new.
 *
 * @returns {Map<string, Set<number>>} filePath -> changed line numbers in the working-tree copy
 */
export function getWorkingTreeChangedLineNumbersByFile() {
  const out = execFileSync("git", ["diff", "-U0", "HEAD"], { encoding: "utf8" });
  const result = parseUnifiedDiffAddedLines(out);

  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const filePath of untracked) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue; // e.g. a broken symlink reported as untracked
    }
    const lineCount = content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
    const lines = new Set();
    for (let i = 1; i <= lineCount; i++) lines.add(i);
    result.set(filePath, lines);
  }
  return result;
}

/**
 * A file's content as it sits on disk right now -- unstaged edits, staged
 * edits and untracked files all read the same way, because all three are
 * about to be committed/pushed and none of them is readable with
 * `git show`. Throws for a path the working tree does not have (deleted,
 * or a directory).
 *
 * @param {string} filePath repo-relative
 * @returns {string}
 */
export function readFileFromWorkingTree(filePath) {
  return fs.readFileSync(path.join(process.cwd(), filePath), "utf8");
}
