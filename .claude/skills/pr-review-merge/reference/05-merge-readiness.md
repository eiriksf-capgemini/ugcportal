# pr-review-merge reference: step 5, merge readiness, the inline-fix checks, BEHIND recovery and branch cleanup

Moved verbatim from `SKILL.md` by ugcportal-j13u. The checklist in `../SKILL.md` is what a round follows; this file holds the rationale, catalogued incidents and worked examples behind it, and where the two differ, this text is the rule. The commands, templates, tables and headings the checklist carries verbatim are not repeated here; an italic line marks where each one stood. "Above", "below" and "this file" in the moved text refer to the original single file: read them as earlier or later in the same step, in the checklist or in this reference.

**The merge does not depend on an approval record, but it does depend on the branch being up to date (ugcportal-li65).** Two different GitHub mechanisms govern `main`, and they are separate APIs: classic branch protection and **rulesets**. The classic endpoint, `gh api repos/:owner/:repo/branches/main/protection`, returns `404 Branch not protected` — that is expected and is **not** evidence that `main` is ungoverned. The live check is the rulesets endpoint:

```bash
gh api repos/:owner/:repo/rulesets --jq '.[] | [.id,.name,.target,.enforcement] | @tsv'
# measured 2026-10-16:  24754352	main	branch	active
gh api repos/:owner/:repo/rulesets/24754352 --jq '[.rules[] | select(.type=="required_status_checks") | .parameters.strict_required_status_checks_policy], [.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count]'
# measured 2026-10-16:  [true]  and  [0]
```

So `gh pr merge` does not require an approving review to succeed — ruleset `main` (id 24754352, active, on `~DEFAULT_BRANCH`) requires **0** approving reviews — so proceed to merge whether the approval attempt above ran, succeeded, or was skipped. But the same ruleset sets `strict_required_status_checks_policy: true`, so a PR whose base has moved on is refused. Read `mergeStateStatus` before merging:

*[A command or template kept verbatim in SKILL.md stood here.]*

- `CLEAN`: require `headRefOid` to equal `<reviewed-sha>` (the head step 1 printed, never this read's value taken as the reference). A different head is a push after review: stop, post the follow-up comment, release the lock and report ("Every stop path" below); it is a new round, not a merge. Only an equal head goes on to the merge below, which pins it with `--match-head-commit <reviewed-sha>`. The one exception is this round's own inline-fix commit, under "After an inline fix" below.
- `mergeStateStatus: BEHIND` (the strict policy at work): run the recovery below. Do **not** treat it as mergeable and do not retry `gh pr merge` hoping it passes.
- `mergeStateStatus: UNKNOWN`: transient right after a push. Re-read once (`sleep 10`, then the same command); if it still prints `UNKNOWN`, treat it as "any other value" below.
- `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`, `BLOCKED` or `UNSTABLE`, or any other value: not mergeable. Stop; nothing below applies. (`CONFLICTING` is a `mergeable` value; the others are `mergeStateStatus` values. Read both fields.) This stop, and the `UNKNOWN` stop above, end the way every recovery stop does: post the follow-up comment, release the lock, report (see "Every stop path" below). The "Auto-approved (review round N)" comment is already on the PR, and it must not stand alone.

**After an inline fix (`review-standards` section 3, ugcportal-kwxh).** These checks run on both paths that end a reviewed-clean round: before the merge below on the auto-merge path, and before the round comment and the `needs-human-merge` label on the sensitive-path stop (step 2). Each is a stop on failure (with the "Every stop path" ending below; on the sensitive-path stop, no label goes on).

*A fix commit.* When this round pushed an inline-fix commit, `<fix-sha>` — the head after that push, written down from `git rev-parse HEAD` in the reviewer's worktree once the push succeeded — takes the place of `<reviewed-sha>` from here to the merge: the `CLEAN` read requires `headRefOid` to equal `<fix-sha>`, the merge pins `--match-head-commit <fix-sha>`, and a BEHIND recovery runs with `<fix-sha>` as the head it compares and pins against. The round comment carries `inline-fix head=<fix-sha>` on a line of its own, which `scripts/check-human-merge-labels.mjs` (`reviewedHead`) reads ahead of the `ugcportal-measured` line's `at=`, so a label applied on `<fix-sha>` is current and not listed as D; `at=` keeps the head the round measured.

```bash
git fetch origin refs/pull/<n>/head
git merge-base --is-ancestor <reviewed-sha> <fix-sha> || { echo "fix commit does not contain the reviewed head" >&2; exit 1; }
git diff --stat <reviewed-sha> <fix-sha>               # must list exactly the files named in the files= fields of the round's inline fix: lines
gh pr view <n> --json headRefOid,statusCheckRollup     # headRefOid must equal <fix-sha>; step 3's per-run verdict over this rollup must print PASS on every row
```

The ancestor check is the one BEHIND recovery step 2 runs on its update commit, and CI on `<fix-sha>` is waited for the way that step waits for its new head's (re-read every 30 seconds, at most 15 minutes, `headRefOid` re-checked each time; an empty rollup is `PENDING`).

*A body or title edit.* A `gh pr edit` has no commit, so `headRefOid` stays `<reviewed-sha>`, but it is an `edited` event, and `.github/workflows/ci.yml` runs its Guards job on every `edited` event (only the quality job skips a title or body edit). Guards is a required check in ruleset 24754352 and carries the Conventional Commits title guard, which is a title fix's gate in CI. So the edit starts a required run that must finish before any label or merge. Make every body and title fix of the round in **one** `gh pr edit` call: `.github/workflows/ci.yml` puts each PR's edited-event runs in one concurrency group with cancel-in-progress, so a second edit cancels the first run, and step 3 reads CANCELLED as FAIL at a head no commit will move (recorded on run 38910283411, PR #274, and run 38879545271, PR #263). Count the Guards entries in the rollup before the edit, and after it re-read every 30 seconds, at most 15 minutes, until there is one more of them and step 3's per-run verdict prints PASS on every row. A FAIL whose log names the title guard is a stop (the title the guard rejects); a CANCELLED entry that a later edit superseded is re-run with `gh run rerun <run-id>` and read again per step 3, never counted as the one more; running out of time is a stop:

```bash
gh pr view <n> --json statusCheckRollup --jq '[.statusCheckRollup[] | select((.name // "") | startswith("Guards"))] | length'   # before the edit, then after it until the count is one higher
```

**BEHIND recovery (ugcportal-li65).** In order, no step skipped. `<reviewed-sha>` is the `headRefOid` **step 1 printed and you wrote down** (the same `<head>` step 1a used) — the head this run reviewed. It is never re-read from the PR at merge time: that value is whatever is live now, and if something was pushed after step 1 it would be the unreviewed head compared against its own update, which prints nothing and merges unreviewed code.

**Every stop path below ends the same way:** post a follow-up comment on the PR saying the merge did not happen and why (the "Auto-approved (review round N)" comment may already be posted, and it must not stand alone), release the step 1a lock, and report (step 6). Post no new round marker.

```bash
live=$(gh pr view <n> --json headRefOid -q .headRefOid)
[ "$live" = "<reviewed-sha>" ] || { echo "head moved after step 1: $live" >&2; exit 1; }
gh api -X PUT repos/:owner/:repo/pulls/<n>/update-branch -f expected_head_sha=<reviewed-sha>   # gh pr update-branch <n> takes no such guard, so use the API
```

0. **If the live head differs from `<reviewed-sha>`, stop.** That is a push after review, a new round, not a recovery. The `expected_head_sha` on the update makes GitHub refuse a moved head itself (HTTP 422), which is the same stop. A 422 is therefore ambiguous between "moved head" and "conflict"; either way the run stops for a human, and the follow-up comment says which one the live head showed (`<live>` differs from `<reviewed-sha>`, or equal).
1. **If the update itself conflicts or is refused** (HTTP 422 with a live head still equal to `<reviewed-sha>`, or the PR then shows `mergeable: CONFLICTING`), **stop for a human.** Do not resolve conflicts in the review run, and do not merge.
2. **Wait for the new head, then pin everything to it.** GitHub applies the update asynchronously (the API answers `202`, "Updating pull request branch."), so reading the head straight after the PUT can return `<reviewed-sha>` itself. Poll until the head differs, every 5 seconds for at most 2 minutes; a head still equal to `<reviewed-sha>` after that is a stop (report a stall: the command, the elapsed time, the last head). Then require that the reviewed head is an ancestor of the new one:

```bash
new=""
for i in $(seq 1 24); do
  new=$(gh pr view <n> --json headRefOid -q .headRefOid) || new=""
  [ -n "$new" ] && [ "$new" != "<reviewed-sha>" ] && break   # an empty read is a failed read: retry, never a changed head
  sleep 5
done
[ -n "$new" ] || { echo "gh pr view returned no headRefOid within 2 minutes (failed read)" >&2; exit 1; }
[ "$new" != "<reviewed-sha>" ] || { echo "head unchanged after 2 minutes" >&2; exit 1; }   # <new-sha> = $new: write it down
git fetch origin main refs/pull/<n>/head
git cat-file -e <reviewed-sha>^{commit} && git cat-file -e <new-sha>^{commit} || { echo "sha not fetched" >&2; exit 1; }
git merge-base --is-ancestor <reviewed-sha> <new-sha> || { echo "new head does not contain the reviewed head" >&2; exit 1; }
```

   The update creates a **new head commit whose CI has not run**. Merging before it is green would merge a tree nobody tested. Re-read CI on it, with the head and the rollup in **one** call so they describe the same moment, and require the head to equal `<new-sha>` (if it does not, stop: something was pushed after the update and it is a new round):

```bash
gh pr view <n> --json headRefOid,statusCheckRollup
```

   Then apply step 3's per-run verdict to that rollup. Every row must read `PASS`. Do not skip, shortcut or reuse the old head's result. `PENDING`: re-run the command every 30 seconds for at most 15 minutes (the skill has no other CI wait, so this is the bound), re-checking each time that `headRefOid` is still `<new-sha>`; if rows are still `PENDING` then, stop and report a stall (the command, the elapsed time, the last rows). An empty rollup (the step 3 command prints `NO_CHECKS_CONFIGURED\tFAIL`) on the new head is `PENDING`, not `FAIL`: GitHub creates the new head's checks a few seconds after the commit (on #254 the run was created 5 s after the commit and its checks started 8 s after), so re-poll it inside the same 15-minute bound. Only an actual failed check is `FAIL`. `FAIL` or `NO_RUN` on any row: stop for a human with the comment above; do not merge, and do not retry the update.
3. **Exactly one update is made; there is no repeat.** Re-read `gh pr view <n> --json mergeStateStatus,mergeable,headRefOid` and act on every value: `CLEAN` with `headRefOid` equal to `<new-sha>` goes on to step 4. `BEHIND` means main moved again during the wait, and **stops for a human** (a second update would need `expected_head_sha=<new-sha>` and a diff check redone against the reviewed head, and this skill does not define that). `UNKNOWN`: re-read once after `sleep 10`; if it persists, stop. `CONFLICTING`, `DIRTY`, `BLOCKED`, `UNSTABLE`, `HAS_HOOKS`, `DRAFT` or any other value: stop. A `headRefOid` other than `<new-sha>`: stop (a push after the update).
4. **Verify the update changed nothing in the PR's own diff** (both shas are already fetched by step 2) — empty output required:

```bash
diff <(git diff origin/main...<reviewed-sha> | grep -v -e '^index ' -e '^@@ ') \
     <(git diff origin/main...<new-sha>      | grep -v -e '^index ' -e '^@@ ')
```

   The `index <blob>..<blob>` and `@@` hunk-header lines (line numbers and the enclosing function name) are dropped from both sides because they change whenever main shifts line numbers or touches a file the PR touches, however far from the PR's lines; left in, such an update would read as non-empty. **What an empty result proves, and what it does not:** the added, removed and context lines of the PR's hunks (the PR's changed lines plus their three lines of context) are byte-identical between the reviewed head and the new head. A change by main elsewhere in a file the PR touches, outside those lines, is not compared. That is acceptable because it is main's own already-reviewed change, not the PR's, and the new head's CI (step 2) is what covers it. **Empty** means the update was zero-diff for the PR's own lines: it does not start a new review round, the verdict already reached stands, and you merge without posting a new round marker. **Non-empty** means main's changes altered the lines or context of the PR's diff — a real change, so **this run ends here and is not the merging round**: post the comment above (naming the new head), release the lock, and hand back; a fresh run reviews the new head as the next round. Do not start that round in this run: its own round-N marker and approval already sit inside this run's `run_started` window, and step 5's "before any stamp" integrity check would count them and force an `untracked-write` stop.
5. **Record it on the PR before merging**: post a comment giving `<reviewed-sha>`, `<new-sha>` and the step 4 result (`empty`), so the merged head differing from the round marker's `at=` is explained where a reader will look. Then merge with the head pinned: `gh pr merge <n> --squash --match-head-commit <new-sha>` (if squash is refused, the merge step below stops for a human), so a push after step 3 makes GitHub refuse the merge instead of merging an uncompared head. Step 6 reports the same two shas and the result.

Why the update commit is not a round, and how it stays out of 4.2 and 4.4: it is the "main merged between rounds" case [step 4.2](../SKILL.md#42-after-a-behaviour-changing-fix-re-grep-the-whole-file) already handles — its trigger intersects the pushed files with the PR's own files, so the commits `origin/main` contributed drop out, and a zero-diff update adds no change to the PR's own lines (empty step 4 result: the filtered diff proves the PR's hunks and their context are unchanged; main may still have changed other lines of a file the PR touches, so `git diff --name-status <reviewed-sha>...<new-sha>` can still print that file and 4.2's intersection keeps it in its changed-file list, the normal `else` branch, not a fail-safe one). That is the case where the update itself is read. For a recovery that stops without merging, the next round reads something else: the merge template stamps no head SHA, so that run's "Auto-approved" comment is the latest round marker and 4.2 takes its no-SHA branch (`round <n> records no head SHA — trigger FIRES, scope is the whole PR diff`) before any intersection. A human's update commit, by contrast, leaves the previous blocking comment as the latest marker; that comment records a head, so 4.2 compares it and intersects as above. 4.4's trigger keys on sentences the round itself writes rather than on commits, so an update commit supplies none. The case that motivated the rule is PR #254, where the update *did* cost a round: it was refused `BEHIND` after `166c345` (`chore(release): v0.8.0`, #253) landed on `main`; round 1 reviewed `3e74045` (its marker records `at=3e74045`); the update commit `a2302de` (a merge of `166c345` into the PR) was then stamped as round 2 at 07:33:51Z, with a three-dot diff identical to the reviewed one — a round that this rule would have let through without one — and it merged as `bf616bd`. Whether `a2302de` came from `update-branch` through the API, `gh pr update-branch` or the UI button is not determinable from the PR.

*[A command or template kept verbatim in SKILL.md stood here.]*

**Do not pass `--delete-branch` here (ugcportal-hvaf).** `--delete-branch` would delete `headRefName` as part of the merge call itself, with no check for an open PR that still lists it as a base — GitHub auto-closes such a PR the instant its base branch disappears, and refuses both reopen and base-change once the base ref is gone, which cost three PRs their comment history in one day (#126, #120, #123). That check, with a test, already lives in `scripts/sweep-merged-branches.mjs` (`classifyBranchRetarget` / `classifyRetargetVerification` / `classifyPreDeleteRecheck`) — an earlier version of this step re-implemented the same logic again here, by hand, in untested prose, which is exactly the two-copies-drift risk `review-standards`' sibling-omission family warns about. So: merge without the flag, then route the actual deletion through that tested script, below.

*[A command or template kept verbatim in SKILL.md stood here.]*

If `gh pr merge` fails, **stop for a human with the error quoted**, whatever the reason (and the same stop, with the `squashMergeAllowed` value quoted in place of an error, when the `gh repo view` read above says it is false): the branch stopped being mergeable, squash was refused, or GitHub refused the `--match-head-commit` pin because the head moved after the reviewed one. Try no other merge method and do not retry blind. This stop ends the way every recovery stop does: post a follow-up comment saying the merge did not happen and why (the "Auto-approved (review round N)" comment is already on the PR and must not stand alone), post no new round marker, release the step 1a lock, and report (step 6). The marker is already on the PR from the first command above, so the next run counts this round correctly.

**Branch and worktree cleanup now both go through one scoped sweep run, not a hand-run `git push origin --delete` plus a separate hand-run `git branch -D` (ugcportal-nvg0, ugcportal-hvaf):**

*[A command or template kept verbatim in SKILL.md stood here.]*

Run this from the main checkout, not from inside the worktree it may remove (same reason `--execute` itself chdirs there when it detects it started inside one). With `<headRefName>`'s PR now `MERGED`, this one call: retargets any open PR currently based on `<headRefName>` to that PR's own (merged) base before doing anything else, re-verifies live immediately before the delete that nothing new appeared in the meantime, deletes the remote branch only once that is clear — via the GitHub API's ref-delete endpoint, which is a plain ref write with no git hook in the path, falling back to `git push origin --delete` only if `gh` is unavailable or the API call fails for a reason other than the ref already being gone (ugcportal-ix0s: a plain `git push --delete` here would otherwise run `.beads/hooks/pre-push`'s full lint/test/build/typecheck suite for a push that carries no code, and under agent load that suite can flake and wrongly refuse a safe deletion — set `UGCPORTAL_PREPUSH=skip` on this and every other push this skill makes, as any agent push should, since CI re-verifies every push regardless and is authoritative (ugcportal-cky9) — though since `core.hooksPath` is shared across every worktree and points at the **main checkout's** `.beads/hooks`, not each worktree's own copy, the variable only takes effect once this behaviour is on `main` and that main checkout has fast-forwarded to it; until then every push, including this script's fallback, still pays for the full suite) — and, if this merge was driven from inside the implementer's own worktree (the usual case for an agent-run merge) — removes that worktree and its local branch too, gating the worktree's `git branch -D` on an executable check (the branch tip reachable from a remote, or equal to this merge's `headRefOid`), not a comment.

Read its output rather than assuming success: a line reading `removed origin/<headRefName>` means the branch is gone; a line reading `kept origin/<headRefName>: <reason>` means it is not, most likely because an open PR based on it could not be safely retargeted — report that reason plainly in your step 6 report and leave the branch for a human rather than forcing it (a manual `git push origin --delete` here would skip the exact check this script exists to apply). Either way, a final check closes the loop without trusting the log alone:

*[A command or template kept verbatim in SKILL.md stood here.]*

If that still prints a line after the script reported success, say so plainly in your step 6 report with the exact output — do not report the merge as fully clean.

If the PR merges at round 2 or later with low findings deferred, say so explicitly in the round-marker comment posted before merge (and in the approval body too, on the rare chain where approval is attempted and succeeds) and list the bead ids from step 5a.
