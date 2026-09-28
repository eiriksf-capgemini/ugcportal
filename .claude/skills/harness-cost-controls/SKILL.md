---
name: harness-cost-controls
description: Reference for the three harness-level Claude Code cost levers measured on this project (ugcportal-9ak, 2026-09-28) — name an explicit model on every worker-shaped subagent spawn instead of letting it inherit the parent's tier, cap an orchestration session's context before it gets expensive to carry, and don't leave a large session parked. Read this before spawning a subagent for implementation, a fix round, review, search, or verification work, and before starting or resuming a long-running orchestration session against this repo. Also documents how to re-run the underlying cost measurement so a regression is visible rather than found weeks later. Does not change review depth or review process — see review-standards / pr-review-merge for that.
---

# Harness cost controls (ugcportal)

This is documentation, not enforcement. Nothing in this repository can make an
orchestrating session pass a `model` argument, cap its own context, or avoid
sitting idle — those are properties of the harness and the session run outside
any file this repo's CI can see. What this skill gives you is a versioned,
reviewable place to point at instead of relying on institutional memory (or a
single `bd remember` entry) as the only record of the rule, plus a
repeatable way to check whether the rule is actually being followed.

The underlying measurement: `~/second-brain/03-professional/AI-USAGE-ECONOMICS.md`
and `~/second-brain/05-knowledge/research/2026-09-28-claude-code-cost-anatomy.md`
(Eirik's own usage, 2026-09-24 onward: $1,558 across 8,370 requests at the time
the bead was filed; re-run at PR-open time below shows a larger, still-growing
total, because time and further work has passed since — see "Re-running the
measurement"). The `bd remember` key `worker-shaped-subagent-spawns-must-name-their-model`
carries the same rule; this file is the versioned, PR-reviewable copy of it,
not a replacement.

## 1. Name the model on every worker-shaped subagent spawn

**Root cause:** the built-in `general-purpose` agent type has no definition
file of its own (unlike the ten repo agent types under `.claude/agents/` in
the environment where this was measured — that directory does not exist in
*this* repo's own tree, confirmed by `git ls-files | grep .claude/agents`
returning nothing here). With no definition to read a `model:` from,
`general-purpose` **inherits whatever tier the parent orchestrator is running
on**. An orchestrator running on Opus that spawns `general-purpose` without a
`model` argument for a worker-shaped task (implementation round, fix round,
review, search, verification — the routing table sends all of these to
Sonnet) pays Opus rates for Sonnet-shaped work, silently, on every such spawn.

Measured: 5,955 subagent requests ran on Opus 5 costing $898 where Sonnet
would have cost $359 — a **$539** difference, arithmetic rather than an
estimate, because Sonnet 5 is exactly 0.4x Opus 5 on every published pricing
line (base input, 5m cache write, 1h cache write, cache read, output). 6 of 15
sampled `general-purpose` spawns passed no `model` argument at all.

**Two mechanisms close this, and they are not redundant — use both:**

1. **Pass an explicit `model` argument on every worker-shaped spawn.** This is
   available today, requires no configuration change, and this file is where
   to point anyone spawning a subagent against this repo. When in doubt about
   which tier a task warrants, use this repo's own model-fit metadata
   convention (`CLAUDE.md` § Model-fit metadata: `haiku` / `sonnet` / `opus` /
   `fable`) as the same routing table a bead's `model` field already encodes.
   Prefer a named `worker-*` agent type (one with a `.claude/agents/*.md`
   definition declaring its own `model:`) over bare `general-purpose` when one
   exists, since a named type does not depend on anyone remembering the
   argument.
2. **Set a default subagent model, so an omitted argument has a safe
   landing instead of inheriting Opus.** Claude Code (confirmed on the
   installed CLI, v2.1.267, against
   [code.claude.com/docs/en/sub-agents.md](https://code.claude.com/docs/en/sub-agents.md)
   § "Model Resolution Order" / "Environment Variables for Default Subagent
   Models") resolves a subagent's model in this order: (1) an explicit
   per-invocation `model` parameter, (2) the agent definition's `model`
   frontmatter, (3) the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable if
   set, (4) the main conversation's model. Setting `CLAUDE_CODE_SUBAGENT_MODEL`
   to `sonnet` (without also setting `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`) means
   an omitted `model` argument on a `general-purpose` spawn lands on Sonnet
   instead of silently inheriting the parent's Opus — while still letting an
   explicit `model: "opus"` or `model: "fable"` argument, or a named agent's
   own frontmatter, override it deliberately for judgment-heavy work.
   **This requires an edit to `.claude/settings.json`, which is
   edit/write-denied for agents in this repo** (see `CLAUDE.md` §
   "Changing `.claude/settings.json`"). The exact snippet is in the PR that
   introduced this file, for a human to apply by hand; it is deliberately not
   committed here.

   Do **not** set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. That overrides every
   subagent regardless of explicit arguments or agent-definition frontmatter,
   which would also flatten deliberate `opus`/`fable` spawns for the
   security/architecture-review work this repo's model-fit tiers reserve
   Opus and Fable for — the review-depth guardrail this bead is explicitly
   not allowed to touch.

**What this does and does not close.** Mechanism 1 is a practice, not a
guarantee — it depends on whoever spawns the subagent reading this file or
the `bd remember` entry. Mechanism 2 is the actual backstop, and it is the
half of this fix that a human has to apply; until it lands, an orchestrator
that forgets the argument is exactly as exposed as before. Neither mechanism
is verifiable from inside this repo's CI (see § 4 below on what K6 can and
cannot check).

## 2. Cap orchestration-session context

Cost scales with context carried per turn, not with output produced:

| Context | Requests | Spend | $/req | avg output tokens |
|---|---:|---:|---:|---:|
| <50k | 848 | $42 | 0.049 | 99 |
| 50-100k | 1,857 | $112 | 0.060 | 197 |
| 100-200k | 1,981 | $189 | 0.095 | 403 |
| 200-400k | 2,041 | $428 | 0.210 | 465 |
| 400-700k | 1,352 | $465 | 0.344 | 421 |
| >700k | 291 | $322 | **1.107** | 628 |

A request above 700k context costs **22x** one under 50k for roughly the same
output. 50.6% of the measured spend sat above 400k context on 19.7% of
requests, nearly all of it in one long-running orchestration session.

**Practice:** treat ~100-200k context as a target ceiling for an orchestration
session, and compact or split before it's badly exceeded. This is a target,
not a promise — compaction has its own cost, and some context genuinely earns
its keep (a long review thread that would otherwise re-derive context is not
automatically waste). Re-measure the $/req curve after adopting this rather
than assuming the target transfers unchanged.

## 3. Don't park a large session

The 5-minute prompt cache expires while a session sits idle, and the entire
context gets rewritten at 1.25x on the next turn:

| Gap before request | Requests | Cache-write $/req |
|---|---:|---:|
| <1 min | 8,171 | $0.060 |
| 1-5 min | 116 | $0.078 |
| 5-60 min | 62 | **$1.647** |
| >1 h | 11 | **$2.312** |

At ~950k tokens of context, stepping away for a coffee costs about two
dollars in cache-write charges alone before the next turn does anything.

An earlier draft of this section quoted a "~$46 1-hour-tier premium" figure
here. That number was real but came from a **different window** (the full
24-day report, 09-05 through 09-28) than the one this file's own baseline
documents (since 2026-09-24), is off by roughly 10x if read against the
window this file actually covers, and — the sharper problem — cannot be
reproduced by the command § 4 gives you: indicator 5 on the documented window
reads **1-hour 0.0%**, because 1-hour cache-tier usage genuinely stopped on
2026-09-18, before this window even starts. A number a reader cannot
reproduce with the command they were just given is worse than no number, so
indicator 5 now computes and prints the relevant comparison directly from
whatever window you actually ran it against: what the window's cache-write
spend actually was, and what it would have been under an all-1-hour or
all-5-minute hypothetical. On the since-2026-09-24 window (snapshot,
2026-09-28 — re-run the command for a current figure): actual cache-write
spend $768.65, all-1-hour hypothetical $1,229.84, i.e. a **$461.19** premium
for hedging the *entire* window's cache writes against TTL-expiry rewrites —
not $46, and not comparable to the older window's figure. This also means
the 1-hour cache tier's premium is usually **not** a saving to take back — a
single avoided TTL-expiry rewrite at this context size is worth several
1h-tier premiums.

**Practice:** finish or explicitly close a large orchestration session rather
than leaving it parked mid-task. If a gap is unavoidable, the 1-hour cache
tier is frequently the *correct* choice at high context sizes, not a cost to
economize away.

## 4. Re-running the measurement

`scripts/claude-usage-report.py` (in the second-brain vault, not this repo —
`~/second-brain/scripts/claude-usage-report.py`) reads
`~/.claude/projects/**/*.jsonl`, dedups by `requestId`, prices each request,
and writes the deduped rows to `/tmp/ccusage/rows.json`, printing only a total
request count and date range. **It does not itself compute the five
indicators named in `AI-USAGE-ECONOMICS.md` § "What to measure"** (cache
read:write ratio, share of spend in the top 1% of requests, cost split by
component, subagent share of total, 1h-vs-5m cache-write mix) — producing
those today means re-deriving the aggregation by hand each time, which is
exactly the "ad-hoc" state this bead's K4 was written against.

`scripts/usage_indicators.py`, alongside this file, closes that gap without
touching or reimplementing `claude-usage-report.py` — it reads the same
transcripts independently and prints all five indicators directly, plus an
Opus/Sonnet/other breakdown of subagent spend (the § 1 finding):

```bash
python3 .claude/skills/harness-cost-controls/scripts/usage_indicators.py --since 2026-09-24
# scope to one project's slug (the directory directly under ~/.claude/projects,
# not necessarily a matched file's immediate parent -- subagent transcripts
# nest two levels deeper, at <slug>/<session-uuid>/subagents/agent-*.jsonl):
python3 .claude/skills/harness-cost-controls/scripts/usage_indicators.py --since 2026-09-24 --project ugcportal
```

It uses `isSidechain` (present on every assistant turn in a Claude Code
transcript) to identify subagent turns, and the same published per-MTok rates
`claude-usage-report.py` uses. For subscription or seat-based access the
dollar figures this produces are **notional** — see the note in the module
docstring and in `AI-USAGE-ECONOMICS.md` — but the *ratios* (read:write,
subagent share, cache-tier mix) describe real resource use regardless of
whether the dollar figure is a real invoice.

**Baseline captured 2026-09-28, all projects, since 2026-09-24 (all-projects
run):** 11,552 requests, $2,133.97 list-price. Subagent (isSidechain) spend:
$1,463.17 (68.6%) partitioned into Opus $1,321.04 across 8,259 requests,
Sonnet $104.45 across 1,389 requests, and other (Fable/Haiku) $37.67 across
134 requests — reconciling exactly to $1,463.17 (a round-2 review finding:
an earlier version of this partition only had Opus and Sonnet lines, so the
Fable/Haiku $37.67 was in the total and in no sub-line at all). Opus-5
subagent spend at Sonnet-5 rates would be ~$528.42. Scoped to `--project
ugcportal` specifically: 11,011 requests, $2,067.28, subagent spend
$1,450.82 (70.2%) across 9,623 requests, of which Opus $1,309.85 across
8,127 requests, Sonnet $103.30 across 1,362, and other $37.67 across 134 —
a non-zero, non-trivial result, which is itself the round-1-review
regression test for the P1 fix below (an earlier version of this script
printed `$0.00 … 0 of N requests` for this exact invocation).

This is **larger** than the bead's originally-cited $1,558 / 8,370 requests /
5,955-Opus-subagent-requests figures, for several reasons: more time and
further work had passed by the time this was captured; an earlier version of
this script undercounted output tokens by roughly half and silently dropped
every nested subagent transcript when `--project` was used (round 1); and an
earlier version's Opus/Sonnet partition excluded Fable/Haiku spend from
every sub-line while still counting it in the total (round 2) — see § 5.
Every reading still agrees on the qualitative finding: most subagent spend
was still running on Opus at measurement time.

**This baseline is a "before" figure, not a "before and after."** Nothing in
this PR changes runtime behavior — § 1 mechanism 2 (the actual backstop)
requires a `.claude/settings.json` edit this PR cannot make. K1's acceptance
criterion ("re-running... over a later window and showing the Opus share of
subagent requests has fallen") needs a second run, after the settings.json
change lands and/or the explicit-model practice is actually adopted in spawns
against this repo, over a window that postdates that adoption. Re-run the
command above then and compare against the baseline in this section.

## 5. When this measurement itself is wrong

Two full rounds of PR review on the PR that added this file found twelve
bugs total in `usage_indicators.py`, and the pattern held across both
rounds: nearly every one of them made a **real regression, or a real gap in
the script's own coverage, look like a clean result** instead of an error.
That is not a coincidence of what reviewers happened to look for — it is
what this class of bug looks like. A script whose job is to notice a cost
regression is, structurally, the easiest kind of tool to get silently wrong
in the reassuring direction, because "the number went down" is exactly what
everyone hopes to see.

**Round 1:** a wrong project-slug path (subagent transcripts nest two levels
deeper than main-thread ones; taking the immediate parent directory read
`"subagents"` for every one of them, so `--project` silently excluded all
subagent traffic — the documented invocation would have printed `$0.00 … 0
of N requests` and read as "the fix worked" instead of "the tool broke"); a
first-seen-wins dedup that kept a partial (lower) output-token count instead
of the final one; an unpriced model silently costing `$0` while still
counting toward the request total.

**Round 2:** the round-1 fix's own docstring claimed test coverage
(`"covered by the self-test in this directory"`) that did not exist yet —
now it does, see below; four silent skip paths (an unreadable file, a line
that fails JSON parsing, a missing request id, a missing timestamp) had no
tally, so a partially-unreadable transcript tree would have reported a
smaller, confident number with nothing to show for it; the Opus/Sonnet
subagent partition excluded Fable and Haiku from every sub-line while still
counting their spend in the total, so the parts didn't sum to the whole; a
code comment stated an inverted ratio (would have argued *for* using more
Opus, had anyone followed it to extend this file); the Fable pricing anomaly
was claimed to be "flagged upstream in the PR" when it was only in a review
reply, not the PR body or a bead (now it is: `ugcportal-xwt`); and `--since`
was an unvalidated string compare, so `--since 2026-09` silently widened to
everything from September onward and `--since 2026-9-24` silently matched
nothing — with the effective window never echoed anywhere, so neither
mistake was visible in the output.

**The fixes**, round 1: resolve the project slug from the path relative to
the glob's own root rather than one parent directory; keep the maximum
`output_tokens` seen per `requestId`; track unpriced models from the final
filtered row set and print them prominently. Round 2: partition subagent
spend into Opus / Sonnet / other so the parts always reconcile to the total
(printed explicitly); correct the inverted comment; track the Fable pricing
question as `ugcportal-xwt` instead of an unverifiable claim; validate
`--since` against a real ISO date (`argparse` `type=`, rejects a partial or
malformed date instead of silently mis-scoping the window); and have
`report()` echo the scan itself — files matched, files unreadable, lines
skipped and why, the filters actually used, and the date range the kept
requests actually cover — **before** printing a single indicator, so a bad
filter or an unreadable file is visible instead of merely absent from the
number. Indicator 5 also grew a same-window, reproducible dollar comparison
(actual cache-write spend vs. an all-1-hour or all-5-minute hypothetical),
replacing a cross-window figure in § 3 above that this script could not
reproduce.

**A committed self-test** now backs the coverage claim this file makes:
`test_usage_indicators.py`, alongside this file — run
`python3 -m unittest test_usage_indicators -v` from this directory. It builds
synthetic transcript trees (including the real nested subagent path layout)
rather than depending on any machine's actual history, so it passes the same
way in CI or on a laptop. Every fix above has a named test that fails when
the fix is reverted (verified by hand for each one while writing this
section — revert the one line, watch the specific test fail, restore).

If you touch this file again: before asking "does the number look right",
ask which direction a mistake in this computation would point the reader,
run the self-test, and prefer a failure that prints a warning over one that
quietly prints a smaller, more reassuring number.

## What this does not do

This file governs neither review depth nor the round-based severity gate.
It touches no file that does — see `review-standards` and `pr-review-merge`
for those, which are out of scope for any PR that also touches this skill.
