# Cost and performance: the seven v0.7.0 claims, tested against the data

Bead: `ugcportal-l6t5`. Written 2026-10-16. The seven claims are the aggregation quoted verbatim in the bead's description; they summarise `docs/process/retrospective-v0.7.0-2026-10-15.md` (`ugcportal-fbng`) and `docs/process/sizing-review-v0.7.0-2026-10-15.md` (`ugcportal-2hwe`) but do not appear verbatim in either. Each section below states what would confirm or refute the claim, tests it, gives a verdict with its `n`, and names the bead that owns the change. Every figure is reproduced by a command in the appendix; a figure this document could not recompute is labelled **asserted, not re-measured**.

## Verdicts

| # | Claim (short) | Verdict | The deciding figure |
|---|---|---|---|
| 1 | The bill is iteration count, not tier or scope | **partly supported** | rounds track cost in all three releases measured (rho 0.62-0.88 recorded, 0.48-0.74 transcript-priced); the K-count "exception" does not replicate (v0.6.0 rho 0.08, n=79) and tier is weakly tied to rounds in two of three releases |
| 2 | Resumed agents have a rising cost floor | **partly supported** | the mechanism holds (a median 87% of a resumed pass's cost is carried history, n=374), the example it rests on is a misreading of cumulative context sizes, and the data place the switch-over on carried context (150k-250k), not on a pass count |
| 3 | A strict reviewer with no lenient band converts lows into rounds | **partly supported** | 0 of 159 marker PRs have an `exact` chain; lows-only rounds are 33 of 50 and 23 of 38 rounds at 4+ in v0.5.0 and v0.7.0, but 3 of 13 in v0.6.0 under the same gate |
| 4 | Orchestrator controls pay more than worker controls | **partly supported** | one stale baseline reached 12 briefs, not five; "nine of nine" is asserted, not re-measured; an orchestrator turn costs about 3x an agent turn, so controls the orchestrator runs inline are dearer per run |
| 5 | A memory is not an owner | **partly supported** | after its memory existed, `bd update --notes` still ran 7 times (rate 6.8% → 3.5% → 1.1% of note writes); B1 was re-committed 33 minutes after cataloguing, not twenty; the mechanical-check arm has no data |
| 6 | Price the controls | **partly supported** | the claim that no document records the cost is true for all but two prose figures; the price is recoverable from transcripts and is given here (section 7); the payoff side is untestable for three of the five controls |
| 7 | Fresh-machine gates catch what cached machines hide | **supported, n=1** | the gate's first run failed on a real 401 that still reproduces today against working controls; one run, one catch, about 60 s |

Beads filed from this document: `ugcportal-cii0` (P1), `ugcportal-8r06`, `ugcportal-2jvh`, `ugcportal-vu49` (P2), `ugcportal-md4c`, `ugcportal-vtgz` (P3). Existing owners linked: `ugcportal-62b6`, `ugcportal-n005`, `ugcportal-eph2`, `ugcportal-4bok`, `ugcportal-zce5`, `ugcportal-7w83`. Section 9 lists them with what each owns.

## 1. What was measured, and in what unit

### 1.1 Sources and reach

- **bd metadata**: `bd list --all --limit 0 --json` in the main checkout, 2026-10-16, 485 beads. Of 272 closed beads, `tokens_impl` is present on 197 and positive on 195 (`qnq9.2` and `6uxr` carry 0), `tokens_qa` present on 169 and positive on 167 (the same two), `tokens_impl_passes` on 123, a `tokens_qa_rN` key on 117. The brief's 195 and 167 are the positive counts.
- **Review rounds**: `scripts/release-cost-report.mjs --releases v0.5.0,v0.6.0,v0.7.0`, which reads the round markers of 178 PRs with the step-4b rules and the reviewer's stated severity per round (with the faults `ugcportal-7w83` records). A round counts as "medium-or-above" here on any non-zero medium count. Parse faults run both ways — the `#121` artefact inflates a count, `7w83`'s flag-shape fault can zero a real one — so every medium count below is approximate, and a "0 mediums" can hide one.
- **Claude Code transcripts**: every session under `~/.claude/projects/-Users-eiriksf-code-ugcportal`, 32 orchestrator sessions and 1,750 subagent transcripts (1,782 files), 2026-09-16 to today, read by the new `scripts/agent-pass-cost.mjs`. Every transcript figure below is cut at **2026-10-16T00:00Z** (`--before`), which leaves 1,743 agents and 2,774 passes, so a re-run gets the same numbers while new sessions are written. The window covers the builds of v0.4.0 through v0.7.0; v0.5.0 to v0.7.0 are compared release by release.
- **Source documents**: the retrospective, the sizing review, `review-rounds-v0.5.0.md`, `release-cost-v0.5.0-vs-v0.6.0.md` and the `ugcportal-fbng` catalogue notes (105,556 characters).

### 1.2 The recorded token figures measure context size, not cost

Before testing anything, the unit. `tokens_impl` and `tokens_qa` are filled from the `subagent_tokens` figure of each task-notification. The transcripts let that figure be checked against the agent's own API usage:

- Of 1,961 notifications compared, **1,953 are within 5%, and 1,896 within 2%, of the context size of the agent's last API call** (input + cache read + cache write + output). On the 142 resumed agents that got one notification per pass, every pass matches.
- So the figure is a **snapshot of the context window at the end of the run**, not the tokens the run processed. A run of 72 calls ending at 155k of context reads about 6.7M tokens from cache along the way (`lskg`'s first pass).
- For a resumed agent the snapshots are **cumulative**, and the beads use two incompatible conventions. Of 86 resumed implementers mapped to exactly one bead, **14 beads record the sum of the cumulative snapshots** (`ei7 o7l e15 t0y egp jsc 44q bdh nffp 6uc2 7g2o z4nh jain a3hj`) and **40 record the last one**; 32 fit neither (several agents, hand estimates). `pr-review-merge` step 4a tells a reviewer to add "this run's reported total" to the existing `tokens_qa`, which is the summing convention.

This document therefore prices work a second way: **input-token equivalents (ITE)** = input + 0.1 x cache read + 1.25 x 5-minute cache write + 2 x 1-hour cache write + 5 x output, summed over every API call. The weights are the standard ratios of Anthropic's price list, so ITE is proportional to dollars for a model priced at those ratios (the table in `usage_indicators.py` lists two whose cache read is cheaper, `claude-opus-5-5` at 5% and `claude-fable-5-1` at 2.5% of input, where ITE overstates the cache-read part); across models it is a relative measure. For scale: `usage_indicators.py --since 2026-09-17 --project ugcportal` prices the same window, through today, at $9,742.12 list (excluding 573 unpriced `claude-sonnet-5-5` requests) against about 2.94B ITE. Two limits: `claude-opus-5-5` and `claude-sonnet-5-5` transcripts record about 29 and 21 output tokens per call against 315-1,740 for the other models, so ITE is a lower bound on their passes (all from 2026-10-14 on); and the mapping of agents to beads (bead id, then short id, then PR number in the agent's description or first prompt) places 937 of 1,743 agents on exactly one bead.

Measured on the beads that have both: ITE is a median **7.0x** the recorded impl+qa figure in v0.7.0 (IQR 4.5-7.9, n=44), **9.2x** in v0.6.0 (n=66) and **13.0x** in v0.5.0 (n=19). The two still rank beads alike in v0.7.0 (rho 0.86, n=44) and v0.5.0 (0.77, n=19) but much less in v0.6.0 (0.48, n=66). Owner: **`ugcportal-cii0`** (P1) — define the unit, record transcript cost, correct the 14 summed beads.

## 2. Claim 1: the bill is iteration count, not model tier or scope

> Three attributes argued about at planning time (model, size, criteria count) predict the first pass and almost nothing after it; criteria count is the one marginal exception and needs a second release to confirm. Measure and attack the mechanism that produces passes.

**(a) What would decide it.** Confirmed if review rounds track total cost in more than one release and in a unit that is cost rather than context size, while tier and K-count fail to track rounds; refuted if rounds stop tracking cost once the unit is fixed, or if tier or K-count track rounds as well. The sizing review tested v0.7.0 alone; this extends it to v0.5.0 and v0.6.0 (the "second release" the claim asks for) and to ITE.

**(b) Test.** Spearman rho with the two-tailed 5% critical value for its own `n`, same estimator as the sizing review (appendix B, section 2):

| | v0.5.0 | v0.6.0 | v0.7.0 |
|---|---|---|---|
| rounds ~ recorded impl+qa | **0.88** (n=21) | **0.62** (n=70) | **0.82** (n=45) |
| rounds ~ ITE, all agents | **0.74** (n=32) | **0.65** (n=66) | **0.48** (n=45) |
| rounds ~ ITE, review agents | 0.34 (n=8, below) | **0.85** (n=63) | **0.74** (n=43) |
| rounds ~ ITE, implementers | **0.74** (n=25) | **0.63** (n=51) | 0.28 (n=43, below 0.301) |
| tier ~ `tokens_impl` | **0.47** (n=30) | 0.20 (n=70, below) | **0.49** (n=52) |
| tier ~ rounds | **0.37** (n=34) | **0.33** (n=74) | 0.21 (n=55, below) |
| K-count ~ rounds, beads with no K line as 0 | 0.31 (n=38, below 0.320) | 0.08 (n=79, below) | **0.28** (n=59) |
| K-count ~ rounds, K-numbered beads only | **0.56** (n=25) | 0.24 (n=54, below) | **0.32** (n=49) |
| share of ITE in beads at 4+ rounds | 95% (20 of 32) | 41% (11 of 66) | 49% (15 of 45) |

Bold is past the 5% value. The v0.7.0 column reproduces the sizing review (0.82, n=45; K-count 0.28, n=59); its `tokens_qa` figure is 0.92 at n=47 here and n=46 there, because this run does not apply its duplicate-review dedupe.

**(c) Verdict: partly supported.** "Rounds carry the cost" holds in all three releases and survives the change of unit, though more weakly in v0.7.0 priced in ITE (0.48) than recorded (0.82). Two parts do not hold. The K-count signal, the "one marginal exception", **does not replicate**: below the floor in v0.6.0 in both forms and in v0.5.0 in the form the sizing review used; with nine pairings per release here and about fifteen in the sizing review, one marginal pass in a release is what chance gives. And tier is **not** silent after the first pass: it carries a weak positive rank correlation with rounds in v0.5.0 and v0.6.0 (opus beads median 5.5 and 3 rounds against sonnet 5 and 2), which reads as the tier encoding difficulty, not as a lever. One new reading: in v0.7.0 the implementers' ITE does not follow rounds (0.28) while the reviewers' does (0.74) — the release's iteration bill was paid mostly on the review side.

**(d) Change.** Do not adopt a K-count rule: it fails in v0.6.0 in both forms and in v0.5.0 in the form the sizing review used. The claim's own instruction — measure the mechanism that produces passes — has no instrument: finding families per round exist only as verdict prose. Owner: **`ugcportal-2jvh`** (P2), the per-round `findings_rN` record the sizing review proposed and nobody owned. The unit fix is `ugcportal-cii0`.

## 3. Claim 2: resumed agents have a rising cost floor

> Every trivial late pass pays rent on the whole history. Switch to a fresh agent with a digested brief after a fixed number of passes; delete rather than rewrite.

**(a) What would decide it.** Confirmed if a resumed pass's cost rises with the history it carries, independent of the work, and a fresh agent does the same kind of fix for less; refuted if late passes cost what their work costs. A crossover — when to stop resuming — is stated only if the curve shows one.

**(b) Test.** The bead asked for the per-pass curve from the `tokens_impl_note` / `tokens_qa_note` prose ("pass N ≈X", "rN X", by difference). Section 1.2 shows those figures are differences of context snapshots: they measure how much the context **grew** in a pass, not what the pass cost. `lskg`'s notes give passes 4 and 5 as ≈14,464 and ≈11,366; the transcript prices them at 828k and 695k ITE, each opened by re-writing its whole 378k and 392k context because the cache had expired. So the curve is built from the transcripts, over 620 implementer passes of 246 agents, of which 108 were resumed (374 later passes). Medians:

| pass | n | carried context at start | calls | ITE | ITE per call | first call re-wrote the cache | idle before the pass |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 246 | 26k | 76.5 | 1,238k | 16k | — | — |
| 2 | 108 | 199k | 33 | 1,283k | 38k | 84% | 888 s |
| 3 | 79 | 269k | 30 | 1,419k | 43k | 78% | 767 s |
| 4 | 61 | 331k | 33 | 1,790k | 55k | 80% | 826 s |
| 5 | 43 | 382k | 37 | 2,014k | 60k | 86% | 920 s |
| 6 | 26 | 450k | 28 | 2,029k | 70k | 73% | 701 s |
| 7+ | 57 | 421k | 19 | 1,471k | 62k | 65% | 654 s |

The cost per call climbs from 16k to 70k while the work per pass shrinks. Across the 374 resumed passes, the median share of the pass's ITE that is re-reading the carried history (0.1 x calls x carried context) or re-writing it after a cache miss (1.25 x carried context) is **0.87**. The idle gap is the second half of the mechanism: the prompt cache lives five minutes, the median gap before passes 2 to 5 is 13 to 15 minutes, so most resumes start by paying 1.25x for the whole history before doing anything.

Against fresh agents: 85 implementer agents that ran exactly one pass and whose description names a fix round cost a median **612k** ITE (IQR 243k-1,242k, 52 calls); the 374 resumed passes cost **1,521k** (IQR 440k-2,817k, 30 calls). The gap holds within a model — `claude-sonnet-5` 908k vs 1,874k (n=40/202), `claude-opus-5` 1,074k vs 1,764k (n=18/110) — and at matched call counts (21-40 calls: 370k fresh, n=15, against 1,469k resumed, n=102). By the context carried into the pass:

| carried context | n | ITE median | ITE per call | cache re-written on first call |
|---|---:|---:|---:|---:|
| under 150k | 73 | 199k | 17k | 37 of 73 |
| 150k-250k | 81 | 1,003k | 33k | 60 of 81 |
| 250k-350k | 76 | 1,646k | 47k | 69 of 76 |
| 350k and over | 144 | 2,694k | 69k | 129 of 144 |

The claim's own example does not say what it was read as saying. `bd memories resumed-agents-have-a-rising-cost-floor` cites `6uc2` passes 5-7 at "726k, 737k and 744k" for near-zero work. Those are the context snapshots (725k, 737k, 744k in the transcript). The passes cost **5,331k, 2,478k and 983k** ITE: falling, not rising, with the work (62, 22 and 13 calls), and still large because each carried more than 700k. `6uc2`'s recorded `tokens_impl` of 4,410,532 is the seven snapshots added up; its implementer's ITE is 30.0M.

**(c) Verdict: partly supported.** The mechanism is supported on n=374 resumed passes over the whole transcript window (v0.4.0-v0.7.0 builds), not one release: a resumed pass pays for its history on every call and, usually, once more on the first. The remedy's trigger is not: the data place the crossover on **carried context, between 150k and 250k**, where resumed passes go from a median 199k (below the 612k of a fresh fix agent) to 1,003k (above it) — and the median second pass already starts at 199k, so "after a fixed number of passes" would usually switch one pass late. Two limits: the comparison is observational (fresh fix agents cluster on 2026-10-08 to 10-14; which rounds got a fresh agent was not random), and nothing here measures whether a fresh agent's fix needed more review rounds afterwards. "Delete rather than rewrite" is **asserted, not re-measured**: no field or transcript feature separates a deleting pass from a rewriting one.

**(d) Change.** Owner: **`ugcportal-8r06`** (P2) — choose resume or fresh by carried context and idle time, record the choice per round, and re-measure fresh against resumed with the rounds-after-fix comparison before tuning the threshold. The unit the notes record is `ugcportal-cii0`.

## 4. Claim 3: a strict reviewer with no lenient band converts lows into rounds

> When every low blocks, review cost is bounded only by how many narrower siblings a reviewer can find. Fix the gate's identity or policy, not the implementer.

**(a) What would decide it.** Confirmed if chains are never `exact` (so the rounds 4-5 band never opens), late rounds are mostly lows-only, and those rounds cost real tokens; refuted if late rounds mostly carry mediums, or if the same strict gate produced few late rounds when something on the implementer side changed.

**(b) Test.** Marker rounds per release from `release-cost-report.mjs`; reviewer ITE per PR-round from transcripts whose description names both:

| | v0.5.0 | v0.6.0 | v0.7.0 |
|---|---:|---:|---:|
| PRs with marker rounds / chains `exact` | 35 / 0 (34 `approx`, 1 `broken`) | 70 / 0 | 54 / 0 |
| rounds in total | 129 | 148 | 164 |
| rounds 4+ | 50 | 13 | 38 |
| ... of which found a medium-or-above | 14 | 3 | 7 |
| ... lows only | **33** | 3 | **23** |
| ... zero findings / severity unstated | 3 / 0 | 5 / 2 | 6 / 2 |
| if lows stopped blocking from round 4: PRs merged earlier | 15 | 0 | 11 |
| ... review rounds not run | 21 | 0 | 16 |
| ... of which later found a medium-or-above | 3 | 0 | 0 |
| ... recorded `tokens_qa_rN` of those rounds | not recorded | — | 2,591k (16 of 16) |
| ... reviewer ITE of those rounds | 7,888k (9 of 21) | — | **13,727k** (16 of 16) |

A reviewer round costs a median 1,647k ITE at round 1 (n=116 PR-rounds), 978k at rounds 2-3 (n=83) and 879k at round 4 or later (n=54); the fix pass each blocking round triggers costs a median 1,521k more (section 3). `review-rounds-v0.5.0.md` reached the same order on its own window (20 of 100 rounds saved, 5 mediums missed, #80-#103).

The live case the brief offered agrees: PR #252 (`ugcportal-3ssw`) blocked at round 1 on three mediums and two lows and at round 2 on two lows, and merged clean at round 3 (`tokens_qa_note`). Its recorded `tokens_qa_r2` and `_r3` are 30,538 and 14,013; the reviewer's transcript (today's, so outside the cut-off; `node scripts/agent-pass-cost.mjs` without `--before`, agent `a736e368278fee005`) prices those passes at 260k and 345k ITE, the round-3 pass opening on an expired cache.

**(c) Verdict: partly supported.** The first sentence holds where late lows exist: none of the 159 marker PRs of v0.5.0-v0.7.0 has an `exact` chain, two thirds of late rounds in v0.5.0 and v0.7.0 were lows-only, and in v0.7.0 the rounds a lenient band would have skipped cost 13.7M reviewer ITE and found no stated medium afterwards (in v0.5.0 they found 3; both subject to the parser caveat in 1.1). "Bounded only by how many narrower siblings a reviewer can find" is **asserted, not re-measured**: whether a late low is a sibling of the previous fix is a judgement in prose (A18/14), not a field. The second sentence is contradicted by v0.6.0: the same strict gate, every chain `approx`, produced 13 late rounds and no lenient-band saving, after round-1 mediums fell from 43% to 14% of PRs (`release-cost-v0.5.0-vs-v0.6.0.md` §2, attributed there in part to the pre-review). The implementer side moved the late-round count more than the gate did; the gate decides what each late low costs once it exists.

**(d) Change.** The identity fix is **`ugcportal-62b6`** (open, P2); `ugcportal-3ssw`'s GitHub App token helper (PR #252) is its prerequisite, and PR #252's own markers were still written by `eiriksf-capgemini`, so no chain is `exact` yet. Whether a review-thread sentence blocks is **`ugcportal-n005`** (open, P3). Testing the sibling mechanism needs **`ugcportal-2jvh`**. No new bead: the implementer-side lever (pre-review) already exists and is the one v0.6.0 credits.

## 5. Claim 4: orchestrator controls pay more than worker controls

> One brief defect fans out to N agents; one re-derive instruction caught nine of nine errors. Review the least-reviewed participant.

**(a) What would decide it.** Confirmed if the catalogue's attribution is reproducible, a brief defect demonstrably reached several agents, and the re-derive control's catch rate can be recounted; refuted if fan-out is a single instance or the catch count cannot be traced to entries.

**(b) Test.**

- **Attribution**, recounted from the `fbng` notes: 67 line-start labels, one of which (`A23`, line 518) is a back-reference, so **66 entries: A 37, B 11, C 18**, with A13-A19 each used twice — the retrospective's table, reproduced.
- **Fan-out**, re-measured on A1 (the stale "204 files / 4553 tests" baseline) by reading the first prompt of every subagent transcript: **12 briefs carried it as the current baseline**, 2026-10-08 15:53Z to 17:08Z (implementers for `i40s`, `i7lr`, `74w` (the "74w-a" curation-triage agent); reviewers of #192-#195; fix rounds of #193-#195), and 4 later briefs (17:48Z on) quote it as stale. The catalogue says five. The defect fanned out more than recorded.
- **"Nine of nine"**: the catalogue's A29 says "nine errors in" and that briefs asking the agent to re-derive caught them; the nine are not listed as one set with their catcher, so the ratio is **asserted, not re-measured**.
- **What an orchestrator control costs to run**: an orchestrator API call costs a mean 79k ITE (598.2M over 7,579 calls), a subagent call 26k (2,348.6M over the 91,722 calls of the 2,774 passes). The same control costs about three times as much per run when the orchestrator runs it inline: the dispatch gate's 25 orchestrator runs cost 2.05M ITE, about 82k a run.

**(c) Verdict: partly supported.** Fan-out is supported and larger than the catalogue says (12 briefs, n=1 defect re-measured). The catch rate is asserted, not re-measured. "Pay more" holds as leverage and has a price side the claim does not mention: checks the orchestrator does itself are the dearest per run.

**(d) Change.** Reviewing the orchestrator's output is **`ugcportal-eph2`** (open, P2); provenance in review briefs and reports is **`ugcportal-4bok`** (open, P2). Putting each control's runner and price in the release report — so a control that runs inline at 82k a call is visible — is part of **`ugcportal-md4c`** (P3).

## 6. Claim 5: a memory is not an owner

> Rules recorded as prose get re-broken; one was re-committed twenty minutes after being catalogued. Give each error a bead or a mechanical check, and an owner marker on day one.

**(a) What would decide it.** Confirmed if a memory-owned rule keeps recurring after its memory exists, and a mechanically-owned rule does not; refuted if recurrence stops once the memory is written.

**(b) Test.** Every Bash command in the transcripts, matched for `bd update <id> ... --notes` (the replacing flag) and `... --append-notes`, de-duplicated by agent and bead:

| window | `--notes` uses | `--append-notes` writes | `--notes` share |
|---|---:|---:|---:|
| 2026-09-18 to 10-06 13:02Z (before the memory) | 24 | 331 | 6.8% |
| 10-06 13:02Z to 10-08 15:52Z (memory, before its rewrite as a flat prohibition) | 3 | 83 | 3.5% |
| 10-08 15:52Z to 10-15 (after the rewrite) | 4 | 345 | 1.1% |

Some uses are harmless (filling an empty field), so the share measures the habit, not damage. The sweep's recall is below 100%: A24 (2026-10-09) does not appear as a matching command.

B1 to A13: the B1 entry was appended at 2026-10-09T07:28:52Z and the orchestrator's `bd create` with backticks inside double quotes (filing `ugcportal-7w83`) ran at 08:02:16Z — **33 minutes**, not twenty; the A13 entry followed at 08:03:41Z.

Day-one owner markers: the v0.8.0 catalogue bead `ugcportal-zce5` holds its premise line and no entries at the v0.8.0 cut (PR #253, `166c345`).

**(c) Verdict: partly supported.** The memory lowered the rate and did not stop it (7 uses after it existed, n=3 windows); the re-commit happened, 33 minutes on. The other half — that a bead or a mechanical check does better — is **untestable with current data**: no rule in this repo has a mechanical owner and a matched recurrence count to compare against. That `zce5` is empty at the cut says the day-one marker practice has not started; it does not say whether errors occurred.

**(d) Change.** **`ugcportal-vu49`** (P2): a check before the command runs, for the two rules with the clearest recurrence record (`--notes`, and backticks in double-quoted `bd` strings), routed to Eirik because it lives in `.claude/settings.json`; its K3 re-runs this table, which is the missing comparison arm. The catalogue practice is **`ugcportal-zce5`** (open, P1).

## 7. Claim 6: price the controls

> The premise gate, the catalogue and the audits all consume tokens and hours that no document records. A control whose cost is unknown cannot be shown to pay.

**(a) What would decide it.** Confirmed if no document records a price for these controls; refuted if one does. The second sentence is tested by whether a payoff can be set against each price.

**(b) Test.** What was recorded before today: C14 in the `fbng` notes ("two sonnet analysts re-verified 11 premises in ~2 h of wall clock for ~140k tokens") and `ugcportal-j5fl`'s `tokens_impl` 702,396 (the sum of its nine agents' snapshots, "excludes the orchestration session"). Both are in the context-snapshot unit. Nothing else.

Priced here from the transcripts, as the ITE of the API turn that issued each matching command — the context that turn carried, which is what running the control costs beyond the tool's own output — and the seconds from command to result:

| Control | Runs | ITE | Wall clock | Orchestrator share | Recorded before | What it caught |
|---|---:|---:|---:|---|---|---|
| Review-round markers (any command naming the marker) | 1,222 | 61.5M (2.1% of the window) | 6,557 s | 172 runs, 30.3M | nothing | not recorded |
| `claims-audit.mjs` runs | 1,701 | 51.1M | 6,933 s | 40 runs, 5.5M | nothing | not recorded |
| `sweep-candidates.mjs` runs | 728 | 19.7M | 2,868 s | 19 runs, 1.9M | nothing | not recorded |
| `fbng` catalogue writes (bd commands on the bead) | 108 | 10.9M | 741 s | 77 runs, 10.0M | nothing | 66 entries |
| v0.7.0 premise audit (`j5fl`): 9 agents, 245 calls | 9 | 3.0M | 12.5 min (14:46:45-14:59:13Z) | orchestration not priced | 702,396 | 8 changed premises of 58 |
| Dispatch gate (`check-bead-dispatch.mjs`), all runs | 93 | 3.3M | 808 s | 25 runs, 2.05M | nothing | — |
| ... re-verification wave it forced (C14): 2 agents, 31 calls | 2 | 0.32M (lower bound) | 3 min (11:01:52-11:04:48Z) | — | ~140k, ~2 h | 1 false premise, 2 stale criteria of 11 |
| Compose release gate (C16) | 1 | not separable | about 60 s | 1 run | nothing | 1 real failure |

63 of the 93 dispatch-gate runs belong to building and reviewing the validator itself (PRs #230 and #236); the gate as a control is the other 30 (the orchestrator's 25, the two re-verification analysts' 3, one implementer, the release agent), 2.10M ITE. C14's "~140k" reproduces as the sum of the two agents' snapshots (141,663); their price is at least 318k ITE (the lower bound of section 1.2). The "~2 h" does not reproduce from the agents, which ran three minutes; it may be the orchestrator's elapsed time around them and is **asserted, not re-measured**.

**Not recorded** in bd metadata, the catalogue or the process documents (the K2 list): what markers, `claims-audit` and `sweep-candidates` caught — no finding is linked to the control that surfaced it; the orchestrator's own token total for any bead; the drafting turns of a catalogue entry (only the `bd` command is priced above); a whole `pre-review` pass as a unit; human time, including the waits at the round cap; time spent waiting on CI.

**(c) Verdict: partly supported.** "No document records" is true except for two prose figures in the wrong unit. "Cannot be shown to pay" is right for markers, `claims-audit` and `sweep-candidates` (**untestable with current data**: price known, catches not recorded) and wrong for the two premise controls, whose catches are recorded: `j5fl` cost about 3.0M ITE for 8 changed premises, and the retrospective credits it with two builds not wasted (`pc7s`, `n9rc`) — at the median first implementation pass (1,238k, section 3) that is about 2.5M avoided, near break-even before the other six.

**What to record, by whom, at what cost.** Per release, per control: runs, ITE, wall clock and runner, from `node scripts/agent-pass-cost.mjs --tool <pattern> --before <cut>` — one command per control, a few seconds each, run by whoever runs the release cost report. Catches: one marker per finding naming the control that surfaced it, written by the reviewer in the verdict it already writes. Owner: **`ugcportal-md4c`** (P3).

## 8. Claim 7: fresh-machine gates catch what cached machines hide

> A pinned third-party image went private and only the release gate's clean compose up noticed. Cheap, and it found a real failure.

**(a) What would decide it.** Confirmed if the failure is in a primary record, is real (not a cached-credential or registry-protocol artefact) and the gate's cost is small; refuted if the failure does not reproduce from a clean client.

**(b) Test.** The gate's log of its first run survives (`/tmp/compose-validate-969d58e.log`): `quay.io/minio/minio:RELEASE.2025-04-08T15-41-24Z ... 401 UNAUTHORIZED`, run 2026-10-14T12:57:44Z to 12:58:44Z. Re-measured 2026-10-16 with an anonymous registry token: quay.io `minio/minio` and `minio/mc` manifests return **401**, Docker Hub `minio/minio` returns **401**; the controls quay.io `prometheus/node-exporter` and Docker Hub `library/alpine` return **200**, so the 401 is the repository, not the protocol. The fix (`ugcportal-s2qp`, PR #244) moved to digest-pinned images and the gate passed at 2026-10-15T04:50Z and again at 10:55Z.

**(c) Verdict: supported, n=1.** One run, one real failure, about a minute of wall clock. That a machine with the old images cached would have hidden it is the retrospective's reading and is not re-measured here; the run itself pulled the images, so the machine it ran on was not hiding anything. "Fresh-machine gates catch what cached machines hide" as a general rule is **untestable with current data** on one instance. The gate exists only as an instruction: no skill or process document mentions it, and no `docker compose up` appears in any transcript between its last run (2026-10-15T10:55Z) and the v0.8.0 cut (PR #253).

**(d) Change.** **`ugcportal-vtgz`** (P3): write the gate into `cut-release` and add a scheduled CI job that resolves every compose image anonymously. Recommended because it is cheap and has no written home, not because one catch proves it pays.

## 9. Beads filed and linked

| Bead | Priority | Status | Owns | From |
|---|---|---|---|---|
| `ugcportal-cii0` | P1 | new | the cost unit and the two conventions; correcting the 14 summed beads | 1.2, claims 1, 2, 6 |
| `ugcportal-8r06` | P2 | new | resume-or-fresh by carried context and idle time, and its re-measurement | claim 2 |
| `ugcportal-2jvh` | P2 | new | per-round findings by family and severity | claims 1, 3 |
| `ugcportal-vu49` | P2 | new | a check before `bd update --notes` and backticked `bd` strings run | claim 5 |
| `ugcportal-md4c` | P3 | new | pricing each control and recording its catches per release | claims 4, 6 |
| `ugcportal-vtgz` | P3 | new | the compose gate in `cut-release` and as a scheduled CI check | claim 7 |
| `ugcportal-62b6` | P2 | open | a separate reviewer identity, so an `exact` chain exists | claim 3 |
| `ugcportal-n005` | P3 | open | whether a review-thread sentence blocks | claim 3 |
| `ugcportal-eph2` | P2 | open | review of the orchestrator's own output | claim 4 |
| `ugcportal-4bok` | P2 | open | provenance in review briefs and reports to Eirik | claim 4 |
| `ugcportal-zce5` | P1 | open | the v0.8.0 catalogue with owner markers from day one | claim 5 |
| `ugcportal-7w83` | P3 | open | the severity parser's known fault, which this document's round counts inherit | 1.1 |

Each new bead carries a `discovered-from` edge to `ugcportal-l6t5` (`bd dep list ugcportal-l6t5 --direction=up`).

## Appendix A: reproducing the figures

Inputs, gathered 2026-10-16 into `/tmp/l6t5`; `bd` runs in the main checkout, everything else in a worktree of this branch:

```bash
mkdir -p /tmp/l6t5/ghcache
cd /Users/eiriksf/code/ugcportal && bd list --all --limit 0 --json > /tmp/l6t5/beads.json
cd <worktree>
node scripts/release-cost-report.mjs --releases v0.5.0,v0.6.0,v0.7.0 --beads /tmp/l6t5/beads.json \
  --cache /tmp/l6t5/ghcache --json /tmp/l6t5/costreport.json --allow-unmerged > /tmp/l6t5/costreport.md
node scripts/agent-pass-cost.mjs --before 2026-10-16T00:00:00Z --json /tmp/l6t5/passes.json
#   reach (snapshot of 2026-10-16, the same 1,750 agent files as section 1.1; the count grows while sessions are written, --before keeps the 2,774 passes fixed): 16 sessions with subagents, 1750 agent files, 1750 parsed, 0 skipped unreadable, 0 malformed lines skipped, 0 assistant entries with missing/invalid usage, 2774 passes starting before 2026-10-16T00:00:00Z
cd /tmp/l6t5 && node analysis.mjs        # appendix B; prints sections 1-4
```

Control prices (section 7), one command each; each prints a reach line (files examined, files skipped as unreadable, malformed lines skipped, assistant entries with missing or invalid usage, matching calls unpriced, files matched) and a `TOTAL` line, marked `(lower bound)` when anything was skipped or unpriced:

```bash
B=2026-10-16T00:00:00Z
node scripts/agent-pass-cost.mjs --before $B --tool '^\{"command":.*ugcportal-review-round'                 # 1,222 calls, 61.5M
node scripts/agent-pass-cost.mjs --before $B --tool '^\{"command":.*node \S*scripts/claims-audit\.mjs'        # 1,701, 51.1M
node scripts/agent-pass-cost.mjs --before $B --tool '^\{"command":.*node \S*scripts/sweep-candidates\.mjs'    # 728, 19.7M
node scripts/agent-pass-cost.mjs --before $B --tool '^\{"command":.*ugcportal-fbng'                           # 108, 10.9M
node scripts/agent-pass-cost.mjs --before $B --tool '^\{"command":.*node \S*scripts/check-bead-dispatch\.mjs' # 93, 3.3M
# j5fl and C14 agents: passes.json rows whose description starts "Premise audit:" / "Re-verify premises"
node -e 'const P=require("/tmp/l6t5/passes.json");for(const re of [/^Premise audit:/,/^Re-verify premises/]){const r=P.filter(x=>re.test(x.description||""));console.log(re,new Set(r.map(x=>x.agentId)).size,"agents",r.reduce((a,x)=>a+x.calls,0),"calls",r.reduce((a,x)=>a+x.ite,0),"ITE",r.map(x=>x.startTs).sort()[0],[...r.map(x=>x.endTs)].sort().pop())}'
# window totals for the shares: orchestrator 598.2M ITE over 7,579 calls, subagents 2,340M -- sum iteOf() over every
# assistant message id in every *.jsonl under the project directory, calls before $B (agent-pass-cost.mjs exports iteOf)
```

Claim 4 (A1 fan-out) and claim 5 (`--notes` rates, B1 → A13) list matching Bash commands or first prompts from every transcript. `grepcmd.mjs`:

```js
// node grepcmd.mjs '<regex>' [chars]: every Bash command in every transcript matching <regex>, with timestamp and agent
import fs from "node:fs"; import path from "node:path";
const dir = process.env.HOME + "/.claude/projects/-Users-eiriksf-code-ugcportal", re = new RegExp(process.argv[2]), show = Number(process.argv[3] || 160);
const files = []; for (const s of fs.readdirSync(dir)) { if (s.endsWith(".jsonl")) files.push([path.join(dir, s), "orch"]); const sd = path.join(dir, s, "subagents"); if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) if (f.endsWith(".jsonl")) files.push([path.join(sd, f), f.slice(6, 14)]); }
const out = [];
for (const [f, who] of files) for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!l.includes("tool_use")) continue; let e; try { e = JSON.parse(l); } catch { continue; }
  for (const c of Array.isArray(e.message?.content) ? e.message.content : []) if (c.type === "tool_use" && typeof c.input?.command === "string" && re.test(c.input.command)) { const m = c.input.command.match(re); out.push(`${e.timestamp} ${who} ${c.input.command.slice(Math.max(0, m.index - 40), m.index + show).replace(/\n/g, " ")}`); } }
out.sort(); console.log(`examined ${files.length} files; ${out.length} matching commands`); console.log([...new Set(out)].join("\n"));
```

```bash
node grepcmd.mjs 'bd update\s+(ugcportal|pgops)-[a-z0-9.]+[^\n|;&]*?\s--notes[ =]' 30      # 44 commands; de-duplicate by agent+bead -> 24/3/4 by window
node grepcmd.mjs 'bd update\s+(ugcportal|pgops)-[a-z0-9.]+[^\n|;&]*?\s--append-notes[ =]' 10 # 759 commands -> 331/83/345 by window
node grepcmd.mjs 'bd remember[^\n]*bd-update-notes-flag' 40   # the memory: 10-06T13:02:05Z, rewritten 10-08T15:52:56Z and 10-09T21:36Z
node grepcmd.mjs 'B1\. UNESCAPED BACKTICKS|I COMMITTED B1' 60  # B1 appended 10-09T07:28:52Z, A13 08:03:41Z
node grepcmd.mjs 'bd create[^\n]*classifySeverity' 60           # the backticked create of 7w83, 08:02:16Z
# A1: first user message of every subagent transcript matching /\b4,?553\b/ -> 16, of which 4 call it stale
cd ~/.claude/projects/-Users-eiriksf-code-ugcportal && node -e 'const fs=require("fs"),p=require("path");let n=0,h=[];for(const s of fs.readdirSync(".")){const d=p.join(s,"subagents");if(!fs.existsSync(d))continue;for(const f of fs.readdirSync(d).filter(x=>x.endsWith(".jsonl"))){n++;const l=fs.readFileSync(p.join(d,f),"utf8").split("\n").find(x=>x.includes("\"type\":\"user\""));if(!l)continue;const e=JSON.parse(l),c=typeof e.message.content==="string"?e.message.content:JSON.stringify(e.message.content),m=c.match(/.{0,60}\b4,?553\b.{0,40}/);if(m)h.push(e.timestamp+" "+m[0])}}console.log(n,"examined",h.length,"matched");console.log(h.sort().join("\n"))'
```

Catalogue labels (claim 4): `bd show ugcportal-fbng --json` notes to `fbng-notes.txt`, then `grep -oE "^(=== )?[ABC][0-9]+\b" fbng-notes.txt | sed 's/=== //' | sort | uniq -c` (67 labels; `A23` twice, once as the back-reference at line 518). `j5fl` verdicts: `grep -c '| \*\*CHANGED\*\* |' docs/process/premise-audit-v0.7.0-2026-10-08.md` (8).

Claim 7, the registry checks:

```bash
for repo in minio/minio minio/mc prometheus/node-exporter; do
  tok=$(curl -s "https://quay.io/v2/auth?service=quay.io&scope=repository:$repo:pull" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
  echo "quay $repo $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    https://quay.io/v2/$repo/manifests/latest)"; done                       # 401, 401, 200
for repo in minio/minio library/alpine; do
  tok=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
  echo "hub $repo $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" https://registry-1.docker.io/v2/$repo/tags/list)"; done  # 401, 200
grep -n 401 /tmp/compose-validate-969d58e.log
```

## Appendix B: analysis.mjs

Run from `/tmp/l6t5` with `beads.json`, `passes.json` and `costreport.json` beside it. It prints every figure in sections 1 to 4 (Spearman with average ranks for ties; the critical value is the t-based one the sizing review uses).

```js
// Every figure in sections 1-4 of the l6t5 document. Run from the directory holding beads.json, passes.json, costreport.json.
import fs from "node:fs";
const J = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const beads = J("beads.json"), P = J("passes.json"), cost = J("costreport.json");
const byId = Object.fromEntries(beads.map((b) => [b.id, b]));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const k = (x) => (x == null ? "-" : Math.round(x / 1000).toLocaleString("en") + "k");
const rank = (xs) => { const s = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = []; for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let t = i; t <= j; t++) r[s[t][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
const rho = (p) => { const rx = rank(p.map((x) => x[0])), ry = rank(p.map((x) => x[1])), mx = rx.reduce((a, b) => a + b) / rx.length, my = ry.reduce((a, b) => a + b) / ry.length; let xy = 0, xx = 0, yy = 0; rx.forEach((x, i) => { xy += (x - mx) * (ry[i] - my); xx += (x - mx) ** 2; yy += (ry[i] - my) ** 2; }); return xy / Math.sqrt(xx * yy); };
const tC = (df) => { const z = 1.959964; return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3); };
const crit = (n) => { const t = tC(n - 2); return t / Math.sqrt(n - 2 + t * t); };
const sp = (label, p) => console.log(`  ${label}: rho=${rho(p).toFixed(2)} n=${p.length} crit5%=${crit(p.length).toFixed(3)} ${Math.abs(rho(p)) > crit(p.length) ? "above" : "below"}`);

console.log("== 1.1 coverage (closed beads)");
const closed = beads.filter((b) => b.status === "closed");
const has = (key, pos) => closed.filter((b) => b.metadata?.[key] != null && b.metadata[key] !== "" && (!pos || Number(b.metadata[key]) > 0)).length;
console.log(`  closed ${closed.length}; tokens_impl present ${has("tokens_impl")} (>0: ${has("tokens_impl", 1)}); tokens_qa ${has("tokens_qa")} (>0: ${has("tokens_qa", 1)}); tokens_impl_passes ${has("tokens_impl_passes")}; tokens_qa_rN ${closed.filter((b) => Object.keys(b.metadata || {}).some((x) => /^tokens_qa_r\d+$/.test(x))).length}`);

console.log("== 1.2 what subagent_tokens measures");
const agents = new Map(); for (const r of P) (agents.get(r.agentId) || agents.set(r.agentId, []).get(r.agentId)).push(r);
let cmp = 0, w2 = 0, w5 = 0, multi = 0, multiOk = 0;
for (const ps of agents.values()) { const n = ps[0].notified; if (!n.length) continue; const pairs = n.length === ps.length ? n.map((v, i) => [v, ps[i].ctxEnd]) : [[n[n.length - 1], ps[ps.length - 1].ctxEnd]];
  for (const [v, c] of pairs) { cmp++; if (Math.abs(v / c - 1) <= 0.02) w2++; if (Math.abs(v / c - 1) <= 0.05) w5++; }
  if (ps.length > 1 && n.length === ps.length) { multi++; if (pairs.every(([v, c]) => Math.abs(v / c - 1) <= 0.05)) multiOk++; } }
console.log(`  agents ${agents.size}; with a notification ${[...agents.values()].filter((p) => p[0].notified.length).length}; notifications compared ${cmp}; within 2% of the last call's context ${w2}; within 5% ${w5}; multi-pass agents with one notification per pass ${multi}, every pass within 5%: ${multiOk}`);
// agent -> bead: full ids, then short ids containing a digit, then "PR #N" through prs metadata
const ids = new Set(beads.map((b) => b.id)), short = new Map(beads.map((b) => [b.id.replace("ugcportal-", ""), b.id]));
const prTo = new Map(); for (const b of beads) for (const p of (b.metadata?.prs || "").split(",").map((s) => s.trim().replace("gh-", "")).filter(Boolean)) (prTo.get(p) || prTo.set(p, []).get(p)).push(b.id);
const amap = new Map(); for (const r of P) { if (r.pass !== 1) continue; const t = `${r.description || ""} ${r.prompt || ""}`;
  let h = [...new Set((t.match(/ugcportal-[a-z0-9]+(?:\.\d+)?/g) || []).filter((x) => ids.has(x)))];
  if (!h.length) h = [...new Set((t.match(/\b[a-z0-9]{2,5}(?:\.\d+)?\b/g) || []).filter((x) => /\d/.test(x) && /[a-z]/.test(x) && short.has(x)).map((x) => short.get(x)))];
  if (!h.length) { const m = t.match(/\bPR\s*#?(\d{2,3})\b/i) || t.match(/#(\d{2,3})\b/); if (m && prTo.has(m[1])) h = prTo.get(m[1]); }
  amap.set(r.agentId, h); }
console.log(`  agents mapped to exactly one bead: ${[...amap.values()].filter((v) => v.length === 1).length} of ${amap.size}`);
const conv = { summed: [], last: [], other: 0 };
for (const [id, ps] of agents) { if (ps[0].role !== "impl" || ps.length < 2 || ps[0].notified.length < 2) continue; const bs = amap.get(id); if (bs?.length !== 1) continue; const ti = Number(byId[bs[0]]?.metadata?.tokens_impl); if (!ti) continue;
  const n = ps[0].notified, sum = n.reduce((a, b) => a + b, 0), last = n[n.length - 1], near = (x, y) => Math.abs(x - y) / y <= 0.03;
  if (near(ti, sum)) conv.summed.push(bs[0].replace("ugcportal-", "")); else if (near(ti, last)) conv.last.push(bs[0].replace("ugcportal-", "")); else conv.other++; }
console.log(`  resumed implementers whose bead's tokens_impl = SUM of cumulative notifications: ${conv.summed.length} (${conv.summed.join(" ")}); = LAST notification: ${conv.last.length}; neither (several agents, estimates): ${conv.other}`);
const iteBead = new Map(), iteRole = { impl: new Map(), review: new Map() };
for (const r of P) { const bs = amap.get(r.agentId); if (bs?.length !== 1) continue; iteBead.set(bs[0], (iteBead.get(bs[0]) || 0) + r.ite); if (iteRole[r.role]) iteRole[r.role].set(bs[0], (iteRole[r.role].get(bs[0]) || 0) + r.ite); }
console.log(`  ITE over every subagent pass: ${k(P.reduce((a, r) => a + r.ite, 0))} in ${P.reduce((a, r) => a + r.calls, 0)} calls`);

console.log("== 2 claim 1: rounds, tier, K-count, per release");
for (const rel of ["v0.5.0", "v0.6.0", "v0.7.0"]) {
  const rows = cost.rows[rel].map((r) => ({ ...r, ite: iteBead.get(r.id) ?? null, iteImpl: iteRole.impl.get(r.id) ?? null, iteRev: iteRole.review.get(r.id) ?? null, kc: (byId[r.id]?.acceptance_criteria || "").split("\n").filter((l) => /^K\d+:|^Following should never happen/.test(l)).length }));
  const R = rows.filter((r) => r.rounds != null), pr = (x, y, f = () => true) => rows.filter((r) => x(r) != null && y(r) != null && f(r)).map((r) => [x(r), y(r)]);
  const tier = { haiku: 1, sonnet: 2, opus: 3 }, tot = (r) => (r.impl != null && r.qa != null ? r.impl + r.qa : null);
  console.log(` ${rel}: beads ${rows.length}, with rounds ${R.length}, with transcript ITE ${rows.filter((r) => r.ite != null).length}; rounds median sonnet ${med(R.filter((r) => r.tier === "sonnet").map((r) => r.rounds))} (n=${R.filter((r) => r.tier === "sonnet").length}) opus ${med(R.filter((r) => r.tier === "opus").map((r) => r.rounds))} (n=${R.filter((r) => r.tier === "opus").length})`);
  sp("rounds~recorded total", pr((r) => r.rounds, tot)); sp("rounds~tokens_qa", pr((r) => r.rounds, (r) => r.qa)); sp("rounds~ITE total", pr((r) => r.rounds, (r) => r.ite)); sp("rounds~ITE review", pr((r) => r.rounds, (r) => r.iteRev)); sp("rounds~ITE impl", pr((r) => r.rounds, (r) => r.iteImpl));
  sp("tier~tokens_impl", pr((r) => tier[r.tier], (r) => r.impl)); sp("tier~rounds", pr((r) => tier[r.tier], (r) => r.rounds)); sp("K-count (0 included)~rounds", pr((r) => (r.rounds != null ? r.kc : null), (r) => r.rounds)); sp("K-count (K-numbered only)~rounds", pr((r) => r.kc || null, (r) => r.rounds));
  sp("recorded total~ITE total", pr(tot, (r) => r.ite));
  const ratio = rows.filter((r) => r.ite != null && tot(r) != null).map((r) => r.ite / tot(r)); console.log(`  ITE / recorded: median ${med(ratio).toFixed(1)}x IQR ${q(ratio, 0.25).toFixed(1)}-${q(ratio, 0.75).toFixed(1)} n=${ratio.length}`);
  const wi = rows.filter((r) => r.ite != null && r.rounds != null), all = wi.reduce((a, r) => a + r.ite, 0), hi = wi.filter((r) => r.rounds >= 4); console.log(`  beads at 4+ rounds: ${hi.length} of ${wi.length}, ${((100 * hi.reduce((a, r) => a + r.ite, 0)) / all).toFixed(0)}% of their ITE`);
}

console.log("== 3 claim 2: resumed implementers");
const impl = P.filter((r) => r.role === "impl"), miss = (r) => r.firstCallCacheWrite > 0.5 * r.ctxStart;
console.log(`  impl passes ${impl.length}, agents ${new Set(impl.map((r) => r.agentId)).size}, resumed agents ${new Set(impl.filter((r) => r.passes > 1).map((r) => r.agentId)).size}, resumed passes ${impl.filter((r) => r.pass >= 2).length}`);
console.log("  pass | n | ctxStart | calls | ITE | ITE/call | cache miss % | idle s (medians)");
for (const i of [1, 2, 3, 4, 5, 6, "7+"]) { const X = impl.filter((r) => (i === "7+" ? r.pass >= 7 : r.pass === i)); console.log(`  ${i} | ${X.length} | ${k(med(X.map((r) => r.ctxStart)))} | ${med(X.map((r) => r.calls))} | ${k(med(X.map((r) => r.ite)))} | ${k(med(X.map((r) => r.ite / r.calls)))} | ${i === 1 ? "-" : Math.round((100 * X.filter(miss).length) / X.length)} | ${i === 1 ? "-" : med(X.map((r) => r.idleSeconds))}`); }
const isFix = (r) => /round[- ]?\d|\bfix(es)?\b|\br\d\b|follow-?up|rebase|merge/i.test(r.description || "");
const fresh = impl.filter((r) => r.passes === 1 && isFix(r)), res = impl.filter((r) => r.pass >= 2);
const S = (l, X) => console.log(`  ${l}: n=${X.length} calls ${med(X.map((r) => r.calls))} ctxStart ${k(med(X.map((r) => r.ctxStart)))} ITE ${k(med(X.map((r) => r.ite)))} IQR ${k(q(X.map((r) => r.ite), 0.25))}-${k(q(X.map((r) => r.ite), 0.75))}`);
S("fresh fix agents (one pass, description names a round or fix)", fresh); S("resumed passes", res);
for (const [lo, hi] of [[0, 10], [11, 20], [21, 40], [41, 1e9]]) { S(`  fresh, ${lo}-${hi} calls`, fresh.filter((r) => r.calls >= lo && r.calls <= hi)); S(`  resumed, ${lo}-${hi} calls`, res.filter((r) => r.calls >= lo && r.calls <= hi)); }
for (const [lo, hi] of [[0, 150e3], [150e3, 250e3], [250e3, 350e3], [350e3, 1e9]]) { const X = res.filter((r) => r.ctxStart >= lo && r.ctxStart < hi); S(`  resumed, carried context ${k(lo)}-${k(hi)}`, X); console.log(`     ITE/call ${k(med(X.map((r) => r.ite / r.calls)))}; first call re-wrote the cache on ${X.filter(miss).length}/${X.length}`); }
for (const m of ["claude-sonnet-5", "claude-opus-5"]) console.log(`  ${m}: fresh n=${fresh.filter((r) => r.model === m).length} ITE ${k(med(fresh.filter((r) => r.model === m).map((r) => r.ite)))}; resumed n=${res.filter((r) => r.model === m).length} ITE ${k(med(res.filter((r) => r.model === m).map((r) => r.ite)))}`);
const share = res.map((r) => Math.min(1, (0.1 * r.calls * r.ctxStart + (miss(r) ? 1.25 * r.ctxStart : 0)) / r.ite)); console.log(`  share of a resumed pass's ITE that is re-reading (0.1 x calls x carried context) or re-writing (1.25 x carried context, on a miss) the history: median ${med(share).toFixed(2)} n=${share.length}`);
const u6 = P.filter((r) => r.agentId === "a44968758c1b449c9"); console.log(`  6uc2 implementer: ${u6.map((r) => `p${r.pass} notified-ctx ${k(r.ctxEnd)} ITE ${k(r.ite)} calls ${r.calls}`).join("; ")}`);
const byModel = {}; for (const r of P) { const o = (byModel[r.model] ||= { calls: 0, out: 0 }); o.calls += r.calls; o.out += r.output; } console.log(`  output tokens per call by model: ${Object.entries(byModel).map(([m, o]) => `${m} ${(o.out / o.calls).toFixed(0)}`).join(", ")}`);

console.log("== 4 claim 3: the strict gate, per release");
const rv = new Map(); for (const r of P) { if (r.role !== "review") continue; const pm = (r.description || "").match(/PR\s*#?(\d{2,3})/i), rm = (r.description || "").match(/round[- ]?(\d)/i); if (pm && rm) rv.set(`${pm[1]}:${rm[1]}`, (rv.get(`${pm[1]}:${rm[1]}`) || 0) + r.ite); }
const rvv = (f) => [...rv].filter(([x]) => f(+x.split(":")[1])).map(([, v]) => v);
console.log(`  reviewer ITE per PR-round (agents naming both): round 1 ${k(med(rvv((r) => r === 1)))} n=${rvv((r) => r === 1).length}; rounds 2-3 ${k(med(rvv((r) => r >= 2 && r <= 3)))} n=${rvv((r) => r >= 2 && r <= 3).length}; rounds 4+ ${k(med(rvv((r) => r >= 4)))} n=${rvv((r) => r >= 4).length}`);
for (const rel of ["v0.5.0", "v0.6.0", "v0.7.0"]) {
  const prs = [...new Set(cost.rows[rel].flatMap((r) => r.prs))].map((n) => cost.prs[n]).filter((p) => p && p.rounds.length);
  const ch = {}; for (const p of prs) ch[p.chain.status] = (ch[p.chain.status] || 0) + 1;
  const late = prs.flatMap((p) => p.rounds.filter((r) => r.n >= 4)); console.log(` ${rel}: PRs with marker rounds ${prs.length}, chains ${JSON.stringify(ch)}, rounds ${prs.reduce((a, p) => a + p.rounds.length, 0)}; rounds 4+: ${late.length}, of which medium-or-above ${late.filter((r) => r.stated && r.medium > 0).length}, lows only ${late.filter((r) => r.stated && !r.medium && r.low > 0).length}, zero ${late.filter((r) => r.stated && !r.medium && !r.low).length}, unstated ${late.filter((r) => !r.stated).length}`);
  let n = 0, saved = 0, medsAfter = 0, qa = 0, qaN = 0, ite = 0, iteN = 0;
  for (const p of prs) { const max = Math.max(...p.rounds.map((r) => r.n)), f = p.rounds.filter((r) => r.n >= 4 && r.stated && r.medium === 0).sort((a, b) => a.n - b.n)[0]; if (!f || max <= f.n) continue; n++; saved += max - f.n; medsAfter += p.rounds.filter((r) => r.n > f.n).reduce((a, r) => a + (r.medium > 0 ? 1 : 0), 0);
    const owner = beads.find((b) => (b.metadata?.prs || "").split(",").map((s) => s.trim()).includes(`gh-${p.number}`) && b.metadata?.tokens_qa_r1);
    for (let r = f.n + 1; r <= max; r++) { const v = owner && Number(owner.metadata[`tokens_qa_r${r}`]); if (v) { qa += v; qaN++; } if (rv.has(`${p.number}:${r}`)) { ite += rv.get(`${p.number}:${r}`); iteN++; } } }
  console.log(`  if lows stopped blocking from round 4: ${n} PRs merge earlier, ${saved} review rounds not run (recorded tokens_qa_rN on ${qaN}: ${k(qa)}; reviewer ITE on ${iteN}: ${k(ite)}); rounds after the stop that found a medium-or-above: ${medsAfter}`);
}
```
