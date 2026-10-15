# v0.7.0 retrospective: process errors, what they cost, what owns the fix

Bead: `ugcportal-fbng`. Written 2026-10-15, the day v0.7.0 was cut (PR #246, `cceaeac`, 68 beads). Every claim below traces to a dated entry in that bead's notes; the entry label is the citation, and every figure is the catalogue's own unless marked "read from `bd show` 2026-10-15". Where an entry records no cost, this says "cost not recorded". What the release cost is `ugcportal-2hwe`'s subject.

**Citation convention.** Entries are A (orchestrator-caused), B (agent-caused), C (tooling and process gaps). The 2026-10-14 session restarted the A series at A13, so labels A13–A19 each name two entries; the 14 October ones are written `A13/14` … `A19/14`. Unnumbered entries are cited by date and the first words of their header.

## 1. Counts

Parsed from the bead's notes with a regex over entry labels on 2026-10-15: 66 labels, 7 duplicated.

| Cause | Entries | Owned by a bead | Owned by a memory, a skill or an in-place fix | Marked UNOWNED | No marker |
|---|---:|---:|---:|---:|---:|
| A — orchestrator-caused | 37 | 5 | 6 | 8 | 18 |
| B — agent-caused | 11 | 0 | 3 | 6 | 2 |
| C — tooling and process gaps | 18 | 10 | 3 | 3 | 2 |
| **Numbered entries** | **66** | **15** | **12** | **17** | **22** |

Beside those: 15 unnumbered measurement entries (section D and the `===` headers of 10-09/10: the #207 blind spot, prose churn on #209, splice damage on #208, the three corrections to the #207 story, and the rest) and 3 inline B-side incidents (the yzo7 title that kept its descoped half; an agent ending its turn on a background wait, z4nh; a reviewer removing the implementer's worktree, PR #211).

Three things the table says. The orchestrator caused 37 of 66 entries, more than agents and tooling together, and the section-A preamble says why that share matters: a brief defect reaches every agent it is sent to — A1 went into five briefs, and B2's three identical false zeroes came from one instruction. Second, 18 of the 22 unmarked entries are the orchestrator's A13–A30 of 10-09/10, none of which says whether a bead owns it, against the catalogue's own opening sentence ("says whether it is owned"); the other four are B3, B8, C8 and C12. All 22 are counted as unowned here. Third, a memory is a weaker owner than a bead: A13 (10-09) is the orchestrator committing B1 twenty minutes after cataloguing it, and A24 is A4 repeated after its memory became a flat prohibition.

Three things moved after the entries were written (read from `bd show` 2026-10-15): the one UNOWNED item among them, C5 (CI `skipping` reads as failure), was fixed by `ugcportal-h0ef`, PR #232; C1 (owned `ugcportal-fgcb`) says "consider a bead" for the sweep's false zero, and that became `ugcportal-kssp`, PR #229, which is why `sweep-candidates` now prints a scan block; C3's owner `ugcportal-l99p` shipped as PR #205.

## 2. The patterns that cost the most

### 2.1 PRs merged by hand past a pending review round

Entries: A13/14, A14/14, A16/14 (owned `ugcportal-li65`, open); A30 (no marker).

#227 was merged by hand after rounds 1–2 were fixed and before round 3 ran; #230 at 08:30:05Z, twenty seconds before round 3 posted 2 medium + 4 low. Those findings went live on `main` and became `ugcportal-7sjc`, PR #236, whose review cost 874,934 `tokens_qa` (read from `bd show`; the catalogue says 875k). The ruleset's up-to-date rule then refused two clean merges: #234, where round 3 re-reviewed a byte-identical diff for ~134k tokens, and #231, refused at round 6 and merged outside the skill. #236's own merge raced the `edited`-event CI run for 40 s (A16/14). #210 merged outside the orchestrator's control and neither the bead close-out nor the branch cleanup ran (A30; cost not recorded).

Cost: one fix PR with a six-round review, one byte-identical round. The gate has no mechanism against a manual merge; the dashboard now flags "Merged, bead open".

### 2.2 One narrower sibling per round, for five or six rounds, on an `approx` chain

Entries: A18/14 (owned `ugcportal-2yj`/review-standards, closed); C6 (`ugcportal-62b6`, open); C11 (`ugcportal-n005`, open); A17/14 (UNOWNED); the #207 "five rounds did not look" entry and its three corrections (`ugcportal-78ka`, PR #213, closed); "prose churn" on #209 (no marker).

Every chain in this repo is self-asserted, so the lenient band never opens and a low blocks at every round. Section D's headline: across 13 PRs and roughly 30 rounds of the first week, every blocking finding was a false or unsupported claim, none a logic defect in shipped code. #201 took six rounds and 987k of QA against 477k of implementation on a P3 (C6). #207 spent five rounds and ~770k with the file's false opening comment unchanged since its first commit; on an exact chain it would have merged two rounds and ~340k earlier. On 10-14, #237, #241, #243 and #236 each ran 5–6 rounds with one or two lows per round after round 2, each round finding one narrower sibling of the previous fix, at 130–200k per round (A18/14); `tokens_qa` read from `bd show`: hhjq 727,118 for a 69-line test file, 7sjc 874,934, rj7y 1,006,669, qnq9.11 959,302. The dashboard, `ugcportal-vr9q`, written inline by the orchestrator, went six rounds and 1,171,297 `tokens_qa` with the fail-open family in every section (A17/14): the brief-writer is not a better implementer. Round 3 of #209 returned seven lows, three created by round 2's own corrections.

Cost: the largest token line in the catalogue. The stopping rule is behaving as designed; the unfixed input is the single identity (`62b6`). `78ka` shipped the read-the-file-whole rule; why #207's round 1 missed three family-1 claims in its own added lines is unexplained ("third correction", 10-10) and should stay an open question.

### 2.3 The orchestrator transcribed instead of deriving

Entries: A1, A3, A10 (memories); A2, A7, A11, A12 (UNOWNED); A17, A19, A21, A23, A26, A27, A28, A29, A30 and the cycle-marker correction (no marker). The catalogue's tally at A30: ten errors, "nine transcription, one causal".

A stale baseline (204/4553 for a true 205/4584) in five briefs (A1); a wrong advisory severity that cost #191 a blocking round (A3); a fix authorised at #201's cap that zeroed two real historical findings on #131 and #193 (A10); a bead id that never existed (A17); counts written down and later measured false — 29 against 28 border sites, relayed to Eirik three times (A23), a matrix cell in a bead's notes contradicting the leak the bead fixes (A26), 29/11 against 16/6 usages in 7g2o's premise (A27); two changes credited to the wrong PR (A29); a causal story about #207 told three times and wrong twice.

Cost: A3 one round; A10 one cap escalation and a regression on real data; the rest caught before any cost (cost not recorded) — A2, A11 and A12 by the orchestrator's own re-check, and the nine errors A29 tallies by one control, nine for nine: briefs that asked the agent to re-derive and report discrepancies. `dispatch-bead` now carries "never enumerate a set in a brief from memory" for implementer briefs. Review briefs and reports to Eirik (A14, A21, A23) have no such rule: `ugcportal-4bok`, filed from this document.

### 2.4 Instruments that report a reassuring zero

Entries: B2 (memory) and C1 (owned `ugcportal-fgcb`; the sweep's false zero shipped as `ugcportal-kssp`, PR #229); C3 (`ugcportal-l99p`, PR #205); C2 (`ugcportal-fgcb`, open); A16, A18, A20, A23 (no marker); A15/14 (UNOWNED).

`sweep-candidates` reported 0 on #192, #195 and #194 against real figures of 4, 19 and 42, each a blocking round-1 finding (B2); #196 reported 0, then 42 after committing (C1). `.next/standalone` doubled the suite (462/9256 against 225/4999) until the pre-push hook refused a good push on #203 (C3). A silenced stderr hid two failed `bd` writes (A16); a wrong JSON field printed "UNREACHABLE: 0" against a true 10 (A18); `bd list --all` hid two gate beads (A20).

Cost: three blocking rounds and one refused push; the rest caught. The shared fix is review-standards section 6 and `kssp`: print the match count before trusting a zero.

### 2.5 Premises expire, and the dispatch gate now charges for it

Entries: C14 (owned `ugcportal-7sjc`, PR #236); A11 (UNOWNED); C10 (memory); "a retracted premise re-entered" on #214 (swept by `ugcportal-x8ab`, PR #216; residue `ugcportal-5bkn`, open).

The gate's premise-fresh check made every ready bead undispatchable at 25+ commits stale; two sonnet analysts re-verified 11 premises in ~2 h of wall clock for ~140k tokens and found one false premise (ocbo, already fixed by #215) and two stale acceptance texts (gdn3, hhjq). Earlier the `$transaction` premise travelled unverified through three beads and two files and blocked #196 at round 1 (C10), was measured and retracted, then re-entered the codebase in four comments on #214 whose cited file carried the retraction.

Cost: ~140k and ~2 h per dispatch wave, now measured; one blocking round (C10). The rule works and its price is known.

### 2.6 Subagents stalling in long foreground calls, or blocked by their own permission check

Entries: A19/14, B11, B10, C18, B6 (all UNOWNED); the z4nh "ended its turn on waiting" entry of 10-09 (no marker).

Four reviewer runs on #244/#245 sat ten minutes with no output inside an image build, a 30-minute suite under load and a lock check, and the orchestrator finished the reviews inline (A19/14); the #235 round-5 fix agent stalled 600 s after pushing (B11); the #201 round-6 fix and the z4nh round-4 fix each ended on "waiting for" a background task that cannot resume them (B6, 10-09). The 7sjc implementer and the cut-release agent were blocked by the auto-mode permission check on `bd show`, `bd update --claim`, `git push` and `gh pr comment`, stopped correctly and handed back (B10, C18).

Cost: "a full handback and a human round-trip" each (C18); tokens not recorded. The worker definitions say to run the suite in the foreground with `timeout: 600000` and "never end a turn waiting on a background task"; A19/14 says background anything over eight minutes. Both cannot stand: `ugcportal-9u80`. The allowlist is `ugcportal-pyky`.

### 2.7 A pinned third-party image went private

Entries: C16, C17 (owned `ugcportal-s2qp`, PR #244, `bed0193`, closed).

The release gate "validate `docker compose up` before closing" failed on its first run at `969d58e`: `quay.io/minio/*` answers 401 anonymously and `minio/minio` is gone from Docker Hub. The gate caught a fresh-machine failure every cached developer machine would have hidden. Re-run on final main `9ae91a3` at 2026-10-15T04:50Z: `compose up --wait` exit 0, both services healthy, images digest-pinned (C17).

Cost: one failed gate run and one fix PR (`tokens_impl` 73,578, `tokens_qa` not recorded; read from `bd show`).

## 3. What went well

B1, B3, B6, B7, B9 and the worktree removal on #211 were each self-reported by the agent that did it, which is what made them cheap. The j5fl audit prevented two wasted builds (pc7s, n9rc; section D). Three defects were found only by executing: #200's SQL three-valued-logic NOT, nffp's preview-route leak, a3hj's unresolved Tailwind class (112px rendered against an intended 240px). A guardrail criterion caught the cheat it named on #211 round 1 (7g2o's K3). A new rule caught a defect in its own implementation before it shipped (#213: `prev-head` matched `\bhead\b`).

## 4. Recommendations

Each is tracked by its own bead. `cut-release` step 7a does not reconcile this document: it lists `docs/process/release-cost-*.md` and matches beads on `metadata.retro_source`, which none of the 14 beads below carries for this document (`ugcportal-62b6`'s points at the v0.5.0-vs-v0.6.0 cost report; the other 13 have none).

1. Close the hand-merge gap mechanically, and make the up-to-date rule cheap — one branch update, no re-review of a byte-identical diff: `ugcportal-li65`.
2. A separate reviewer identity, so an `exact` chain exists; until then every late round on an `approx` chain costs A18/14's 130–200k per nit: `ugcportal-62b6`. Whether a review-thread sentence blocks: `ugcportal-n005`.
3. Keep the dispatch gate's freshness rule: ~140k and ~2 h per wave (C14), and it found a false premise. No change; `ugcportal-ydbi` carries the backfill.
4. Provenance in review briefs and in reports to Eirik: `ugcportal-4bok` (new).
5. One rule for long commands, and a stall that is reported rather than waited out: `ugcportal-9u80` (new).
6. The permission allowlist, as a dedicated settings PR for Eirik: `ugcportal-pyky` (new).
7. The v0.8.0 catalogue, with a unique label and an owner marker on every entry from day one: `ugcportal-zce5` (new, P1, labelled v0.8.0).
8. Still open from the catalogue: C2 `ugcportal-fgcb`; `ugcportal-5bkn`; A22 `ugcportal-nr72`; C9 `ugcportal-0wh6`. Release sizing (C15) belongs to `ugcportal-2hwe` and `ugcportal-xb68`.

## Appendix: owner of every numbered entry

Owner-bead status read from `bd show` on 2026-10-15.

- **A, 10-08/09.** Memory: A1, A3, A4, A5, A10. Fixed in place: A9. Bead: A8 (`ugcportal-44qs`, closed, PR #223). UNOWNED: A2, A6, A7, A11, A12.
- **A, 10-09/10 (A13–A30).** No marker on any of the 18; A22 points at `ugcportal-nr72` (open), A25's subject became `ugcportal-78ka` (closed, PR #213).
- **A, 10-14.** `ugcportal-li65` (open): A13/14, A14/14, A16/14. `ugcportal-2yj` (closed): A18/14. UNOWNED: A15/14, A17/14, A19/14.
- **B.** Memory: B2, B4, B5. UNOWNED: B1, B6, B7, B9, B10, B11. No marker: B3 (the shared-checkout memory predates it), B8 (covered by A5's memory).
- **C.** Beads: C1 and C2 `ugcportal-fgcb` (open); C3 `ugcportal-l99p` (closed, PR #205); C6 `ugcportal-62b6` (open); C9 `ugcportal-0wh6` (open); C11 `ugcportal-n005` (open); C13 `ugcportal-kt3k`/`ugcportal-7sjc` (closed, PRs #230/#236); C14 `ugcportal-7sjc`; C16 and C17 `ugcportal-s2qp` (closed, PR #244). Memory: C4, C7, C10. UNOWNED: C5 (since fixed by `ugcportal-h0ef`, PR #232), C15, C18. No marker: C8, C12 (C12 records the tool being right).
