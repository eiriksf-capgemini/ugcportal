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
This also means the 1-hour cache tier's ~$46 premium (over the 24-day window)
is usually **not** a saving to take back — a single avoided TTL-expiry rewrite
at this context size is worth several 1h-tier premiums.

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
Opus-vs-Sonnet breakdown of subagent spend (the § 1 finding):

```bash
python3 .claude/skills/harness-cost-controls/scripts/usage_indicators.py --since 2026-09-24
# optionally: --project ugcportal   (substring match on the project dir name)
```

It uses `isSidechain` (present on every assistant turn in a Claude Code
transcript) to identify subagent turns, and the same published per-MTok rates
`claude-usage-report.py` uses. For subscription or seat-based access the
dollar figures this produces are **notional** — see the note in the module
docstring and in `AI-USAGE-ECONOMICS.md` — but the *ratios* (read:write,
subagent share, cache-tier mix) describe real resource use regardless of
whether the dollar figure is a real invoice.

**Baseline captured when this file was added (2026-09-28, all projects, since
2026-09-24):** 10,998 requests, $1,911.68 list-price. Subagent (isSidechain)
spend: $1,265.04 (66.2%) of which Opus $1,162.30 across 8,044 requests and
Sonnet $73.16 across 1,098 requests — Opus subagent spend at Sonnet rates
would be ~$465. This is **larger** than the bead's originally-cited $1,558 /
8,370 requests / 5,955-Opus-subagent-requests figures, because more time and
further work has passed since the bead was filed earlier the same day, and
because this run's method (an independent `isSidechain`-based script) is not
guaranteed to reproduce Eirik's original ad-hoc aggregation number-for-number
even over the same window. Both readings agree on the qualitative finding:
most subagent spend was still running on Opus at measurement time.

**This baseline is a "before" figure, not a "before and after."** Nothing in
this PR changes runtime behavior — § 1 mechanism 2 (the actual backstop)
requires a `.claude/settings.json` edit this PR cannot make. K1's acceptance
criterion ("re-running... over a later window and showing the Opus share of
subagent requests has fallen") needs a second run, after the settings.json
change lands and/or the explicit-model practice is actually adopted in spawns
against this repo, over a window that postdates that adoption. Re-run the
command above then and compare against the baseline in this section.

## What this does not do

This file governs neither review depth nor the round-based severity gate.
It touches no file that does — see `review-standards` and `pr-review-merge`
for those, which are out of scope for any PR that also touches this skill.
