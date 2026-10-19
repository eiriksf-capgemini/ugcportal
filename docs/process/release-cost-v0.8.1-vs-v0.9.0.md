# Release cost review: v0.8.1 vs v0.9.0

This document is the cost review of the v0.9.0 release (tag `v0.9.0` = `4dd2ef9`), measured on 2026-10-19 by a read-only analyst agent from bead metadata, `scripts/agent-pass-cost.mjs` and `scripts/release-cost-report.mjs`. The analyst report below is committed verbatim; section 7 and the appendix were added afterwards.

The inputs named under "Inputs" live only under `/tmp` on the orchestrator's machine and are not reproducible from the repo. Each measured table below names the command or script that produced it, or the input file it was derived from (a few derived tables cite only the script directory `/tmp/rr-work/`).

---

# v0.9.0 cost review: where the cost went (measurement only)

Analyst report, 2026-10-19, read-only. Tag `v0.9.0` = `4dd2ef9`, read from a detached worktree `/tmp/wt-release-review-v090` (removed at the end). No tracked file edited, no bd write.

**Units.** **ITE** = transcript-priced input-token equivalents (`input + 0.1*cacheRead + 1.25*cacheWrite5m + 2*cacheWrite1h + 5*output`, header of `scripts/agent-pass-cost.mjs`). **Context size** = `tokens_impl`/`tokens_qa`, an agent's last context window, **not cost**. The two are never added together here. ITE is proportional to dollars only within one model priced at the standard ratios. It is **not** a dollar comparison across models, and it overstates `claude-opus-5-5`'s cache reads, which are priced at 5% rather than 10% (CLAUDE.md "Token cost metadata").

## Inputs (all under /tmp)

| File | What | Command |
|---|---|---|
| `/tmp/rr-all.json` | 646 beads | `bd list --all --json --limit 0` (main checkout) |
| `/tmp/rr-passes.json` | 3,233 passes of 2,090 subagent transcripts | `node scripts/agent-pass-cost.mjs --json /tmp/rr-passes.json` (worktree). stderr reach: `14 sessions with subagents, 2090 agent files, 2090 parsed, 0 skipped unreadable, 0 malformed lines skipped, 0 assistant entries with missing/invalid usage, 3233 passes` |
| `/tmp/rr-report.md`, `/tmp/rr-report.json`, `/tmp/rr-cache/` | reference report | `node scripts/release-cost-report.mjs --releases v0.7.0,v0.8.0,v0.8.1,v0.9.0 --changelog CHANGELOG.md --beads /tmp/rr-all.json --cache /tmp/rr-cache --json /tmp/rr-report.json --bd-cwd /Users/eiriksf/code/ugcportal` (exit 0, K3: every `prs` entry MERGED) |
| `/tmp/rr-analysis.json` | joins: rounds to agents, impl passes, per-bead figures | `node /tmp/rr-work/main.mjs` |
| `/tmp/rr-tables.md`, `/tmp/rr-prs.json` | per-round, per-PR, impl and model tables | `node /tmp/rr-work/tables.mjs` |
| `/tmp/rr-prdiff.txt`, `/tmp/rr-prtouch.txt` | `git diff --shortstat <sq>^ <sq>` per squash commit in `v0.8.1..v0.9.0` (40 commits), and whether each one touches `.claude/` or `CLAUDE.md` | loop in worktree |
| `/tmp/rr-overhead.json`, `/tmp/rr-overhead-all.json` | per-call ITE attribution of reviewer transcripts | `node /tmp/rr-work/overhead.mjs`, `node /tmp/rr-work/run-all.mjs` |
| `/tmp/rr-tagdates.txt` | tag commit dates v0.5.0 to v0.9.0 | `git log -1 --format=%cI <tag>` |

**v0.9.0 membership.** It is the CHANGELOG section on main: **97 beads**. That is the 89 counted in `/tmp/release-size-v0.9.0.md`, plus zoee, itti, ze80, arfp (#324), nexj (#327), and 1j4j, eylm, 1aw4 (#326). The release has 37 PRs (#291-#327). #285 is excluded because it is tw9x's v0.8.1 PR. #289 (ul2j) and #290 (i2q) are in the tag range but have no closed bead, so their cost is **not** in any bead figure below.

**Join coverage (v0.9.0).**
- 107 `tokens_qa_rN_agent` keys give 107 distinct agents. Each one is in `cost_agents_qa` and has a transcript. 107 equals the sum of the highest round marker over the 37 PRs (`rep.prs[n].chain.highest`), so every v0.9.0 review round is joined to its agent.
- Two more QA agents carry no round key: a460a8706c52f2784 (233,517 ITE) and a0893a9b0eb428ca9 (949,191). Both are on rma #302.
- QA ITE recomputed from the transcripts is 85,295,408, which equals the sum of the beads' `cost_ite_qa` exactly.
- Impl ITE from the transcripts of all 114 `cost_agents_impl` agents is 36,628,410, against 36,570,142 on the beads. The gap of 58,268 is all on bq9g: recorded 196,953, transcript now 255,221.

---

## 1. Headline by release

Rounds and PR counts come from `/tmp/rr-report.json` (`prs[n].chain.highest` per distinct PR in the release's beads). Passes come from `tokens_impl_passes`. ITE comes from beads the report reads as ITE (`unit=="ite"`). Context size is the sum over every bead's own `tokens_impl`/`tokens_qa`, with `summed-snapshots` excluded. Script: `/tmp/rr-work/main.mjs`, object `head`.

| Measure | v0.7.0 | v0.8.0 | v0.8.1 | v0.9.0 |
|---|---:|---:|---:|---:|
| Beads (CHANGELOG section) | 68 | 5 | 37 | 97 |
| PRs (distinct `prs`) / with round markers | 59 / 54 | 5 / 4 | 34 / 33 | 37 / 37 |
| Review rounds (sum of highest marker per PR) | 164 | 15 | 106 | 107 |
| Rounds per PR, mean / median | 3.04 / 3 | 3.75 / 3.5 | 3.21 / 3 | 2.89 / 3 |
| PRs merged at round 1 | 10 | 0 | 2 | 7 |
| PRs at round >= 4 / at cap (>= 6) | 17 / 9 | 2 / 0 | 14 / 3 | 18 / 0 |
| Impl passes (`tokens_impl_passes`): sum (beads with it) | 150 (58) | 15 (4) | 104 (31) | 111 (38) |
| **ITE impl** (cost) | 30,018,329 | none | 5,109,404 | **36,570,142** |
| **ITE qa** (cost) | 11,063,233 | none | 20,811,211 | **85,295,408** |
| **ITE total** (cost) | 41,081,562 | none | 25,920,615 | **121,865,550** |
| ITE coverage (beads with ITE / beads) | 1 / 68 | 0 / 5 | 7 / 37 | 38 / 97 (every PR's lead bead plus uwh1, so 100% of PRs; siblings carry none) |
| Review share of ITE | 27% (1 bead) | n/a | 80% (7 beads) | 70% |
| *Context size, NOT cost:* impl (beads with figure) | 19,107,250 (57) | 1,547,355 (4) | 5,786,963 (30) | 9,575,415 (38) |
| *Context size, NOT cost:* qa (beads with figure) | 28,337,872 (47) | 1,671,513 (5) | 9,747,889 (31) | 18,637,682 (37) |
| *Context size, NOT cost:* impl + qa | 47,445,122 | 3,218,868 | 15,534,852 | 28,213,097 |
| *Context size, NOT cost:* qa share | 60% | 52% | 63% | 66% |

**ITE is comparable across these four rows only where coverage is comparable, and it is not.** It covers 1, 0 and 7 beads before v0.9.0, and the whole release in v0.9.0. The bead-level context-size row is the only like-for-like series built from bead metadata, and it is not cost. It also carries a known break: before ugcportal-cii0, `tokens_qa` of a resumed reviewer could be a sum of snapshots, and only `tokens_impl` carries a convention flag.

### 1b. A like-for-like ITE series: every subagent pass, by release window

The transcripts go back to 2026-09-24, so all subagent spend can be priced by the time window between tag commits. A pass is placed in a window by its `startTs`. Role is `agent-pass-cost`'s own classification. Orchestrator sessions are not included. A window is **not** release membership: work straddles tags, and the "other" role includes analysts. Command: a node one-liner over `/tmp/rr-passes.json` and `/tmp/rr-tagdates.txt`.

| Window | Days | Review passes / ITE | Impl passes / ITE | Other ITE | All ITE | Review share of review+impl | Changed lines (`git diff --shortstat`) | All ITE per changed line |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v0.5.0..v0.6.0 | 1.97 | 241 / 230,992,201 | 171 / 465,444,417 | 69,355,335 | 765,791,953 | 33% | 48,609 | 15,754 |
| v0.6.0..v0.7.0 | 7.80 | 173 / 183,024,122 | 157 / 190,357,859 | 20,223,698 | 393,605,679 | 49% | 49,337 | 7,978 |
| v0.7.0..v0.8.0 | 1.09 | 29 / 19,324,002 | 17 / 18,313,456 | 0 | 37,637,458 | 51% | 4,674 | 8,053 |
| v0.8.0..v0.8.1 | 0.40 | 106 / 54,408,884 | 100 / 32,352,919 | 417,020 | 87,178,823 | 63% | 11,326 | 7,697 |
| v0.8.1..v0.9.0 | 2.73 | 134 / 100,748,928 | 139 / 39,409,681 | 2,937,353 | 143,095,962 | **72%** | 19,276 | **7,424** |

Mean per pass in each window, from the same data:

| Window | Review: mean ITE / mean calls / mean ctxEnd | Impl: mean ITE / mean calls / mean ctxEnd |
|---|---|---|
| v0.6.0 | 958,474 / 38 / 197,721 | 2,721,897 / 84 / 313,457 |
| v0.7.0 | 1,057,943 / 54 / 173,513 | 1,212,470 / 54 / 175,451 |
| v0.8.0 | 666,345 / 23 / 268,869 | 1,077,262 / 36 / 269,202 |
| v0.8.1 | 513,291 / 27 / 151,045 | 323,529 / 21 / 105,914 |
| v0.9.0 | 751,858 / 38 / 174,743 | 283,523 / 23 / 81,140 |

Model generations differ across windows. v0.6.0 and v0.7.0 are mostly `sonnet-5`/`opus-5`; `-5-5` models appear from late v0.7.0 on. ITE does not normalise for that.

---

## 2. QA share and per-round cost, v0.9.0

### 2a. Per-round ITE (107 rounds, each priced from its own agent's every pass)

```
n=107  min 114,916 / median 730,674 / mean 786,100 / p90 1,365,561 / max 3,199,605 / sum 84,112,700
calls: min 10 / median 38 / mean 41 / p90 60 / max 92;  wall-clock span of passes: median 8 min, max 141 min
reviewer model: claude-opus-5-5 71 rounds, claude-sonnet-5-5 36 rounds
```

| Round | Rounds | ITE | Median ITE/round | Outcomes |
|---|---:|---:|---:|---|
| r1 | 37 | 23,409,654 | 534,980 | 9 medium+, 21 lows-only, 7 clean |
| r2 | 30 | 21,177,357 | 602,403 | 5 medium+, 16 lows-only, 9 clean |
| r3 | 22 | 23,828,698 | 946,796 | 2 medium+, 17 lows-only, 3 clean |
| r4 | 18 | 15,696,991 | 826,500 | **0 medium+**, 10 lows-only, 8 clean |

Top 10 rounds by ITE:

| # | PR | Lead | Round | ITE | Calls | Min | Model | Outcome | `findings_rN` | PR diff |
|---|---|---|---|---:|---:|---:|---|---|---|---|
| 1 | #301 | hx2 | r3 of 4 | 3,199,605 | 91 | 47 | opus-5-5 | lows-only | `f1:2 f2:0 f3:0 f4:2 med:0 low:2` | +1513/-53 |
| 2 | #297 | 74w.1 | r3 of 4 | 2,495,591 | 92 | 14 | opus-5-5 | lows-only | `f1:4 f2:0 f3:1 f4:3 med:0 low:5` | +1771/-87 |
| 3 | #301 | hx2 | r2 of 4 | 2,296,240 | 49 | 141 | opus-5-5 | lows-only | `f1:1 f2:0 f3:0 f4:1 med:0 low:1` | +1513/-53 |
| 4 | #301 | hx2 | r4 of 4 | 2,030,279 | 81 | 17 | opus-5-5 | clean | `med:0 low:0` | +1513/-53 |
| 5 | #291 | gkax | r3 of 4 | 1,814,081 | 72 | 12 | opus-5-5 | lows-only | `f1:5 f2:0 f3:1 f4:4 med:0 low:5` | +2219/-218 |
| 6 | #303 | 90i5 | r1 of 4 | 1,742,845 | 44 | 68 | opus-5-5 | lows-only | `f1:4 f2:0 f3:0 f4:1 med:0 low:5` | +123/-75 |
| 7 | #298 | 5x8 | r2 of 4 | 1,570,030 | 72 | 11 | opus-5-5 | lows-only | `f1:5 f2:0 f3:0 f4:0 med:0 low:5` | +360/-0 |
| 8 | #297 | 74w.1 | r4 of 4 | 1,479,829 | 60 | 12 | opus-5-5 | lows-only | `f1:1 f2:0 f3:0 f4:1 med:0 low:1` | +1771/-87 |
| 9 | #306 | 2k2q | r3 of 4 | 1,459,359 | 59 | 12 | opus-5-5 | lows-only | `f1:2 f2:0 f3:0 f4:0 med:0 low:2` | +719/-23 |
| 10 | #303 | 90i5 | r2 of 4 | 1,371,881 | 57 | 51 | opus-5-5 | lows-only | `f1:1 f2:0 f3:0 f4:1 med:0 low:1` | +123/-75 |

None of the ten most expensive rounds found a medium.

Outcome source: all 107 rounds were read from the orchestrator-written `findings_rN` keys. 18 of those keys are the literal `clean`, which my parser reads as med 0 / low 0. `release-cost-report.mjs` treats `clean` as malformed and falls back to the verdict prose, which is why it lists 17 beads as "malformed". On three of those rounds the prose parse counts lows the key does not: #310 r2 (2 lows), #313 r2 (4) and #321 r2 (3). The key reading is used here. Under the prose reading those three rounds would move from clean to lows-only, adding 3 rounds and their ITE to the lows-only line below.

### 2b. ITE by round outcome

| Outcome | Rounds | QA ITE | Share of round ITE | Median ITE/round |
|---|---:|---:|---:|---:|
| clean (med 0, low 0) | 27 | 11,318,147 | 13.5% | 321,844 |
| **lows-only** | **64** | **58,329,012** | **69.3%** | 807,650 |
| medium-or-above | 16 | 14,465,541 | 17.2% | 859,766 |
| total with round key | 107 | 84,112,700 | 100% | 730,674 |
| plus rma #302 agents with no round key | 2 | 1,182,708 | | |
| **QA total** | | **85,295,408** | | |

### 2c. Rounds 4+ and the pass-budget-stopped PRs

**Rounds >= 4:** 18 rounds, **15,696,991 ITE** (18.4% of QA ITE). 10 were lows-only and 8 clean; **none found a medium**. Per round:

#291 811,219 (L) · #292 354,388 (C) · #294 285,566 (C) · #295 772,000 (L) · #296 759,372 (C) · #297 1,479,829 (L) · #298 321,844 (C) · #299 994,228 (L) · #300 1,077,077 (L) · #301 2,030,279 (C) · #303 878,024 (L) · #304 693,497 (C) · #305 841,780 (L) · #306 1,066,454 (L) · #316 379,468 (C) · #322 552,622 (C) · #324 1,267,837 (L) · #326 1,131,507 (L)

(L = lows-only, C = clean.)

**Stopped PRs, verified from the notes.** Sweep: every bead's notes, close_reason, description and design matched against `/pass[- ]budget|B2 stop|check-pass-budget|three implementation passes/i`. 646 beads examined; 29 matched among the beads with `released_in=v0.9.0`, and each was read by hand. A stop is confirmed on **12 PRs**:
- #299 lmsi, #300 s4eb, #301 hx2, #302 rma, #303 90i5: "Filed ... under dispatch-bead section 6 (pass-budget STOP)" on 8ii6, omyh, 0fue, rgw7, umox.
- #304 7ex5 and #305 qf9v: "left when that bead hit its pass budget" on 5o8q and zn42.
- #306 2k2q: "PR #306 hit the pass budget" on pm4t.
- #316 uj69 and #322 to7b: "Remainder ... after PR #316/#322 hit the pass budget" on pjah and 4an4.
- #324 zoee: "Pass-budget STOP 2026-10-19 after round 3" on zoee.
- #326 1j4j: "PASS-BUDGET STOP (dispatch-bead section 6): check-pass-budget exit 1 after round 2" on 1j4j, with a fifth pass granted by Eirik.

| | PRs | Rounds | QA ITE | Share of QA ITE |
|---|---:|---:|---:|---:|
| All rounds on the 12 stopped PRs (incl. rma's 2 unkeyed agents) | 12 | 47 | 47,469,568 | **55.7%** |
| of which rounds after round 3 | 11 | 11 | 10,912,773 | 12.8% |
| Outcomes of the 47 rounds | | 35 lows-only, 8 medium+, 4 clean | | |

### 2d. QA ITE per PR against the PR's own diff

Diff = `git diff --shortstat <squash>^ <squash>`. Round string: c = clean, l = lows-only, m = medium+, one letter per round. Full table for all 37 PRs: `/tmp/rr-tables.md`.

Top 10 by QA ITE:

| PR | Lead | Beads | Files | Lines +/- | Rounds | QA ITE | QA ITE / round | Impl ITE | QA ITE / changed line |
|---|---|---:|---:|---|---|---:|---:|---:|---:|
| #301 | hx2 | 3 | 20 | +1513/-53 | 4 (lllc) | 8,448,141 | 2,112,035 | 4,068,442 | 5,395 |
| #297 | 74w.1 | 1 | 28 | +1771/-87 | 4 (mmll) | 5,493,898 | 1,373,475 | 3,119,081 | 2,957 |
| #303 | 90i5 | 4 | 2 | +123/-75 | 4 (llll) | 4,761,033 | 1,190,258 | 1,338,120 | 24,046 |
| #291 | gkax | 1 | 21 | +2219/-218 | 4 (mmll) | 4,630,328 | 1,157,582 | 3,662,089 | 1,900 |
| #302 | rma | 3 | 1 | +264/-0 | 3 (mll) | 4,544,039 | 1,514,680 | 2,679,704 | 17,212 |
| #324 | zoee | 4 | 4 | +371/-28 | 4 (mmml) | 4,426,670 | 1,106,668 | 1,446,267 | 11,094 |
| #306 | 2k2q | 5 | 4 | +719/-23 | 4 (mmll) | 4,339,245 | 1,084,811 | 1,532,970 | 5,848 |
| #322 | to7b | 8 | 4 | +254/-21 | 4 (mllc) | 4,144,802 | 1,036,201 | 1,021,720 | 15,072 |
| #295 | gdi0 | 1 | 8 | +726/-1032 | 4 (llll) | 4,090,543 | 1,022,636 | 759,973 | 2,327 |
| #298 | 5x8 | 1 | 1 | +360/-0 | 4 (lllc) | 3,778,001 | 944,500 | 3,167,089 | 10,494 |

The 10 smallest diffs:

| PR | Lead | Beads | Files | Lines +/- | Rounds | QA ITE | QA ITE / round | Impl ITE | QA ITE / changed line |
|---|---|---:|---:|---|---|---:|---:|---:|---:|
| #318 | bq9g | 1 | 1 | +1/-1 | 1 (c) | 253,436 | 253,436 | 196,953 | 126,718 |
| #319 | vbrb | 1 | 1 | +2/-2 | 1 (c) | 301,334 | 301,334 | 135,731 | 75,334 |
| #325 | p5ep | 1 | 1 | +2/-2 | 1 (c) | 335,688 | 335,688 | 173,446 | 83,922 |
| #327 | nexj | 1 | 1 | +3/-2 | 3 (llc) | 1,699,242 | 566,414 | 282,986 | 339,848 |
| #309 | 33xi | 1 | 2 | +3/-3 | 1 (c) | 307,021 | 307,021 | 182,443 | 51,170 |
| #310 | d6si | 4 | 1 | +3/-3 | 2 (lc) | 581,925 | 290,963 | 360,815 | 96,988 |
| #321 | 6hpv | 1 | 1 | +10/-8 | 2 (lc) | 546,165 | 273,083 | 320,872 | 30,343 |
| #293 | x76d | 1 | 3 | +13/-9 | 2 (lc) | 800,215 | 400,108 | 528,897 | 36,373 |
| #323 | sd96 | 1 | 3 | +16/-14 | 1 (c) | 257,559 | 257,559 | 203,587 | 8,585 |
| #307 | dsp8 | 1 | 1 | +23/-0 | 2 (lc) | 998,315 | 499,158 | 180,293 | 43,405 |

Others named in the brief: #326 1j4j, +693/-0, 4 rounds (mlll), QA 3,437,162, impl 1,139,881. The lows batches #310-#324 are in the full table.

Per-round QA ITE by the PR's diff size:

| Diff lines | PRs | Rounds | Median ITE/round | Mean |
|---|---:|---:|---:|---:|
| 0-10 | 6 | 9 | 330,853 | 386,516 |
| 11-100 | 13 | 32 | 472,445 | 484,923 |
| 101-500 | 9 | 30 | 927,701 | 865,598 |
| > 500 | 9 | 36 | 837,007 | 1,087,460 |

A 1-to-10-line PR's round costs a median 331k ITE. That is 45% of the release's median round (731k) for a diff more than a thousand times smaller.

### 2e. Implementer side

Every pass of the 114 `cost_agents_impl` agents (136 transcript passes) is listed in `/tmp/rr-analysis.json` under `implPasses`.

```
all impl passes:     n=136 min 6,845 / median 149,325 / mean 269,327 / p90 472,159 / max 2,855,204 / sum 36,628,410
first pass per bead: n=38  median 194,059 / mean 400,419 / max 2,855,204 / sum 15,215,934  (42%)
later passes:        n=98  median 122,033 / mean 218,495 / max 1,813,308 / sum 21,412,476  (58%)
```

- `tokens_impl_passes` over the 38 lead beads: sum 111. Distribution: 1 pass 8 beads, 2 passes 8, 3 passes 4, 4 passes 15, 5 passes 3.
- The transcripts count 136 passes against the 111 recorded. A transcript pass is any resumed prompt, and watchdog resumes count; hx2's notes record "stalled three times ... resumed each time".
- Impl ITE by recorded pass count: 1 pass 1,391,294 · 2 passes 3,161,342 · 3 passes 3,630,341 · **4 passes 24,954,341 (15 beads, 68% of impl ITE)** · 5 passes 3,432,824.
- The 5-pass beads are 2k2q (#306, impl 1,532,970), 1j4j (#326, 1,139,881; the first pass was blocked at push by the app's missing Workflows permission, and passes 4-5 were granted by Eirik) and gdi0 (#295, 759,973).

---

## 3. Model mix (v0.9.0 beads' agents)

From the `model` field of the passes. Command: `/tmp/rr-work/tables.mjs`, section R3.

| Role | Model | Passes | Calls | ITE | Share of role ITE | Mean ITE/pass | Median ITE/pass |
|---|---|---:|---:|---:|---:|---:|---:|
| impl | claude-opus-5-5 | 32 | 1,115 | 17,375,334 | 47.4% | 542,979 | 384,911 |
| impl | claude-sonnet-5-5 | 76 | 1,055 | 11,262,155 | 30.7% | 148,186 | 107,468 |
| impl | claude-haiku-4-5 | 26 | 566 | 4,383,430 | 12.0% | 168,593 | 165,924 |
| impl | claude-fable-5-1 | 2 | 80 | 3,607,491 | 9.8% | 1,803,746 | 1,803,746 |
| impl | all | 136 | 2,816 | 36,628,410 | 100% | 269,327 | 149,325 |
| qa | claude-opus-5-5 | 83 | 3,445 | 73,247,840 | **85.9%** | 882,504 | 832,234 |
| qa | claude-sonnet-5-5 | 36 | 986 | 12,047,568 | 14.1% | 334,655 | 302,989 |
| qa | all | 119 | 4,431 | 85,295,408 | 100% | 716,768 | 682,378 |

**Not every reviewer was opus.**
- 71 rounds were `opus-5-5` and 36 were `sonnet-5-5`.
- The sonnet rounds ran on #291-#295, #298 and #309-#325, between 2026-10-17 14:30Z and 2026-10-18 23:52Z. Their outcomes were 16 lows-only and 20 clean, with **0 medium+**.
- The opus rounds produced all 16 medium+ outcomes (48 lows-only, 7 clean).
- On PRs of 100 changed lines or fewer: sonnet rounds median 268,503 ITE and 24 calls (22 rounds); opus rounds median 624,907 ITE and 38 calls (19 rounds).
- This is a measured association, not a causal one. Opus was assigned the larger, riskier and later PRs, so the PR mix is confounded with the model.

Bead tier estimate against the model actually used (lead beads with ITE):

| Bead `model` | Lead beads | Impl passes by model used | Review rounds by model | Impl ITE | QA ITE |
|---|---:|---|---|---:|---:|
| haiku | 13 | haiku 22, sonnet 8 | sonnet 18, opus 5 | 4,407,289 | 8,972,626 |
| sonnet | 19 | sonnet 59, opus 7, haiku 3 | **opus 45**, sonnet 16 | 13,933,478 | 45,089,130 |
| opus | 4 | opus 19, sonnet 5 | opus 15, sonnet 1 | 12,382,582 | 22,911,612 |
| fable | 2 | fable 2, opus 6, sonnet 4, haiku 1 | opus 6, sonnet 1 | 5,846,793 | 8,322,040 |

The bead tier describes the *build*, and the review model was chosen separately. Sonnet-tier beads drew 45 opus review rounds and carry 45.1M of the 85.3M QA ITE (53%).

---

## 4. Fixed overhead per review round (estimate)

**Method.** For each reviewer transcript, every distinct assistant call's usage was walked in order.
- A call's cache-write and input cost is attributed to the content that entered since the previous call. That content is the previous call's output tokens plus its tool results, split across the tool calls by result byte length.
- A call's cache-read cost is spread over all earlier content in proportion to its token size.
- The first call's whole context (system prompt, CLAUDE.md instructions, skill listing, agent definition, brief) is "base prompt".
- A tool call is categorised by its command or path. A `Read` of a persisted tool-results file inherits the category of the command that produced it, because the long skill files are mostly read that way.
- The attribution sums exactly to `agent-pass-cost`'s ITE for every agent (85,295,405 against 85,295,408 across all 109). Script: `/tmp/rr-work/overhead.mjs`.
- "Fixed" here means base prompt + process docs (`.claude/skills`, `.claude/agents`, `CLAUDE.md`, any Skill tool load) + setup (worktree, `npm install`, `prisma generate`, `git fetch`) + suite/gates (vitest, lint, tsc, build) + post/merge/lock.

**Requested sample** (docs-only or tiny PRs), share of the round's ITE:

| Category | #327 r1 | #327 r2 | #327 r3 | #321 r1 | #321 r2 | #323 r1 | #318 r1 | #319 r1 | #325 r1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base prompt (system + brief) | 26% | 18% | 18% | 39% | 33% | 40% | 37% | 34% | 31% |
| process docs (skills, agent def, CLAUDE.md) | 59% | 61% | 60% | 43% | 40% | 34% | 48% | 49% | 44% |
| setup | 2% | 4% | 3% | 2% | 1% | 2% | 1% | 5% | 0% |
| suite/gates | 2% | 1% | 1% | 0% | 4% | 9% | 3% | 3% | 3% |
| post/merge/lock | 1% | 1% | 2% | 3% | 1% | 1% | 3% | 1% | 1% |
| **fixed subtotal** | **90%** | **85%** | **84%** | **87%** | **79%** | **86%** | **92%** | **92%** | **79%** |
| PR/diff/CI/markers | 4% | 8% | 10% | 7% | 16% | 9% | 1% | 6% | 3% |
| read repo files / docs/process (incl. the subject file) / scripts / bd | 5% | 6% | 5% | 6% | 4% | 4% | 6% | 1% | 17% |
| model output (generation + re-read) | 1% | 2% | 2% | 1% | 0% | 0% | 1% | 0% | 1% |
| round ITE | 472,746 | 624,907 | 601,589 | 200,791 | 345,374 | 257,559 | 253,436 | 301,334 | 335,688 |
| calls / model | 25 opus | 34 opus | 32 opus | 18 sonnet | 31 sonnet | 27 sonnet | 24 sonnet | 28 sonnet | 28 sonnet |

**All 109 v0.9.0 reviewer agents** (`/tmp/rr-work/run-all.mjs`):

| Category | ITE | Share |
|---|---:|---:|
| process docs | 33,863,170 | 39.7% |
| base prompt | 14,980,947 | 17.6% |
| read repo files | 13,830,863 | 16.2% |
| PR/diff/CI/markers | 7,707,974 | 9.0% |
| setup | 2,499,360 | 2.9% |
| suite/gates | 2,420,869 | 2.8% |
| repo scripts/checks | 2,354,142 | 2.8% |
| hooks/reminders/other | 2,321,647 | 2.7% |
| bd | 1,825,056 | 2.1% |
| docs/process (incl. subject) | 1,652,636 | 1.9% |
| post/merge/lock | 871,856 | 1.0% |
| model output (gen + re-read) | 966,885 | 1.1% |

- Fixed subtotal: **54.6M of 85.3M (64%)**. Per round, the fixed share was p25 0.63, median 0.76, p75 0.84 (min 0.21, max 0.98). Fixed ITE per round: median 502,496, min 94,127, max 1,281,328.
- PRs whose diff touches `.claude/` or `CLAUDE.md` (#296, #299, #309, #312, #315, #317, #320, #322, #324): reading the skills is partly reading the subject, so "process docs" overstates the overhead there. On the other 28 PRs (82 rounds), fixed = 44.4M of 68.1M = **65%**, with a median per round of 76%.
- **Range to quote: roughly 60-85% of a typical round's ITE is setup and process reading that does not depend on the diff, and about 80-90% on a one-to-twenty-line docs PR.**

**Files read every round** (bytes at the tag, `wc -c`; growth across tags from `git show <tag>:<path> | wc -c`):

| File | v0.7.0 | v0.8.1 | v0.9.0 | Lines at v0.9.0 |
|---|---:|---:|---:|---:|
| `.claude/skills/pr-review-merge/SKILL.md` | 143,585 | 182,154 | **189,067** | 1,177 |
| `.claude/skills/review-standards/SKILL.md` | 32,597 | 39,609 | 42,475 | 351 |
| `.claude/agents/worker-reviewer.md` | 12,869 | 14,921 | 15,980 | 257 |
| `CLAUDE.md` | 16,616 | 24,850 | 24,850 | 401 |
| `bd prime` output (main checkout, today) | | | 91,980 | 509 |

- All 109 reviewer transcripts reference `pr-review-merge/SKILL.md`.
- **0 of 109 ran `bd prime`**, and the reviewer transcripts carry no SessionStart hook attachment. The prime output is therefore not in reviewer context unless a reviewer runs it.
- First-call context (system prompt + instructions + skill listing + agent definition + brief) was 32,644-34,964 tokens, median 33,747, and it is re-read on every call.

**Mechanism, from the weights only (arithmetic, not a measurement).** Content read early is paid once at the cache-write rate and then 0.1x on every later call. At about 4 bytes per token (approximate), pr-review-merge's 189 kB is roughly 47k tokens. Read in full at call 5 of a 40-call round, it costs about 1.25 x 47k + 0.1 x 47k x 35 ≈ 220k ITE. So the overhead scales with the number of calls a round makes, not only with the file size.

---

## 5. Lows against everything else

Groups reuse `/tmp/release-size-v0.9.0.md` section 2.
- **A1** = the batch beads d6si, sxsg, c7q2, cafh, 6c4p, d7fm, to7b and **zoee**, plus their members (now including itti, ze80, arfp).
- **A2** = the review-filed lows outside batches, plus nexj, eylm and 1aw4.
- **1j4j is put in "rest"**: it carries no `severity` and is a `ci` gate feature, not a filed low. Its PR #326 also carries eylm and 1aw4.

Script: `/tmp/rr-work/lows.mjs`.

| Group | Beads | with ITE | ITE impl | ITE qa | ITE total | ctx impl (NOT cost) | ctx qa (NOT cost) |
|---|---:|---:|---:|---:|---:|---:|---:|
| A1 lows batches + members | 43 | 8 | 4,136,135 | 11,738,276 | 15,874,411 | 1,478,816 | 2,973,495 |
| A2 other review-filed lows | 31 | 10 | 3,223,311 | 6,663,585 | 9,886,896 | 981,870 | 2,137,192 |
| **lows total** | **74** | 18 | 7,359,446 | 18,401,861 | **25,761,307 (21%)** | 2,460,686 | 5,110,687 |
| **rest** (gkax 74w.1 7ex5 pm4t y1tn lmsi bawz qf9v 2k2q dsp8 wds4 s4eb 90i5 1j4j gdi0 zu0a bc04 pc7s hx2 5x8 rma 74w uwh1) | 23 | 20 | 29,210,696 | 66,893,547 | **96,104,243 (79%)** | 7,114,729 | 13,526,995 |

- The `severity=low` metadata reading gives 80 beads and 46,501,818 ITE. It includes seven PR leads (7ex5, lmsi, bawz, qf9v, dsp8, s4eb, 90i5) that were filed as lows but shipped as features or fixes on their own PRs. x76d is in A2 without `severity=low`.
- **Rounds by PR content:**
  - **18 PRs** carry only lows (#293, #309-#313, #315-#325, #327): **39 of 107 rounds**, 18,401,861 QA ITE, outcomes 18 clean, 17 lows-only, 4 medium+.
  - 9 PRs (#299-#306, #326) have a non-low lead with filed lows riding along: 35 rounds, 36,373,491 ITE.
  - The remaining 33 rounds are on other PRs.

---

## 6. Cost per shipped line (rough)

`git diff --shortstat` of each tag range:
- v0.6.0..v0.7.0: 47,750 / 1,587
- v0.7.0..v0.8.0: 4,190 / 484
- v0.8.0..v0.8.1: 7,562 / 3,764
- v0.8.1..v0.9.0: 14,346 / 4,930 = 19,276 lines

The 37 release PRs alone come to +12,115 / -4,659 = 16,774. The tag range also holds #289/#290 (2,267 lines, no closed bead) and the release commit.

| Release | Bead ITE per changed line (cost) | Bead context size per changed line (NOT cost) | Window ITE per changed line (cost; all subagents, §1b) |
|---|---:|---:|---:|
| v0.7.0 | n/a (1 bead) | 962 (47.4M / 49,337) | 7,978 |
| v0.8.0 | n/a | 689 (3.2M / 4,674) | 8,053 |
| v0.8.1 | n/a (7 beads) | 1,372 (15.5M / 11,326) | 7,697 |
| v0.9.0 | **6,322** on the tag range; 7,265 on release-PR lines (QA 5,085 + impl 2,180) | 1,464 tag range / 1,682 release-PR lines | 7,424 |

---

## What the figures say (measured statements only)

1. **The total spend did not rise in v0.9.0, but the mix moved to review.**
   - All subagent ITE per changed line was 7,424 in the v0.9.0 window, against 7,697 (v0.8.1), 8,053 (v0.8.0) and 7,978 (v0.7.0) (§1b). It was 15,754 in v0.6.0.
   - Review ITE per changed line rose in each window: 3,710 (v0.7.0) → 4,134 → 4,804 → 5,227 (v0.9.0).
   - Impl ITE per changed line fell: 3,858 → 3,918 → 2,857 → 2,044.
   - Review's share of review+impl ITE went 33% → 49% → 51% → 63% → 72%.
   - The bead-level context-size qa share moved the same way: 52-60% earlier, 66% in v0.9.0.
2. **QA is 70% of v0.9.0's bead ITE** (85.3M of 121.9M). Per round: median 731k ITE, p90 1.37M, max 3.20M.
3. **Lows-only rounds are 69% of round ITE.** That is 64 rounds and 58.3M. Medium-or-above rounds are 17% (16 rounds, 14.5M) and clean rounds 13% (27 rounds, 11.3M). Rounds 4+ cost 15.7M (18% of QA) across 18 rounds and found no medium. None of the ten most expensive rounds found a medium.
4. **The 12 pass-budget-stopped PRs carry 56% of QA ITE** (47 rounds, 47.5M). Their rounds after round 3 cost 10.9M.
5. **Per-round cost has a large floor that does not depend on the diff.**
   - The 1-to-10-line PRs' rounds cost a median 331k ITE. The 101-500-line PRs' cost 928k.
   - Attribution over all 109 reviewers puts about 64% of QA ITE (54.6M) in base prompt + process-document reading + setup + suite + posting. 40% of all QA ITE is process-document reading alone.
   - On one-to-twenty-line docs PRs the fixed share is 79-92%.
   - pr-review-merge/SKILL.md grew from 143.6 kB (v0.7.0) to 189.1 kB (v0.9.0), and every reviewer reads it.
   - #327, a 5-line docs change, took 3 rounds and 1.70M QA ITE, 6x its impl ITE (283k).
6. **Reviewer model.** 86% of QA ITE ran on opus-5-5 (83 passes, mean 883k ITE per pass) and 14% on sonnet-5-5 (36 passes, mean 335k). On ≤100-line PRs, sonnet rounds had a median of 269k ITE and opus rounds 625k. Every medium+ round was an opus round. The PR mix is confounded with the model, and ITE overstates opus-5-5's cache reads relative to dollars.
7. **Impl.** 15 beads at 4 passes carry 68% of impl ITE. Later passes are 58% of impl ITE. The 3 five-pass beads cost 3.4M.
8. **Lows are 76% of beads but 21% of bead ITE** (74 beads, 25.8M). The PRs carrying only lows took 39 of 107 rounds.

## Not measured / caveats

- **Orchestrator sessions are not priced.** All figures are subagent transcripts. Inline orchestrator work, such as nexj's pass 3 per its `cost_note_impl`, carries no agent id and is in no figure.
- **ITE is not dollars across models.** Per-model prices differ, and ITE overstates opus-5-5's and fable-5-1's cache reads (CLAUDE.md). `agent-pass-cost` notes that transcripts under-record output for some models, so the 1% output share in §4 is a lower bound and the ITE figures are lower bounds there.
- **The windows in §1b are not release membership.** Work straddles tags, the windows differ in length (0.4 to 7.8 days), and the model generations differ (`-5` against `-5-5`). Roles come from `agent-pass-cost`'s classification; for example, the fable passes of the review beads rma and 5x8 are classed as review in the window table.
- **Lines changed** is a crude size measure. It counts a lockfile churn (#295 -1,032, #292 -2,903) the same as code.
- **The §4 categories come from regexes** over commands and paths. A command that both reads a skill and does other work is placed in one category. The split of the cache-write between the previous call's output and its tool results assumes all non-output new tokens are tool results, so hook text and reminders are folded in. That is ~2.7%, shown as a separate row only when a call had no tool. "Fixed" is not independent of the diff: a longer review makes more calls and re-reads the same skill text more times.
- **Outcome reading.** `findings_rN` keys were used for all 107 rounds, with `clean` read as zero. Three rounds disagree with the prose parse (§2a). Severity is the reviewer's own and is not re-judged here.
- **Earlier-release context-size figures** may include summed snapshots for resumed reviewers (only `tokens_impl` is flagged). Bead coverage differs per release (§1).
- **Not reproduced:** re-pricing v0.7.0-v0.8.1 per bead from transcripts (agent ids were not recorded on beads then), and per-round wall-clock beyond the pass spans (the 141-minute #301 r2 includes stalls). I also did not judge whether any finding was worth its cost.

## 7. Recommendations for v0.10.0

1. Cut what a reviewer reads: split `.claude/skills/pr-review-merge/SKILL.md` (189 kB at v0.9.0, read by all 109 reviewer agents) into a short operational checklist and a reference opened per step. Basis: section 4 (process docs 39.7% of review ITE; fixed share median 76% per round).
2. From round 2 apply the round-4 rule: a round that finds only lows files them as beads and the PR merges; round 1 stays the any-finding hunt. Basis: sections 2b and 2c (64 lows-only rounds, 58.3M ITE, 69%; every medium found in rounds 1-3, 14 of 16 in rounds 1-2; rounds 4+ 15.7M with no medium; stopped PRs 56% of review cost).
3. Fix trivial lows (a sentence, a commit subject) inline in the same round instead of a fix pass plus a fresh round. Basis: section 2d (PRs of 1-10 lines cost a median 331k per round; #327, five lines, took three rounds and 1.70M).
4. Route the reviewer model by risk: sonnet for docs, process and lows-only PRs, opus for guard, auth, sellability, rights and CI paths, honouring the bead's model tier. Basis: section 3 (71 opus rounds, mean 1.02M ITE per round and 883k per pass over 83 passes, against 36 sonnet rounds at a mean of 335k; the 61 rounds on sonnet-tiered beads, 45 of them opus, carry 45.1M of 85.3M review ITE, 53%; every medium was found by an opus round, on the larger PRs, an association only).
5. Record per-round transcript cost on the bead as `cost_ite_qa_rN` beside `tokens_qa_rN`. Basis: Inputs and section 2a (per-round ITE had to be rebuilt from 2,090 agent files).

## Appendix: owner of every numbered entry

| item | bead id | status-at-filing |
|---|---|---|
| 1 | ugcportal-j13u | open, filed 2026-10-19 |
| 2 | ugcportal-kwxh | open, filed 2026-10-19 |
| 3 | ugcportal-kwxh | open, filed 2026-10-19 |
| 4 | ugcportal-1mhn | open, filed 2026-10-19 |
| 5 | ugcportal-gmzi | open, filed 2026-10-19 |

No bead id cell is empty, so no item reads "unowned".
