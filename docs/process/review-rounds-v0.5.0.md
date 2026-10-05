# Why PRs take six rounds: the v0.5.0 review data, root causes, and what to change before v0.6.0

Bead: `ugcportal-wzgw`. Written 2026-10-05 from the PR comments, review objects and Actions runs of every PR between the `v0.4.0` and `v0.5.0` tags (#51-#103), with #23-#52 (the v0.4.0 cut) as a baseline. Sibling report: `docs/process/release-cost-v0.4.0-vs-v0.5.0.md` (`ugcportal-apsq`) owns the cost tables and model routing; the mechanism-level numbers here (rounds, lows versus mediums per round) are shared with it and not duplicated.

Every claim about what happened on a PR below is traceable to a specific round comment: "`#95` r5" means the comment on PR #95 whose first line is `<!-- ugcportal-review-round: 5 approx -->`. Severities are the ones the reviewer wrote; the four-family labels are the ones the reviewer's sweep line stated; where a comment states neither, the table says "unstated". The one classification that is mine, not the reviewer's, is whether a family-1 low was **new prose written during a fix** or a **sibling left stale by a fix** — that is read from the comment text, and the counts are marked approximate.

## Summary

- **50 PRs merged in the range; 40 carry at least one counted review round. Median 3.5 rounds over those 40; the 11 feature PRs have median 6; 12 of the 40 (30%) reached the six-round cap.** The v0.4.0 cut's beads record a median of 5 review passes (n=17, from their close reasons), so the feature median went *up* after the severity gate shipped — because the gate's lenient band was never reachable (cause 1).
- **In the 10-04/05 batch (#80-#103, 100 rounds, 98 with a stated verdict): 53% of rounds found only lows, 37% found a medium, 10% found nothing and merged.** Nine of the ten zero-finding merges were on PRs of 1-3 rounds; the tenth was `#83` at round 5.
- **The tail is comments.** In #94-#102, rounds 4-6 raised 60 findings: 57 lows and 3 mediums. 35 of the 57 lows (61%) were family 1 (a comment claiming what the code does not do); of those 35, roughly half were sentences written during a fix round and roughly a third were sentences a fix had left stale one file over. In the 10-04 batch (#81-#93) the tail looks different: 85 lows, 10 of them family 1 (12%); the rest were `code-review`'s reuse / simplification / efficiency cleanup items.
- **An exact chain would have saved 20 of the 100 rounds** (14 of 23 PRs, 1 to 2 rounds each) and every overnight wait for a human at the cap — but 5 mediums were found in rounds that would not have run (`#81` r5, `#92` r6 ×3, `#98` r6), all in auth or guard code. The bead's "two to three rounds on nearly every PR" is overstated; "one or two on most, and the latency" is what the data supports.
- **Main went red once in the cut**: 2026-10-05 06:55-08:00Z, three merges in six minutes (`#95`, `#97`, `#98`), each green on its branch and red on `main` against a test `#94` had just added; `#96` restored it. Branch protection is not available on this plan (`403 Upgrade to GitHub Pro`), so the fix is procedural or $4/month.
- **The cause the bead did not name**: the implementers *did* report the four-family sweep and mutation checks in their PR bodies (14 of 14 PR bodies checked mention it), and the reviewer still found a family-1 item at round 1 on 13 of the 14 and a family-3 item on 4. A self-administered sweep without a mechanical list in front of it is weak; `/pre-review` with `scripts/claims-audit.mjs` is the answer this PR implements.
- **Every escalation to Eirik at the cap ended in a merge** (11 of 11), with lows filed and, twice, a medium turned into a follow-up bead (`#92` → `ysub`, `#98` → `qqgi`). The human step changed no outcome; it added between 30 minutes and 7.5 hours of latency per PR.

Verdicts on the bead's three stated causes: **cause 1 confirmed in mechanism, overstated in magnitude, and not sufficient alone** (agents also stamp ` approx` on every marker, so an identity change without a template fix still reads `approx`); **cause 2 confirmed for #94-#102, refuted as "almost all" for #81-#93**; **cause 3 confirmed as the cost structure** (47k-306k `tokens_qa` per round, median ≈180k, comment-only rounds costing the same as code rounds). Details in Part 2.

---

## Part 1. The evidence

### Method

```bash
# PR list, authors, merge times
gh pr list -R eiriksf-capgemini/ugcportal --state all --limit 120 --json number,title,author,state,mergedAt,createdAt,mergedBy
# per PR: issue comments, review submissions, inline comments
gh api --paginate repos/eiriksf-capgemini/ugcportal/issues/<n>/comments | jq -s add
gh api --paginate repos/eiriksf-capgemini/ugcportal/pulls/<n>/reviews   | jq -s add
gh api --paginate repos/eiriksf-capgemini/ugcportal/pulls/<n>/comments  | jq -s add
# round count and chain status: pr-review-merge step 4b's jq, run over the dump as-is
# (me = pr_author = eiriksf-capgemini) and once more with pr_author = someone-else
# CI on main
gh run list -R eiriksf-capgemini/ugcportal --branch main --limit 300 --json conclusion,headSha,createdAt,displayTitle
gh run view <id> --log-failed
# token cost per bead (read-only)
bd show ugcportal-<id> --json | jq .metadata
```

Three facts about the data that shape everything below:

1. **The reviewer and the PR author are one account on every PR** (`eiriksf-capgemini`), so step 4b reads every chain `approx` and the lenient rounds 4-5 row never applied. `gh pr review --approve` is rejected by GitHub on one's own PR ("Can not approve your own pull request" — `#52`, `#68`, `#72` r2, `#76`, `#77`, `#78` r4, `#79` r5 all record the rejection), so there is **no APPROVED review object on any PR in the range**; every merge was `gh pr merge` on the strength of a comment.
2. **From #80 on (2026-10-04) every marker carries the ` approx` suffix** (`<!-- ugcportal-review-round: N approx -->`). The skill reserves that suffix for a bootstrap; the agents stamped it because the chain *was* approx. Consequence, measured by re-running step 4b's command with a different `pr_author`: #51-#79's chains would read `exact` under a bot identity; **#80-#103's would still read `approx`**, because `$mk | any(.a != null)` is true. Item 1 has to fix the template, not only the account.
3. **Two operating modes.** On 09-30 to 10-02 (`#60`, `#61`, `#75`, `#78`, `#79`) the orchestrator ran `code-review`, fixed everything itself in the same round, stamped, and re-ran; and on `#60`, `#61`, `#75` it applied the lenient band at round 4 despite the chain reading `approx` (`#75` r4: "Per the round-4 rule, only medium-or-above blocks"). `#78`'s "4-correction" comment (2026-10-01 15:44Z) is the moment the strict-at-every-round reading took hold; every PR after it followed it. From 10-04 a separate implementer fixed and a reviewer verified. Both modes produced 5-6 rounds on feature PRs.

### Table A — the 10-04/05 batch (#80-#103), the primary dataset

Columns: rounds as step 4b counts them today (and how the same markers would read under a separate reviewer identity); per round, mediums + lows as the reviewer stated them; which rounds found a medium; which found only lows; mediums found by *execution* (a real 500, a real flow, a measurement, fuzzing) rather than reading; how the PR ended; whether `main`'s CI run on the merge commit failed; `tokens_qa` on the bead and per round; median minutes between consecutive markers.

| PR | bead · type · tier | rounds (today / if bot) | per round | M rounds | lows-only rounds | mediums by execution | ended | main after | tokens_qa (/round) | gap |
|---|---|---|---|---|---|---|---|---|---|---|
| #80 | cl4e · test · sonnet | 1 approx / approx | r1 0 | – | – | – | auto-merged, zero findings | green | 62k | – |
| #81 | 1551 · feat · (untagged) | **6 broken** / broken | r1 0M+7L · r2, r3 **unstated (markers never posted)** · r4 0M+7L · r5 1M · r6 0M+4L filed | r5 | r1, r4, r6 | r5 authz bypass via the bootstrap promotion: reasoned, test-confirmed | human (cap + `src/lib/auth.ts`) | green | 1,572,553 (262k) | 55 |
| #82 | e15 · chore · haiku | 3 approx | r1 3L · r2 1L · r3 0 | – | r1, r2 | – | auto | green | 139,548 (47k) | 17 |
| #83 | o7l · feat · haiku | 5 approx | r1 2M+1L · r2 1M · r3 1M+2L · r4 1M · r5 0 | r1-r4 | – | none; r1 and r3 mediums were family-3 tests asserting a local string (read) | auto | green | 768,777 (154k) | 20 |
| #85 | 1b2c · fix · sonnet | 6 approx | r1 2M+5L · r2 3L · r3 5L · r4 1M · r5 2L · r6 0M+7L filed | r1, r4 | r2, r3, r5, r6 | r4 payload loss in a throttled log: two angles, reasoned | human (cap) | green | 1,837,870 (306k) | 29 |
| #86 | ei7 · perf · sonnet | 2 approx | r1 4L (3 family 1) · r2 0 | – | r1 | – | auto | green | 521,004 (260k) | 22 |
| #87 | jx4 · fix · sonnet | 6 approx | r1 1M · r2 1M+4L · r3 3L · r4 2L · r5 5L · r6 0M+7L filed | r1, r2 | r3-r6 | r1 invisible focus (reasoned, WCAG) | human (cap) | green | 498,149 (83k) | 23 |
| #88 | qnq9 research · docs | 2 approx | r1 1L · r2 0 (3 content items filed) | – | r1 | – | auto, on Eirik's instruction | green | – | 9 |
| #89 | qnq9.14 · docs · fable | 1 approx | r1 0 | – | – | – | auto | green | 81,876 | – |
| #90 | qnq9.4 · feat · fable | 6 approx | r1 2L · r2 9L · r3 1M+3L · r4 7L · r5 6L · r6 0M+4L filed | r3 | r1, r2, r4, r5, r6 | r3 bracketed operator value blocks both legal pages: reasoned | human (cap) | green | 524,812 (87k) | 34 |
| #91 | mzr · fix · opus | 6 approx | r1 1M+8L · r2 1M+11L · r3 6L · r4 6L · r5 1L · r6 0M+1L filed | r1, r2 | r3-r6 | none by execution; both mediums by reading the data model | human (cap + `src/lib/auth.ts`) | green | 982,017 (164k) | 25 |
| #92 | 3wgp · feat · sonnet | 6 approx | r1 3M+7L · r2 1M+9L · r3 1M+9L · r4 4M+6L · r5 7L · r6 **3M**+5L | r1-r4, r6 | r5 | r3 and r6 scanner blinding reproduced by the reviewer; r4 `request-body.ts` regex shape found in the real tree | human (cap **with mediums**; merged, `ysub` spun off as #95) | green | 1,749,964 (292k) | 42 |
| #93 | qnq9.7 · feat · sonnet | 6 approx | r1 1M+12L · r2 6L · r3 5L · r4 3M+4L · r5 7L · r6 0M+7L filed | r1, r4 | r2, r3, r5, r6 | none; r1 mailto encoding and r4 ordering/API/migration by reading | human (cap) | green | 528,690 (88k) | 30 |
| #94 | 14k9 · feat · sonnet | 6 approx | r1 1M+4L · r2 4L · r3 1M · r4 1M+9L · r5 10L · r6 5L → Eirik | r1, r3, r4 | r2, r5, r6 | r1 contrast measured with the repo's helper (1.1:1); r4 medium was a **merge conflict with #92** | human (cap; fixed, uncounted verification, merged 06:55Z) | green | 1,316,502 (219k) | 42 |
| #95 | ysub · fix · opus | 6 approx | r1 2M+1L · r2 1M+4L · r3 6L · r4 1M · r5 6L (all family 1) · r6 2L (family 1) → Eirik | r1, r2, r4 | r3, r5, r6 | r1 both by execution (TSX parse of `.ts`, unterminated `/*`); r2 and r4 by `Linter.verify` | human (cap; merged 06:55Z) | **red** (Test) | 1,764,205 (294k) | 29 |
| #96 | akv6 · feat · sonnet | 5 approx | r1 1M+6L · r2 1M+6L · r3 1M+5L · r4 4L (family 1) · r5 1L (stale sibling of the r4 fix) → uncounted verification | r1-r3 | r4, r5 | r3 by a real `next start`; r2 by mutation (no positive-path test) | human (merged 08:00Z after the uncounted verification) | green (restored main) | 1,359,898 (272k) | 24 |
| #97 | 6dvg · feat · sonnet | 6 approx | r1 2M+7L · r2 1M+8L · r3 1M+3L · r4 3L · r5 2L · r6 1L → Eirik | r1-r3 | r4-r6 | r1 text over a near-white shape measured; r2 a **real 500** when `getSession` rejects; r3 contrast token measured | human (cap; merged 06:56Z) | **red** (Test) | 1,187,182 (198k) | 25 |
| #98 | t33p · feat · opus | 6 approx | r1 2M+9L · r2 2M+4L · r3 1M+5L · r4 4L · r5 4L · r6 **1M**+4L → Eirik | r1-r3, r6 | r4, r5 | r1-r3 all five mediums by driving `@auth/core`'s real `handleLoginOrRegister` against a temporary database | human (cap with a medium + `src/lib/auth.ts`; merged 07:01Z, `qqgi` spun off as #100) | **red** (Test) | 1,226,051 (204k) | 27 |
| #99 | alg · docs · fable | 1 approx | r1 0 | – | – | – | auto | green | 325,998 | – |
| #100 | qqgi · test · opus | 3 approx | r1 4L · r2 1L · r3 0 | – | r1, r2 | – | auto | green | 341,725 (114k) | 17 |
| #101 | ig4g · fix · sonnet | 5 approx | r1 3M+12L · r2 2L · r3 3L · r4 5L · r5 5L → Eirik's decision | r1 | r2-r5 | r1 `SQLITE_BUSY` in about a third of e2e runs; r5 shipped-CSS weight measured | human (merge with lows filed, uncounted merge note) | green | 739,016 (148k) | 28 |
| #102 | 8df3 · fix · sonnet | 5 approx | r1 4L · r2 3L · r3 1L · r4 1L · r5 0 | – | r1-r4 | – (the fix itself verified on a real dev server) | auto | green | 537,752 (108k) | 19 |
| #103 | release | 1 approx | r1 0 | – | – | – | auto | green | – | – |

Reading notes on Table A:

- `#81`'s chain is `broken` today and was never noticed: rounds 2 and 3 happened (r4 says "Round-3 findings all fixed") but no marker was posted. Nothing depended on it, because an `approx` chain is already in the strict band and the PR touched `src/lib/auth.ts` so a human merged regardless.
- `#94`'s round 4 was spent on a conflict with `#92`, which had merged under it; a merge conflict is not a defect in the diff. Two "housekeeping" comments on `#94` record a close-and-reopen to re-trigger CI and the deletion of a duplicate round-5 marker posted by a stray review worker (the per-PR lock did not prevent it; the worker never took it).
- `#96` and `#101` ended with an uncounted "scoped verification" / "merge note" comment after Eirik's decision — the behaviour the `7+` row describes, done without the row, because an `approx` chain cannot enter it.
- Gaps between rounds are 12-45 minutes in this batch; a round is review plus fix plus re-review. Comment-only rounds (`#102` r2-r5) took 12-24 minutes and cost the same per round in `tokens_qa` as code rounds.

### Table B — the rest of the v0.5.0 range (#51-#79)

| PR | bead · type | rounds | per round | ended | notes |
|---|---|---|---|---|---|
| #51 | 4il · fix | 1 (label "exact") | r1 clean | human (`.claude/skills/**`) | |
| #52 | release v0.4.0 | 1 | r1 0 | auto | first comment to record the self-approval rejection |
| #53, #55, #57, #59, #63, #64 | 4il, 7yr7, 4il, kvb, 5znw, aj2k | 0 markers | – | human / unreviewed | docs and skill files; `#55`/`#59`/`#63` sensitive paths |
| #54 | e5zf · chore | 1 | r1 0 | auto | |
| #56 | d4z · ci | 1 | r1 1M+1L fixed in-round | human (`.github/workflows/**`) | |
| #58 | bf7 · chore | 0 markers, 1 round | 2 findings fixed | auto | reviewed before the marker rule was followed |
| #60 | 5dr6/plp6/ws3 · chore | 4 (label "exact") | r1 10L · r2 4L · r3 10L · r4 1M+lows | **merged at r4 under the lenient band** | main went **red** on the merge (`fd8cc5d`: three `rights/page.test.tsx` timeouts, a pre-existing flaky test that also failed on 09-28) |
| #61 | drt1 · fix | 4 (label "exact") | r1 7 · r2 10 · r3 6 (severity unstated, all fixed in-round) · r4 2L | merged at r4, lenient band | |
| #62, #67 | 5znw, r3h | 0 markers; inline review only | 2 and 4 inline findings | human / auto | `#67` merged with a wording bug the inline comment named; fixed by `#72` |
| #65 | 4at · fix | ci-stop + 1 | r1 0 | auto | |
| #66 | qmxl · ci | ci-stop + 2 | r1 2L (family 4) · r2 2L plausible | human (`.github/workflows/**`), merged 4 days later | |
| #68, #71, #73, #76, #77 | lykb, ggw, asg, 5g9t, 000 | 1 each | r1 0 | auto | `#77`: `code-review` fork never returned, reviewed by hand |
| #72 | r3h · fix | 2 | r1 1M (family 3, by fixture mutation) · r2 0 | auto | |
| #74 | juo · fix | 0 markers, 1 round | 2 findings (family 1, family 3) fixed | auto | |
| #75 | 0dh · fix | 6 | r1 1L · r2 5L (+1 M filed as out of scope) · r3 1M+4L · r4 1M+4L · r5 2L · r6 5L | **self-merged at r6 under the lenient band on an `approx` chain** | markers 1-4 posted within 42 seconds (retroactive) |
| #78 | gwr · feat | 5 (+ a "4-correction") | r1 4M+5L · r2 3M+3L · r3 4M+6L · r4 3M+7L · r5 1M | merged on zero outstanding | r5: `code-review` fork stalled 600 s, reviewed by hand; the correction comment is where strict-at-every-round began |
| #79 | rw9j · feat | 5 | r1 2M+3L · r2 4M · r3 3M · r4 3M+7L · r5 4M+6L | merged on zero outstanding after in-round fixes | seven WCAG regressions across rounds, all family 4 of one root cause; r5 run from a handoff file after the previous session died |

### Table C — the v0.4.0 baseline (#23-#52)

Markers exist only on `#43` (5, the PR that introduced them). Review-pass counts from the beads' own close reasons (as cited in `harness-cost-controls` §6): `bdh` 4, `lu7` 1, `44q` 5, `97y` 2, `e86` 8, `r1d` 9, `0ss` 7, `u7g` 4, `axu` 4, `05b` 5, `j4j` 5, `vsm` 4, `71y` 6, `2yj` 6, `9cs` 6, `egp` 4, `t0y` 5 — **median 5 (n=17)**, worst 9. Severity per round is not recorded for these except in `2yj`'s notes. Main went red once in that cut too (`11263d9`, `#44`, the same `rights/page.test.tsx` timeout as `#60`).

### Summary statistics (v0.5.0 range)

| Measure | Value | Source |
|---|---|---|
| PRs merged / with ≥1 counted round | 50 / 40 | Tables A, B |
| Median rounds, all reviewed PRs | 3.5 (14 at 1, 4 at 2, 2 at 3, 2 at 4, 6 at 5, 12 at 6) | marker counts |
| Median rounds, feature PRs (n=11: #78 #79 #81 #83 #90 #92 #93 #94 #96 #97 #98) | **6** | marker counts |
| PRs at the cap | 12 of 40 (30%); 7 of 11 features | marker counts |
| Rounds in the 10-04/05 batch | 100 (98 with a stated verdict; `#81` r2-r3 unstated) | Table A |
| Rounds that found only lows | 52 of 98 (**53%**) | Table A |
| Rounds that found a medium | 36 of 98 (37%) | Table A |
| Rounds that found nothing and merged | 10 of 98 (10%); nine on PRs of ≤3 rounds, one at round 5 (`#83`) | Table A |
| Findings at round ≥4, #94-#102 | 60: 57 lows, 3 mediums (`#94` r4 merge conflict, `#95` r4, `#98` r6) | round comments |
| Family-1 share of those 57 lows | 35 (**61%**) | reviewer's sweep lines |
| …of which new prose written in a fix round / stale sibling of a fix / other | ≈17 / ≈11 / ≈7 (my reading of the comment text) | round comments |
| Lows at round ≥4, #81-#93 | 85, of which 10 family 1 (12%); the rest reuse, simplification, efficiency, design, test hygiene | reviewer's sweep lines |
| Round-1 finding count, 10-04/05 batch | median 5 (range 1-15) | Table A |
| Rounds an exact chain would have saved | **20 of 100** (14 PRs; 16 lows-only rounds, 3 medium rounds, 1 clean round) | Part 2 table |
| Escalations to a human at the cap | 11 PRs; 11 merged, 0 reverted; 2 mediums became follow-up beads | Table A |
| Main red after a merge | 1 incident, 65 min, 3 commits (`#95`, `#97`, `#98`); plus `#60` (flaky pre-existing test) | `gh run list --branch main` |
| `tokens_qa` per round | 47k-306k, median ≈180k over the 18 PRs with a figure | bead metadata / marker count |

### The main-red incident, exactly

`gh run list -R eiriksf-capgemini/ugcportal --branch main` for 2026-10-05: `fa0d1c5` (`#94`) success 06:55:10Z; `4c57fd2` (`#95`) **failure** 06:55:49Z; `35800c9` (`#97`) **failure** 06:56:25Z; `2425355` (`#98`) **failure** 07:01:19Z; `d8894aa` (`#96`) success 08:00:14Z. All three failures were the `Test` step of `Lint, test, typecheck, build`:

- `#95`: `site-header.height.test.ts` — "expected exactly one `h-14` utility in `site-header.tsx`, found 4". `#94` added that test at its round 4/5; `#95` had merged main before `#94` landed and its textual merge kept both header shapes.
- `#97` and `#98`: the same `h-14` failure plus `dual-meaning-usage.test.ts` — "New dual-meaning token usage found with no audit entry" for `hero.tsx` `text-ink`. `#97` was green on its branch because the audit baseline it tested against predated `#94`'s merge.
- `#96`'s post-cap verification comment (07:49Z) records "main at 2425355 really fails typecheck … and the audit (hero.tsx text-ink), both green here" and its merge restored main.

All three were green on their own branches. None had merged `main` after `#94` landed at 06:55Z. The PRs were merged by hand in a batch after the overnight escalations; the time between `#94`'s merge and `#95`'s was 40 seconds.

---

## Part 2. Root causes

### Cause 1 (stated): the reviewer shares the author's identity, so every chain is `approx` and the strict rule applies at every round

**Confirmed in mechanism.** Every chain in the range reads `approx` (or `broken`) under step 4b, the round-4+ comments say "blocks only because an approx chain blocks on any finding", and every cap was an escalation. The lenient band was applied only by mistake (`#60`, `#61`, `#75` before the `#78` correction).

**Overstated in magnitude.** Replaying the exact-chain rule over Table A — at round ≥4, a lows-only round files and merges; a round-6 lows-only auto-merges — gives:

| PR | first lows-only round ≥4 | rounds that would not have run | what those rounds found |
|---|---|---|---|
| #81 | r4 | r5, r6 | **r5: a medium** (authz: an unbound allow-list entry promoted to ADMIN through a bare-address match); r6: 4 lows |
| #85 | r5 | r6 | 7 lows |
| #87 | r4 | r5, r6 | 5 lows; 7 lows |
| #90 | r4 | r5, r6 | 6 lows; 4 lows |
| #91 | r4 | r5, r6 | 1 low; 1 low |
| #92 | r5 | r6 | **3 mediums** (scanner blinding of the K6/K2 guards) + 5 lows |
| #93 | r5 | r6 | 7 lows |
| #94 | r5 | r6 | 5 lows |
| #95 | r5 | r6 | 2 lows |
| #96 | r4 | r5 | 1 low |
| #97 | r4 | r5, r6 | 2 lows; 1 low |
| #98 | r4 | r5, r6 | 4 lows; **r6: a medium** (a P2002 race-recovery branch no test reached) |
| #101 | r4 | r5 | 5 lows |
| #102 | r4 | r5 | 0 |
| #82, #83, #86, #88, #100, and the 1-round PRs | – | 0 | – |

**20 of 100 rounds, on 14 of 23 PRs: one round on 8 PRs, two on 6.** Not "two to three rounds on nearly every PR". And not free: the three PRs where the saved rounds held a medium are the three auth/guard PRs (`#81`, `#98` touch `src/lib/auth.ts`; `#92`'s mediums were in the consent guard mechanisms). Those PRs go to a human anyway under the sensitive-path gate, which is an argument for keeping full-depth late rounds exactly there and nowhere else (Part 3, item 3).

**What the identity *did* cost that the round count does not show:** the eleven cap escalations all ended in a merge, with lows filed. Nine were lows-only and would have auto-merged on an exact chain; the two with mediums (`#92`, `#98`) were merged by Eirik with the medium turned into a follow-up bead — the decision a reviewer could not make but a human made identically each time. Latency (round-6 comment to `mergedAt`): `#87`, `#90`, `#93` waited 30-60 minutes and `#85` 3.7 hours; `#94`, `#95`, `#97`, `#98` waited 5-7.5 hours overnight, and were then merged within six minutes of each other, which is the main-red incident.

**Not sufficient alone.** Under a different reviewer identity, #80-#103's markers still read `approx` because of the ` approx` suffix (Part 1, fact 2). The template in step 5 says plain `<N>`; the agents wrote `N approx` because the comment also said "chain approx". Item 1 therefore has two halves: the account, and the stamp.

### Cause 2 (stated): fix rounds add prose that asserts measurements, and each paragraph is new family-1 surface

**Confirmed for #94-#102; refuted as "almost all" for the batch before it.** The 61% figure (35 of 57 tail lows) is for the nine PRs the bead named. The 10-04 batch (`#81`-`#93`) had 85 tail lows, 10 of them family 1; there the rounds were filled with `code-review`'s cleanup angles — `#93` r1 twelve lows of which eleven were reuse/simplification/efficiency, `#90` r2 nine lows of which eight were design and reuse, `#91` r2 eleven lows. Two populations, two remedies: comment discipline (item 4) for the first, and either the lenient band (item 1) or a `/simplify` pass before the PR for the second — the cleanup lows are not defects, and under an exact chain they are exactly what rounds 4-5 file.

Of the 35 family-1 tail lows in #94-#102, my reading of the comments puts ≈17 as new sentences written in a fix round (`#97` r4: two explanations of a motion fix that were each wrong about which media query wins; `#97` r5: `-2px` attributed to `--spacing`; `#102` r1-r2: a dedupe paragraph "measured backwards"; `#98` r5: an adoptability reason that named the wrong join column; `#101` r4: "this round fixed" sentences about files not in the PR), ≈11 as stale siblings of a fix (`#94` r5: two cross-file comments left by the header move; `#95` r6: "three fail-closed exits" in the test after round 5 fixed it in the source; `#96` r5: `legalPageFor`'s doc after round 4 corrected `pages.ts`; `#102` r2-r3: the corrected model in two of five places, then four of five; `#98` r4: `reconcileBootstrapAdmin`'s guard comment after round 1 moved the read), and ≈7 pre-existing or in the PR body. `#102` is the clean case: a one-paragraph fix at round 1, then four comment-only rounds (12-24 minutes, ~108k tokens each) to make five copies of one sentence agree.

### Cause 3 (stated): each round is a fresh agent, worktree, `npm ci` and full re-verification

**Confirmed as the cost structure.** `tokens_qa` per round (the `code-review` subagent only; the orchestrator's verdict assembly and the implementer's fix are not in it): `#87` 83k, `#90` 87k, `#93` 88k, `#102` 108k, `#100` 114k, `#101` 148k, `#83` 154k, `#91` 164k, `#97` 198k, `#98` 204k, `#94` 219k, `#86` 260k, `#81` 262k, `#96` 272k, `#92` 292k, `#95` 294k, `#85` 306k. A round that verified a 37-line comment delta (`#102` r4) cost the same order as a round that drove `@auth/core` (`#98` r2), because the reviewer is spun up fresh and re-verifies the whole PR each time — every round-N+1 comment opens with "Round-N items verified by execution" over the full list. The fork-reviewer failure mode is also on record (`bd memories fork-reviewers-continue-as-orchestrator`: the `#95` r2 fork posted its own marker, messaged the implementer and took locks on `#98` and `#99`), and three verdicts say "assembled from the finder angles because the consolidating reviewer did not report" (`#90` r2, `#91` r1, `#93` r1; `#81` r5 "verdict posted late" for the same reason), plus two `code-review` stalls (`#77`, `#78` r5).

### Causes the bead did not name

4. **The self-administered sweep is weak without a list in front of it.** Every PR body in #85-#102 reports the four-family sweep and mutation checks (`#96`'s body: "found and fixed one before push … every remaining assertion was fixture-mutated by hand"); the reviewer still found a family-1 item at round 1 on 13 of the 14 (all but `#87`) and a family-3 item on 4 (`#85`, `#92`, `#97`, `#101`). The sweep is a reading exercise, and attention is demonstrably not the missing ingredient (`review-standards` §2 says the same of family 3). The fix is mechanical enumeration before the push — item 2.
5. **Round-1 findings a local check would have caught.** Of the round-1 findings in Table A: the family-1 lows (`#86` 3, `#102` 3, `#100` 2, `#101` 7, `#98` 3, `#97` 4, `#96` 2) are claim-shaped sentences `scripts/claims-audit.mjs` enumerates; the family-3 items (`#83` r1 M2, `#92` M2/M3, `#101` M3, `#97`'s `øl` regex) fall to a fixture mutation; `#82`'s foreign hunk and `#91`'s attribution line fall to a `--stat` and a `grep`. The execution mediums (`#97` M1-M2, `#98` M1-M2, `#95` M1-M2, `#101` M1, `#94` M1, `#93` M1) do not fall to anything but running the thing — and those are the rounds that earned their cost.
6. **Concurrent PRs on a moving `main`.** `#94` r4 (a full round), the three red merges, `#96`'s dependency on `#94`'s tagline, `#93`'s coordination with `#90`'s `PRIVACY_PATH`, `#97`'s hero heading versus `#94`'s. Four design PRs touching `app-shell.tsx` and `site.ts` were open at once. Item 5.
7. **Review value by execution is real and late.** The five mediums an exact chain would have skipped were all found by execution or `Linter.verify` on auth/guard code at rounds 5-6; `#98`'s five mediums at rounds 1-3 were all found by driving the real flow. Depth is the thing not to cut; what to cut is re-verifying a comment delta at full depth.
8. **Mechanics that drifted or never fired.** The ` approx` stamp; `#81`'s unposted markers (a `broken` chain nobody saw); the duplicate round-5 stamp on `#94` by a worker that bypassed the lock; zero lock stand-downs in 100 rounds (`grep` over every comment finds the lock mentioned once, `#79` r5 "Lock released"); the bootstrap and `7+` rows never exercised (they cannot be, on `approx`), while their purpose — a post-escalation verification pass — happened three times as an uncounted comment (`#94`, `#96`, `#101`).

---

## Part 3. The five in-scope items

### Item 1 — identity: a reviewer that is not the author, so chains read `exact`

Two ways to get a second identity; both verified against GitHub's documentation on 2026-10-05.

**Option A — a machine user with a token (recommended first step).** GitHub's Terms of Service, section B.3: "A machine account is an Account set up by an individual human who accepts the Terms on behalf of the Account, provides a valid email address, and is responsible for its actions … You may maintain no more than one free machine account in addition to your free Personal Account." Private repositories on GitHub Free allow collaborators, so:

1. Eirik creates the account (say `ugcportal-review-bot`) with a dedicated e-mail, and adds it as a collaborator with **Write** on `eiriksf-capgemini/ugcportal` (Settings → Collaborators); the bot accepts the invitation.
2. Signed in as the bot: Settings → Developer settings → Personal access tokens. A **fine-grained** token is bound to a "Resource owner", which for a personal-account token is the token's own account or an organisation it belongs to — so a collaborator's fine-grained token cannot be scoped to a repository owned by another personal account; use a **classic** token with the `repo` scope (no `workflow`, no `admin:*`), expiry 90 days, and put the renewal date in the bead. If the fine-grained UI does offer `eiriksf-capgemini` as resource owner for the bot, prefer it with Contents: write, Pull requests: write, Issues: write, Metadata: read, Checks: read, Actions: read.
3. Store the token outside the repo: `~/.config/ugcportal/review-bot-token`, mode `600`. Verify: `GH_TOKEN="$(cat ~/.config/ugcportal/review-bot-token)" gh api user --jq .login` prints `ugcportal-review-bot`; `gh pr view <open PR> --json author --jq .author.login` prints `eiriksf-capgemini`. **That pair is K3**, and it is checked before any gate change is relied on.
4. How `pr-review-merge` obtains it: **not** `gh auth switch` — `gh` credentials are global state on the machine, implementer agents push and open PRs as Eirik concurrently, and a switch mid-run flips every agent's identity (the shared-state lesson in `bd memories shared-checkout-is-not-safe-for-agents`, one level up). Per the `gh` manual, `GH_TOKEN` "takes precedence over previously stored credentials" and is per-process. So a three-line wrapper, proposed as `scripts/gh-review.sh`:

   ```sh
   #!/bin/sh
   # pr-review-merge runs every gh command through this, so the review identity is the bot's
   # and never the orchestrator's stored credentials (ugcportal-wzgw, item 1).
   exec env GH_TOKEN="$(cat "${UGCPORTAL_REVIEW_TOKEN_FILE:-$HOME/.config/ugcportal/review-bot-token}")" gh "$@"
   ```

   and in the skill, every `gh ` in steps 1-6 becomes `scripts/gh-review.sh `. This satisfies the skill's own "a value used inside one command block is assigned inside that same block" rule without a shell variable.

**Option B — a GitHub App (the longer-term shape; more skill changes).** Registration: profile → Settings → Developer settings → GitHub Apps → New GitHub App; "GitHub App name" (unique, ≤34 chars), "Homepage URL" (any), deselect the webhook "Active" toggle, "Where can this GitHub App be installed?" → Only on this account; repository permissions, from GitHub's "Permissions required for GitHub Apps": **Pull requests: write** (`POST pulls/{n}/reviews`, including `APPROVE`; `GET pulls/{n}/comments`), **Contents: write** (`PUT pulls/{n}/merge`, `POST git/tags`, `POST git/refs`, `DELETE git/refs/{ref}` — the review lock), **Issues: write** (`POST issues/{n}/comments`), **Checks: read**, **Actions: read**, Metadata read is implicit. Generate a private key and install the app on the repository. Tokens: mint a JWT from the private key, `GET /repos/{owner}/{repo}/installation` for the installation id, `POST /app/installations/{id}/access_tokens` → a token that "will expire after 1 hour"; `gh` does not mint these, so a helper script does, and the review wrapper calls it when the cached token is older than 50 minutes. **Identity under an App**: the skill's own step 4b documents that `GET /user` returns 403 for an installation token and the identity guard exits loudly — correct, and it means step 4b's `me=$(gh api user --jq .login)` must be replaced by a configured login, `<app-slug>[bot]`, which is how the App's comments appear (`user.login`, with `user.type == "Bot"`). Two more filters then need attention: the bootstrap probe's `select(.login == $me and .type != "Bot")` would exclude the App's own comments, and the `7+` evidence probe's `!= "Bot"` is correct as is (it looks for humans). A later maintainer joining is the reason to prefer B over A; today A is a one-afternoon change and B is a skill revision.

**What must change in `pr-review-merge` under Option A** (for Eirik's hand; `.claude/skills/**` is a sensitive path and this PR does not touch that file):

1. **The stamp.** Step 5's templates say `<N>`; add one sentence under them: *"Never write ` approx` on a marker unless this run is the bootstrap in step 4b. The chain's status is derived from identity and history by the counter; writing it into the marker pins the chain to `approx` under any identity."* Measured: with `pr_author` set to another account, #51-#79 read `exact`; #80-#103 read `approx` solely because of the suffix.
2. **Every `gh` through the wrapper**, including `gh pr review --approve` (which now works) and `gh pr merge`. `code-review --comment`'s inline comments are posted by the global skill's own `gh` calls and will carry the orchestrator's identity unless the reviewer agent's process has `GH_TOKEN` set; they are not read by the counter, so the chain is unaffected, but say so in step 6.
3. **In-flight PRs**: existing markers were written by `eiriksf-capgemini`; under the bot they fail `.login != $me` and read `broken` — the skill already documents the chain-reset comment as the remedy. Expect one reset per open PR on the day of the switch.
4. **Step 6 report** gains "reviewer identity: `<login>`; PR author: `<login>`".
5. The team-maintainer bullet in `CLAUDE.md` ("auto-approve and squash-merge") becomes literally true for the first time; no wording change needed.

**K1 measurement plan.** Before: this document, Table A — feature PRs median 6, 7 of 11 at the cap, 12 of 40 reviewed PRs at the cap. After the switch, for the next five feature PRs: run step 4b's command under the bot (it must print `exact`), record rounds, the round at which lows were first filed, and whether the cap was reached; K1 holds if the median is ≤3 and no PR reaches round 6 with only lows outstanding. Record the five rows in `ugcportal-wzgw`'s notes in the same shape as Table A. If the median does not fall, the cause is not identity, and Part 2's causes 2, 4 and 5 are where to look next.

### Item 2 — local pre-review before the PR exists (implemented)

`/.claude/skills/pre-review/SKILL.md` is the skill; `scripts/claims-audit.mjs` (with `scripts/claims-audit.test.mjs`) is the mechanical half of its family-1 step; `scripts/lib/git-diff.mjs` is the git plumbing it shares with `scripts/sweep-candidates.mjs`. Seven steps, each grounded in a finding it would have caught:

| Step | Would have caught | Would not have caught |
|---|---|---|
| 1. Merge `origin/main`, then lint → test → build → typecheck on the merged tree | `#94` r4 (a round on a conflict with `#92`); the 10-05 main-red incident (`#95`, `#97`, `#98` each green alone, red against `#94`'s new test) | anything the suite does not assert |
| 2. The guard suites, named, read on the merged tree | `#97`'s `hero.tsx` `text-ink` with no audit entry; `#95`/`#98`'s `h-14` failure | a guard that does not exist yet (`#79` r2's gate-design gap) |
| 3. Four-family sweep with `sweep-candidates` | `#96`'s decorative `not.toContain` (its body says the pre-push run caught it); `#93` r2's `env.example` sibling | cross-file siblings the enumerator cannot see (`#96` r1's `SITE_DESCRIPTION` versus `#94`) |
| 4. Claims audit (`ABSOLUTE`, `MEASUREMENT`, `TEMPORAL`, `HISTORY`, `REFERENCE not found`) | `#86` r1 (3 of 4 lows), `#102` r1 (3 of 4), `#100` r1-r2 (3 of 5), `#98` r1 (nonexistent file reference; "runs once per sign-in"), `#97` r1 (nonexistent contrast entry), `#101` r1 (7 comment items), `#95` r5 (6 family-1 lows incl. `.mtsx`), `#82` r1 ("remains to be switched") | a wrong claim with none of the trigger words (`#94` r5 "no listeners attached"); the PR body (prose outside the tree) |
| 5. Fixture mutation for every new assertion | `#83` r1 M2 and r3 M1, `#92` r1 M3 (tests asserting a local string); `#97` r1 `øl` regex; `#96` r2 `get-in-touch` needle; `#101` r1 M3; `#72` r1 | a test that mutates the dead layer (`#102` r1) unless the implementer asks which layer holds in production |
| 6. Drive the real flow | `#97` r2 (real 500), `#98` r1-r3 (five mediums through `@auth/core`), `#101` r1 (`SQLITE_BUSY`), `#94` r1 / `#97` r1 / `#97` r3 (measured contrast) — *if* run; this step is bead-specific and the skill says so | – |
| 7. Diff hygiene and the checklist | `#82` r1-r2 (foreign hunk, fix claimed and not done), `#91` r1 (attribution), `#83` r5 (PR type), `#98` r5-r6 (stale PR body) | – |

Round-1 findings it would **not** have caught, by category: every medium found by reading a data model or a library's behaviour (`#91` r1-r2, `#85` r1, `#87` r1-r2, `#93` r1 and r4, `#90` r3, `#83` r1 M1, `#92` r1 M1, `#94` r1 and r3), and every reuse/simplification/efficiency low (`#93` r1 eleven, `#91` r1 six, `#90` r2 eight). The first set is the reviewer's job; the second is `/simplify`'s or the lenient band's.

**Measurement.** Target from the bead: round-1 finding counts halve (batch median 5 → ≤2-3). Record round-1 counts for the next ten PRs whose body carries the pre-review checklist, split by family and by low/medium, against Table A's round-1 column. Secondary: the family-1 share of round-≥4 lows (61% in #94-#102) should fall below a third; if it does not, implementers are not acting on the audit's output and the skill should be made louder, not longer.

### Item 3 — incremental review: one reviewer per PR, resumed on the new head (proposed, not implemented)

**Protocol.**

1. **Spawn, once per PR, at round 1**: `Agent(subagent_type: "general-purpose", model: <the bead's tier, named explicitly — harness-cost-controls §1>, isolation: "worktree", prompt: <brief>)`. Never `fork` (`bd memories fork-reviewers-continue-as-orchestrator`). The brief ends with the hard stop: *"After reporting, do nothing else: post nothing further, spawn nothing, message no agent, take no lock."* The orchestrator writes the returned agent id and the reviewer's worktree path next to the PR number in its own notes (values that cross a step boundary get written down — the skill's rule).
2. **Round 1 runs `pr-review-merge` in full** inside that agent: full `code-review`, the four-family sweep, the claims audit, the guard suites, the real flow where the bead has one. It posts the verdict and the marker itself, under the review identity (item 1). The report back includes the finding list with ids `F1..Fk`, each with "how to verify" (a command, a test name, a request).
3. **Rounds 2..5 are delta rounds**: the implementer pushes; the orchestrator sends `SendMessage(<reviewer id>, "Round N+1 of PR #<n>. New head <sha>; previous head <sha>. Verify F1..Fk by execution on the delta, run the regression smoke (changed test files, the guard suites, the bead's K tests), run the four-family sweep and claims-audit --all-lines over the files the delta touched, post the verdict and marker, report. Hard stop.")`. The reviewer `git fetch`es and checks out `<sha>` in the worktree it already has — `node_modules` and the Prisma client are already there, which is the `npm ci` and `prisma generate` the bead's cause 3 names. It runs `code-review` at full depth again **only** when the delta touches a production file outside the previous round's finding list, or when the PR touches a sensitive path (`src/lib/auth.ts`, the consent/design guards) — the five late-found mediums in Part 2 were all there.
4. **Round 6, the cap, is a full round again** (full `code-review`), whatever the delta — the one re-hunt the data says is worth paying for on an exact chain, and the row where an outstanding medium goes to a human.
5. **Respawn when the reviewer's context is the cost.** `harness-cost-controls` §2: a request at 200-400k context costs about twice one at 100-200k, and 22x above 700k. A delta round adds roughly a review of the delta plus the verification transcript; after three or four resumes a reviewer can be carrying more than a fresh full review would cost. Rule: the reviewer reports its approximate context size with each round; above ~250k the orchestrator spawns a fresh reviewer for the next round with the finding list and the worktree path in the brief, instead of resuming.
6. **Whether a finished agent's worktree survives until the next `SendMessage`** is not something the tool description states (`isolation: "worktree"` is "auto-cleaned if unchanged"). The reviewer must `test -d <worktree>` on resume and fall back to a fresh clone if it is gone; the K2 measurement below records how often that happens, because if it is often, cause 3's `npm ci` cost is not actually saved and the protocol should keep the reviewer alive differently.

**Proposed text for `pr-review-merge`** (a new step between 4 and 4.1; Eirik applies):

> ### 4.0 Round scope
>
> Round 1, round 6 and every round on a PR that touches a sensitive path (step 2) run `code-review` in full. Rounds 2-5 on other PRs are **delta rounds** when the same reviewer is resumed on a new head (orchestration protocol: `docs/process/review-rounds-v0.5.0.md`, Part 3, item 3): verify every outstanding finding from the previous round by execution; run the changed test files, the guard suites named in `/pre-review` step 2, and the bead's K tests; run the four-family sweep (4.1) and `node scripts/claims-audit.mjs --all-lines` over the files the delta touched; run `code-review` in full only if the delta touches a production file outside the previous round's finding list. State in the marker comment which kind of round this was (`full` / `delta`) and why. A delta round is still a round: it counts, it stamps, and any finding it raises is a finding under step 5.

And in step 6's report list: *"Whether this was a full or a delta round, the reviewer's approximate context size, and whether the worktree from the previous round was reused."*

**Proposed text for `harness-cost-controls`** (new §7):

> ## 7. Resume the reviewer; do not respawn it (ugcportal-wzgw)
>
> Measured on the v0.5.0 cut: `tokens_qa` per review round ran 47k-306k (median ≈180k) and a round that re-verified a 37-line comment delta (`#102` r4) cost the same order as a round that drove `@auth/core` (`#98` r2), because every round was a fresh agent with a fresh worktree re-verifying the whole PR. Keep one reviewer per PR (non-fork, model named, worktree isolation, hard-stop brief) and resume it with `SendMessage` on each new head; respawn fresh only when its context passes ~250k (§2) or its worktree is gone. Target (K2 of `ugcportal-wzgw`): a resumed round costs under half of a fresh full review of the same PR. Record `tokens_qa` per round, not only per bead, while measuring.

**K2 measurement plan.** For the first two PRs run under the protocol: per round, record `subagent_tokens` from the reviewer's completion notification (the resumed agent's figure is the round's marginal cost), whether the round was full or delta, context size reported, and worktree reuse. Compare each delta round against the same PR's round-1 figure; K2 holds if delta rounds average under 50% of round 1. Table A's per-round figures (83k-306k) are the before.

### Item 4 — comment discipline (implemented)

`.claude/skills/review-standards/SKILL.md` §5, grounded in the 35-of-57 count above and the specific comments: measurements belong in tests and the comment points at the test; a doc comment caps at the why; a fix round adds no prose beyond what the finding needs; when a fix changes a claim, grep for its siblings (`claims-audit --all-lines`); a pointer names a thing that exists. The section says what it does not change: the reviewer's sweep.

### Item 5 — sequential merges, or "require branches to be up to date"

**What happened**: Part 1, "The main-red incident". Three green branches, one new test on `main`, merges 39 seconds and six minutes apart, 65 minutes red, fixed by the fourth merge.

**The settings path is not available on this plan.** `gh api repos/eiriksf-capgemini/ugcportal/branches/main/protection` and `.../rulesets` both return `403 "Upgrade to GitHub Pro or make this repository public to enable this feature."` (`#79` r5 recorded the same). `gh api repos/eiriksf-capgemini/ugcportal/branches/main --jq .protected` is `false`. GitHub's documentation on protected branches: available "in public repositories owned by a GitHub Free organization and in all repositories owned by an organization using GitHub Team or GitHub Enterprise Cloud" — and for personal accounts, on GitHub Pro.

**If Eirik takes GitHub Pro** (US$4/month at the time of writing; verify on the pricing page), the exact call:

```bash
gh api -X PUT repos/eiriksf-capgemini/ugcportal/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Lint, test, typecheck, build",
      "Guard sensitive settings files",
      "Guard package.json/package-lock.json version consistency",
      "Guard conventional-commit PR title",
      "harness-cost-controls self-test"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

`strict: true` is "Require branches to be up to date before merging": per GitHub's documentation, "the branch must be up to date with the base branch before merging … More builds may be required, as you'll need to bring the head branch up to date after other collaborators update the target branch." **The cost**: with four PRs waiting, each merge invalidates the other three; each needs `gh api -X PUT repos/eiriksf-capgemini/ugcportal/pulls/<n>/update-branch` (or a local merge and push) and a CI run (~2.5-3.5 minutes on this repo), so four queued PRs cost 3+2+1 = 6 extra CI runs and roughly 15-20 minutes of wall time, serial. Against 65 minutes of red `main` and three agents re-deriving which merge broke what, that is cheap; against a quiet day with one PR, it costs nothing.

**Without Pro, the same outcome procedurally**, and it is what this report recommends first because it needs no money and no settings:

1. `/pre-review` step 1 merges `origin/main` before the PR exists (done).
2. In `pr-review-merge` step 5, before `gh pr merge`, add one check (proposed text for Eirik):

   > Confirm the head contains `main`'s tip: `gh api repos/:owner/:repo/compare/<headRefOid>...main --jq .ahead_by` must print `0`. If it does not, the branch is behind; call `gh api -X PUT repos/:owner/:repo/pulls/<n>/update-branch`, stamp the non-counting `<!-- ugcportal-review-stop: behind-main -->`, and stop — CI on the updated head decides the next run. Do not merge a branch whose CI ran against a `main` that no longer exists.

   (`mergeStateStatus` cannot be used for this: without branch protection GitHub reports `CLEAN` for a branch that is behind.)
3. When several PRs are waiting on a human, **merge one, wait for `main`'s run to go green (`gh run list --branch main --limit 1`), update the next**. The overnight batch of 10-05 is the case this rule exists for.

---

## Part 4. Recommendation

In order, with the arithmetic shown. Per-round figures are `tokens_qa` only (the `code-review` subagent); the implementer's fix round and the orchestrator's turns are on top and roughly double it, per the `apsq` tables.

1. **Do item 1 (Option A) before v0.6.0, together with the stamp fix.** One afternoon of Eirik's time; no skill logic changes beyond the wrapper and the one sentence about ` approx`. Expected effect, from the replay in Part 2: 20 fewer rounds per 100 (0.9 per PR, 1.4 per PR that reaches round 4), at a median of ≈180k `tokens_qa` per round ≈ **3.6M tokens per hundred rounds**, plus every overnight wait at the cap. Expected cost: on an exact chain, rounds 5-6 would not have run on `#81`, `#92`, `#98`, and five mediums in auth/guard code would have shipped to be found later — so pair it with item 3's rule that sensitive-path PRs run full `code-review` at every round (they go to a human anyway; the human should see the medium). K3 is checked first; K1 is measured on the next five feature PRs.
2. **Use `/pre-review` (item 2) on every bead from now on.** Already implemented. Expected effect on the comment-driven PRs: `#102`'s shape (4 family-1 lows at r1, four comment-only rounds) becomes one or two rounds — 5 rounds × 108k = 538k → ≈216k, saving ≈320k and 3 rounds on that one PR; `#86` (3 of 4 r1 lows family 1) and `#100` (3 of 5) similar. Expected effect on round-1 counts: the median of 5 falls by the family-1 and family-3 items the audit and the mutation step enumerate, roughly to 2-3; it does not touch the execution mediums, and should not. Cost: 10-20 minutes of implementer time per PR, a fraction of one round.
3. **Keep item 4** (implemented; zero cost; it is the rule item 2's step 4 enforces).
4. **Do item 5 procedurally now** (the `ahead_by` check in step 5 and merge-one-wait-green when batching); take Pro only if the procedural rule is broken again. Cost of the procedural rule: one API call per merge and a few minutes of serial waiting on batch days.
5. **Pilot item 3 on two PRs, then decide.** It is the largest token lever (a comment-delta round at ~108k could plausibly be 20-40k when the reviewer already knows the PR) but the most moving parts (worktree persistence, context growth, the fork memory, two skill files). It also depends on item 1: an exact chain makes rounds 4-5 file lows, which removes most of the rounds item 3 would make cheaper — measure item 1 first, then see how many delta rounds are left to save.

**What to drop or not do.**

- Drop the bead's framing that an exact chain saves "two to three rounds on nearly every PR"; the measured figure is one or two on 14 of 23, and the latency is the larger win.
- Do not take GitHub Pro only for branch protection until the procedural rule has failed once; the incident is real but singular, and the rule is a one-line check.
- Do not add a severity or depth change to `code-review` (out of scope, `2yj`); the late mediums show depth is earning its keep where it is sensitive.

**Simplifications the data supports** (each is a step, lock, marker or hand-off that cost something in 100 rounds and did not visibly earn it):

- **The ` approx` suffix on markers**: written on every marker since 10-04, reserved for bootstraps, and the single reason an identity change would not work on the first day. Stop writing it (item 1).
- **Escalation to a human when only lows are outstanding at the cap**: 9 of 9 such escalations ended "merge with the lows filed", the outcome the exact-chain rule gives automatically. Under item 1 this step disappears for exact chains; nothing is lost.
- **The bootstrap and `7+` rows of step 4b/5**: never exercised in 100 rounds (an `approx` chain cannot enter `7+`; no pre-rule PR was bootstrapped), while their purpose happened three times as an uncounted comment. After item 1 they become reachable; if a cut passes without either firing, replace both with "a post-escalation verification is posted as a comment with `<!-- ugcportal-review-stop: post-cap-verification -->` and a human merges", which is what `#94`, `#96` and `#101` actually did.
- **The per-PR review lock**: zero stand-downs in 100 rounds, and the one duplicate stamp (`#94` r5) was by a worker that did not take it. It is cheap (four API calls) and the race it guards is real in principle; keep it, but it is not evidence-backed, and item 3's "one reviewer per PR, resumed" removes the race it exists for.
- **Fork-based review and multi-angle consolidation**: four verdicts "assembled from the finder angles because the consolidating reviewer did not report", two stalls, one fork that became an orchestrator. A single non-fork reviewer with a written brief (item 3) is simpler and the memory already prefers it.
- **Review-history narration in code** (`HEADER_HEIGHT_PX (ugcportal-14k9 PR #94 review round 4/5)` as a test title): `claims-audit` flags it as `HISTORY`; delete it on sight.

**Where the bead's premise was wrong.** The premise that the lenient band would have "filed the lows and merged, saving two to three rounds on nearly every PR" holds for the direction and not the size. The premise that the tail lows were "almost all family 1" holds for the nine PRs named and not for the batch the day before, where the tail was `code-review`'s cleanup items. The premise that rounds cost "100k to 350k tokens" is right (47k-306k measured, median ≈180k); the part it understates is that a comment-only round costs the same as a code round.

---

## Appendix

### Reproducing the counts

Step 4b's command, as run for Table A, over a dump of the comments with `me` and `pr_author` as parameters:

```bash
# dump
n=94; gh api --paginate repos/eiriksf-capgemini/ugcportal/issues/$n/comments | jq -s add > pr-$n-issue.json
gh api --paginate repos/eiriksf-capgemini/ugcportal/pulls/$n/reviews | jq -s add > pr-$n-reviews.json
# count: paste the jq program from .claude/skills/pr-review-merge/SKILL.md step 4b after
#   { jq -r '... | @tsv' pr-$n-issue.json; jq -r '... | @tsv' pr-$n-reviews.json; } | jq -Rrn --arg me ... --arg pr_author ...
# with --arg pr_author eiriksf-capgemini for today's reading and --arg pr_author someone-else for the bot reading
```

Note for whoever reruns it with the system `jq` 1.7: `"" | split("\n")[0]` is `null` there and `sub()` on it errors for an empty review body; `gh --jq` (gojq) returns `""`. The skill's command is correct under `gh`; a local replay needs `(.body // "") | split("\n") | .[0] // ""`.

### Data gaps

- `#81` rounds 2-3 have no marker and no verdict comment; their findings are counted as unstated.
- `#61` rounds 1-3 state finding counts but not severities.
- `#78`, `#61`, `#60`'s `plp6`/`ws3`, `#92`'s round-level cost: no per-round `tokens_qa`; the per-round figures in Table A are bead totals divided by marker count and assume equal rounds.
- `tokens_qa` covers the `code-review` subagent only; orchestrator and implementer costs per round are in the `apsq` report, not here.
- The new-prose / stale-sibling split of the 35 family-1 tail lows is my classification from the comment text, hence "≈".
- Inline `code-review` comments (`pulls/<n>/comments`) were dumped but not reconciled finding-by-finding against the verdict comments; the verdict comments are treated as the record, as the skill intends.
- The v0.4.0 baseline has no severity-by-round data; its round counts come from bead close reasons via `harness-cost-controls` §6.
