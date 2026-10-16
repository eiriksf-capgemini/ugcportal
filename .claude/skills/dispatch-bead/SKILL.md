---
name: dispatch-bead
description: Dispatch a bead in this repo to an implementer agent. Runs the mechanical dispatch gate (scripts/check-bead-dispatch.mjs) first and refuses to write the brief if it fails, then assembles the brief from the setup that has burned a session before (worktree, prisma generate, capped vitest workers), records the gate's output in the brief so a skipped gate is visible, and names the substance checks the gate could not make so a green gate is not mistaken for a good bead. Use when about to hand a bead to an implementer, when asked to "dispatch ugcportal-xxx", "start work on this bead", or "brief an agent on this bead".
---

# Dispatching a bead (ugcportal)

One bead, one implementer, one PR. This skill covers the step before any of
that: deciding whether the bead is fit to be worked on at all.

Phase 4 of `docs/process/development-process.md` describes the brief. What
it did not have until `ugcportal-kt3k` was a gate — every requirement on a
bead was a sentence somewhere, and a sentence is what gets skipped under
load. Eirik, 2026-10-12: *"Before we start working with the beads all should
pass validation."* A failing bead is a **hard block**, not a warning.

## 1. Run the gate. Its exit status decides.

```bash
git -C /path/to/main/checkout fetch origin main        # freshness is measured against origin/main
set -o pipefail && node scripts/check-bead-dispatch.mjs <bead-id> | tee /tmp/dispatch-<bead-id>.txt
```

**`set -o pipefail` is load-bearing, and it stays on the same line as the
pipeline.** A pipeline's exit status is its *last* command's, `tee` always
succeeds, and neither bash nor zsh sets `pipefail` by default — so without
it this line reports `0` for a bead that failed every check (measured in
both shells on 2026-10-13), and every sentence below about reading the exit
status is then vacuously true. That is the fail-open shape this gate exists
to stop, in the gate's own invocation. Same line, not a line of its own:
each agent tool call gets a fresh shell, so an option set earlier in the
block is not in effect when the pipeline is run by itself. If you would
rather not depend on a shell option at all, do not use a pipeline:

```bash
node scripts/check-bead-dispatch.mjs <bead-id> > /tmp/dispatch-<bead-id>.txt 2>&1; st=$?; cat /tmp/dispatch-<bead-id>.txt; exit $st
```

The trailing `exit $st` is the whole point of that form — stopping after
`cat` would leave the sequence's status as `cat`'s, which is the same
fail-open with a different last command.

Exit `0` — continue to step 2. Exit `1` — **stop**; fix the bead (`bd update
<id> --description=... --acceptance=... --set-metadata ...`) and run it
again. Exit `2` — usage error or an id `bd` cannot resolve; a bead id that
does not exist is itself a finding (`bd memories
verify-every-bead-id-before-putting-it-in-a-brief`).

Do not paraphrase the result and do not decide the bead "is basically fine".
The command is the decision:

```bash
node scripts/check-bead-dispatch.mjs <bead-id> && echo DISPATCH-OK
```

**The failure you should expect most often is freshness.** The gate requires
the bead's `Premise verified` line to name `origin/main`'s *current* HEAD —
that commit itself, not an older one and not one built on top of it — and
prints how many commits stale it is otherwise, or that the commit is not on
`origin/main` at all — usually a branch commit whose PR was since
squash-merged (`main` has the change under a different sha), sometimes a
branch not yet merged; either way it cannot be compared with `main`'s
history, so re-verify against `origin/main`'s HEAD. That is deliberate and it
is the expensive half: clearing it means re-running the bead's premise check
against today's code and writing a new line, not copying a date forward. The
reason is measured — the v0.7.0 premise audit
(`docs/process/premise-audit-v0.7.0-2026-10-08.md`, `ugcportal-j5fl`) found
that only 68 of 136 non-closed beads carried a premise line at all and those
were up to 80 commits stale, and `ugcportal-dabx`'s four-day-old premise was
partly wrong when someone finally looked.

Sweep the whole backlog with `--all` when planning rather than dispatching;
that run is advisory and will report nearly everything as stale, by design.

## 2. Write the brief, and put the gate's output in it

The brief names the bead, the setup, the quality bar and the boundaries.
Mandatory setup, because each item below has burned a session:

- a **private git worktree** (`git worktree add -b <type>/<bead-id>-<slug>
  /tmp/wt-<short> origin/main`); the implementer runs `git` only there and
  `bd` only in the main checkout;
- **`npx prisma generate`** after `npm install` — without it 8 test files
  fail to *collect* and the suite reports a plausible but low total
  (`docs/process/development-process.md` §5.1);
- **capped vitest workers** (`VITEST_MAX_FORKS=2 VITEST_MAX_THREADS=2`) when
  several agents run;
- **the bot identity for the PR**: before any `git push` or `gh pr create` the
  implementer runs (at the start of every Bash call that commits, pushes or
  runs `gh pr create`, since shell state does not persist between calls and an
  empty `GH_TOKEN` silently opens a human-authored PR) `eval "$(GH_APP_PRIVATE_KEY_PATH=/Users/eiriksf/code/ugcportal/hal9000.pem
  node scripts/gh-app-token.mjs --env)"` (it sets `GH_TOKEN` and the git
  author/committer to `hal9000-agent-bot[bot]`), pushes over HTTPS with the
  token (the SSH remote does not carry it; exact command in
  `.claude/agents/worker-implementer.md`), and opens the PR with `GH_TOKEN`
  set, so the PR author reads `app/hal9000-agent-bot` and differs from the
  reviewer's login (`ugcportal-62b6`); it then asserts that with `gh pr view
  <n> --json author -q .author.login`, and anything else is a failed step. The token lasts one hour (re-run the
  eval before a later push) and `gh api user` fails under it, which is
  expected. The reviewer is not briefed to use the bot;
- **a named model** on the spawn (`harness-cost-controls`); the bead's
  `model` / `model_effort` metadata is the estimate to use.

The brief also names the **long-command rule** from the machine section of
`.claude/agents/worker-*.md`: a foreground command carries an explicit
`timeout`; a command expected to run longer than about eight minutes (the full
suite on a cold worktree, Playwright, a cold build) is started in the
background with its output redirected to a file and polled in-turn; a stall is
reported with the command and the elapsed time, never waited out silently, and
the turn does not end while the background task is still running. One example
of each form, to paste into the brief:

```bash
# Foreground, Bash tool call with timeout: 600000 (the ceiling; the default is two minutes).
cd /tmp/wt-<short> && VITEST_MAX_FORKS=2 VITEST_MAX_THREADS=2 npx vitest run src/lib/design
```

```bash
# Background, Bash tool call with run_in_background: true. Output goes to a file;
# the trailing echo records the exit status the poll below waits for.
cd /tmp/wt-<short> && date +%s > /tmp/vitest-<bead-id>.start && VITEST_MAX_FORKS=2 VITEST_MAX_THREADS=2 npx vitest run > /tmp/vitest-<bead-id>.log 2>&1; echo "exit $?" >> /tmp/vitest-<bead-id>.log

# Poll, in a foreground Bash tool call with timeout: 600000, in the same turn.
# Bounded at nine minutes; repeat it while the byte count keeps growing, and
# report a stall (command, elapsed time, last lines) once it stops growing.
i=0; until grep -q '^exit ' /tmp/vitest-<bead-id>.log || [ $i -ge 54 ]; do sleep 10; i=$((i+1)); done; echo "$(( $(date +%s) - $(cat /tmp/vitest-<bead-id>.start) ))s since start, $(wc -c < /tmp/vitest-<bead-id>.log) bytes"; tail -5 /tmp/vitest-<bead-id>.log
```

The bounded `until` loop is the only in-turn poll a worker has. The Monitor
tool is an orchestrator-side tool, not a wait available to a worker: it
returns at once and delivers events as notifications, which a worker could
only receive by ending its turn. The measured basis is the
`ugcportal-fbng` catalogue: entry A19 of 2026-10-14 for the foreground
stalls, and the 2026-10-09 B-side entry for the turns that ended on a
background wait.

And the rule that governs briefs: **never enumerate a set in a brief from
memory**. Paste the command that produced it, or tell the implementer to
re-derive the set and report differences.

The companion rule covers **review briefs and the orchestrator's reports to
the user**: a claim that nothing has measured yet stays attributed to its
source and marked unverified, in every direction it travels (the review
brief, bead notes, the report to the user), until a reviewer has measured it.
Two shapes, each with its own wording:

- (a) an implementer's self-assessment (a count, a "no overlap", a rationale,
  a matrix cell): "the implementer reports X; not yet verified". Catalogued
  as A14 (an inverted privacy rationale restated in PR #206's round-1 brief),
  A21 (an implementer's "non-overlapping failure sets" repeated to the user;
  PR #208 round 2 measured three shared tests) and A26 (a matrix cell copied
  into a bead's notes that contradicted the leak the bead fixes; PR #208
  round 4);
- (b) the orchestrator's own recollection: "from memory, not from a recorded
  value; not yet verified". Catalogued as A29 (two briefs crediting changes
  to the wrong source: #8 named the right PR, #207, but the wrong commit,
  since the cycle branch is in #207's first commit and not its round-2 fix;
  #9 credited PR #208 with a gate that commit 501df31 introduced) and PR #252
  / `ugcportal-qzfu`, where the round-2 review brief stated the
  installation-token format as fact, the format was wrong, and a defect
  shipped.

A review brief asks the reviewer to test it, do not confirm it. A
report to the user that carries a figure from an agent says whether it was
reproduced and by whom ("reproduced by the reviewer on PR #n", "reproduced by
me with `<command>`", or "not reproduced"). **Never relay an unverified claim,
from either source, to the user or into a brief as established fact.** The
catalogue is `ugcportal-fbng` (via `bd show`); the retrospective's section
2.3, "The orchestrator transcribed instead of deriving", names the gap.

Worked example (PR #252 round 2; both clauses were the orchestrator's own,
from memory and from its own earlier tool output, so this is shape (b)).
Before: "ghs_ plus base62 as far as I know; the probe token this morning
matched". After: "The orchestrator believes, from memory and not from a
recorded value, that the token is `ghs_` plus base62; nothing has verified
this. Mint a real token and check its character set; do not confirm the
format."

The brief must carry this block verbatim, with the real output pasted in:

```
## Dispatch check

$ node scripts/check-bead-dispatch.mjs <bead-id>; echo "exit $?"
<paste the full output, including the SUBSTANCE CHECKS NOT MADE section>
exit 0
```

The command recorded in the block is the **unpiped** one above, with `$?`
echoed, so the `exit 0` line is a status the reader can see was taken from
the run rather than typed. (If you ran the `tee` form at step 1, the saved
`/tmp/dispatch-<bead-id>.txt` is the output to paste; the status still has
to come from a run whose exit code was not swallowed by a pipe.)

**A brief with no `## Dispatch check` block is a dispatch that skipped the
gate**, and it is visible as exactly that — a missing recorded result, not
an unprovable omission. Reviewers and the implementer can both see it. Do
not summarise the output; paste it, including the substance section, because
that section is what stops the block reading as a certificate.

## 3. A green gate is not a good bead

The gate checks that fields are populated. It does not check that they are
right, and the bottom of every run says so. Specifically it did **not**
check whether the premise is true, whether each criterion is satisfiable by
whoever finishes the bead on the day they finish it, whether the guardrail
guards anything, whether the model tier fits, or — the expensive one —
whether a criterion that should exist is missing.

`ugcportal-p3v` is the standing case. The criterion that stops uncleared
material being sold was authored, rewritten and premise-verified across
three dated notes in that bead and never reached its acceptance field; it is
now `ugcportal-zbcs`, a P1. Every field a format check reads was populated
the whole time. `bead-template` says it in its own words: *"the expensive
bead failures are substance failures, not format failures."*

So after the gate passes, spend one minute on the three substance checks in
`~/.claude/skills/bead-template/SKILL.md` ("Before you create"), applied to
a bead that already exists:

1. Is the premise actually **true** today — not just freshly dated?
2. Can the implementer **run** every `Verified by` on the day they finish,
   with only what this bead delivers?
3. Is anything the bead's own notes argue for **missing from the criteria**?

If the answer to (3) is yes, that material becomes a criterion on this bead
before dispatch, or its own bead — not a note.

## 4. Then spawn

Three implementer agents at a time in practice, and never two on the same
`cc_scope`. Claim the bead (`bd update <id> --claim`) and hand over the
brief.
