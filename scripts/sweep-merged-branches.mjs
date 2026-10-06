#!/usr/bin/env node
/**
 * One-shot sweep for drift left behind when a PR merges without its branch
 * and worktree being cleaned up (ugcportal-nvg0).
 *
 * Why this exists: ugcportal-nvg0's premise (re-verified 2026-10-06) found
 * 23 remote branches on `origin` whose PR had already merged, and 29 of 31
 * agent worktrees under `.claude/worktrees` pointed at a branch whose PR was
 * merged or closed -- both cleaned by hand once, with nothing short of a
 * repeat hand-sweep to catch the next round of drift. This script is that
 * repeatable sweep: it lists every remote branch and worktree eligible for
 * removal under the same branch-deletion-verification rule
 * `.claude/skills/pr-review-merge/SKILL.md`'s merge step applies to a single
 * PR, and only removes them when told to.
 *
 * Eligibility (classifyRemoteBranch / classifyWorktree below) is
 * deliberately narrow -- a branch or worktree is a removal candidate only
 * when its PR's state is exactly MERGED:
 *
 *   - a branch with an OPEN or CLOSED-without-merge PR is kept (closing a
 *     PR without merging it is a human decision this script does not make);
 *   - a branch with no PR at all is kept (same reason, and this is also
 *     where a non-PR ref like Dolt's `__dolt_remote_info__` branch under
 *     `refs/heads` lands -- it never has a PR, so it is never a candidate);
 *   - a worktree with uncommitted changes, or locked (every active agent
 *     worktree carries a `locked claude agent ...` line from the harness),
 *     is kept regardless of its branch's PR state;
 *   - a worktree whose branch tip is not reachable from any remote branch,
 *     and does not equal the merged PR's own head commit, is kept with
 *     reason "unpushed commits" -- a clean working tree says nothing about
 *     commits that are already committed locally but never pushed, and this
 *     repo squash-merges, so a branch's own commits are never reachable
 *     from `main` even once its PR has merged. Without this check, a clean
 *     worktree with one such commit survives `git worktree remove` (git
 *     sees nothing to object to) and is then force-deleted by `git branch
 *     -D`, losing the commit to reflog only;
 *   - a worktree git itself reports as `prunable` (its directory is gone,
 *     typically deleted by hand instead of via `git worktree remove`) is
 *     classified `"prune"`, distinct from `"remove"` -- `git worktree
 *     prune` clears its administrative entry, and this script never tries
 *     to run `git status` against a path that is already gone. Without this
 *     check, that status call exits 128 and crashes the whole script,
 *     including a plain dry run, before printing a single line -- on
 *     exactly the drift this script exists to find;
 *   - the main worktree and the default branch are always kept, checked
 *     before anything else.
 *
 * Usage:
 *   node scripts/sweep-merged-branches.mjs                       # dry run: lists candidates only
 *   node scripts/sweep-merged-branches.mjs --execute              # also removes them, repo-wide
 *   node scripts/sweep-merged-branches.mjs --branch <name> --execute   # scoped to one branch/worktree
 *
 * In `--execute` mode, a remote-branch removal is verified rather than
 * trusted: after `git push origin --delete <branch>`, `git ls-remote --heads
 * origin <branch>` must print nothing, matching ugcportal-nvg0's K1 (the same
 * verification `pr-review-merge/SKILL.md`'s merge step now requires for a
 * single just-merged PR). A worktree removal uses plain `git worktree remove
 * <path>` with no `--force`, so a dirty or locked worktree is refused by git
 * itself even if the classifier above it were ever wrong; the `git branch -D`
 * that follows it is not refused by git on its own, which is why the
 * unpushed-commits check above exists as its own guard rather than relying
 * on that refusal. That check is no fresher than this clone's
 * `refs/remotes/origin/*`, which `--execute` itself invalidates by deleting
 * remote branches before the worktree loop runs -- so every fetch starts
 * with `git fetch --prune`, every remote delete prunes its own tracking ref
 * immediately, and each worktree's reachability is re-checked right before
 * its `git branch -D`, not trusted from the value computed before either
 * loop started. `git worktree remove` can delete the running process's own
 * `cwd` (git does not refuse this), so `--execute` chdirs to the main
 * worktree first if it started inside any other one -- otherwise every
 * later default-cwd git call, including the final `git worktree prune`,
 * fails with "Unable to read current working directory". That trailing
 * `prune` runs once at the end of `--execute` mode, clearing the
 * administrative entry for every worktree classified `"prune"` above (and
 * any others git finds stale in between).
 *
 * Self-test: npm test -- runs scripts/sweep-merged-branches.test.mjs
 * (vitest), against the pure classification functions and parsers below,
 * following the scripts/sweep-candidates.mjs convention of testing the
 * classification logic directly rather than fabricating a git remote. The
 * unpushed-commits and deleted-worktree-directory cases are also exercised
 * end to end against real temporary git repositories, in the same file --
 * a hand-built fixture object cannot reproduce "git status is clean but
 * the commit was never pushed" or "git itself reports this directory gone".
 */

import { execFileSync } from "node:child_process";

import { isMainModule } from "./lib/is-main.mjs";

// --- Pure classification -------------------------------------------------

/**
 * @param {object} branch
 * @param {string} branch.name
 * @param {boolean} branch.isMainBranch
 * @param {"OPEN"|"MERGED"|"CLOSED"|null} branch.prState null when no PR targets this branch name
 * @returns {{action: "remove"|"keep", reason: string}}
 */
export function classifyRemoteBranch({ name, isMainBranch, prState }) {
  void name; // identifies the branch in the caller's report, not used in the decision
  if (isMainBranch) return { action: "keep", reason: "main branch" };
  if (prState === "MERGED") return { action: "remove", reason: "PR merged" };
  if (prState === "OPEN") return { action: "keep", reason: "PR open" };
  if (prState === "CLOSED") return { action: "keep", reason: "PR closed without merge" };
  return { action: "keep", reason: "no PR found for this branch" };
}

/**
 * A remote branch deletion only removes a ref on `origin` -- it never
 * destroys a commit, which is why `classifyRemoteBranch` above has no
 * unpushed-commits check of its own. A worktree's local branch is different:
 * `deleteLocalBranch` (below) force-deletes it with `git branch -D`, which
 * DOES destroy a commit that only exists there.
 *
 * @param {object} worktree
 * @param {string} worktree.path
 * @param {string|null} worktree.branch null for a detached-HEAD worktree
 * @param {boolean} worktree.isMainWorktree
 * @param {boolean} worktree.isLocked
 * @param {boolean} worktree.isPrunable true when git itself reports this worktree's directory is gone
 * @param {boolean} worktree.statusUnknown true when `git status` could not be read for a reason other than "directory gone" (isPrunable false)
 * @param {boolean} worktree.isDirty
 * @param {boolean} worktree.isPushed true when the branch tip is reachable from a remote branch, or equals the merged PR's own head commit -- irrelevant, and may be any value, unless prState is "MERGED"
 * @param {"OPEN"|"MERGED"|"CLOSED"|null} worktree.prState
 * @returns {{action: "remove"|"keep"|"prune", reason: string}}
 */
export function classifyWorktree({ path, branch, isMainWorktree, isLocked, isPrunable, statusUnknown, isDirty, isPushed, prState }) {
  void path; // identifies the worktree in the caller's report, not used in the decision
  if (isMainWorktree) return { action: "keep", reason: "main checkout" };
  // Locked first, even over isPrunable: `git worktree prune` itself will not
  // touch a locked worktree even when its directory is gone, so offering to
  // prune one here would promise something the final `git worktree prune`
  // call does not do.
  if (isLocked) return { action: "keep", reason: "worktree is locked" };
  if (isPrunable) return { action: "prune", reason: "worktree directory is gone -- git worktree prune will clear it" };
  if (statusUnknown) return { action: "keep", reason: "could not determine whether the worktree is dirty" };
  if (isDirty) return { action: "keep", reason: "worktree has uncommitted changes" };
  if (branch === null) return { action: "keep", reason: "detached HEAD, no branch to check" };
  if (prState === "MERGED") {
    if (!isPushed) return { action: "keep", reason: "unpushed commits" };
    return { action: "remove", reason: "branch's PR merged" };
  }
  if (prState === "OPEN") return { action: "keep", reason: "PR open" };
  if (prState === "CLOSED") return { action: "keep", reason: "PR closed without merge" };
  return { action: "keep", reason: "no PR found for this branch" };
}

// --- Pure parsers ---------------------------------------------------------

/**
 * `git ls-remote --heads origin` output -> branch names, stripping the
 * `refs/heads/` prefix.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function parseRemoteHeads(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ""));
}

/**
 * `git worktree list --porcelain` output -> one entry per worktree, in the
 * order git printed them. `man git-worktree`'s LIST subcommand documents
 * "The main worktree is listed first", which is how the caller decides
 * `isMainWorktree` (index 0) rather than this parser guessing at a tag
 * porcelain mode does not emit.
 *
 * @param {string} output
 * @returns {{path: string, branch: string|null, headSha: string|null, locked: boolean, lockReason: string|null, prunable: boolean}[]}
 */
export function parseWorktreeList(output) {
  const entries = [];
  let current = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null, headSha: null, locked: false, lockReason: null, prunable: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
      current.lockReason = line === "locked" ? null : line.slice("locked ".length);
    } else if (current && line.startsWith("prunable")) {
      current.prunable = true;
    }
    // `detached` and `bare` lines, plus blank separator lines, are not
    // needed by either classifier field and are ignored.
  }
  flush();
  return entries;
}

/**
 * `gh pr list --state all --json headRefName,state,number,headRefOid` output
 * -> the most recently listed PR's state and head commit per branch name.
 * `gh pr list` without `--search` sorts by creation descending, so the first
 * entry seen per branch is its newest PR -- the one a re-used branch name
 * should be judged by.
 *
 * @param {{headRefName: string, state: string, headRefOid: string}[]} prs
 * @returns {Map<string, {state: string, headRefOid: string}>}
 */
export function buildPrInfoByBranch(prs) {
  const map = new Map();
  for (const pr of prs) {
    if (!map.has(pr.headRefName)) map.set(pr.headRefName, { state: pr.state, headRefOid: pr.headRefOid });
  }
  return map;
}

/** @returns {boolean} whether main() needs to run isShaPushedToRemote at all -- false short-circuits straight to isPushed: true, the same as isDirty's `!wt.prunable` guard: a prunable worktree's directory is gone, so `-C` into it to check `branch -r --contains` is as unsafe as the status call that guard already protects. */
export function needsPushedCheck({ prState, headSha, isPrunable }) {
  return prState === "MERGED" && Boolean(headSha) && !isPrunable;
}

/** @returns {string|null} null well under `limit`; otherwise a message naming both numbers -- `gh pr list --limit <limit>` silently drops the OLDEST PRs past that cap, which is the merged-but-forgotten drift this script exists to sweep, so `count >= limit` fails closed rather than silently sweeping an incomplete PR list. */
export function prListCapWarning(count, limit) {
  if (count < limit) return null;
  return `gh pr list returned ${count} PRs, at or above the --limit ${limit} cap -- the oldest merged PRs may be missing from this sweep.`;
}

/** @returns {{branch: string|null}|{error: string}} a present-but-empty or missing `--branch` value is a usage error, not a silent repo-wide fallback -- reading it as "no filter" turns one branch's scoped cleanup into every eligible branch and worktree in the repo. Accepts `--branch <name>` and `--branch=<name>`; any other token starting with `--branch` is also a usage error rather than being ignored (which would read as "no filter" too). A value starting with `--` (e.g. `--branch --execute`, where "--execute" becomes the value) is treated as missing, not as a literal branch name. */
export function parseBranchFlag(argv) {
  const token = argv.find((arg) => arg.startsWith("--branch"));
  if (token === undefined) return { branch: null };

  const usageError = { error: "--branch requires a non-empty value" };

  if (token === "--branch") {
    const value = argv[argv.indexOf(token) + 1];
    return !value || value.startsWith("--") ? usageError : { branch: value };
  }
  if (token.startsWith("--branch=")) {
    const value = token.slice("--branch=".length);
    return !value ? usageError : { branch: value };
  }
  return { error: `unrecognized form of --branch: ${token}` };
}

/** @returns {string|null} the main worktree to chdir into before anything destructive runs, or null if `cwd` isn't inside any other worktree. `worktrees[0]` is the main worktree (parseWorktreeList's own documented convention). `git worktree remove` deletes a worktree's directory even when it is the running process's own cwd, after which every default-cwd git call fails. */
export function resolveChdirTarget(worktrees, cwd) {
  const mainWorktreeRoot = worktrees[0]?.path ?? null;
  if (!mainWorktreeRoot || cwd === mainWorktreeRoot) return null;
  const inside = worktrees.slice(1).some((wt) => cwd === wt.path || cwd.startsWith(`${wt.path}/`));
  return inside ? mainWorktreeRoot : null;
}

// --- git/gh integration -------------------------------------------------
// `isWorktreeDirty` and `isShaPushedToRemote` shell out to git and ARE
// exercised directly in scripts/sweep-merged-branches.test.mjs, against real
// temporary git repositories -- the unpushed-commits and deleted-directory
// cases they decide are only reproducible against real git state, not a
// hand-built fixture object. The rest of this section (gh calls, `main()`'s
// orchestration) is not unit-tested directly, same convention as
// scripts/lib/git-diff.mjs.

function resolveMainBranch() {
  try {
    return execFileSync("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "main"; // no network, or `gh` unavailable -- every branch in this repo is judged against "main" elsewhere
  }
}

const PR_LIST_LIMIT = 1000;

function fetchPrInfoByBranch() {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--state", "all", "--json", "headRefName,state,number,headRefOid", "--limit", String(PR_LIST_LIMIT)],
    { encoding: "utf8" },
  );
  const prs = JSON.parse(out);
  const warning = prListCapWarning(prs.length, PR_LIST_LIMIT); // see prListCapWarning's own test
  if (warning) throw new Error(warning);
  return buildPrInfoByBranch(prs);
}

function fetchRemoteBranches() {
  const out = execFileSync("git", ["ls-remote", "--heads", "origin"], { encoding: "utf8" });
  return parseRemoteHeads(out);
}

function fetchWorktrees() {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  return parseWorktreeList(out);
}

/** @returns {boolean} true if the worktree at `path` has uncommitted changes. Throws if `path` cannot be read (e.g. already deleted) -- callers must not call this for a worktree already known `prunable`, and must otherwise catch. */
export function isWorktreeDirty(path) {
  const out = execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" });
  return out.trim().length > 0;
}

/** @returns {{reachable: boolean, error: string|null}} whether `sha` is reachable from some remote-tracking branch in the repository at `cwd` -- `error` is set when the check itself could not run, separate from a confirmed `reachable: false`. */
export function checkShaPushedToRemote(sha, cwd = ".") {
  try {
    const out = execFileSync("git", ["-C", cwd, "branch", "-r", "--contains", sha], { encoding: "utf8" });
    return { reachable: out.trim().length > 0, error: null };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

/** @returns {boolean} true if `sha` is reachable from some remote-tracking branch in the repository at `cwd`. Fails closed (false, i.e. "not pushed") on any git error -- used to decide whether a commit is safe to force-delete, so a failed check and a confirmed `false` are not distinguished here (see checkShaPushedToRemote / recheckBeforeDeletingBranch for callers that need to tell them apart). */
export function isShaPushedToRemote(sha, cwd = ".") {
  return checkShaPushedToRemote(sha, cwd).reachable;
}

/** @returns {{action: "delete"}|{action: "keep", reason: string}} the live re-check immediately before a worktree's `git branch -D` -- re-derives reachability rather than trusting the value computed before the remote-branch loop ran. Tells a commit confirmed not reachable apart from a check that could not run at all (e.g. a broken `cwd`), so a diagnostic isn't stated as something the check didn't actually establish. */
export function recheckBeforeDeletingBranch({ headSha, prHeadRefOid, cwd = "." }) {
  if (headSha === prHeadRefOid) return { action: "delete" };
  const { reachable, error } = checkShaPushedToRemote(headSha, cwd);
  if (error) return { action: "keep", reason: `could not verify reachability: ${error}` };
  if (!reachable) return { action: "keep", reason: "only ref was the deleted remote branch" };
  return { action: "delete" };
}

/** Best-effort: refreshes stale `refs/remotes/origin/*` before classification, so a branch deleted some other way (GitHub UI, an earlier sweep) since the last fetch reads as gone, not pushed. A failure (no network, no remote) is reported but does not abort the sweep -- the existing refs are used as-is, same as if this call were skipped. */
export function pruneRemoteTrackingRefs(cwd = ".") {
  try {
    execFileSync("git", ["-C", cwd, "fetch", "--prune", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function deleteRemoteBranch(name, cwd = ".") {
  execFileSync("git", ["-C", cwd, "push", "origin", "--delete", name], { stdio: ["ignore", "pipe", "pipe"] });
  const remaining = execFileSync("git", ["-C", cwd, "ls-remote", "--heads", "origin", name], { encoding: "utf8" });
  if (remaining.trim().length > 0) {
    throw new Error(`origin/${name} still present after delete (git ls-remote still lists it)`);
  }
  // Prune this branch's own now-stale tracking ref immediately, rather than
  // waiting for the next pruneRemoteTrackingRefs call -- a worktree whose
  // branch this same run is about to force-delete is checked against this
  // ref later in this same execution, so it has to be gone now, not just at
  // the next sweep.
  try {
    execFileSync("git", ["-C", cwd, "update-ref", "-d", `refs/remotes/origin/${name}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // best-effort -- a later pruneRemoteTrackingRefs call catches it regardless
  }
}

export function removeWorktree(path) {
  // No --force: a dirty or locked worktree is refused by git itself here.
  execFileSync("git", ["worktree", "remove", path], { stdio: ["ignore", "pipe", "pipe"] });
}

export function deleteLocalBranch(branch) {
  // Not refused by git the way removeWorktree's dirty/locked case is --
  // that gate already happened in classifyWorktree (isPushed), so only an
  // already-safe branch ever reaches this call with action "remove".
  execFileSync("git", ["branch", "-D", branch], { stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  const execute = process.argv.includes("--execute");

  const branchFlag = parseBranchFlag(process.argv);
  if ("error" in branchFlag) {
    console.error(branchFlag.error);
    process.exitCode = 1;
    return;
  }
  const onlyBranch = branchFlag.branch;

  const worktrees = fetchWorktrees();
  const chdirTarget = resolveChdirTarget(worktrees, process.cwd());
  if (chdirTarget) {
    console.log(`running from inside a worktree this run may remove -- switching to the main checkout (${chdirTarget}) first`);
    process.chdir(chdirTarget);
  }

  if (!pruneRemoteTrackingRefs()) {
    console.error("warning: git fetch --prune failed -- remote-tracking refs may be stale");
  }
  const mainBranch = resolveMainBranch();
  const prInfoByBranch = fetchPrInfoByBranch();

  let branchCandidates = fetchRemoteBranches().map((name) => ({
    name,
    ...classifyRemoteBranch({ name, isMainBranch: name === mainBranch, prState: prInfoByBranch.get(name)?.state ?? null }),
  }));

  let worktreeCandidates = worktrees.map((wt, index) => {
    const isMainWorktree = index === 0;

    let isDirty = false;
    let statusUnknown = false;
    // Never call git status on a path git itself already reports as gone --
    // and the main worktree is always kept regardless, so there's nothing
    // to learn by checking it either.
    if (!isMainWorktree && !wt.prunable) {
      try {
        isDirty = isWorktreeDirty(wt.path);
      } catch {
        statusUnknown = true; // some OTHER read failure (permissions, a transient git error, ...) -- keep, don't crash
      }
    }

    const prInfo = wt.branch ? (prInfoByBranch.get(wt.branch) ?? null) : null;
    const isPushed = needsPushedCheck({ prState: prInfo?.state, headSha: wt.headSha, isPrunable: wt.prunable })
      ? wt.headSha === prInfo.headRefOid || isShaPushedToRemote(wt.headSha, wt.path)
      : true;

    const classification = classifyWorktree({
      path: wt.path,
      branch: wt.branch,
      isMainWorktree,
      isLocked: wt.locked,
      isPrunable: wt.prunable,
      statusUnknown,
      isDirty,
      isPushed,
      prState: prInfo?.state ?? null,
    });
    return { path: wt.path, branch: wt.branch, headSha: wt.headSha, prHeadRefOid: prInfo?.headRefOid ?? null, ...classification };
  });

  if (onlyBranch) {
    branchCandidates = branchCandidates.filter((c) => c.name === onlyBranch);
    worktreeCandidates = worktreeCandidates.filter((c) => c.branch === onlyBranch);
  }

  console.log("--- sweep-merged-branches: remote branches ---");
  for (const c of branchCandidates) {
    console.log(`  [${c.action}] ${c.name} -- ${c.reason}`);
  }
  console.log(`remove candidates: ${branchCandidates.filter((c) => c.action === "remove").length}`);

  console.log("--- sweep-merged-branches: worktrees ---");
  for (const c of worktreeCandidates) {
    console.log(`  [${c.action}] ${c.path} (${c.branch ?? "detached"}) -- ${c.reason}`);
  }
  console.log(`remove candidates: ${worktreeCandidates.filter((c) => c.action === "remove").length}`);
  console.log(
    `prune candidates: ${worktreeCandidates.filter((c) => c.action === "prune").length} (cleared by \`git worktree prune\` below in --execute mode)`,
  );

  if (!execute) {
    console.log("(dry run -- pass --execute to remove the candidates listed above)");
    return;
  }

  let failures = 0;

  for (const c of branchCandidates.filter((x) => x.action === "remove")) {
    try {
      deleteRemoteBranch(c.name);
      console.log(`removed origin/${c.name}`);
    } catch (err) {
      failures++;
      console.error(`failed to remove origin/${c.name}: ${err.message}`);
    }
  }

  for (const c of worktreeCandidates.filter((x) => x.action === "remove")) {
    try {
      removeWorktree(c.path);
      console.log(`removed worktree ${c.path}`);
    } catch (err) {
      failures++;
      console.error(`failed to remove worktree ${c.path}: ${err.message}`);
      continue; // the worktree is still there -- its branch is still in use, don't touch it
    }
    if (c.branch) {
      // Re-evaluate reachability right before this one irreversible step,
      // not the value computed before the remote-branch loop above ran --
      // that loop may have just deleted the very ref this candidate's
      // "remove" verdict relied on.
      const verdict = recheckBeforeDeletingBranch({ headSha: c.headSha, prHeadRefOid: c.prHeadRefOid });
      if (verdict.action === "keep") {
        console.error(`kept local branch ${c.branch}: ${verdict.reason}`);
        continue;
      }
      try {
        deleteLocalBranch(c.branch);
        console.log(`deleted local branch ${c.branch}`);
      } catch (err) {
        failures++;
        console.error(`worktree ${c.path} removed, but failed to delete local branch ${c.branch}: ${err.message}`);
      }
    }
  }

  try {
    execFileSync("git", ["worktree", "prune"], { stdio: ["ignore", "pipe", "pipe"] });
    console.log("ran: git worktree prune");
  } catch (err) {
    failures++;
    console.error(`failed to run git worktree prune: ${err.message}`);
  }

  if (failures > 0) {
    console.error(`${failures} removal(s) failed -- see above`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
