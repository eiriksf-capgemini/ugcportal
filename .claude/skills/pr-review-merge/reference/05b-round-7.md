# pr-review-merge reference: the 7+ row's entry conditions (step 5) and round 7 and after (step 5b)

Moved verbatim from `SKILL.md` by ugcportal-j13u. The checklist in `../SKILL.md` is what a round follows; this file holds the rationale, catalogued incidents and worked examples behind it, and where the two differ, this text is the rule. The commands, templates, tables and headings the checklist carries verbatim are not repeated here; an italic line marks where each one stood. "Above", "below" and "this file" in the moved text refer to the original single file: read them as earlier or later in the same step, in the checklist or in this reference.

*(From step 5, continued.)*

**The `7+` row requires three things, all of them, and none of them is arithmetic.** It is the one row in which almost nothing can block a merge, so it gets the strictest entry conditions in this file.

1. **The chain must be `exact`.** Not merely non-`broken` — `exact`. An `approx` chain is one whose number this skill did not independently record — somebody typed it, or the PR's own author wrote the markers — and this row on top of that means a PR merges with only an unresolved-blocker test standing between it and `main`. This is the condition that actually closes the hole; the clamp in step 4b narrows it, but only this makes it unreachable.
2. **The most recent stop comment at or above round 6 must exist**, found rather than inferred — and it is *the latest* one, never literally `6`. Anchoring to `6` was a bug: after a round-7 hand-back, round 8 re-entered this row on the *same* round-6 comment and the *same* pre-round-7 commits, with no new activity at all, and rounds 9, 10, … did the same. The anchor must advance with the chain.

   ```bash
   read -r anchor_n stop_at < <(
     gh api repos/:owner/:repo/issues/<n>/comments --paginate \
       --jq '.[] | [.created_at, ((.body // "") | split("\n")[0] | sub("\r$"; ""))] | @tsv' \
     | jq -Rrn '
       [ inputs | split("\t")
         | {at: .[0], line: (.[1] // "")}
         | . + (.line | capture("^<!-- ugcportal-review-round: (?<r>[0-9]+)( approx)? -->$"))
         | .n = (.r | tonumber)
         | select(.n >= 6 and .n <= 100)
       ] | max_by(.n) | select(. != null) | "\(.n)\t\(.at)"')
   [ -n "$stop_at" ] || { echo "no round-6-or-later stop comment: the 7+ row does not apply" >&2; exit 1; }
   ```

   The `.n <= 100` half of that `select` is the same sanity ceiling step 4b applies, for the same reason and with the same value: a marker number comes from a comment, so it is untrusted, and `max_by(.n)` hands the anchor to whoever writes the biggest number. Measured on a fixture of a genuine `6 approx`, a genuine `7`, and one forged `<!-- ugcportal-review-round: 100000000000 -->`: without the ceiling the probe anchors to the **forged** comment and its timestamp; with it, to the real round 7. (A PR carrying that marker also reads `broken` in step 4b, and a `broken` chain never merges, so this is the belt to that braces — but the two commands have to agree on what a plausible `N` is, or the next reader has to work out which one is authoritative.)

   The `sub("\r$"; "")` is not cosmetic: GitHub returns `\r\n` for bodies authored or edited through the web UI, and jq's `$` does not match before a trailing `\r`. Without it, step 4b (which does strip) counts a human-written escalation while this probe cannot see it, and the return path is unreachable on exactly the PRs a human touched. `select(. != null)` matters too — `max_by` on an empty array returns `null`, and `"\(.n)" // empty` happily interpolates it as the string `"null null"`, which is truthy. That one was caught by running it.

3. **Something must have happened since the anchor**, or there is nothing for this round to verify:

   ```bash
   # head SHA now vs the one recorded in the anchor comment (step 5 records it)
   gh pr view <n> --json headRefOid --jq .headRefOid

   # non-bot human comments after the anchor
   gh api repos/:owner/:repo/issues/<n>/comments --paginate \
     --jq '.[] | [.created_at, .user.type, ((.body // "") | startswith("<!-- ugcportal-review")), .html_url] | @tsv' \
   | jq -Rrn --arg t "$stop_at" '[inputs | split("\t")
       | select(.[0] > $t and .[1] != "Bot" and .[2] == "false")] | .[] | .[3]'
   ```

   Evidence is **a changed head SHA, or at least one non-bot human comment** after the anchor. Zero of both means nobody has acted — do not merge, do not re-hunt; say the escalation is still outstanding and stop.

   Two things this deliberately does *not* use. `.commit.committer.date` is when a commit was **authored**, not when it was pushed: a fix committed at 10:00 while round 6 was still running, escalated at 10:05 and pushed at 10:06, is invisible to a date comparison, so the return path closes on precisely the PRs it exists for. Comparing the head SHA against the one recorded in the anchor comment has no such gap. And the human-comment probe now filters `.user.type != "Bot"`, matching the bootstrap probe one section up — without it a Dependabot note or a preview-deploy bot satisfies "someone acted on the escalation" and the run enters this row with nobody having touched the blocker.

   **The `[ -n "$stop_at" ]` guard is what stops this check passing vacuously.** `tail -1` on empty input yields the empty string, and `select(.[0] > "")` is true for *every* ISO timestamp — so an unguarded empty `stop_at` reports the PR's entire history as "evidence someone acted" and condition 3 waves through a PR with no round-6 stop at all. Three findings in this file now share that shape: an empty variable that turns a filter into a pass-through. When a comparison is driven by a captured value, guard the capture, in the same block.

   Note the shape: `gh api --jq` takes **no `--arg`**, so the timestamp comparison happens in a downstream `jq -Rrn`, the same split this step already uses for the marker count. The first draft of these two commands passed `--arg` to `gh api` and failed with `accepts 1 arg(s), received 4` the first time it was run — which is the whole reason this file requires every command in it to have been executed rather than reasoned about.

If any of the three fails, the `7+` row does not apply however high the count is — but the two failure modes do not have the same answer, and an earlier draft gave them the same one:

- **Condition 1 or 2 fails** (the chain is not `exact`, or there is no stop comment at or above 6 to anchor to): the count is above 6 with nothing behind it, so **treat the round as 6, the cap** — which on an `exact` chain merges with its lows filed, and on an `approx` chain escalates to a human, because an `approx` chain runs the `1` row's rules at every round and may not auto-merge at the cap.
- **Condition 3 fails** (there *is* an anchor at or above 6, and nothing has happened since it): **do not merge and do not re-hunt.** The escalated blocker is by definition still outstanding — nobody has pushed a commit or said a word since the escalation — so say exactly that, stamp the non-counting `<!-- ugcportal-review-stop: escalation-outstanding -->` marker (through the "before any stamp" checkpoint below), and stop. This is the rule stated under condition 3 above, and it is not the same as "treat as 6": treating it as 6 would re-run the cap's *merge* branch against a PR whose open blocker nobody has touched. The marker is non-counting because nothing was decided: a counting stamp would grow the chain by one on every idle re-run of an untouched PR — 7, 8, 9, … — moving the anchor forward each time while no review verdict and no human action ever happened, which is the "effort spent is not rounds counted" invariant in step 4b read backwards. (Its own stamp is not mistaken for *evidence*: the condition-3 probe drops every comment whose body starts with `<!-- ugcportal-review`. The harm is the inflation, not a false positive.)

If all three hold, link the anchor comment and the evidence in your step 5b comment as the things being verified.

*(From step 5, continued.)*

**When you fall back to "treat as 6" — on any chain, `approx` or `exact` — do not stamp `6`.** That is the trap: the counting marker means "round N completed", the chain already contains a `6`, and stamping a second one trips the duplicate check and turns the chain permanently `broken` — after which the only recovery, a chain reset, yields `approx`, which lands back on this same line and loops. Measured: `[6 approx]` → `6 approx`; `[6 approx, 6]` → `6 broken`; plus a reset → `6 approx` again. A fallback that corrupts the state it is reading is worse than no fallback. So this path stamps the **non-counting** `<!-- ugcportal-review-stop: approx-cap -->` (step 5, through the "before any stamp" checkpoint below) and the chain stops growing.

*(From step 5b.)*

Escalating at the cap hands the PR to a human. It does not retire the PR, and it must not make the PR permanently unmergeable — bounding the rounds by making the work unfinishable is not a stopping rule, it is a dead end.

So: the human (or the implementer) addresses the blocker and `/pr-review-merge` runs again. Step 4b reports 6, and this is round 7.

**Do not reach this step by arithmetic.** An earlier draft argued that round 7 could only follow a round-6 escalation, because round 6 either merges or stops for a human. That deduction is not safe on its own: a bootstrap, or any mis-stamp, can produce a number above 6 with no escalation behind it.

Worse, and this is the case that forced the `exact` requirement: the escalation comment this skill posts for an `approx` cap stop has `<!-- ugcportal-review-round: 6 approx -->` as its first line — which the round-6 stop probe matches, because its pattern is `6( approx)?`. So a bootstrap that stamps `6 approx` and escalates would, on the *very next* run with no human action at all, read `6 approx` → round 7 → find its own escalation comment → treat "the count is approximate" as the outstanding blocker, find nothing that could resolve it → merge. A PR whose entire provenance is a number somebody typed would merge on its second run. The clamp does not stop that; it produces it.

So step 5's three entry conditions all apply, and the first one is what closes it: the chain must be **`exact`**, not merely non-`broken`. An `approx` chain can never enter this row, so a bootstrap cannot reach it however the arithmetic lands. The stop-comment probe and the evidence-of-action check are the two independent backstops.

**What is bounded at round 7+ is the *decision*, not the looking.** An earlier draft said this round is "scoped to the blocker". That was wrong when step 4 ran through `Skill(skill: "code-review", ...)`, whose only interface took a PR number and an effort level with no argument to restrict it to part of a diff, and it is still wrong now that step 4 is this agent running all six finder angles itself: nothing stops narrowing the scope technically, but doing so is exactly the depth regression `ugcportal-2yj` rules out. So the rule was never a tool limitation, it is a policy rule, and an agent that tried to scope the reviewer anyway ran a full seventh hunt while the text claimed otherwise. The honest rule:

- **Run step 4 in full** — all six finder angles, each verified, plus the 4.1 family sweep and the two scope rules (4.2 fires if the fix that answered the escalation changed behaviour, which it usually did; 4.3 applies as written, since this round is one that may approve) — at its normal depth. Do not try to scope the reviewer to the blocker.
- **What changes is what may block: severity, never age.** The PR stays open if the escalated blocker is unresolved, **or if any medium-or-above is outstanding, whenever it was first raised**. Lows are filed under 5a rather than fixed here, and that is the only relaxation. An earlier draft said "the escalated blocker, or a *new* medium-or-above", which left a medium first raised at round 7 in neither bucket — so at round 8 the text permitted merging past an open medium, contradicting both "nothing above low is ever closed by the cap" and "a medium-or-above blocks at every round including the last". Age was never the right axis.
- **This round cannot start another, and cannot be re-entered for free.** It ends in exactly one of two states: merge on step 5's always-applies gates (saying in the round-marker comment that this is a post-escalation verification round, and linking the anchor comment it answers), or hand it back to the same human. Either way it stamps a counting marker, which becomes the new anchor — so a subsequent round 8 has to show fresh evidence against *that* comment, not against the original round-6 one. Without that, rounds 8, 9, 10 … all re-qualified off the same stale artifacts and the post-escalation band was unbounded. (If the escalated blocker was a *sensitive path*, step 2 still stands and the PR goes to a human regardless.)

That is where the cost bound actually comes from: not from looking less, but from this being the last round that can block, with a human on the other side of it either way.

Stamp the round marker as usual, on whichever comment ends the pass.
