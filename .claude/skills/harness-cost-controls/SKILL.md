---
name: harness-cost-controls
description: Reference for the three harness-level Claude Code cost levers measured on this project (ugcportal-9ak, 2026-09-28) — name an explicit model on every worker-shaped subagent spawn instead of letting it inherit the parent's tier, cap an orchestration session's context before it gets expensive to carry, and don't leave a large session parked. Read this before spawning a subagent for implementation, a fix round, review, search, or verification work, and before starting or resuming a long-running orchestration session against this repo. Also documents how to re-run the underlying cost measurement so a regression is visible rather than found weeks later, and (§6, ugcportal-bf7) why this repo's own bead-level tokens_impl/tokens_qa metadata can't yet be used to recalibrate CLAUDE.md's model-fit tiers. Does not change review depth or review process — see review-standards / pr-review-merge for that.
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

**These are Eirik's original point-in-time figures (bead-filing time,
2026-09-28), not the current reproducible baseline.** § 4 below re-derives
the same measurement with a runnable command, and its numbers are larger and
still growing (more time and traffic have passed, and three rounds of review
found real undercounting bugs in the tool that produced them — see § 5). The
figure to compare against the **$539** above is § 4's own savings-available
number, computed the same way (Opus-5 subagent spend minus the Sonnet-5-rate
counterfactual): as of the § 4 baseline captured 2026-09-28 that is
$1,325.09 − $530.04 ≈ **$795** on the all-projects baseline in § 4 — not
$539, and not the same window measured twice. This figure was previously
misquoted here as $792 using an earlier round's inputs ($1,321.04 − $528.42);
corrected 2026-09-29 (ugcportal-4il). Re-run § 4's command for a current
figure rather than trusting either number as current; the two will keep
diverging as more time passes.

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
spend $777.58, all-1-hour hypothetical $1,244.13, i.e. a **$466.55** premium
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
docstring and in `AI-USAGE-ECONOMICS.md`.

Two of the five indicators are pure token ratios and hold regardless of
whether the dollar figures are real: the cache read:write ratio (1) and the
cache-write tier mix (5). **Subagent share (4) is not one of these** — it is
reported here list-price-dollar-weighted, and that is a different number
from the request-count-weighted version: on the round-3 baseline below,
subagent spend is 68.4% of dollars but 9,888 of 11,674 requests — **84.7%**
by request count. On a subscription, the dollar-weighted figure is exactly
as notional as any other dollar figure in this file; the request-count
figure is the plan-neutral one, and that is the whole reason this
distinction matters enough to spell out rather than lump into "ratios that
don't depend on the dollar figures being real."

**Baseline captured 2026-09-28, all projects, since 2026-09-24 (all-projects
run):** 11,674 requests, $2,154.17 list-price. Separately — and NOT scoped to
this `--since 2026-09-24` window, or to any window at all — the scan also
reports 45 requests with an unrecognized model (`lines_unrecognized_model` in
the anomalies ledger § 5 describes): a real, counted gap, not silently
absorbed, but a **whole-history** count accumulated over everything the glob
matched on this machine, not a count of what happened since 2026-09-24. (See
`usage_indicators.py`'s `ANOMALY_KEYS` comment and `report()`'s own "anomalies
across the WHOLE matched glob, not limited to `--since`/`--project`" banner —
the underlying counter has no window concept to be scoped to in the first
place.) Subagent (isSidechain) spend: $1,474.36 (68.4% of dollars, **84.7%** of
requests — see the note above on why those two numbers differ) partitioned
into Opus $1,325.09 across 8,301 requests, Sonnet $111.60 across 1,453
requests, and other (Fable/Haiku) $37.67 across 134 requests — reconciling
exactly to $1,474.36. Opus-5 subagent spend at Sonnet-5 rates would be
~$530.04. Scoped to `--project ugcportal` specifically: 11,132 requests,
$2,086.96, subagent spend $1,462.04 (70.1%) across 9,729 requests, of which
Opus $1,313.90 across 8,169 requests, Sonnet $110.47 across 1,426, and other
$37.67 across 134 — a non-zero, non-trivial result, which is itself the
round-1-review regression test for the P1 fix below (an earlier version of
this script printed `$0.00 … 0 of N requests` for this exact invocation).

This is **larger** than the bead's originally-cited $1,558 / 8,370 requests /
5,955-Opus-subagent-requests figures (§ 1), for several reasons: more time
and further work had passed by the time this was captured; an earlier
version of this script undercounted output tokens (measured 64.0% on this
window, 48.8% over this machine's full available history — a different,
wider denominator, not a discrepancy) and silently dropped every nested
subagent transcript when `--project` was used (round 1); an earlier
version's Opus/Sonnet partition excluded Fable/Haiku spend from every
sub-line while still counting it in the total (round 2); and an earlier
version's model-id normalizer only recognized two hardcoded date suffixes,
so any other date-stamped model id fell through to "unpriced" instead of
being priced (round 3) — see § 5. Every reading still agrees on the
qualitative finding: most subagent spend was still running on Opus at
measurement time.

**This baseline is a "before" figure, not a "before and after."** Nothing in
this PR changes runtime behavior — § 1 mechanism 2 (the actual backstop)
requires a `.claude/settings.json` edit this PR cannot make. K1's acceptance
criterion ("re-running... over a later window and showing the Opus share of
subagent requests has fallen") needs a second run, after the settings.json
change lands and/or the explicit-model practice is actually adopted in spawns
against this repo, over a window that postdates that adoption. Re-run the
command above then and compare against the baseline in this section.

## 5. When this measurement itself is wrong

Three full rounds of PR review on the PR that added this file found
nineteen bugs total in `usage_indicators.py`, and the pattern held across
all three: nearly every one of them made a **real regression, or a real gap
in the script's own coverage, look like a clean result** instead of an
error. That is not a coincidence of what reviewers happened to look for —
it is what this class of bug looks like. A script whose job is to notice a
cost regression is, structurally, the easiest kind of tool to get silently
wrong in the reassuring direction, because "the number went down" is
exactly what everyone hopes to see. By round 3, the reviewer said it more
sharply than this file had: two of that round's seven findings were, again,
the same family this section already named, and the right response to a
lesson recurring for the third time is not a fourth writeup — it's a
structural change (see below).

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

**Round 3, the two mediums:** `norm_model` only stripped two hardcoded date
suffixes, so any other date-stamped model id (a new snapshot, or one this
file just hadn't seen yet) fell through unpriced and rendered as
`of which Opus: $0.00 (N reqs)` — the THIRD instance of this same pricing
gap rendering as a reassuring zero, which is the finding that forced the
structural fix below rather than a fourth patch. And this file claimed the
self-test "passes the same way in CI" — false: `ci.yml` has no Python step
at all, so reverting any fix here (the dedup, say) merges green. **That
claim is corrected below, and a Python CI step is tracked as `ugcportal-d4z`
rather than added in this PR** (`.github/workflows/**` is a sensitive path;
pulling it into an already-large PR would need its own review).

**Round 3, the five lows:** `valid_since_date` returned the raw input
string, so on Python ≥ 3.11 (where `date.fromisoformat` itself became
lenient enough to accept `--since 20260924` or `--since 2026-W40-1`) the
validator "passed" but the comparison then silently matched nothing —
reproduced on Python 3.14.7: `no requests matched` over 11,608 matching
requests; fixed by returning the parsed date's own `.isoformat()`. The
`base_dir` computation cut the glob pattern at the first literal `*`
character, which is wrong the moment a `*` lands mid-component rather than
at a component boundary (a narrowing glob like `projects/ugc*/**/*.jsonl`)
— every resolved project slug came out as `".."` and `--project` matched
nothing; fixed by walking whole path components and stopping at the first
one containing a glob metacharacter. Three more silent `continue` paths
(non-assistant lines that still contain the substring `"usage"`, a
non-dict `usage` field, an unrecognized model) had no tally — 45 real
records on the actual tree today — contradicting the coverage this section
already claimed. § 1's headline $539/5,955-request figures sit next to § 4's
own reproducible, much larger baseline with no caveat connecting them —
now added, see § 4. And "subagent share" was listed among the ratios that
don't depend on dollar figures being real, but it's dollar-weighted
(68.4%), not request-count-weighted (84.7%) — also fixed, see § 4.

**The fixes**, round 1: resolve the project slug from the path relative to
the glob's own root rather than one parent directory; keep the maximum
`output_tokens` seen per `requestId`; track unpriced models from the final
filtered row set and print them prominently. Round 2: partition subagent
spend into Opus / Sonnet / other so the parts always reconcile to the total
(printed explicitly); correct the inverted comment; track the Fable pricing
question as `ugcportal-xwt` instead of an unverifiable claim; validate
`--since` against a real ISO date; and have `report()` echo the scan itself
before printing a single indicator. Indicator 5 also grew a same-window,
reproducible dollar comparison (actual cache-write spend vs. an all-1-hour
or all-5-minute hypothetical), replacing a cross-window figure in § 3 above
that this script could not reproduce.

**Round 3's fix is structural, not seven more patches.** Every path in
`load_rows` that drops, skips, or fails to price a record now increments a
key in a single `ANOMALY_KEYS` counter, and `report()`'s first output —
before it prints a single dollar figure, and unconditionally, including as
an explicit `0` — is every one of those keys plus the unpriced-models dict.
Silence and "checked, found nothing" can no longer look the same. `norm_model`
now strips any 8-digit date suffix by regex instead of two hardcoded ones;
`glob_base_dir` walks whole path components; `valid_since_date` returns the
canonical `isoformat()`; and indicator 4's Opus/Sonnet/other line now
annotates inline when a bucket's `$0.00` is because its rows are unpriced,
rather than relying solely on the top-of-report banner — "loud wherever it
appears," not just tallied at the end.

**A committed self-test** backs the coverage claim this file makes:
`test_usage_indicators.py`, alongside this file — run
`python3 -m unittest test_usage_indicators -v` from this directory (29
tests as of round 3, verified passing on both Python 3.9 and 3.14). It
builds synthetic transcript trees (including the real nested subagent path
layout) rather than depending on any machine's actual history, so it
produces the same result wherever it's run. **What is true, precisely:** it
runs the same way anywhere it IS run. **What is not true, and was claimed
here until round 3 caught it:** that this includes CI. Nothing in
`.github/workflows/ci.yml` runs it — it is run by hand, and only by hand,
until `ugcportal-d4z` closes. Every fix above has a named test that fails
when the fix is reverted (verified by hand for each one while writing this
section — revert the one line, watch the specific test fail, restore).

If you touch this file again: run the self-test by hand (nothing else will),
ask which direction a mistake in this computation would point the reader,
and ask whether that mistake would actually show up in the `ANOMALY_KEYS`
ledger — if it wouldn't, the ledger is missing a key, which is how three of
these nineteen bugs were found.

## 6. Bead-level cost vs assigned tier (ugcportal-bf7)

§§1-5 measure the harness from outside the project. This section answers a
different question, from inside it: does this repo's own bead metadata
(`tokens_impl`/`tokens_qa`, `model`) show the assigned tier actually
predicting cost, per `CLAUDE.md`'s own calibration test ("if a sonnet bead
consistently costs what an opus bead costs, the estimate was wrong — fix the
bead, and the guidance here")?

Measured 2026-09-29, across the 31 closed beads carrying at least one token
figure (`bd list --status closed --json`; re-run that query verbatim rather
than trusting this snapshot — beads keep closing, and one, `ugcportal-2pnq`,
closed mid-analysis and changed the sonnet row below by the time this was
double-checked):

| tier | n impl | avg tokens_impl | n qa | avg tokens_qa |
|---|---:|---:|---:|---:|
| sonnet | 10 | 662,458 | 5 | 307,643 |
| opus | 11 | 717,546 | 10 | 320,884 |
| haiku | 4 | 27,399 | 2 | 53,554 |
| fable | 2 | 170,524 | 1 | 193,870 |
| (untagged) | 2 | 856,015 | 1 | 202,003 |

**Sonnet-tagged and opus-tagged beads cost close to the same to build and to
review** (662k vs 718k impl — sonnet about 8% cheaper, not the ~2.5x the
list-price ratio would predict; 308k vs 321k qa — closer still). Read this
as confirmation of §1's root cause, at full-dataset scale rather than the
two anecdotal beads (`r1d`, `lu7`) already named in this bead's own
dependency history: **the tag was decorative until `ugcportal-2tc` set
`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` globally, closed 2026-09-29.** Before
that fix, a `sonnet`-tagged worker-shaped spawn with no explicit `model`
argument inherited the parent's Opus exactly as §1 describes, so most of
this dataset's "sonnet" beads plausibly ran on Opus regardless of their
tag. `haiku` (n=4, all small mechanical CI/scaffold beads — `25x`, `0hc`,
`e5zf`, `97y`) is the one tier that does show a large gap from the rest,
but this dataset can't tell whether that's the tag being honored at runtime
or just that haiku-tier work is inherently smaller in scope — it would take
knowing which model actually ran to separate the two.

**Do not use this historical dataset to recalibrate `CLAUDE.md`'s
model-fit table.** Sonnet and opus assignments were not a clean experiment
here. Re-run this comparison after a meaningful number of beads (a dozen or
so) have closed with `2tc`'s fix in effect, and only treat a persisting
sonnet-close-to-opus cost figure as a real finding if it survives that
re-run — right now the closeness is most likely an artifact of the
inheritance bug, not evidence that tier choice doesn't matter.

**Round count alone is a weak predictor of `tokens_qa`.** Across the 17
closed beads with both a recorded review-pass count and a measured
`tokens_qa` — `e5zf` 1, `lu7` 1, `97y` 2, `u7g` 4, `axu` 4, `bdh` 4, `egp` 4,
`vsm` 4, `44q` 5, `05b` 5, `j4j` 5, `2yj` 6, `71y` 6, `9cs` 6, `0ss` 7, `e86`
8, `r1d` 9 — each figure cited from that bead's own close reason where it
states one, or (`97y`, `lu7`) from `ugcportal-ws3`'s per-bead round table
where it does not — the Pearson correlation between round count and
`tokens_qa` is **r ≈ 0.49** (r² ≈ 0.24): moderate and positive, consistent
with this bead's own finding that review cost tracks pass count more than
diff size, but round count alone explains under a quarter of the variance.
`j4j` (5 rounds, `tokens_qa` 590,000) cost more to review than `r1d` (9
rounds, 415,357), `0ss` (7 rounds, 459,771) or `e86` (8 rounds, 310,432) —
per-round severity dominates over round count. (`ugcportal-8wa` and
`ugcportal-r9q` also carry `tokens_qa` but no round count anywhere in their
own record, so they're excluded rather than guessed at.)

**The two largest single outliers are scope-ambiguity stories, not
tier-mismatch stories, and re-tagging would not have prevented either.**

- `ugcportal-jsc` (tagged `sonnet`/`medium`) recorded 2.10M `tokens_impl` —
  the largest implementation figure in the dataset, ahead of every
  `opus`-tagged bead including the P0 auth-bypass fix (`egp`, 1.6M). Its own
  close reason already names why: "this was the most expensive bead of the
  phase." The cost traces to real multi-system scope — a many-to-many schema
  with cascade-delete implications for other users' published work, a
  same-transaction write chosen specifically to avoid a concurrent-upload
  data loss, and a contested claim on the app's first site-wide navigation
  that was granted and then explicitly un-granted mid-bead — plus two
  same-day rescopes by Eirik before implementation even started. A same-day
  rescope stacked with a contested claim on a cross-cutting resource is a
  cheaper, earlier signal to watch for than tier mismatch.
- `ugcportal-t0y` ("Nothing links to the upload page", **no tier assigned at
  all**) recorded 1.5M `tokens_impl` over five rounds for what reads as a
  one-line nav-link addition. Its own close reason names the mechanism:
  round 3 added request-level middleware to satisfy a reviewer's "cheap to
  add" `aria-current` request; round 4 found that middleware's matcher also
  intercepted `/api/*` and truncated request bodies over 10MB — a regression
  on this app's 200MB video-upload path, introduced by a PR whose only job
  was adding a link. This corroborates `ugcportal-9ak`'s own dependency-note
  finding that follow-up beads filed by implementing agents mid-PR are
  systematically the ones with no tier assigned, and are exactly the
  "small, cheap, mechanical" work most at risk of silently growing — not
  from over-provisioning here, but from an unsized in-review mechanism
  decision.

Neither outlier is a lever this bead can encode as a rule with a measured
saving (per its own K3, a lever must show what it would have saved against
real history): re-tagging `jsc` to `opus`, or assigning `t0y` a tier at
authoring time, would not have changed either cost driver. They're recorded
here as the concrete instances behind the caution above — bead-level
`tokens_impl`/`tokens_qa` isn't yet a clean signal for tier calibration, and
the actual top costs in this dataset came from scope ambiguity and
in-review mechanism growth, not from picking the wrong model tier.

## What this does not do

This file governs neither review depth nor the round-based severity gate.
It touches no file that does — see `review-standards` and `pr-review-merge`
for those, which are out of scope for any PR that also touches this skill.
