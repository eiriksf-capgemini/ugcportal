# pr-review-merge reference: step 1, gather facts

Moved verbatim from `SKILL.md` by ugcportal-j13u. The checklist in `../SKILL.md` is what a round follows; this file holds the rationale, catalogued incidents and worked examples behind it, and where the two differ, this text is the rule. The commands, templates, tables and headings the checklist carries verbatim are not repeated here; an italic line marks where each one stood. "Above", "below" and "this file" in the moved text refer to the original single file: read them as earlier or later in the same step, in the checklist or in this reference.

*[A command or template kept verbatim in SKILL.md stood here.]*

**Do not also run `gh pr checks <n>` here or anywhere in this skill.** It reports only the latest run per check name, so a title/body edit after a green run makes it print `skipping` for a check that already passed (`ugcportal-h0ef`) — and the inverse is worse: it gives no way to tell "the quality job was skipped by design on this run" apart from "the quality job never ran on this head at all." `statusCheckRollup`, already fetched above, carries every run recorded against the head; step 3 reads it properly.

**Record the printed timestamp in your own notes and substitute it as a literal wherever this file writes `<run_started>`.** Step 4b needs it to tell the PR's pre-existing history apart from the comments and review objects this run is about to create, and taken any later it is useless.

It must be written down rather than left in a shell variable, because **each Bash invocation is a fresh shell — no variable set in one tool call survives into the next.** An earlier draft assigned `run_started=$(date ...)` here and referenced `$run_started` in step 4b; that expands to the empty string, `select(. < "")` is false for every timestamp, and the probe silently returned `0` on every PR, which reads as "genuinely fresh". Three rounds of review have now found the same bootstrap branch unreachable by three different routes, and this was the third. The general rule, which applies to every command in this file: **a value that has to cross a step boundary gets written down; a value used inside one command block must be assigned inside that same block.** Where this file assigns a variable (`me=`, `stop_at=`), the whole fenced block is one invocation and must be run as one.

**Write down three more values from that output, for the same reason:**

- **`headRefOid`** — the branch's head SHA. Every comment template in step 5 records it (`head <headRefOid>`), the `7+` row's condition 3 compares the live head against the one recorded in the anchor comment, and step 1a's lock object points at it. It used to be fetched *only* inside the `7+` block, which runs on a handful of PRs and never before an ordinary round 1-6 blocking comment — so that template's `head <headRefOid>` field had no value to fill in, and an agent either left the placeholder standing or invented something. Either way the anchor a later round compares against carried no real SHA, which silently disarms the SHA half of condition 3 and leaves it resting on the human-comment probe alone. **A value a template requires must be fetched by a step that always runs before that template.**
- **`headRefName`** — the branch name itself. The merge step's branch-deletion verification (below) runs `git ls-remote --heads origin <headRefName>`; it is already in this step's `--json` field list above, so only the writing-down was missing.
- **`author.login`** — the account that opened the PR. Step 4b's counter needs it: a round chain whose markers were written by the PR's own author is self-asserted, and a self-asserted chain can never be `exact`.

Bail out immediately (no review, no approval, no merge — just report why) if:
- `baseRefName` isn't `main` — this skill only handles PRs targeting `main`.
- `mergeable` isn't `MERGEABLE` (conflicts) — report that a rebase/resolve is needed.
