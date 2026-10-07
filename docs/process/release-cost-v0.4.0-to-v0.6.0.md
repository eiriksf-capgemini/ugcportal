# Release cost across three releases: v0.4.0, v0.5.0, v0.6.0

One table per measure with all three releases in the same row, and a trend column saying which way each moved. Written for `ugcportal-k06e` on 2026-10-07. The two pairwise reports hold the analysis behind each step: `release-cost-v0.4.0-vs-v0.5.0.md` (`ugcportal-apsq`) for the first, `release-cost-v0.5.0-vs-v0.6.0.md` (`ugcportal-7dtn`) for the second. This document adds no new recommendations; `7dtn`'s section 9 stands.

The appendix is the output of `node scripts/release-cost-report.mjs --releases v0.4.0,v0.5.0,v0.6.0` (section 5). Figures in the prose that the appendix does not print are quoted from the two pairwise reports, with the section named, or come from the commands in section 5.

## 1. What makes v0.4.0 only partly comparable

Three things changed between v0.4.0 and the later two releases, and each one marks a row below as **not comparable** rather than as a trend.

- **No round markers.** The review stopping rule and its marker comments shipped with `#43` on 2026-09-28, the last day of v0.4.0. Every v0.4.0 round count comes from the bead's close reason ("seven review passes"), and only 19 of 38 beads state one. Per-round severity does not exist for v0.4.0 at all: its "mediums stated" and "rounds with no stated severity" cells are `#43` alone.
- **"Sonnet" mostly ran on Opus.** Until `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` took effect on 2026-09-29, a sonnet-tagged worker spawn inherited the parent's Opus (`harness-cost-controls` §6, `ugcportal-bf7`). The harness measurement in `apsq` section 4 puts Opus at ~88% of v0.4.0 subagent spend. v0.4.0's tier rows therefore say what was *planned*, not what ran.
- **Recording was thinner.** 27 of 38 beads have a build figure and 16 a review figure; 22 beads have no review cost at all, including the four most expensive features. Every v0.4.0 total is a looser lower bound than the later ones.

Two more differences apply to all three columns. The windows are not the same length (v0.4.0 ten days, v0.5.0 seven, v0.6.0 two), so nothing here is per day. And release membership is the CHANGELOG section; the v0.4.0 git range cannot be cross-checked because v0.3.0 and v0.4.0 share no merge base (`apsq` section 1).

## 2. Every measure, three releases, one row

Trend reads left to right across the three cells. "Better" and "worse" are judged against the process goals the pairwise reports state: fewer rounds, less review spend per bead, more of the cost recorded, no human merge for a reason the process could have removed, `main` never red.

### 2.1 Volume and cost

| Measure | v0.4.0 (09-18 to 09-28) | v0.5.0 (09-29 to 10-05) | v0.6.0 (10-05 to 10-07) | Trend |
|---|---:|---:|---:|---|
| Beads shipped | 38 | 54 | 85 | up, each release |
| Beads with any token figure | 27 (71%) | 40 (74%) | 76 (89%) | **better**: recording is nearly complete |
| Recorded build cost (`tokens_impl`) | 16.6M (27 beads) | 11.1M (32) | 24.4M (76) | not a trend: the v0.6.0 figure covers 2.4× the beads |
| Recorded review cost (`tokens_qa`) | 5.0M (16 beads) | 19.4M (29) | 23.2M (70) | same caveat |
| Recorded total | 21.6M | 30.5M | 47.6M | same caveat |
| **Recorded total per bead shipped** | 568k | 565k | 560k | **flat**: three releases within 1.5% |
| Review share of recorded cost | 23% | 64% | 49% | v0.4.0 under-recorded review (16 beads); v0.5.0 → v0.6.0 **better** |
| Median build cost, beads with a figure | 523,716 | 199,917 | 296,199 | down then up; v0.6.0 records the small beads v0.5.0 left unrecorded, so not a clean trend |
| Median review cost, beads with a figure | 316,261 | 524,812 | 245,931 | up then **better**: v0.6.0 is the lowest of the three |
| Recorded cost per feature bead | 878k (13 feats, 11.4M) | 1.51M (10, 15.1M) | 737k (16, 11.8M) | up then **better**: v0.6.0 is the lowest of the three |

Per-bead cost has not moved in three releases while per-bead *review* cost has fallen and the bead count per release has risen. The cost did not disappear; it moved from review rounds into first-round review and into build, which is where `7dtn` section 3 says it now sits (round 1 is 68% of v0.6.0 review spend).

### 2.2 Review rounds and the gate

| Measure | v0.4.0 | v0.5.0 | v0.6.0 | Trend |
|---|---:|---:|---:|---|
| Rounds median, beads with a count | 5 (n=19, close reasons) | 5 (n=38) | 2 (n=79) | **better** from v0.5.0; v0.4.0 cell is a different measurement |
| Rounds median, per PR with markers | not comparable (no markers) | 4 (n=35) | 2 (n=70) | **better** |
| Beads whose PR reached the cap (≥6 rounds) | 5 | 12 | 2 | worse then **better** |
| PRs at the cap | not comparable | 11 | 1 | **better** |
| Feature PRs, median rounds | not comparable | 5.5 (n=10) | 2 (n=16) | **better** |
| PRs merged at round 1 with zero findings | not comparable | 9 of 35 (26%) | 23 of 70 (33%) | **better** |
| Round-1 verdicts that found a medium | not comparable | 15 of 35 (43%) | 10 of 70 (14%) | **better**, with the caveat two rows down |
| Mediums the reviewer stated (unique PRs) | 2 (`#43` only) | 84 | 30 (appendix says 151; `#121` artefact, `7dtn` §8) | fewer found; `7dtn` §6 attributes it to the pre-review, not to shallower review |
| Rounds with no stated severity | 4 (`#43` only) | 4 of 129 (3%) | 22 of 148 (15%) | **worse**: the gate keys on this value (`7dtn` §2 finding 5) |
| Implementation passes recorded (`tokens_impl_passes`) | 0 of 38 | 0 of 54 | 61 of 85 | **better**: new in v0.6.0 |
| Per-round review cost recorded (`tokens_qa_rN`) | 0 of 38 | 0 of 54 | 68 of 85 | **better**: new in v0.6.0; round 1 median 185k, later rounds 60k |

### 2.3 Who merged, and whether `main` stayed green

| Measure | v0.4.0 | v0.5.0 | v0.6.0 | Trend |
|---|---:|---:|---:|---|
| Human merges, and why | not comparable (no markers to classify) | 24 of 44 PRs: 6 sensitive path, 18 cap or blocked; plus 9 with no review round | 20 of 77: 17 sensitive path, 3 cap or blocked; plus 7 with no review round | **better**: the cap-or-blocked share fell from 18 to 3; the sensitive-path share is the process working as written |
| Escalations at the cap that ended in a merge anyway | not measured | 11 of 11 (`review-rounds-v0.5.0` summary) | 1 (`#109`, three findings filed) | **better** |
| `main` red after a merge | not measured here | 1 incident, 65 min, 3 commits (`review-rounds-v0.5.0`, "The main-red incident") | 0 of 77 runs failed (70 success, 7 cancelled by the concurrency group) | **better** |

### 2.4 Model tier

Planned tier on the bead. The v0.4.0 column is what was planned on a release that mostly ran on Opus (section 1); the harness row at the bottom is what actually ran.

| Measure | v0.4.0 | v0.5.0 | v0.6.0 | Trend |
|---|---:|---:|---:|---|
| Beads by tier (haiku / sonnet / opus / fable) | 4 / 15 / 14 / 3 | 10 / 27 / 9 / 5 | 5 / 60 / 9 / 6 | sonnet carries each release more; opus 14, then 9 twice |
| Sonnet: median rounds, share passing in ≤2 | 5 (n=5), 0% | 5 (n=21), 33% | 2 (n=60), 72% | **better** |
| Sonnet: reached the cap | 2 of 5 | 7 of 21 (33%) | 1 of 60 (2%) | **better** |
| Sonnet: median build / review per bead | 760k / 369k | 204k / 533k | 302k / 235k | review **better**; build mixed |
| Opus: median rounds, share passing in ≤2 | 5 (n=10), 10% | 6 (n=6), 0% | 3 (n=9), 22% | **better** from v0.5.0 |
| Opus: median build / review per bead | 562k / 362k | 450k / 982k | 335k / 330k | **better** |
| Haiku: median rounds, share passing in ≤2 | 2 (n=1), 100% | 2 (n=7), 57% | 1 (n=5), 80% | flat to better; small n throughout |
| Fable beads with a review round | 1 of 3 | 2 of 5 | 0 of 6 | v0.6.0 routed fable to process documents merged by hand, the shape `apsq` §4 asked for |
| Harness: Opus share of subagent spend (list price) | ~88% (~$1,318 of ~$1,491; `apsq` §4) | ~25% ($478 of $1,901; `apsq` §4) | 38% ($730 of $1,910 for 10-06 to 10-07; `7dtn` §4) | **better** then **worse**: the v0.6.0 Opus share is review runs, not implementers (`7dtn` §2 finding 8) |

### 2.5 The most expensive bead of each release

| Release | Bead | Total | Shape | What the pairwise report said about it |
|---|---|---:|---|---|
| v0.4.0 | `jsc` tag vocabulary (`#46`) | ~2.1M build, review unrecorded | 4 rounds | scope ambiguity and in-review mechanism growth (`apsq` §5, `harness-cost-controls` §6) |
| v0.5.0 | `jx4` Load more keeps keyboard focus (`#87`) | 2.51M (2.0M build over six passes + 498k review) | 6 rounds, 4 lows-only | stop the implementer at three passes (`apsq` §5 item 1) |
| v0.6.0 | `61pv` reduced-motion scan (`#129`) | ~1.69M (587k build + 1.1M review) | 2 rounds; round 1 alone 980k | a P4 whose first review round cost five times the release median (`7dtn` §5 item 1) |

The most expensive bead's recorded total went 2.1M (build only, review unrecorded), 2.5M, 1.7M, and the shape of the expense moved with it: build in v0.4.0, review rounds in v0.5.0, one heavy first round in v0.6.0.

## 3. Reading the three columns together

- **Throughput rose and unit cost did not.** 38, 54, 85 beads at 568k, 565k, 560k recorded tokens each. The process changes between the releases did not make a bead cheaper; they made more beads fit in a release and moved the cost between phases.
- **The round problem was a one-release problem.** v0.4.0 and v0.5.0 both sit at a median of five rounds; v0.6.0 at two. What changed between v0.5.0 and v0.6.0 was the pre-review on the branch (`wzgw` item 2, implemented 2026-10-05), and `7dtn` §6 credits it. What did *not* change is the identity rule: every chain in all three releases is `approx`, so the lenient band has never been used, and the round count fell anyway.
- **Recording improved more than anything else.** Build figures on 71%, 59%, 89% of beads; review figures on 42%, 54%, 82%; implementation passes and per-round review cost from nothing to 72% and 80% of beads. The v0.6.0 figures are the first that can bear per-round and per-pass conclusions.
- **Two measures got worse in v0.6.0 and both are about discipline, not design.** Rounds with no stated severity (3% to 15%) and the Opus share of spend (25% to 38%). Neither needs a new mechanism: one is a template field the reviewer must fill, the other is the model named on the reviewer spawn (`7dtn` §9 items 1 and 8).
- **What the three releases cannot yet show** is a per-round cost trend before v0.6.0, or whether v0.4.0's tiers meant anything. The next release will be the first with two comparable points on both.

## 4. Data gaps

- The v0.4.0 column has no PR-level round data, no per-round severity, no implementation-pass counts, and 22 beads with no review cost. Its rows are marked above.
- The appendix's v0.6.0 "Mediums stated" (151) and "Outcome (heuristic)" column carry the two parser faults `7dtn` §8 reports (`ugcportal-zo8n`, `ugcportal-577s`); the prose uses the corrected figures.
- The `main` CI history for the v0.4.0 and v0.5.0 windows is not recomputed here: `gh run list --branch main --limit 400` returned 7 runs for the v0.5.0 window where `review-rounds-v0.5.0` records three failed and two successful runs on 2026-10-05 alone, so the listing is incomplete for older dates and the v0.5.0 cell quotes that document instead. The v0.6.0 cell is from `7dtn` §10.
- The offline regeneration of the appendix (`--offline`) skips the git-range membership cross-check; the online run in `7dtn` reconciled v0.5.0 and v0.6.0, and `apsq` §7 reconciled v0.4.0 by tag dates.

## 5. Reproducing the tables

```bash
# From the repo root, with gh authenticated and bd available. Writes the appendix of this file.
node scripts/release-cost-report.mjs --releases v0.4.0,v0.5.0,v0.6.0 \
  --cache /tmp/release-cost-cache --json /tmp/release-cost-3.json \
  --write docs/process/release-cost-v0.4.0-to-v0.6.0.md

# Per-feature cost (section 2.1): the "feat" row of each release's totals table, Total / Beads.
# Per-PR rounds, merge paths and per-round costs (sections 2.2, 2.3): the python block in
# docs/process/release-cost-v0.5.0-vs-v0.6.0.md section 10, run over the same --json dump.

# Recording coverage for passes and per-round cost (section 2.2), per release. Membership is the
# report's own (rows[release] in the --json dump), so the counts match the appendix's bead totals.
bd list --all --json > /tmp/beads.json
for rel in v0.4.0 v0.5.0 v0.6.0; do
  jq -r '.rows["'"$rel"'"][].id' /tmp/release-cost-3.json | sort -u > /tmp/ids-$rel.txt
  jq -r --arg rel "$rel" --rawfile ids /tmp/ids-$rel.txt '
    ($ids | split("\n") | map(select(length>0))) as $ids
    | [.[] | select(.id as $i | $ids | index($i))] as $b
    | "\($rel): beads \($b|length), with passes \([$b[] | select(.metadata.tokens_impl_passes != null)] | length), with tokens_qa_rN \([$b[] | select((.metadata // {}) | keys | map(select(startswith("tokens_qa_r"))) | length > 0)] | length)"' /tmp/beads.json
done
```

## Appendix: generated tables

<!-- release-cost-report:generated:start -->

_Generated 2026-10-07 by `node scripts/release-cost-report.mjs`; reviewer identity `unknown`; 151 PRs read via `gh`. Legend: `~` = the bead's own notes call this figure an estimate; `(cr)` = round count from the close reason (pre-marker PR); `(!)` = markers and close reason disagree, markers shown; `rN:?` = that round's verdict states no severity; "Lows (labels)" counts severity labels, a single `LOW:` label often covers several items, so it is a floor. qa/round is tokens_qa divided by rounds, a crude mean, because per-round cost is not recorded._

### v0.4.0: per-bead table

| Bead | Type | Scope | Tier/effort | tokens_impl | tokens_qa | Total | PRs | Rounds | Chain | Mediums by round | Lows (labels) | qa/round | Outcome (heuristic) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `jsc` | feat | tags | sonnet/medium | ~2,100,000 | — | ~2,100,000 | #46 | 4 (cr) | #46 approx | n/a (0 labelled medium, 9 unlabelled, ~4 bursts) | 0 | — | human |
| `egp` | fix | auth | opus/xhigh | ~1,600,000 | 362,122 | ~1,962,122 | #45 | 4 (cr) | #45 approx | n/a (2 labelled medium, 5 unlabelled, ~4 bursts) | 4 | ~90,531 | human (sensitive path) |
| `2yj` | chore | process | opus/high | ~1,500,000 | ~164,046 | ~1,664,046 | #43 | 5 | #43 approx {1,2,3,4,5} | r1:? r2:? r3:? r4:? r5:2 | 0 | ~32,809 | cap → human |
| `t0y` | feat | app-shell | — | 1,500,000 | — | 1,500,000 | #47 | 5 (cr) | #47 approx | n/a (2 labelled medium, 3 unlabelled, ~5 bursts) | 11 | — | merged |
| `j4j` | fix | design-system | sonnet/high | 760,431 | 590,000 | 1,350,431 | #39 | 5 (cr) | #39 approx | n/a (0 labelled medium, 20 unlabelled, ~5 bursts) | 2 | ~118,000 | merged |
| `71y` | feat | gallery | sonnet/high | ~900,000 | ~322,089 | ~1,222,089 | #41 | 6 (cr) | #41 approx | n/a (2 labelled medium, 19 unlabelled, ~6 bursts) | 2 | ~53,682 | cap → human |
| `0ss` | feat | instagram | opus/high | 757,281 | 459,771 | 1,217,052 | #33 | 7 (cr) | #33 approx | n/a (4 labelled medium, 29 unlabelled, ~8 bursts) | 3 | ~65,682 | cap → human |
| `n3c` | feat | upload | sonnet/high | 1,200,000 | — | 1,200,000 | #42 | — | #42 approx | 0 | 0 | — | merged (no close reason) |
| `44q` | feat | media | opus/xhigh | ~1,070,048 | ~103,410 | ~1,173,458 | #29 | 5 (cr) | #29 approx | n/a (2 labelled medium, 9 unlabelled, ~4 bursts) | 9 | ~20,682 | human |
| `05b` | fix | media | opus/xhigh | ~523,716 | ~601,554 | ~1,125,270 | #38 | 5 (cr) | #38 approx | n/a (2 labelled medium, 14 unlabelled, ~5 bursts) | 2 | ~120,311 | merged |
| `vsm` | refactor | rights | opus/high | 561,941 | 449,599 | 1,011,540 | #40 | 4 (cr) | #40 approx | n/a (2 labelled medium, 9 unlabelled, ~4 bursts) | 1 | ~112,400 | merged |
| `r1d` | feat | media | sonnet/high | 542,171 | 415,357 | 957,528 | #32 | 9 (cr) | #32 approx | n/a (3 labelled medium, 12 unlabelled, ~8 bursts) | 18 | ~46,151 | cap → human |
| `e86` | perf | media | opus/high | 595,443 | 310,432 | 905,875 | #31 | 8 (cr) | #31 approx | n/a (2 labelled medium, 23 unlabelled, ~6 bursts) | 9 | ~38,804 | cap → human |
| `bdh` | feat | security | opus/high | 522,408 | 275,634 | 798,042 | #27 | 4 (cr) | #27 approx | n/a (3 labelled medium, 3 unlabelled, ~2 bursts) | 5 | ~68,909 | merged |
| `9ak` | chore | process | sonnet/high | 770,000 | — | 770,000 | #48, #50 | 3 (cr) | #48 approx; #50 approx | n/a (0 labelled medium, 25 unlabelled, ~4 bursts) | 0 | — | human (sensitive path) |
| `axu` | feat | design-system | opus/high | 389,887 | 374,504 | 764,391 | #37 | 4 (cr) | #37 approx | n/a (0 labelled medium, 18 unlabelled, ~4 bursts) | 0 | ~93,626 | merged |
| `9cs` | docs | legal | fable/high | ~230,000 | 193,870 | ~423,870 | #44 | 6 (cr) | #44 approx | n/a (2 labelled medium, 23 unlabelled, ~4 bursts) | 3 | ~32,312 | cap → human |
| `u7g` | fix | media | — | 212,030 | 202,003 | 414,033 | #35 | 4 (cr) | #35 approx | n/a (0 labelled medium, 1 unlabelled, ~2 bursts) | 5 | ~50,501 | merged |
| `a2l` | feat | media | opus/high | 242,281 | — | 242,281 | #36 | 2 (cr) | #36 approx | n/a (0 labelled medium, 3 unlabelled, ~1 bursts) | 0 | — | merged |
| `lu7` | feat | auth | sonnet/high | 87,057 | 81,096 | 168,153 | #28 | — | #28 approx | 0 | 0 | — | human |
| `9rt` | build | infra | sonnet/high | ~145,391 | — | ~145,391 | #23 | — | #23 approx | 0 | 0 | — | merged |
| `naa` | docs | process | opus/high | ~130,000 | — | ~130,000 | #20 | — | #20 approx | 0 | 0 | — | merged |
| `zec` | chore | legal | fable/xhigh | 111,048 | — | 111,048 | #26 | — | #26 approx | 0 | 0 | — | human |
| `97y` | test | ci | haiku/medium | ~25,000 | 70,644 | ~95,644 | #30 | 2 (cr) | #30 approx | n/a (1 labelled medium, 0 unlabelled, ~1 bursts) | 0 | ~35,322 | merged |
| `4fx` | feat | gitops | sonnet/high | 74,535 | — | 74,535 | — | — | — | 0 | 0 | — | no PR |
| `0hc` | ci | ci | haiku/medium | ~39,473 | — | ~39,473 | #22 | — | #22 approx | 0 | 0 | — | merged |
| `25x` | ci | ci | haiku/medium | ~37,124 | — | ~37,124 | #21 | — | #21 approx | 0 | 0 | — | merged |
| `1yr` | feat | release-tooling | sonnet/high | — | — | — | #19 | — | #19 approx | 0 | 0 | — | merged |
| `i04` | fix | media | sonnet/high | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `r7t` | docs | process | opus/high | — | — | — | #49 | — | #49 approx | 0 | 0 | — | auto-merged |
| `720` | ci | deploy | opus/high | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `cd8` | ci | deploy | opus/high | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `j4d` | build | infra | sonnet/high | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `zdn` | ci | deploy | sonnet/high | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `234` | chore | process | sonnet/medium | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `2eh` | chore | legal | fable/high | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `4ar` | chore | infra | haiku/medium | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `j7h` | chore | process | sonnet/medium | — | — | — | #24 | — | #24 approx | 0 | 0 | — | merged |

### v0.4.0: totals and medians per bead type

| Group | Beads | with impl | with qa | impl total | qa total | Total | impl median | qa median | Rounds median (n) | At cap | Mediums stated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| feat | 13 | 12 | 7 | 9,385,668 | 2,031,861 | 11,417,529 | 649,726 | 322,089 | 5 (9) | 3 | 0 |
| fix | 5 | 4 | 4 | 3,096,177 | 1,755,679 | 4,851,856 | 642,074 | 476,061 | 5 (4) | 0 | 0 |
| perf | 1 | 1 | 1 | 595,443 | 310,432 | 905,875 | 595,443 | 310,432 | 8 (1) | 1 | 0 |
| docs | 3 | 2 | 1 | 360,000 | 193,870 | 553,870 | 180,000 | 193,870 | 6 (1) | 1 | 0 |
| refactor | 1 | 1 | 1 | 561,941 | 449,599 | 1,011,540 | 561,941 | 449,599 | 4 (1) | 0 | 0 |
| test | 1 | 1 | 1 | 25,000 | 70,644 | 95,644 | 25,000 | 70,644 | 2 (1) | 0 | 0 |
| build | 2 | 1 | 0 | 145,391 | 0 | 145,391 | 145,391 | — | — (0) | 0 | 0 |
| ci | 5 | 2 | 0 | 76,597 | 0 | 76,597 | 38,299 | — | — (0) | 0 | 0 |
| chore | 7 | 3 | 1 | 2,381,048 | 164,046 | 2,545,094 | 770,000 | 164,046 | 4 (2) | 0 | 2 |
| **v0.4.0 total** | 38 | 27 | 16 | 16,627,265 | 4,976,131 | 21,603,396 | 523,716 | 316,261 | 5 (19) | 5 | 2 |

### v0.5.0: per-bead table

| Bead | Type | Scope | Tier/effort | tokens_impl | tokens_qa | Total | PRs | Rounds | Chain | Mediums by round | Lows (labels) | qa/round | Outcome (heuristic) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `jx4` | fix | gallery | sonnet/high | 2,008,736 | 498,149 | 2,506,885 | #87 | 6 | #87 approx {1,2,3,4,5,6} | r1:1 r2:1 | 21 | 83,025 | cap → human |
| `ysub` | fix | privacy | opus/high | 536,035 | 1,764,205 | 2,300,240 | #95 | 6 | #95 approx {1,2,3,4,5,6} | r1:2 r2:1 r4:3 | 6 | 294,034 | cap → human |
| `14k9` | feat | design | sonnet/high | 880,124 | 1,316,502 | 2,196,626 | #94 | 6 | #94 approx {1,2,3,4,5,6} | r1:1 r3:1 r4:1 | 15 | 219,417 | cap → human |
| `akv6` | feat | design | sonnet/high | 771,662 | 1,359,898 | 2,131,560 | #96 | 5 | #96 approx {1,2,3,4,5} | r1:1 r2:1 r3:1 | 6 | 271,980 | cap → human |
| `6dvg` | feat | design | sonnet/high | 886,369 | ~1,187,182 | ~2,073,551 | #97 | 6 | #97 approx {1,2,3,4,5,6} | r1:2 r2:1 r3:1 | 7 | ~197,864 | cap → human |
| `t33p` | feat | auth | opus/xhigh | 657,754 | 1,226,051 | 1,883,805 | #98 | 6 | #98 approx {1,2,3,4,5,6} | r1:2 r2:2 r3:1 r6:1 | 12 | 204,342 | cap → human |
| `1b2c` | fix | upload | sonnet/high | — | 1,837,870 | 1,837,870 | #85 | 6 | #85 approx {1,2,3,4,5,6} | r1:2 r4:1 | 22 | 306,312 | cap → human |
| `1551` | feat | auth | — | ~250,000 | 1,572,553 | ~1,822,553 | #81 | 6 | #81 broken {1,4,5,6} | r5:1 | 18 | 262,092 | cap → human |
| `3wgp` | feat | privacy | sonnet/high | — | 1,749,964 | 1,749,964 | #92 | 6 | #92 approx {1,2,3,4,5,6} | r1:3 r2:1 r3:1 r4:4 r6:1 | 39 | 291,661 | cap → human |
| `ig4g` | fix | gallery | sonnet/medium | ~822,520 | 739,016 | ~1,561,536 | #101 | 5 | #101 approx {1,2,3,4,5} | r1:3 | 16 | 147,803 | human |
| `o7l` | feat | seo | haiku/medium | 316,285 | 768,777 | 1,085,062 | #83 | 5 | #83 approx {1,2,3,4,5} | r1:2 r2:1 r3:1 r4:1 | 4 | 153,755 | human (sensitive path) |
| `mzr` | fix | auth | opus/xhigh | — | 982,017 | 982,017 | #91 | 6 | #91 approx {1,2,3,4,5,6} | r1:1 r2:1 | 33 | 163,670 | cap → human |
| `gwr` | feat | a11y | sonnet/high | ~950,000 | — | ~950,000 | #78 | 5 | #78 approx {1,2,3,4,5} | r1:4 r2:3 r3:3 r4:3 r5:1 | 16 | — | auto-merged |
| `ei7` | perf | media | sonnet/high | 407,136 | 521,004 | 928,140 | #86 | 2 | #86 approx {1,2} | 0 | 4 | 260,502 | human (sensitive path) |
| `8df3` | fix | design | sonnet/high | 373,876 | 537,752 | 911,628 | #102 | 5 | #102 approx {1,2,3,4,5} | 0 | 6 | 107,550 | merged |
| `0dh` | fix | gallery | sonnet/high | ~55,000 | 623,498 | ~678,498 | #75 | 6 | #75 approx {1,2,3,4,5,6} | r2:1 r3:1 r4:1 | 21 | 103,916 | cap → human |
| `rw9j` | feat | design | opus/xhigh | ~450,000 | 227,893 | ~677,893 | #79 | 5 | #79 approx {1,2,3,4,5} | r1:2 r2:4 r3:3 r4:3 | 3 | 45,579 | auto-merged |
| `qqgi` | test | auth | opus/high | 223,833 | 341,725 | 565,558 | #100 | 3 | #100 approx {1,2,3} | 0 | 2 | 113,908 | human (sensitive path) |
| `qnq9.7` | feat | pages | sonnet/high | — | 528,690 | 528,690 | #93 | 6 | #93 approx {1,2,3,4,5,6} | r1:1 r4:3 | 41 | 88,115 | cap → human |
| `qnq9.4` | docs | privacy | fable/high | — | 524,812 | 524,812 | #90 | 6 | #90 approx {1,2,3,4,5,6} | r3:1 | 31 | 87,469 | cap → human |
| `e15` | chore | build | haiku/medium | 318,687 | 139,548 | 458,235 | #82 | 3 | #82 approx {1,2,3} | 0 | 5 | 46,516 | human (sensitive path) |
| `5dr6` | chore | process | sonnet/medium | — | 406,438 | 406,438 | #60 | 4 | #60 approx {1,2,3,4} | r4:1 | 16 | 101,610 | human (sensitive path) |
| `kvb` | fix | process | sonnet/high | 232,808 | — | 232,808 | #59 | — | #59 approx | 0 | 0 | — | merged |
| `ggw` | fix | upload | sonnet/high | ~176,000 | — | ~176,000 | #71 | 1 | #71 approx {1} | 0 | 0 | — | human (sensitive path) |
| `r3h` | fix | rights | haiku/medium | ~58,000 | 108,799 | ~166,799 | #67, #72 | 2 | #67 approx; #72 approx {1,2} | 0 | 0 | 54,400 | human (sensitive path) |
| `bf7` | chore | process | opus/xhigh | 157,870 | — | 157,870 | #58 | — | #58 approx | 0 | 0 | — | merged |
| `5g9t` | fix | auth | sonnet/high | ~70,000 | 71,633 | ~141,633 | #76 | 1 | #76 approx {1} | 0 | 0 | 71,633 | human (sensitive path) |
| `7z48` | docs | process | sonnet/medium | ~135,000 | — | ~135,000 | — | — | — | 0 | 0 | — | no PR |
| `lykb` | chore | process | sonnet/medium | ~70,000 | 45,715 | ~115,715 | #68 | 1 | #68 approx {1} | 0 | 0 | 45,715 | human (sensitive path) |
| `cl4e` | test | gallery | sonnet/high | ~40,000 | ~62,447 | ~102,447 | #80 | 1 | #80 approx {1} | 0 | 0 | ~62,447 | human (sensitive path) |
| `juo` | fix | upload | sonnet/medium | ~95,000 | — | ~95,000 | #74 | — | #74 approx | 0 | 0 | — | merged (no close reason) |
| `qnq9.14` | docs | research | fable/low | 6,000 | 81,876 | 87,876 | #89 | 1 | #89 approx {1} | 0 | 0 | 81,876 | human (sensitive path) |
| `4il` | fix | process | sonnet/high | — | 68,583 | 68,583 | #51, #53, #57 | 1 | #51 approx {1}; #53 approx; #57 approx | r1:? | 0 | 68,583 | human (sensitive path) |
| `d4z` | ci | process | — | — | 66,769 | 66,769 | #56 | 1 | #56 approx {1} | r1:1 | 1 | 66,769 | human (sensitive path) |
| `000` | test | media | sonnet/high | ~65,000 | — | ~65,000 | #77 | 1 | #77 approx {1} | 0 | 0 | — | human (sensitive path) |
| `2pnq` | chore | process | sonnet/medium | 45,000 | — | 45,000 | — | — | — | 0 | 0 | — | no PR |
| `e5zf` | chore | repo | haiku/low | ~8,000 | 36,464 | ~44,464 | #54 | 1 | #54 approx {1} | 0 | 0 | 36,464 | human (sensitive path) |
| `asg` | refactor | auth | haiku/medium | 25,000 | — | 25,000 | #73 | 1 | #73 approx {1} | 0 | 0 | — | human (sensitive path) |
| `4at` | fix | gallery | haiku/medium | 18,000 | — | 18,000 | #65 | 1 | #65 approx {1} | 0 | 0 | — | human (sensitive path) |
| `aj2k` | docs | process | haiku/low | 8,000 | — | 8,000 | #64 | — | #64 approx | 0 | 0 | — | merged (no close reason) |
| `1xf` | fix | process | opus/xhigh | — | — | — | #59 | — | #59 approx | 0 | 0 | — | human |
| `52ue` | fix | design | haiku/low | — | — | — | #101 | 5 | #101 approx {1,2,3,4,5} | r1:3 | 16 | — | merged |
| `5xj` | fix | process | opus/xhigh | — | — | — | #59 | — | #59 approx | 0 | 0 | — | merged |
| `drt1` | fix | auth | sonnet/high | — | — | — | #61 | 4 | #61 approx {1,2,3,4} | r1:? r2:? r3:? | 2 | — | human (sensitive path) |
| `205x` | docs | process | sonnet/medium | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `5znw` | docs | process | sonnet/high | — | — | — | #62, #63 | — | #62 approx; #63 approx | 0 | 0 | — | human (sensitive path) |
| `7yr7` | docs | process | haiku/low | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `cbtk` | docs | tooling | haiku/medium | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `2tc` | chore | process | — | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `plp6` | chore | process | sonnet/high | — | — | — | #60 | 4 (!) | #60 approx {1,2,3,4} | r4:1 | 16 | — | human (sensitive path) |
| `qnq9.10` | chore | compliance | fable/low | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `qnq9.8` | chore | compliance | fable/low | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `qnq9.9` | chore | compliance | fable/low | — | — | — | — | — | — | 0 | 0 | — | no PR |
| `ws3` | chore | process | opus/xhigh | — | — | — | #60 | 4 | #60 approx {1,2,3,4} | r4:1 | 16 | — | human (sensitive path) |

### v0.5.0: totals and medians per bead type

| Group | Beads | with impl | with qa | impl total | qa total | Total | impl median | qa median | Rounds median (n) | At cap | Mediums stated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| feat | 10 | 8 | 9 | 5,162,194 | 9,937,510 | 15,099,704 | 714,708 | 1,226,051 | 6 (10) | 6 | 62 |
| fix | 18 | 11 | 10 | 4,445,975 | 7,231,522 | 11,677,497 | 176,000 | 580,625 | 5 (14) | 5 | 19 |
| perf | 1 | 1 | 1 | 407,136 | 521,004 | 928,140 | 407,136 | 521,004 | 2 (1) | 0 | 0 |
| docs | 8 | 3 | 2 | 149,000 | 606,688 | 755,688 | 8,000 | 303,344 | 4 (2) | 1 | 1 |
| refactor | 1 | 1 | 0 | 25,000 | 0 | 25,000 | 25,000 | — | 1 (1) | 0 | 0 |
| test | 3 | 3 | 2 | 328,833 | 404,172 | 733,005 | 65,000 | 202,086 | 1 (3) | 0 | 0 |
| ci | 1 | 0 | 1 | 0 | 66,769 | 66,769 | — | 66,769 | 1 (1) | 0 | 1 |
| chore | 12 | 5 | 4 | 599,557 | 628,165 | 1,227,722 | 70,000 | 92,632 | 4 (6) | 0 | 1 |
| **v0.5.0 total** | 54 | 32 | 29 | 11,117,695 | 19,395,830 | 30,513,525 | 199,917 | 524,812 | 5 (38) | 12 | 84 |

### v0.6.0: per-bead table

| Bead | Type | Scope | Tier/effort | tokens_impl | tokens_qa | Total | PRs | Rounds | Chain | Mediums by round | Lows (labels) | qa/round | Outcome (heuristic) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `61pv` | test | design | sonnet/high | ~587,434 | 1,098,822 | ~1,686,256 | #129 | 2 | #129 approx {1,2} | r1:1 r2:2 | 2 | 549,411 | human (sensitive path) |
| `np1i` | fix | process | sonnet/high | 423,011 | 1,200,037 | 1,623,048 | #133 | 4 | #133 approx {1,2,3,4} | r1:? r2:3 r3:? r4:? | 4 | 300,009 | human (sensitive path) |
| `nvg0` | chore | process | sonnet/high | 792,562 | 741,985 | 1,534,547 | #109, #113 | 6 | #109 approx {1,2,3,4,5,6}; #113 approx | r1:? r2:? r3:1 r4:3 r5:1 r6:1 | 5 | 123,664 | cap → human |
| `ff2a` | fix | upload | sonnet/high | 594,060 | 805,441 | 1,399,501 | #112 | 4 | #112 approx {1,2,3,4} | r1:? r2:? r3:? | 2 | 201,360 | human (sensitive path) |
| `qqnt.2` | refactor | design | sonnet/high | ~885,721 | 507,257 | ~1,392,978 | #122 | 4 | #122 approx {1,2,3,4} | r1:2 r2:1 | 14 | 126,814 | human (sensitive path) |
| `qnq9.3` | feat | rights | opus/xhigh | 746,942 | 626,562 | 1,373,504 | #157, #168 | 6 | #157 approx {1,2,3}; #168 approx {1,2,3} | r2:? | 12 | 104,427 | cap → human |
| `5gca` | fix | process | sonnet/xhigh | ~563,021 | 652,856 | ~1,215,877 | #115 | 4 | #115 approx {1,2,3,4} | r1:? r3:1 | 1 | 163,214 | human (sensitive path) |
| `ze1o` | chore | storage | sonnet/high | ~427,778 | 777,577 | ~1,205,355 | #116 | 3 | #116 approx {1,2,3} | r1:1 r2:1 | 4 | 259,192 | human (sensitive path) |
| `w7wc` | fix | db | opus/xhigh | ~310,300 | 825,608 | ~1,135,908 | #117 | 2 | #117 approx {1,2} | r1:1 | 7 | 412,804 | human (sensitive path) |
| `mqh8` | feat | rights | sonnet/high | 799,174 | 260,416 | 1,059,590 | #174 | 2 | #174 approx {1,2} | 0 | 2 | 130,208 | human (sensitive path) |
| `qqnt.4` | feat | design | sonnet/high | 750,830 | 249,220 | 1,000,050 | #173 | 2 | #173 approx {1,2} | 0 | 1 | 124,610 | human (sensitive path) |
| `hvaf` | fix | process | sonnet/high | 530,581 | 451,154 | 981,735 | #143, #152 | 3 | #143 approx {1,2}; #152 approx {1} | r1:? | 0 | 150,385 | human (sensitive path) |
| `oejb` | refactor | lib | sonnet/high | ~299,000 | 663,731 | ~962,731 | #128 | 2 | #128 approx {1,2} | 0 | 1 | 331,866 | human (sensitive path) |
| `ymp4` | fix | tooling | sonnet/medium | ~126,200 | 830,973 | ~957,173 | #139 | 2 | #139 approx {1,2} | 0 | 4 | 415,487 | auto-merged |
| `nf9l` | fix | legal | sonnet/medium | 264,542 | 686,464 | 951,006 | #140 | 2 | #140 approx {1,2} | 0 | 0 | 343,232 | human (sensitive path) |
| `qnq9.12` | feat | seo | sonnet/xhigh | 643,368 | 259,420 | 902,788 | #144 | 3 | #144 approx {1,2,3} | r1:1 r2:1 | 2 | 86,473 | human (sensitive path) |
| `bn94` | feat | process | sonnet/high | 576,251 | 295,651 | 871,902 | #154 | 3 | #154 approx {1,2,3} | r1:? | 2 | 98,550 | human (sensitive path) |
| `qnq9.2.2` | feat | disclosure | sonnet/high | 551,749 | 317,129 | 868,878 | #183 | 2 | #183 approx {1,2} | r1:? | 0 | 158,565 | human (sensitive path) |
| `dzz` | fix | gallery | sonnet/high | 329,457 | 516,075 | 845,532 | #146 | 1 | #146 approx {1} | 0 | 0 | 516,075 | human (sensitive path) |
| `qnq9.2.1` | feat | disclosure | opus/xhigh | 470,448 | 372,255 | 842,703 | #176 | 3 | #176 approx {1,2,3} | r1:1 r3:1 | 8 | 124,085 | human (sensitive path) |
| `z1nh` | fix | design | sonnet/low | 492,857 | 314,018 | 806,875 | #182 | 4 | #182 approx {1,2,3,4} | r1:1 r2:1 r3:1 | 1 | 78,505 | human (sensitive path) |
| `e0jv` | feat | disclosure | sonnet/high | 577,681 | 192,334 | 770,015 | #162 | 1 | #162 approx {1} | 0 | 0 | 192,334 | human (sensitive path) |
| `qqnt.3` | feat | design | sonnet/high | 503,418 | 258,955 | 762,373 | #171 | 2 | #171 approx {1,2} | r1:? | 0 | 129,478 | human (sensitive path) |
| `9faa` | test | process | haiku/low | 502,685 | 242,642 | 745,327 | #163 | 2 | #163 approx {1,2} | r1:? | 0 | 121,321 | human (sensitive path) |
| `98rb` | fix | storage | opus/xhigh | 399,150 | 330,136 | 729,286 | #156 | 4 | #156 approx {1,2,3,4} | r1:1 r2:1 | 7 | 82,534 | human (sensitive path) |
| `u25s` | docs | process | sonnet/medium | 238,429 | 479,651 | 718,080 | #142 | 3 | #142 approx {1,2,3} | r1:1 r2:1 | 4 | 159,884 | human (sensitive path) |
| `qqnt.1` | feat | design | sonnet/high | ~513,317 | 202,439 | ~715,756 | #114 | 2 | #114 approx {1,2} | r1:? | 0 | 101,220 | human (sensitive path) |
| `xxy2` | fix | tooling | sonnet/high | 339,506 | 369,811 | 709,317 | #135 | 3 | #135 approx {1,2,3} | 0 | 10 | 123,270 | human (sensitive path) |
| `cr2h` | fix | process | sonnet/medium | 413,472 | 289,482 | 702,954 | #155 | 2 | #155 approx {1,2} | 0 | 0 | 144,741 | human (sensitive path) |
| `8hsf` | fix | upload | opus/high | 293,398 | 375,208 | 668,606 | #158 | 5 | #158 approx {1,2,3,4,5} | r4:? | 21 | 75,042 | human (sensitive path) |
| `qnq9.1` | feat | disclosure | opus/xhigh | 368,382 | 296,225 | 664,607 | #147 | 3 | #147 approx {1,2,3} | 0 | 7 | 98,742 | human (sensitive path) |
| `z3lo` | chore | process | sonnet/xhigh | ~200,000 | 448,362 | ~648,362 | #125 | 4 | #125 approx {1,2,3,4} | 0 | 9 | 112,091 | human (sensitive path) |
| `ix0s` | fix | process | sonnet/medium | 394,664 | 233,744 | 628,408 | #165 | 2 | #165 approx {1,2} | r1:? | 0 | 116,872 | human (sensitive path) |
| `177y` | fix | privacy | sonnet/high | ~293,000 | 334,354 | ~627,354 | #111 | 3 | #111 approx {1,2,3} | r1:? | 0 | 111,451 | human (sensitive path) |
| `qn3` | feat | rights | opus/xhigh | 334,914 | 289,208 | 624,122 | #145 | 3 | #145 approx {1,2,3} | 0 | 5 | 96,403 | human (sensitive path) |
| `euqi` | ci | process | sonnet/high | ~258,500 | 344,857 | ~603,357 | #107 | 3 | #107 approx {1,2,3} | r1:? | 0 | 114,952 | human (sensitive path) |
| `qudv` | test | admin | sonnet/high | 174,662 | 423,277 | 597,939 | #132 | 2 | #132 approx {1,2} | 0 | 3 | 211,639 | human (sensitive path) |
| `qqnt.5` | feat | design | sonnet/high | 378,778 | 215,308 | 594,086 | #177 | 1 | #177 approx {1} | 0 | 0 | 215,308 | human (sensitive path) |
| `0p5s` | test | auth | sonnet/medium | ~222,000 | 354,490 | ~576,490 | #138 | 4 | #138 approx {1,2,3,4} | 0 | 7 | 88,623 | human (sensitive path) |
| `96eb` | docs | privacy | haiku/low | 105,359 | ~470,587 | ~575,946 | #119 | 1 | #119 approx {1} | 0 | 0 | ~470,587 | human (sensitive path) |
| `qnq9.15` | refactor | privacy | sonnet/medium | 358,845 | 203,695 | 562,540 | #164 | 1 | #164 approx {1} | 0 | 0 | 203,695 | human (sensitive path) |
| `qnq9.16` | refactor | portfolio | sonnet/medium | 365,492 | 193,385 | 558,877 | #166 | 1 | #166 approx {1} | 0 | 7 | 193,385 | human (sensitive path) |
| `qz1u` | fix | upload | sonnet/high | 316,800 | 200,082 | 516,882 | #130 | 1 | #130 approx {1} | 0 | 0 | 200,082 | human (sensitive path) |
| `0sdf` | test | design | sonnet/high | 336,136 | 174,207 | 510,343 | #179 | 1 | #179 approx {1} | 0 | 0 | 174,207 | human (sensitive path) |
| `cky9` | ci | process | sonnet/medium | 284,869 | 217,344 | 502,213 | #172 | 2 | #172 approx {1,2} | 0 | 3 | 108,672 | human (sensitive path) |
| `dvb` | fix | upload | opus/xhigh | 268,168 | 223,649 | 491,817 | #149 | 1 | #149 approx {1} | 0 | 1 | 223,649 | human (sensitive path) |
| `h2yd` | fix | db | sonnet/medium | 305,132 | 179,343 | 484,475 | #160 | 1 | #160 approx {1} | 0 | 0 | 179,343 | human (sensitive path) |
| `ei5c` | fix | design | sonnet/high | 323,726 | 156,083 | 479,809 | #175 | 1 | #175 approx {1} | 0 | 0 | 156,083 | human (sensitive path) |
| `oavb` | fix | design | sonnet/high | 283,118 | 195,205 | 478,323 | #170 | 1 | #170 approx {1} | 0 | 0 | 195,205 | human (sensitive path) |
| `wzgw` | chore | process | fable/xhigh | 477,025 | — | 477,025 | #105 | — | #105 approx | 0 | 0 | — | human |
| `lju` | feat | sharing | sonnet/high | 278,191 | 192,899 | 471,090 | #180 | 2 | #180 approx {1,2} | 0 | 0 | 96,450 | human (sensitive path) |
| `qlfo` | refactor | auth | sonnet/medium | 256,938 | 191,140 | 448,078 | #150 | 1 | #150 approx {1} | 0 | 0 | 191,140 | human (sensitive path) |
| `gkj` | fix | rights | sonnet/high | 235,415 | 200,432 | 435,847 | #153 | 2 | #153 approx {1,2} | 0 | 1 | 100,216 | human (sensitive path) |
| `apsq` | docs | process | fable/xhigh | ~412,639 | — | ~412,639 | #104 | — | #104 approx | 0 | 0 | — | human |
| `dj4i` | refactor | gallery | sonnet/high | 212,842 | 182,181 | 395,023 | #134 | 1 | #134 approx {1} | 0 | 0 | 182,181 | human (sensitive path) |
| `0xw` | chore | process | sonnet/medium | 147,197 | 236,078 | 383,275 | #131 | 2 | #131 approx {1,2} | 0 | 2 | 118,039 | human (sensitive path) |
| `c70s` | fix | process | sonnet/high | 193,005 | 183,007 | 376,012 | #108 | 1 | #108 approx {1} | 0 | 0 | 183,007 | human (sensitive path) |
| `o312` | fix | design | sonnet/medium | 188,078 | 139,880 | 327,958 | #169 | 1 | #169 approx {1} | 0 | 0 | 139,880 | human (sensitive path) |
| `aigs` | fix | process | sonnet/low | 162,645 | 146,175 | 308,820 | #161 | 1 | #161 approx {1} | 0 | 0 | 146,175 | human (sensitive path) |
| `mj50` | docs | privacy | sonnet/medium | 136,304 | 161,334 | 297,638 | #167 | 1 | #167 approx {1} | 0 | 0 | 161,334 | human (sensitive path) |
| `i72n` | fix | gallery | sonnet/high | ~137,700 | 139,153 | ~276,853 | #124 | 1 | #124 approx {1} | 0 | 0 | 139,153 | human (sensitive path) |
| `yvbi` | docs | process | haiku/low | 137,443 | 139,063 | 276,506 | #151 | 3 | #151 approx {1,2,3} | r1:? | 1 | 46,354 | human (sensitive path) |
| `qqnt` | feat | design | sonnet/high | 157,164 | 106,439 | 263,603 | #181 | 1 | #181 approx {1} | 0 | 0 | 106,439 | human (sensitive path) |
| `6wkd` | test | design | sonnet/low | 141,672 | 114,553 | 256,225 | #178 | 1 | #178 approx {1} | 0 | 0 | 114,553 | human (sensitive path) |
| `a4ue` | docs | process | haiku/low | 103,412 | 137,381 | 240,793 | #159 | 1 | #159 approx {1} | 0 | 1 | 137,381 | human (sensitive path) |
| `6hmh` | ci | process | sonnet/medium | 108,941 | 127,766 | 236,707 | #141 | 1 | #141 approx {1} | r1:? | 0 | 127,766 | human (sensitive path) |
| `3wcd` | chore | process | sonnet/high | ~111,800 | 124,752 | ~236,552 | #121 | 1 | #121 approx {1} | r1:121 | 0 | 124,752 | human (sensitive path) |
| `33hi` | ci | process | sonnet/high | ~72,800 | 119,605 | ~192,405 | #110 | 1 | #110 approx {1} | 0 | 0 | 119,605 | human (sensitive path) |
| `0cdw` | docs | auth | sonnet/medium | ~60,000 | 100,278 | ~160,278 | #118 | 1 | #118 approx {1} | 0 | 0 | 100,278 | human (sensitive path) |
| `quxl` | docs | design | haiku/low | 90,558 | 67,014 | 157,572 | #148 | 1 | #148 approx {1} | 0 | 0 | 67,014 | human (sensitive path) |
| `0an4` | ci | process | fable/high | ~30,000 | — | ~30,000 | #127 | — | #127 approx | 0 | 0 | — | human |
| `z3j1` | chore | process | fable/low | ~25,000 | — | ~25,000 | #136 | — | #136 approx | 0 | 0 | — | human |
| `t7oh` | docs | process | fable/high | ~20,000 | — | ~20,000 | #106 | — | #106 approx | 0 | 0 | — | human |
| `sxwb` | ci | process | fable/low | ~15,000 | — | ~15,000 | #137 | — | #137 approx | 0 | 0 | — | human |
| `qnq9.2` | feat | disclosure | opus/xhigh | 0 | 0 | 0 | #176, #183 | 5 | #176 approx {1,2,3}; #183 approx {1,2} | r1:1 r3:1 r1:? | 8 | 0 | human (sensitive path) |
| `6uxr` | test | design | sonnet/high | 0 | 0 | 0 | #179 | 1 | #179 approx {1} | 0 | 0 | 0 | human (sensitive path) |
| `p4jw` | fix | process | sonnet/medium | — | — | — | #155 | 2 | #155 approx {1,2} | 0 | 0 | — | human (sensitive path) |
| `lasi` | fix | process | sonnet/medium | — | — | — | #155 | 2 | #155 approx {1,2} | 0 | 0 | — | human (sensitive path) |
| `ufdx` | fix | upload | — | — | — | — | #158 | 5 | #158 approx {1,2,3,4,5} | r4:? | 21 | — | human (sensitive path) |
| `bq1k` | fix | storage | sonnet/high | — | — | — | #156 | 4 | #156 approx {1,2,3,4} | r1:1 r2:1 | 7 | — | human (sensitive path) |
| `5whs` | fix | process | — | — | — | — | #163 | 2 | #163 approx {1,2} | r1:? | 0 | — | human (sensitive path) |
| `1b88` | chore | process | — | — | — | — | #158 | 5 | #158 approx {1,2,3,4,5} | r4:? | 21 | — | human (sensitive path) |
| `g6n6` | chore | process | — | — | — | — | #158 | 5 | #158 approx {1,2,3,4,5} | r4:? | 21 | — | human (sensitive path) |
| `9v2u` | chore | process | — | — | — | — | #157 | 3 | #157 approx {1,2,3} | 0 | 10 | — | auto-merged |
| `f6w3` | chore | process | sonnet/high | — | — | — | #108 | 1 | #108 approx {1} | 0 | 0 | — | human (sensitive path) |

### v0.6.0: totals and medians per bead type

| Group | Beads | with impl | with qa | impl total | qa total | Total | impl median | qa median | Rounds median (n) | At cap | Mediums stated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| feat | 16 | 16 | 16 | 7,650,607 | 4,134,460 | 11,785,067 | 508,368 | 259,188 | 2 (16) | 1 | 4 |
| fix | 30 | 25 | 25 | 8,181,006 | 9,978,370 | 18,159,376 | 310,300 | 314,018 | 2 (30) | 0 | 10 |
| docs | 9 | 9 | 7 | 1,304,144 | 1,555,308 | 2,859,452 | 105,359 | 139,063 | 1 (7) | 0 | 2 |
| refactor | 6 | 6 | 6 | 2,378,838 | 1,941,389 | 4,320,227 | 328,923 | 198,540 | 1 (6) | 0 | 3 |
| test | 7 | 7 | 7 | 1,964,589 | 2,407,991 | 4,372,580 | 222,000 | 242,642 | 2 (7) | 0 | 3 |
| ci | 6 | 6 | 4 | 770,110 | 809,572 | 1,579,682 | 90,871 | 172,555 | 2 (4) | 0 | 0 |
| chore | 11 | 7 | 5 | 2,181,362 | 2,328,754 | 4,510,116 | 200,000 | 448,362 | 3 (9) | 1 | 129 |
| **v0.6.0 total** | 85 | 76 | 70 | 24,430,656 | 23,155,844 | 47,586,500 | 296,199 | 245,931 | 2 (79) | 2 | 151 |

### Side by side

| Measure | v0.4.0 | v0.5.0 | v0.6.0 |
| --- | --- | --- | --- |
| Beads in the CHANGELOG section | 38 | 54 | 85 |
| Beads with any token figure | 27 (71%) | 40 (74%) | 76 (89%) |
| Beads with tokens_impl / tokens_qa | 27 / 16 | 32 / 29 | 76 / 70 |
| tokens_impl total (lower bound) | 16,627,265 | 11,117,695 | 24,430,656 |
| tokens_qa total (lower bound) | 4,976,131 | 19,395,830 | 23,155,844 |
| Grand total (lower bound) | 21,603,396 | 30,513,525 | 47,586,500 |
| tokens_impl median (beads with a figure) | 523,716 | 199,917 | 296,199 |
| tokens_qa median (beads with a figure) | 316,261 | 524,812 | 245,931 |
| Review share of recorded cost | 23% | 64% | 49% |
| Rounds median (beads with a count) | 5 (n=19) | 5 (n=38) | 2 (n=79) |
| Beads whose PR reached the cap (≥6 rounds) | 5 | 12 | 2 |
| Mediums stated in verdicts (marker PRs only, each PR once) | 2 | 84 | 151 |
| Rounds with no stated severity | 4 | 4 | 27 |
| Figures marked ~ (impl / qa) | 12 / 4 | 14 / 2 | 21 / 1 |

### v0.4.0: model tier performance

| Tier | Beads | with rounds | Passed in ≤2 rounds | Reached cap (≥6) | Rounds median | qa total | qa median | impl total | impl median | Mediums stated | qa/round median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | 4 | 1 | 1 (100%) | 0 (0%) | 2 | 70,644 | 70,644 | 101,597 | 37,124 | 0 | 35,322 |
| sonnet | 15 | 5 | 0 (0%) | 2 (40%) | 5 | 1,408,542 | 368,723 | 6,579,585 | 760,431 | 0 | 53,682 |
| opus | 14 | 10 | 1 (10%) | 2 (20%) | 5 | 3,101,072 | 362,122 | 7,893,005 | 561,941 | 2 | 68,909 |
| fable | 3 | 1 | 0 (0%) | 1 (100%) | 6 | 193,870 | 193,870 | 341,048 | 170,524 | 0 | 32,312 |
| (none) | 2 | 2 | 0 (0%) | 0 (0%) | 5 | 202,003 | 202,003 | 1,712,030 | 856,015 | 0 | 50,501 |

### v0.5.0: model tier performance

| Tier | Beads | with rounds | Passed in ≤2 rounds | Reached cap (≥6) | Rounds median | qa total | qa median | impl total | impl median | Mediums stated | qa/round median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | 10 | 7 | 4 (57%) | 0 (0%) | 2 | 1,053,588 | 124,174 | 751,972 | 25,000 | 8 | 50,458 |
| sonnet | 27 | 21 | 7 (33%) | 7 (33%) | 5 | 11,554,341 | 533,221 | 8,084,231 | 204,404 | 51 | 105,733 |
| opus | 9 | 6 | 0 (0%) | 3 (50%) | 6 | 4,541,891 | 982,017 | 2,025,492 | 450,000 | 27 | 163,670 |
| fable | 5 | 2 | 1 (50%) | 1 (50%) | 4 | 606,688 | 303,344 | 6,000 | 6,000 | 1 | 84,672 |
| (none) | 3 | 2 | 1 (50%) | 1 (50%) | 4 | 1,639,322 | 819,661 | 250,000 | 250,000 | 2 | 164,431 |

### v0.6.0: model tier performance

| Tier | Beads | with rounds | Passed in ≤2 rounds | Reached cap (≥6) | Rounds median | qa total | qa median | impl total | impl median | Mediums stated | qa/round median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | 5 | 5 | 4 (80%) | 0 (0%) | 1 | 1,056,687 | 139,063 | 939,457 | 105,359 | 0 | 121,321 |
| sonnet | 60 | 60 | 43 (72%) | 1 (2%) | 2 | 18,760,306 | 234,911 | 19,319,833 | 302,066 | 148 | 142,311 |
| opus | 9 | 9 | 2 (22%) | 1 (11%) | 3 | 3,338,851 | 330,136 | 3,191,702 | 334,914 | 7 | 98,742 |
| fable | 6 | 0 | — | — | — | 0 | — | 979,664 | 27,500 | 0 | — |
| (none) | 5 | 5 | 1 (20%) | 0 (0%) | 5 | 0 | — | 0 | — | 0 | — |

### Both releases: model tier performance

| Tier | Beads | with rounds | Passed in ≤2 rounds | Reached cap (≥6) | Rounds median | qa total | qa median | impl total | impl median | Mediums stated | qa/round median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | 19 | 13 | 9 (69%) | 0 (0%) | 2 | 2,180,919 | 138,222 | 1,793,026 | 58,000 | 8 | 60,707 |
| sonnet | 102 | 86 | 50 (58%) | 10 (12%) | 2 | 31,723,189 | 274,949 | 33,983,649 | 305,132 | 199 | 130,208 |
| opus | 32 | 25 | 3 (12%) | 6 (24%) | 4 | 10,981,814 | 362,122 | 13,110,199 | 450,000 | 36 | 96,403 |
| fable | 14 | 3 | 1 (33%) | 2 (67%) | 6 | 800,558 | 193,870 | 1,326,712 | 30,000 | 1 | 81,876 |
| (none) | 10 | 9 | 2 (22%) | 1 (11%) | 5 | 1,841,325 | 202,003 | 1,962,030 | 250,000 | 2 | 66,769 |

### v0.4.0: five most expensive beads (recorded cost, lower bound)

| Rank | Bead | Type | Tier | Build (tokens_impl) | Review (tokens_qa) | Rounds | Mediums by round | Lows-only tail rounds | Crude qa/round | First-round review (crude) | Tail review (crude) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `jsc` #46 | feat | sonnet/medium | ~2,100,000 | — | 4 | 0 | — | — | — | — |
| 2 | `egp` #45 | fix | opus/xhigh | ~1,600,000 | 362,122 | 4 | 0 | — | ~90,531 | ~90,531 | — |
| 3 | `2yj` #43 | chore | opus/high | ~1,500,000 | ~164,046 | 5 | r1:? r2:? r3:? r4:? r5:2 | 0 | ~32,809 | ~32,809 | ~0 |
| 4 | `t0y` #47 | feat | — | 1,500,000 | — | 5 | 0 | — | — | — | — |
| 5 | `j4j` #39 | fix | sonnet/high | 760,431 | 590,000 | 5 | 0 | — | ~118,000 | ~118,000 | — |

### v0.5.0: five most expensive beads (recorded cost, lower bound)

| Rank | Bead | Type | Tier | Build (tokens_impl) | Review (tokens_qa) | Rounds | Mediums by round | Lows-only tail rounds | Crude qa/round | First-round review (crude) | Tail review (crude) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `jx4` #87 | fix | sonnet/high | 2,008,736 | 498,149 | 6 | r1:1 r2:1 | 4 | ~83,025 | ~83,025 | ~332,099 |
| 2 | `ysub` #95 | fix | opus/high | 536,035 | 1,764,205 | 6 | r1:2 r2:1 r4:3 | 2 | ~294,034 | ~294,034 | ~588,068 |
| 3 | `14k9` #94 | feat | sonnet/high | 880,124 | 1,316,502 | 6 | r1:1 r3:1 r4:1 | 2 | ~219,417 | ~219,417 | ~438,834 |
| 4 | `akv6` #96 | feat | sonnet/high | 771,662 | 1,359,898 | 5 | r1:1 r2:1 r3:1 | 2 | ~271,980 | ~271,980 | ~543,959 |
| 5 | `6dvg` #97 | feat | sonnet/high | 886,369 | ~1,187,182 | 6 | r1:2 r2:1 r3:1 | 3 | ~197,864 | ~197,864 | ~593,591 |

### v0.6.0: five most expensive beads (recorded cost, lower bound)

| Rank | Bead | Type | Tier | Build (tokens_impl) | Review (tokens_qa) | Rounds | Mediums by round | Lows-only tail rounds | Crude qa/round | First-round review (crude) | Tail review (crude) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `61pv` #129 | test | sonnet/high | ~587,434 | 1,098,822 | 2 | r1:1 r2:2 | 0 | ~549,411 | ~549,411 | ~0 |
| 2 | `np1i` #133 | fix | sonnet/high | 423,011 | 1,200,037 | 4 | r1:? r2:3 r3:? r4:? | 2 | ~300,009 | ~300,009 | ~600,019 |
| 3 | `nvg0` #109, #113 | chore | sonnet/high | 792,562 | 741,985 | 6 | r1:? r2:? r3:1 r4:3 r5:1 r6:1 | 0 | ~123,664 | ~123,664 | ~0 |
| 4 | `ff2a` #112 | fix | sonnet/high | 594,060 | 805,441 | 4 | r1:? r2:? r3:? | 4 | ~201,360 | ~201,360 | ~805,441 |
| 5 | `qqnt.2` #122 | refactor | sonnet/high | ~885,721 | 507,257 | 4 | r1:2 r2:1 | 2 | ~126,814 | ~126,814 | ~253,629 |

### Membership cross-check (CHANGELOG section vs git tag range)

- **v0.4.0** (v0.3.0..v0.4.0): offline: git range not checked
- **v0.5.0** (v0.4.0..v0.5.0): offline: git range not checked
- **v0.6.0** (v0.5.0..v0.6.0): offline: git range not checked

### Data gaps

- **v0.4.0**
  - no `tokens_impl` (11): 1yr, i04, r7t, 720, cd8, j4d, zdn, 234, 2eh, 4ar, j7h
  - no `tokens_qa` (22): 1yr, 4fx, a2l, jsc, n3c, t0y, i04, naa, r7t, 0hc, 25x, 720, 9rt, cd8, j4d, zdn, 234, 2eh, 4ar, 9ak, j7h, zec
  - no PR in `prs` (9): 4fx, i04, 720, cd8, j4d, zdn, 234, 2eh, 4ar
  - PR but no round count from markers or close reason (10): 1yr, lu7, n3c, naa, r7t, 0hc, 25x, 9rt, j7h, zec
  - round count from the close reason, not markers (18): 0ss, 44q, 71y, a2l, axu, bdh, jsc, r1d, t0y, 05b, egp, j4j, u7g, e86, 9cs, vsm, 97y, 9ak
  - rounds whose verdict states no severity: 2yj (4)
- **v0.5.0**
  - no `tokens_impl` (22): 3wgp, qnq9.7, 1b2c, 1xf, 4il, 52ue, 5xj, drt1, mzr, 205x, 5znw, 7yr7, cbtk, qnq9.4, d4z, 2tc, 5dr6, plp6, qnq9.10, qnq9.8, qnq9.9, ws3
  - no `tokens_qa` (25): gwr, 1xf, 4at, 52ue, 5xj, drt1, ggw, juo, kvb, 205x, 5znw, 7yr7, 7z48, aj2k, cbtk, asg, 000, 2pnq, 2tc, bf7, plp6, qnq9.10, qnq9.8, qnq9.9, ws3
  - no PR in `prs` (9): 205x, 7yr7, 7z48, cbtk, 2pnq, 2tc, qnq9.10, qnq9.8, qnq9.9
  - PR but no round count from markers or close reason (7): 1xf, 5xj, juo, kvb, 5znw, aj2k, bf7
  - round count from the close reason, not markers (0): —
  - markers and close reason disagree: plp6 (markers (close reason says 3))
  - rounds whose verdict states no severity: 4il (1), drt1 (3)
  - marker chains reading `broken` under step 4b: 1551 #81 broken {1,4,5,6}
- **v0.6.0**
  - no `tokens_impl` (9): p4jw, lasi, ufdx, bq1k, 5whs, 1b88, g6n6, 9v2u, f6w3
  - no `tokens_qa` (15): p4jw, lasi, ufdx, bq1k, 5whs, apsq, t7oh, sxwb, 0an4, wzgw, z3j1, 1b88, g6n6, 9v2u, f6w3
  - no PR in `prs` (0): —
  - PR but no round count from markers or close reason (6): apsq, t7oh, sxwb, 0an4, wzgw, z3j1
  - round count from the close reason, not markers (0): —
  - rounds whose verdict states no severity: qnq9.2.2 (1), qnq9.3 (1), qnq9.2 (1), bn94 (1), qqnt.3 (1), qqnt.1 (1), 8hsf (1), hvaf (1), np1i (3), 177y (1), ufdx (1), ix0s (1), 5whs (1), ff2a (3), 5gca (1), yvbi (1), 9faa (1), 6hmh (1), euqi (1), nvg0 (2), 1b88 (1), g6n6 (1)
- **K3:** every `prs` entry on every bead in both releases is `MERGED` (verified by `gh pr view --json state,mergedAt`).

<!-- release-cost-report:generated:end -->
