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
the bead's `Premise verified` line to name `origin/main`'s *current* HEAD,
and prints how many commits stale it is otherwise. That is deliberate and it
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
- **a named model** on the spawn (`harness-cost-controls`); the bead's
  `model` / `model_effort` metadata is the estimate to use.

And the rule that governs briefs: **never enumerate a set in a brief from
memory**. Paste the command that produced it, or tell the implementer to
re-derive the set and report differences.

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
