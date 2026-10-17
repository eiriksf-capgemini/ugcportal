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

Before any pass after the first (a fix round, section 5), run the pass-budget
check of section 6.

## 5. Sending a fix round back: resume or fresh (ugcportal-8r06)

A review round that blocks needs a fix. The agent that made the most recent
pass on the PR can be resumed (`SendMessage`), or a fresh agent can be dispatched. Choose on two
figures, not on how many passes the agent has already had:

- **Carried context**: the `subagent_tokens` of the *last* completion
  notification of the agent that made the most recent pass on the PR (the
  implementer, or the fix agent once a fresh one has taken a round). That is context size, not cost (CLAUDE.md, "Token
  cost metadata"), and it approximates what a resume carries into its first call.
- **Idle time**: minutes since that same agent's last pass ended. The prompt cache
  lives five minutes.

**Rule.** Resume only when carried context is **under 150k tokens AND the
agent has been idle under five minutes**. In every other case, including when
either figure is unknown, dispatch a **fresh agent with a digested brief**:
the findings (verbatim, with their severities), the PR URL and head sha (or the
diff), the files to read, and the setup items of section 2 (prisma generate,
capped vitest workers, the bot identity, a named model, the long-command rule).
Do not use section 2's worktree item as written: its `git worktree add -b ...
origin/<base>` form (the workers' machine section) cuts a new branch for new
work, and a fix must land on the PR's existing head branch. The orchestrator,
which the workers' machine section does not bind, runs `git fetch origin
<branch>` in the shared checkout itself before it spawns, so that the head
commit is present locally, and puts the branch name and the head sha in the
brief. The fresh agent then adds its OWN detached worktree on that commit, from
the shared checkout: `git worktree add --detach /tmp/wt-<bead-id>-fix<N>
<head-sha>` (`<N>` is the fix round; `<head-sha>` may be written
`origin/<branch>`), and pushes with `git push origin HEAD:<branch>`. That
`--detach <path> <commit>` call is the one the machine section already grants
reviewers and analysts (it names no `-b`), so the agent runs no `git fetch` of
its own and needs no exception for it; ugcportal-2day adds the detached
fix-round form to the implementer's list, and until it lands this section owns
it. Do not run `git worktree add <path> <branch>`: the PR's head branch is
normally still checked out in the implementer's live worktree (until the
post-merge sweep removes it), and git then refuses with `fatal: '<branch>' is
already used by worktree at '<path>'` (reproduced in a scratch repo, git 2.54.0,
rc=128, in PR #280's body). A detached worktree creates no local branch, so it
does not depend on who holds one. Never use the implementer's worktree or its
path, which the machine section forbids borrowing. A fresh, agent-named path
also sidesteps `git worktree add` refusing with "missing but already
registered worktree" when an earlier directory was deleted without `git
worktree remove` (the machine section permits neither `git worktree prune` nor
`-f`). If git still refuses on the path, stop and report that; do not force it. Do not
forward the old agent's history.

Case K1, quoted from the bead: an implementer whose last context was 300k
tokens and who has been idle twenty minutes gets a **fresh agent with a
digested brief, not a resume**. Both figures fail the rule independently.

**Where the threshold comes from, stated honestly.**
`docs/process/cost-performance-claims-v0.7.0-2026-10-16.md` section 3 (374
resumed implementer passes, 85 fresh fix agents, 2026-09-17 to 2026-10-15)
puts the crossover between **150k and 250k** of carried context: resumed passes
that started under 150k cost a median 199k ITE, those at 150-250k cost 1,003k,
against a median 612k for a fresh fix agent. 150k is the **conservative edge**
of that band, not a measured optimum. 84% of second passes began with the
cache expired (median idle 888 s), which is why idle time is the second test.
The comparison is observational (fresh fix agents cluster on 2026-10-08 to
10-14, and which rounds got one was not random) and says nothing about whether
a fresh agent's fix needed more review rounds afterwards.

**Worked case.** ugcportal-l6t5, 2026-10-16: implementer `ab608c13f79bda3dd`
ended its one pass with a last notification of 352,596 tokens (the transcript's
last call: 349,162), so the first fix round on PR #255 went to a fresh agent,
`a0b5576299a5578a3`, which began at 29,081 tokens of context and its fix pass
cost at least 183,843 ITE (a lower bound: `a0b5576299a5578a3` ran on
`claude-sonnet-5-5`, whose transcripts under-record output, document section 1.2;
it recorded 109 output tokens over 17 calls). Reproduce with `node scripts/agent-pass-cost.mjs --json
/tmp/passes.json` and select those two agent ids.

**Record one line per fix round (K2).** Write it once the spawn (or the
`SendMessage`) has returned the agent id, in the same turn as the dispatch, and
never with a placeholder such as `pending-spawn`: a placeholder forces a second
line, which a reader matching on the `Fix round` prefix sees as a malformed
record.

```bash
bd update <id> --append-notes "Fix round <N> <date>: <resume|fresh>, carried context <tokens>k|unknown, idle <minutes> min, agent <id>"
```

`<N>` is the review round whose findings the fix answers, so the first fix
round after a round-1 review is 1 (PR #255 carries one round marker, and the
worked case's fix answered it).

Filled in: `Fix round 1 2026-10-16: fresh, carried context 353k, idle 20 min, agent a0b5576299a5578a3`.
Write `unknown` in place of a figure you could not read, with no `k`
(`carried context unknown`, `idle unknown min`); that is itself a reason for
`fresh`. Never write a bound such as `idle over 5 min`: the format defines
none. `<id>` is the agent that takes the round, the new one when fresh. Note that
the next round's two figures are keyed to this agent, the one that made the
most recent pass, not to the original implementer.

**How idle is measured.** From the previous agent's last pass end (`endTs` in
`node scripts/agent-pass-cost.mjs --json`, or the last timestamp in its
transcript) to the dispatch time, which for a fresh agent is its first call
(`startTs`). Do not use the orchestrator's own clock (when it noticed the
review comment, or when it began composing the brief): the idle figures
recorded on 2026-10-16 did that and overstated the transcript measure (for
example 25 min recorded against 13.3 min measured for ugcportal-8r06 round 2).

**Correcting a wrong line.** Do not edit or re-use the `Fix round` prefix.
Append `bd update <id> --append-notes "Correction to the Fix round <N> line: <what was wrong, the right figure and how it was measured>"`.

**Changing the threshold.** Any change to the 150k or five-minute figure
requires the n per arm and the rounds-after-fix comparison beside it, never
one release's median alone. That re-measurement is `ugcportal-hw97`; until it
reports, the figures above stand. The cost unit the figures are in is
`ugcportal-cii0`; reviewer agents are outside this rule, since their late
passes are short and cheap in the same data.

## 6. The pass budget: three passes without a clean round stop the bead (ugcportal-bc04)

Section 5 decides *how* to send a fix round back. This section decides
*whether* to. A PR that is still being redesigned in review after three
implementation passes is a different piece of work from the one the bead
described, and it should be a bead of its own, not an open-ended spend. This
is rule B2 of `docs/process/release-cost-v0.4.0-vs-v0.5.0.md` section 6.2, which
`docs/process/release-cost-v0.5.0-vs-v0.6.0.md` section 9 item 4 found had never
been enforced.

**Where the 3 comes from.** B2 states it, and the v0.6.0 data (85 beads, 61 of
them with `tokens_impl_passes` recorded) put nine beads over it, the worst at
seven passes. Neither document derives 3 from a cost curve; it is the figure
the retrospectives chose and this rule adopts. Changing it needs the same kind
of evidence section 5's "Changing the threshold" asks for.

**Run the script before you dispatch the fix round**, after recording the pass
count so far (`bd update <id> --set-metadata tokens_impl_passes=<n>`: the
passes already made, counting the implementer's first):

```bash
node scripts/check-pass-budget.mjs <bead-id>; echo "exit $?"
```

It reads `bd show <id> --json` and its exit status is the verdict:

| Exit | Verdict | Meaning | You |
|---|---|---|---|
| 0 | PROCEED | under 3 passes, or 3+ with a recorded clean round (`findings_r<N>` or `findings_pr<n>_r<N>` equal to `f1:0 f2:0 f3:0 f4:0 med:0 low:0`) | dispatch the round per section 5 |
| 1 | STOP | 3+ passes and no clean round | do **not** spawn; do the stop below |
| 2 | UNKNOWN | `tokens_impl_passes` absent, empty or not a whole number, or the bead could not be read | record the count and re-run; do **not** treat it as zero and carry on |

The script prints how many metadata keys it examined. A bead whose pass count
the orchestrator has not written comes back UNKNOWN, never PROCEED: an absent
field read as zero would make the rule fire on nothing, and the beads it exists
for are the ones where bookkeeping lagged.

**On STOP, in this order:**

1. Post a PR comment stating the stop: the script's output verbatim, the head
   sha, what is and is not fixed, and that no further pass will be spawned.
2. File the remainder as a new bead in the bead-template form, with the
   findings still open as its scope, linked at creation with
   `--deps=discovered-from:<stopped-bead-id>` (the form pr-review-merge step
   5a uses), then read the new bead back with `bd show` to confirm the edge
   points from the new bead to the stopped one (`review-standards` section 6).
3. Append a note to the stopped bead naming the new bead's id and the stop.
4. Do not spawn the fix pass. What happens to the PR (merge as it is, close, or
   wait for the new bead) is a human decision; the round cap in CLAUDE.md still
   governs the rounds themselves.

A human who directs another pass past a STOP takes the decision over; record who
and why in a note, and do not clear the verdict by lowering
`tokens_impl_passes`.
