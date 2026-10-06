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
 * Retarget-before-delete (ugcportal-hvaf): deleting a remote branch that an
 * OPEN pull request still lists as its *base* auto-closes that PR the moment
 * the branch disappears, and GitHub refuses both reopen and base-change once
 * the base ref is gone -- observed three times in one day (#126, #120,
 * #123), each needing a brand-new PR number and losing its comment history.
 * `--execute` guards every `"remove"`-classified remote branch against this
 * in three stages, a later pass over this bead having found gaps in the original
 * single-stage version (a 30-item silent cap on an un-`--limit`ed query, no
 * re-check once retargeting itself had taken real time, and a frozen
 * recorded base that can point at a branch this same run already deleted):
 *
 *   1. One repo-wide `gh pr list --state open --json number,baseRefName
 *      --limit 1000` snapshot, fetched once near the top of `main()`
 *      (`fetchOpenPrsByBase`/`buildOpenPrsByBase`) -- not one `gh pr list
 *      --base <branch>` round trip per candidate, which is wasted work on
 *      every branch that (almost always) has nothing stacked on it.
 *      `classifyBranchRetarget` decides, from this snapshot, whether
 *      anything needs retargeting at all.
 *   2. If so, each open PR is retargeted with `gh pr edit <n> --base
 *      <newBase>` and the result is read back with `gh pr view` --
 *      `gh pr edit`'s own exit code is not trusted, the same "verify, don't
 *      trust" rule `deleteRemoteBranch` already applies to its own delete
 *      call (the GitHub API, or `git push origin --delete` as its fallback
 *      -- ugcportal-ix0s). `newBase` is not simply this branch's own merged PR's
 *      recorded `baseRefName` (that value is frozen GitHub history, and can
 *      point at an intermediate branch this same sweep -- or an earlier one
 *      -- already deleted): `resolveNewBase` walks that chain up to the
 *      first base still present on `origin`, or `main`, so a multi-level
 *      stack resolves correctly instead of wedging on a dangling name.
 *   3. Immediately before the actual, irreversible `deleteRemoteBranch` call
 *      -- not before, not "close enough" -- one LIVE `gh pr list --base
 *      <branch> --state open --limit 1000` re-check (`fetchOpenPrsBasedOn`
 *      / `classifyPreDeleteRecheck`): the batch snapshot in step 1 is stale
 *      by however long steps 1-2 took, so this is the only point that can
 *      rule out a PR opened in that window.
 *
 * Any failure anywhere in this sequence -- a lookup, an edit, a verify
 * read-back that doesn't match, or something new appearing at step 3 --
 * keeps the branch instead of risking the delete, reporting which PRs (if
 * any) were already safely retargeted before the failure. `--no-retarget-
 * open-prs` switches off the retargeting in step 2 in favour of keep-and-
 * report (so the operator handles the stacked PR by hand instead of this
 * script touching it) -- step 3's safety recheck still runs regardless of
 * that flag, since it protects against a PR the flag was never about.
 *
 * Usage:
 *   node scripts/sweep-merged-branches.mjs                       # dry run: lists candidates only
 *   node scripts/sweep-merged-branches.mjs --execute              # also removes them, repo-wide
 *   node scripts/sweep-merged-branches.mjs --branch <name> --execute   # scoped to one branch/worktree
 *   node scripts/sweep-merged-branches.mjs --execute --no-retarget-open-prs   # keep-and-report instead of retargeting
 *
 * In `--execute` mode, a remote-branch removal is verified rather than
 * trusted: after the delete (via the GitHub API, or `git push origin
 * --delete <branch>` as its fallback -- see `deleteRemoteBranch` and
 * `classifyGhApiDeleteFailure`, ugcportal-ix0s), `git ls-remote --heads
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

/**
 * Decides what to do, for one branch about to be deleted, about any currently
 * OPEN pull requests that use it as their *base* (ugcportal-hvaf) -- a
 * distinct question from the branch's own PR state that classifyRemoteBranch
 * above answers. Deliberately takes the already-fetched PR list rather than
 * querying inside this function, so the decision stays a pure, fixture-driven
 * test (K1) with no `gh` call of its own.
 *
 * @param {object} params
 * @param {{number: number}[]} params.openPrsBasedOnBranch every currently OPEN PR whose base is the branch about to be deleted
 * @param {boolean} params.retarget true unless --no-retarget-open-prs was passed
 * @returns {{action: "none"}|{action: "retarget", prNumbers: number[]}|{action: "keep", reason: string}}
 */
export function classifyBranchRetarget({ openPrsBasedOnBranch, retarget }) {
  if (openPrsBasedOnBranch.length === 0) return { action: "none" };
  const prNumbers = openPrsBasedOnBranch.map((pr) => pr.number);
  if (!retarget) {
    return {
      action: "keep",
      reason: `open PR(s) based on this branch, retargeting disabled by --no-retarget-open-prs: #${prNumbers.join(", #")}`,
    };
  }
  return { action: "retarget", prNumbers };
}

/**
 * Classifies the read-back of one `gh pr edit --base <newBase>` call (K2) --
 * `gh pr edit`'s own exit code is not trusted, the same "verify, don't trust"
 * rule `deleteRemoteBranch` already applies to its own delete call (the
 * GitHub API, or `git push origin --delete` as its fallback -- ugcportal-ix0s).
 * Any mismatch here is what makes the caller keep the branch, with a reason,
 * instead of deleting it while a stacked PR might still be unsafe.
 *
 * @param {object} params
 * @param {number} params.prNumber
 * @param {string} params.actualBaseRefName base read back from `gh pr view` after the edit
 * @param {string} params.expectedBaseRefName the base the edit was supposed to set
 * @param {string} params.state PR state read back after the edit -- must still be OPEN
 * @returns {{action: "ok"}|{action: "failed", reason: string}}
 */
export function classifyRetargetVerification({ prNumber, actualBaseRefName, expectedBaseRefName, state }) {
  if (state !== "OPEN") {
    return { action: "failed", reason: `PR #${prNumber} is no longer open after retargeting (state ${state})` };
  }
  if (actualBaseRefName !== expectedBaseRefName) {
    return {
      action: "failed",
      reason: `PR #${prNumber} base reads back as ${actualBaseRefName}, expected ${expectedBaseRefName}`,
    };
  }
  return { action: "ok" };
}

/** @returns {boolean} true unless --no-retarget-open-prs was passed -- the opt-out from classifyBranchRetarget's default (retarget automatically) behaviour, in favour of keep-and-report. */
export function parseRetargetFlag(argv) {
  return !argv.includes("--no-retarget-open-prs");
}

/**
 * Resolves where an open PR stacked on a branch about to be deleted should
 * actually be retargeted to (ugcportal-hvaf): not always
 * the deleted branch's own recorded `baseRefName` directly, because that
 * value is a merged PR's frozen GitHub history -- it is never updated after
 * the branch IT pointed to is itself deleted. Concretely: branch A's merged
 * PR has base B; B's merged PR has base `main`; B is swept (this run or an
 * earlier one). A PR stacked on A should land on `main`, not on a `B` that
 * no longer exists -- `gh pr edit <n> --base B` would simply fail forever,
 * wedging A in "kept" indefinitely even though the stack trivially resolves.
 *
 * Walks up the base chain while the current candidate is neither `main` nor
 * still present on `origin`, following each intermediate branch's own
 * recorded `baseRefName` from `prInfoByBranch` -- the same snapshot
 * `classifyRemoteBranch` and the caller already use, so this costs no extra
 * `gh` or `git` call. Falls back to `mainBranch` the moment the chain runs
 * out of information (no PR recorded for the current candidate) or exceeds
 * `maxHops`, which also defends a cyclic or otherwise malformed chain from
 * looping forever -- GitHub's own UI prevents a PR from being its own
 * ancestor, but nothing here assumes that holds for every possible `prs`
 * snapshot fed to this function in a test.
 *
 * @param {object} params
 * @param {string} params.baseRefName the branch's own (merged) PR's recorded base -- the starting candidate
 * @param {Set<string>} params.remoteBranchNames branches currently on `origin`, kept in sync by the caller as THIS run's own deletions land
 * @param {Map<string, {state: string, headRefOid: string, baseRefName: string}>} params.prInfoByBranch same snapshot classifyRemoteBranch uses
 * @param {string} params.mainBranch
 * @param {number} [params.maxHops] safety cap on chain length; default well above any realistic stack depth
 * @returns {string}
 */
export function resolveNewBase({ baseRefName, remoteBranchNames, prInfoByBranch, mainBranch, maxHops = 50 }) {
  let candidate = baseRefName;
  const seen = new Set();
  for (let hops = 0; hops < maxHops; hops++) {
    if (candidate === mainBranch) return candidate;
    if (remoteBranchNames.has(candidate)) return candidate;
    if (seen.has(candidate)) return mainBranch; // cycle -- fail safe rather than loop forever
    seen.add(candidate);
    const next = prInfoByBranch.get(candidate)?.baseRefName;
    if (!next) return mainBranch; // chain runs out of recorded information
    candidate = next;
  }
  return mainBranch; // maxHops exceeded -- fail safe
}

/**
 * Classifies the outcome of a failed `gh api -X DELETE
 * repos/{owner}/{repo}/git/refs/heads/<branch>` call (ugcportal-ix0s) --
 * decides whether `deleteRemoteBranch` should treat the branch as already
 * gone (no further action needed) or fall back to `git push origin
 * --delete`. `git push origin --delete` runs `.beads/hooks/pre-push`'s full
 * lint/test/build/typecheck suite for a push that carries no code, and under
 * agent load a tree-walking test (bead 9faa) flakes and wrongly refuses the
 * deletion -- observed four times in one day against PRs #151, #153, #154,
 * #155, each time after the worktree and local branch were already gone.
 * Deleting through the API instead is a single HTTPS ref-delete call with no
 * git hook in the path at all.
 *
 * Verified directly against the real GitHub API (2026-10-06, this repo):
 * deleting an ALREADY-GONE ref through this specific endpoint returns HTTP
 * 422 `{"message":"Reference does not exist",...,"status":"422"}` /
 * `gh: Reference does not exist (HTTP 422)` on stdout/stderr respectively --
 * that is the only already-gone shape this classifies. A 404 is
 * deliberately NOT treated as already-gone (ugcportal-ix0s): verified live
 * that this endpoint also returns
 * `{"message":"Not Found","status":"404"}` / `gh: Not Found (HTTP 404)` when
 * the REPOSITORY itself cannot be resolved (e.g. `{owner}/{repo}` doesn't
 * expand because `origin` isn't a GitHub remote), which is a materially
 * different and more concerning failure than "the branch is already gone" --
 * an unmatched 404 here falls through to `"unavailable"` and the caller
 * falls back to `git push origin --delete`, same as any other unrecognized
 * failure. This is not a safety gap: `deleteRemoteBranch`'s unconditional
 * post-delete `git ls-remote --heads origin <name>` check (unchanged by this
 * function, ugcportal-nvg0's K1) is the actual backstop regardless of which
 * path fired -- it throws if the branch is still there, so a wrongly
 * "already-gone"-classified failure could never have produced a false
 * "removed" either way.
 *
 * @param {object} params
 * @param {boolean} params.ghMissing true when `gh` itself could not be
 *   spawned at all (ENOENT) -- no API call was attempted, so `output` is not
 *   consulted
 * @param {string} params.output combined stdout+stderr text from the failed
 *   `gh api` invocation; ignored when `ghMissing` is true
 * @returns {"already-gone"|"unavailable"} "already-gone" only for the
 *   verified 422 "Reference does not exist" shape; "unavailable" for
 *   everything else (gh missing, a 404, or any other API failure), which
 *   makes the caller fall back to `git push origin --delete`
 */
export function classifyGhApiDeleteFailure({ ghMissing, output }) {
  if (ghMissing) return "unavailable";
  if (/"status"\s*:\s*"422"/.test(output) && /Reference does not exist/i.test(output)) return "already-gone";
  return "unavailable";
}

/**
 * The final check immediately before the irreversible `deleteRemoteBranch`
 * call (ugcportal-hvaf) -- a TOCTOU window the earlier,
 * batch-derived retarget decision (`classifyBranchRetarget`, fed from the
 * single upfront `gh pr list --state open` snapshot `fetchOpenPrsByBase`
 * takes) cannot close on its own: that snapshot is read once, before this
 * loop starts, and retargeting itself takes real wall-clock time (one `gh pr
 * edit` plus one `gh pr view` per stacked PR) -- time in which a brand new
 * PR could be opened with this branch as its base. `main()` re-queries live,
 * right here, and this is the pure decision over that live result: keep
 * (never delete) the moment anything -- new or missed -- still lists this
 * branch as its base, exactly the same "never deletes while a PR still
 * lists it as base" guarantee `classifyBranchRetarget` makes for the
 * earlier, batch-derived check, now re-asserted against current reality
 * rather than a stale snapshot.
 *
 * @param {object} params
 * @param {{number: number}[]} params.openPrsBasedOnBranch a FRESH, live query result, not the batch snapshot
 * @returns {{action: "delete"}|{action: "keep", reason: string}}
 */
export function classifyPreDeleteRecheck({ openPrsBasedOnBranch }) {
  if (openPrsBasedOnBranch.length === 0) return { action: "delete" };
  const prNumbers = openPrsBasedOnBranch.map((pr) => pr.number);
  return {
    action: "keep",
    reason: `open PR(s) appeared based on this branch since the last check, immediately before delete: #${prNumbers.join(", #")}`,
  };
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
 * `gh pr list --state all --json headRefName,state,number,headRefOid,baseRefName`
 * output -> the most recently listed PR's state, head commit and base branch
 * per branch name. `gh pr list` without `--search` sorts by creation
 * descending, so the first entry seen per branch is its newest PR -- the one
 * a re-used branch name should be judged by. `baseRefName` is this branch's
 * own PR's base -- the starting point for what an open PR stacked on this
 * branch gets retargeted to once this branch's PR is MERGED and the branch
 * is about to be deleted (ugcportal-hvaf): `resolveNewBase` walks it further
 * when that recorded base branch is itself already gone from `origin`, so a
 * multi-level stack still resolves correctly rather than wedging on a
 * dangling intermediate name.
 *
 * @param {{headRefName: string, state: string, headRefOid: string, baseRefName: string}[]} prs
 * @returns {Map<string, {state: string, headRefOid: string, baseRefName: string}>}
 */
export function buildPrInfoByBranch(prs) {
  const map = new Map();
  for (const pr of prs) {
    if (!map.has(pr.headRefName)) map.set(pr.headRefName, { state: pr.state, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName });
  }
  return map;
}

/**
 * `gh pr list --state open --json number,baseRefName` output -> every
 * currently OPEN PR, grouped by its base branch (ugcportal-hvaf). One repo-wide snapshot, fetched once near the top of
 * `main()` alongside `fetchPrInfoByBranch`'s own `--state all` snapshot,
 * answers "does anything currently depend on this branch as a base" for
 * EVERY `"remove"`-candidate branch at once -- the same N-calls-to-one-call
 * pattern `fetchPrInfoByBranch` already applies, now applied to the
 * question `classifyBranchRetarget`'s initial decision needs answered,
 * instead of a separate `gh pr list --base <branch>` round trip per
 * candidate. This snapshot is intentionally NOT what the final,
 * immediately-before-delete safety check (`classifyPreDeleteRecheck`) reads
 * -- that check needs a live, per-branch query taken at the moment of
 * deletion, which this upfront batch is taken too early to serve; see the
 * comment above `fetchOpenPrsBasedOn`.
 *
 * @param {{number: number, baseRefName: string}[]} prs
 * @returns {Map<string, {number: number}[]>}
 */
export function buildOpenPrsByBase(prs) {
  const map = new Map();
  for (const pr of prs) {
    const list = map.get(pr.baseRefName) ?? [];
    list.push({ number: pr.number });
    map.set(pr.baseRefName, list);
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
    ["pr", "list", "--state", "all", "--json", "headRefName,state,number,headRefOid,baseRefName", "--limit", String(PR_LIST_LIMIT)],
    { encoding: "utf8" },
  );
  const prs = JSON.parse(out);
  const warning = prListCapWarning(prs.length, PR_LIST_LIMIT); // see prListCapWarning's own test
  if (warning) throw new Error(warning);
  return buildPrInfoByBranch(prs);
}

/** One repo-wide `gh pr list --state open` snapshot (ugcportal-hvaf) -- see buildOpenPrsByBase's own doc for why this exists instead of one `gh pr list --base <branch>` call per candidate. Same `--limit`/cap-warning discipline as fetchPrInfoByBranch, for the same silent-truncation reason (ugcportal-hvaf). */
function fetchOpenPrsByBase() {
  const out = execFileSync("gh", ["pr", "list", "--state", "open", "--json", "number,baseRefName", "--limit", String(PR_LIST_LIMIT)], {
    encoding: "utf8",
  });
  const prs = JSON.parse(out);
  const warning = prListCapWarning(prs.length, PR_LIST_LIMIT);
  if (warning) throw new Error(warning);
  return buildOpenPrsByBase(prs);
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

/**
 * Attempts the primary deletion path (ugcportal-ix0s): `gh api -X DELETE
 * repos/{owner}/{repo}/git/refs/heads/<name>` -- a single HTTPS ref-delete
 * call with no git hook in the path at all, unlike `git push origin
 * --delete` (see `classifyGhApiDeleteFailure`'s doc for why that matters).
 * `{owner}` and `{repo}` are `gh`'s own placeholder syntax, resolved from
 * `cwd`'s git remote -- no separate `gh repo view` round trip needed here.
 *
 * @returns {"deleted"|"already-gone"|"unavailable"} see
 *   `classifyGhApiDeleteFailure` for the latter two; "deleted" is this
 *   function's own success case, not something that classifier decides.
 */
function deleteRemoteBranchViaApi(name, cwd) {
  try {
    execFileSync("gh", ["api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${name}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "deleted";
  } catch (err) {
    if (err.code === "ENOENT") return classifyGhApiDeleteFailure({ ghMissing: true, output: "" });
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    return classifyGhApiDeleteFailure({ ghMissing: false, output });
  }
}

/**
 * Deletes a remote branch, verified rather than trusted either way
 * (ugcportal-nvg0's K1). Primary path (ugcportal-ix0s): the GitHub API's ref
 * delete, via `deleteRemoteBranchViaApi` -- a plain ref deletion that
 * triggers no git hook, unlike `git push origin --delete`, which runs
 * `.beads/hooks/pre-push`'s full lint/test/build/typecheck suite for a push
 * that carries no code and, under agent load, can be wrongly refused by an
 * unrelated flake (bead 9faa). Falls back to `git push origin --delete`
 * only when `gh` itself is unavailable, or the API call failed for a reason
 * other than the branch already being gone -- see
 * `classifyGhApiDeleteFailure` for exactly which responses count as
 * "already gone". Every other safety check this function already made
 * before `ugcportal-ix0s` -- the post-delete `ls-remote` verification (the
 * actual backstop against a wrongly-classified API failure: it throws if
 * the branch is still there, regardless of which path fired), the
 * tracking-ref prune -- is unchanged and runs the same way regardless of
 * which path actually removed the ref.
 */
export function deleteRemoteBranch(name, cwd = ".") {
  const apiResult = deleteRemoteBranchViaApi(name, cwd);
  if (apiResult === "unavailable") {
    execFileSync("git", ["-C", cwd, "push", "origin", "--delete", name], { stdio: ["ignore", "pipe", "pipe"] });
  }
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

/**
 * Every currently OPEN PR whose base is `branch`, queried fresh. This is the
 * ONLY live, per-branch open-PR query left in this file -- the earlier,
 * batch-derived existence check lives in `fetchOpenPrsByBase` instead --
 * and `main()` calls this exactly once per `"remove"` candidate, immediately
 * before that candidate's `deleteRemoteBranch` call, as the final
 * TOCTOU-closing safety check (`classifyPreDeleteRecheck`, ugcportal-hvaf):
 * the batch snapshot is read once before the loop starts and retargeting
 * itself takes real time, so only a live query taken at the moment of
 * deletion can rule out a PR opened in between. Same `--limit`/cap-warning
 * discipline as the other two `gh pr list` call sites in this file. Not
 * unit-tested directly, same convention as the other `gh`-calling functions
 * in this section (see the section comment above).
 *
 * @returns {{number: number}[]}
 */
function fetchOpenPrsBasedOn(branch) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--base", branch, "--state", "open", "--json", "number", "--limit", String(PR_LIST_LIMIT)],
    { encoding: "utf8" },
  );
  const prs = JSON.parse(out);
  const warning = prListCapWarning(prs.length, PR_LIST_LIMIT);
  if (warning) throw new Error(warning);
  return prs;
}

function retargetPr(prNumber, newBase) {
  execFileSync("gh", ["pr", "edit", String(prNumber), "--base", newBase], { stdio: ["ignore", "pipe", "pipe"] });
}

/** @returns {{baseRefName: string, state: string}} read back after a retarget attempt, so the edit is verified rather than trusted (classifyRetargetVerification). */
function fetchPrBaseState(prNumber) {
  const out = execFileSync("gh", ["pr", "view", String(prNumber), "--json", "baseRefName,state"], { encoding: "utf8" });
  return JSON.parse(out);
}

/**
 * Runs for every `"remove"`-classified branch, before `main()`'s final
 * pre-delete recheck (ugcportal-hvaf): retargets every OPEN PR in
 * `openPrsBasedOnBranch` (the upfront batch snapshot, `fetchOpenPrsByBase` --
 * ugcportal-hvaf, not a fresh call of its own) to `newBase` -- or, if
 * `retarget` is false, keeps the branch and reports instead of touching
 * anything -- and verifies every retarget actually landed before giving the
 * caller the go-ahead to delete. Fails closed: any error (an edit, a verify
 * read-back that doesn't match) keeps the branch rather than risking GitHub
 * auto-closing a PR whose base just vanished out from under it.
 *
 * Not atomic across multiple stacked PRs, by design, not by oversight
 * (ugcportal-hvaf): if PR N's retarget+verify succeeds but PR N+1's then
 * fails, N is NOT rolled back -- it is already safely rebased onto
 * `newBase`, which is strictly safer than leaving it on a branch about to be
 * deleted. What this function guarantees instead is that the caller always
 * learns which PRs are in which state: the `"keep"` result's `retargeted`
 * field lists every PR that succeeded before the failure, distinct from the
 * one named in `reason`, so an operator reading the log is never left
 * guessing whether an already-moved PR quietly changed base.
 *
 * @param {{number: number}[]} openPrsBasedOnBranch every currently OPEN PR whose base is the branch about to be deleted, from the upfront batch snapshot
 * @param {string} newBase where to retarget any open PR based on this branch -- resolved by `resolveNewBase`
 * @param {boolean} retarget false when --no-retarget-open-prs was passed
 * @returns {{action: "none"}|{action: "retargeted", prNumbers: number[]}|{action: "keep", reason: string, retargeted: number[]}}
 */
function retargetOpenPrsBeforeDelete(openPrsBasedOnBranch, newBase, retarget) {
  const decision = classifyBranchRetarget({ openPrsBasedOnBranch, retarget });
  if (decision.action !== "retarget") return decision;

  const retargeted = [];
  for (const prNumber of decision.prNumbers) {
    try {
      retargetPr(prNumber, newBase);
    } catch (err) {
      return { action: "keep", reason: `failed to retarget PR #${prNumber} to ${newBase}: ${err.message}`, retargeted };
    }

    let info;
    try {
      info = fetchPrBaseState(prNumber);
    } catch (err) {
      return { action: "keep", reason: `could not verify PR #${prNumber} after retargeting: ${err.message}`, retargeted };
    }

    const verdict = classifyRetargetVerification({
      prNumber,
      actualBaseRefName: info.baseRefName,
      expectedBaseRefName: newBase,
      state: info.state,
    });
    if (verdict.action === "failed") return { action: "keep", reason: verdict.reason, retargeted };
    retargeted.push(prNumber);
  }

  return { action: "retargeted", prNumbers: retargeted };
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
  const retargetOpenPrs = parseRetargetFlag(process.argv);

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
  const openPrsByBase = fetchOpenPrsByBase(); // ugcportal-hvaf: one batch call, not one per candidate

  const remoteBranchList = fetchRemoteBranches();
  // Mutable, and kept in sync as THIS run's own deletions land below --
  // resolveNewBase needs to see a branch this run already deleted as gone,
  // not as it stood in the snapshot taken before the removal loop started
  // (ugcportal-hvaf).
  const remoteBranchNames = new Set(remoteBranchList);

  let branchCandidates = remoteBranchList.map((name) => ({
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
    const recordedBase = prInfoByBranch.get(c.name)?.baseRefName ?? mainBranch;
    const newBase = resolveNewBase({ baseRefName: recordedBase, remoteBranchNames, prInfoByBranch, mainBranch });

    const openPrsBasedOnBranch = openPrsByBase.get(c.name) ?? [];
    const retargetResult = retargetOpenPrsBeforeDelete(openPrsBasedOnBranch, newBase, retargetOpenPrs);
    if (retargetResult.action === "keep") {
      failures++;
      const partial = retargetResult.retargeted?.length
        ? ` (already retargeted before the failure: #${retargetResult.retargeted.join(", #")})`
        : "";
      console.error(`kept origin/${c.name}: ${retargetResult.reason}${partial}`);
      continue;
    }
    if (retargetResult.action === "retargeted") {
      console.log(`retargeted open PR(s) based on origin/${c.name} to ${newBase}: #${retargetResult.prNumbers.join(", #")}`);
    }

    // Final TOCTOU-closing recheck, live, immediately before the irreversible
    // delete (ugcportal-hvaf) -- not the batch snapshot above, which was
    // read before this loop started and is now stale by however long the
    // retargeting above took.
    let freshOpenPrs;
    try {
      freshOpenPrs = fetchOpenPrsBasedOn(c.name);
    } catch (err) {
      failures++;
      console.error(`kept origin/${c.name}: could not verify no new PR appeared since the last check: ${err.message}`);
      continue;
    }
    const recheck = classifyPreDeleteRecheck({ openPrsBasedOnBranch: freshOpenPrs });
    if (recheck.action === "keep") {
      failures++;
      console.error(`kept origin/${c.name}: ${recheck.reason}`);
      continue;
    }

    try {
      deleteRemoteBranch(c.name);
      remoteBranchNames.delete(c.name); // keep resolveNewBase's view in sync for the rest of this run
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
