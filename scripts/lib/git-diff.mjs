/**
 * Git plumbing shared by the advisory pre-push / pre-review scripts
 * (scripts/sweep-candidates.mjs, scripts/claims-audit.mjs): which files a
 * branch changed against a base ref, which added lines, and a file's content
 * at HEAD. Extracted (ugcportal-wzgw) when a second script needed the same
 * four functions, so there is one implementation to fix rather than two
 * copies -- the shape scripts/with-local-ca.mjs and scripts/sweep-candidates.mjs
 * once had with their entry-point check (see scripts/lib/is-main.mjs).
 *
 * KNOWN LIMITATION (ugcportal-lykb): getChangedFiles, getChangedLineNumbersByFile
 * and readFileAtHead inspect the currently CHECKED-OUT HEAD, not necessarily
 * the content of whatever is being pushed. scripts/sweep-candidates.mjs only
 * uses those, so it still has this limitation (a follow-up bead applying the
 * working-tree-aware functions below to that caller too is left for
 * ugcportal-np1i's own follow-up, not this fix). scripts/claims-audit.mjs
 * instead uses resolveMergeBase/getChangedLineNumbersSince/
 * listUntrackedFiles/readFileFromWorkingTree below, which diff a merge-base
 * commit directly against the CURRENT WORKING TREE (index + unstaged +
 * untracked combined) in one coordinate system, so it no longer reports a
 * false "0 candidates" on uncommitted work and no longer misaligns line
 * numbers when a file has both a committed and an uncommitted change
 * (ugcportal-np1i M1/M2) -- see claims-audit.mjs's own file header. Neither
 * caller blocks a push or a merge on its own, so the blast radius of
 * inspecting the wrong ref is a missed local hint, not a bypassed gate. See
 * the KNOWN LIMITATION notes in .beads/hooks/pre-push and
 * scripts/sweep-candidates.mjs.
 *
 * Not unit-tested directly: it shells out to git. The pure analysis
 * functions in each caller are what the test files exercise, plus
 * scripts/claims-audit.test.mjs's temp-fixture-repo tests for the working-
 * tree functions below (ugcportal-np1i K1/K2/M1/M2/M3/H1), since those have
 * no pure parser to test against a literal string.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A large uncommitted diff (e.g. a big generated file, or many files edited
// at once) can exceed execFileSync's 1 MB default maxBuffer before a commit
// exists to shrink it back down to the usual per-commit size (ugcportal-np1i
// M3: this is a working-tree diff, not a commit-to-commit one, so it has no
// such natural ceiling). 64 MB comfortably covers this repo's largest
// tracked text file with room to spare, without buffering an unbounded
// amount of memory if something genuinely runs away.
const LARGE_MAX_BUFFER = 64 * 1024 * 1024;

// Computed once per process, the first time anything needs it, then cached
// -- the repo root never changes mid-run. `git rev-parse --show-toplevel`
// resolves correctly from any cwd inside the repo, any depth down
// (ugcportal-np1i round 3 H1).
let cachedRepoRoot = null;

/**
 * The absolute path of the repository's top-level working directory,
 * regardless of the current working directory the process was started in.
 * Every function below that reads a path straight off disk (not through
 * `git`, which already resolves plain pathspecs against the repo root on
 * its own for `diff`/`show`) joins its path against this first -- a bare
 * `fs.readFileSync(filePath)` with a repo-relative `filePath` silently reads
 * the wrong file (or nothing) unless the process happens to be running from
 * the repo root already (round 3 H1: `readFileFromWorkingTree` used to do
 * exactly that, so running claims-audit.mjs from a subdirectory reproduced
 * the original "candidates found: 0" bug this whole bead exists to fix, via
 * a third trigger -- cwd -- that no fixture test exercised, since every
 * fixture always invokes the script with `cwd` set to the fixture's own
 * root). `git ls-files` has a worse version of the same problem, in two
 * parts, one level removed: unlike `diff`/`show`, it both prints paths
 * relative to cwd by default AND scopes its listing to "cwd and below" by
 * default, so listTrackedFiles/listUntrackedFiles below pass `--full-name`
 * (fixes the path format) alongside an explicit top-level pathspec, `:/`
 * (fixes the scope) -- `--full-name` on its own looked sufficient and
 * wasn't: it silently narrows the list to whatever subtree cwd sits in,
 * dropping every file elsewhere rather than merely misformatting them.
 *
 * @returns {string}
 */
export function getRepoRoot() {
  if (cachedRepoRoot === null) {
    cachedRepoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  }
  return cachedRepoRoot;
}

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
 * Every tracked path, repo-root-relative, for "does the file this comment
 * points at exist" checks. One subprocess; callers should cache the result.
 * Unlike `git diff`/`git show`, plain `git ls-files` is scoped to "the
 * current directory and below" AND prints paths relative to the current
 * directory, not the repo root -- two separate cwd-dependencies, both
 * defaults, neither overridden by the other's fix. `--full-name` only fixes
 * the second (path FORMAT); without the explicit top-level pathspec `:/`
 * (git's "from the repo root" magic pathspec) as well, this list silently
 * narrows to files under whatever subdirectory the script happens to run
 * from, missing everything else entirely rather than just misformatting it
 * (ugcportal-np1i round 3 H1 -- caught only by comparing this function's
 * actual output counts from two different cwds, not by `--full-name` alone,
 * which looked sufficient but wasn't).
 *
 * @returns {string[]}
 */
export function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "--full-name", "--", ":/"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/**
 * The commit `base` and HEAD share, as a plain ref `base` itself already is
 * when it is an ancestor of HEAD (the common case for `origin/main` or a
 * fixture's own earlier commit) -- computed explicitly anyway so that an
 * unrelated/unresolvable `base` fails here, in one place, rather than
 * wherever its first use happens to be. Throws if `base` does not resolve or
 * shares no history with HEAD -- callers decide what that means (claims-
 * audit.mjs: refuse if `base` was given explicitly; degrade to `HEAD` if it
 * was only the computed default -- ugcportal-np1i M1). The thrown error's
 * message is just git's own stderr, trimmed to one line -- stdio suppresses
 * it from leaking to the terminal raw (the way resolveDefaultBase's probe
 * call already does), the caller still gets to report why (ugcportal-np1i
 * round 2 L2: before this, a resolution failure printed git's raw `fatal:
 * ...` line AND claims-audit's own wrapped message, once each).
 *
 * @param {string} base
 * @returns {string} a commit SHA
 */
export function resolveMergeBase(base) {
  try {
    return execFileSync("git", ["merge-base", base, "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const stderr = (err.stderr ?? "").toString().trim();
    throw new Error(stderr || err.message);
  }
}

/**
 * Untracked, repo-root-relative paths .gitignore does not exclude. Exported
 * as its own function, separate from the two below, so a single call's
 * result can be reused by both instead of each shelling out to `git
 * ls-files --others` a second time (ugcportal-np1i M3/L4 -- the previous
 * working-tree functions each ran this independently). `--full-name` plus
 * the explicit `:/` top-level pathspec for the same two-part reason as
 * listTrackedFiles above: without both, this list is both misformatted
 * (cwd-relative, not repo-root-relative) AND silently incomplete (scoped to
 * cwd's own subtree, missing an untracked file anywhere else) the moment
 * the script runs from a subdirectory (round 3 H1).
 *
 * @returns {string[]}
 */
export function listUntrackedFiles() {
  return execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/**
 * Added/changed line numbers between `ref` and the CURRENT WORKING TREE, in
 * ONE coordinate system -- the working tree's own line numbers -- covering a
 * change already committed between `ref` and HEAD and a further uncommitted
 * edit on top of it with a single diff. This is the fix for ugcportal-np1i
 * M2: the previous design unioned a HEAD-coordinate diff (`base...HEAD`)
 * with a separately-computed working-tree-coordinate diff (`HEAD` vs
 * worktree), which silently misaligned whenever a file had both kinds of
 * change -- an uncommitted line inserted above a committed one shifts every
 * HEAD-relative line number below it, so the union pointed at the wrong
 * lines in the content actually read (always the working-tree copy for such
 * a file). Diffing straight from `ref` to the working tree has no second
 * coordinate system to misalign with. The returned map's keys are also the
 * full list of tracked paths `ref` and the working tree differ on -- every
 * `+++ b/<path>` header `parseUnifiedDiffAddedLines` sees becomes a key,
 * with or without any added lines -- so a caller that needs both the file
 * list and the line numbers gets both from this one diff (ugcportal-np1i
 * round 2 L3: a separate `git diff --name-only ref` call used to recompute
 * the same diff a second time just for the file list).
 *
 * @param {string} ref usually the output of resolveMergeBase, or HEAD
 * @returns {Map<string, Set<number>>}
 */
export function getChangedLineNumbersSince(ref) {
  const out = execFileSync("git", ["diff", "-U0", ref], { encoding: "utf8", maxBuffer: LARGE_MAX_BUFFER });
  return parseUnifiedDiffAddedLines(out);
}

/**
 * A file's content as it sits on disk right now -- unstaged edits, staged
 * edits and untracked files all read the same way, because all three are
 * about to be committed/pushed and none of them is readable with
 * `git show`. Throws for a path the working tree does not have (deleted,
 * or a directory). `filePath` is resolved against the REPO ROOT
 * (getRepoRoot), not `process.cwd()` -- a bare `fs.readFileSync(filePath)`
 * resolves against whatever directory the process happens to be started
 * from, unlike the `git show HEAD:path` this function replaced, which git
 * itself always resolves against the repo root. Round 3 H1: running the
 * unfixed version from any subdirectory made every file lookup throw
 * ENOENT, each one caught and silently treated as "deleted", reproducing
 * the exact false "candidates found: 0" this bead exists to eliminate.
 *
 * @param {string} filePath repo-relative
 * @returns {string}
 */
export function readFileFromWorkingTree(filePath) {
  return fs.readFileSync(path.join(getRepoRoot(), filePath), "utf8");
}
