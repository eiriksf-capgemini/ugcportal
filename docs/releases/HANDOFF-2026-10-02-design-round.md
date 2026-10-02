# Handoff — process-improvement cleanup + start of the petrol design round

Written 2026-10-02, at the close of orchestration session `ugcportal-f5` (formerly
`3ef8bf0e…`, which this session continued after a context reset), for whoever picks
this up next. Like the 2026-09-28 handoff before it: not a status report — `bd ready`
and `bd epic status ugcportal-842j` give you that, fresher than this file will stay.
This records what is **only** in the session transcript.

Read `bd prime`, then the 2026-09-28 and 2026-09-30 handoffs in this directory, then
this one.

---

## 1. Current state, in one paragraph

**Re-derive, don't trust these numbers.** At the time of writing: the process-improvement
epic (`ugcportal-842j`) is at 16/20 (80%) — of its 20 children, only two closed this
session (`aj2k`, `lykb`); a third epic child, `qmxl`, has a clean, review-approved PR
(#66) still **open**, parked on Eirik because it touches a sensitive path
(`.github/workflows/ci.yml`) that this repo's process requires a human to merge — see
§4. The other three still-open epic children (`0xw`, `ju4`, `cchw`) were deliberately
*not* touched this session — see the 2026-09-30 handoff for why each is premature or
intentionally deferred. Alongside the epic work, this session also closed six
**standalone** beads unrelated to `842j` (`4at`, `ggw`, `r3h`, `asg`, `5g9t`, `000`,
`juo`, `0dh` — eight, not six; all independent review-deferred bugs or small fixes),
one of which (`r3h`) was discovered mid-session to have been merged buggy once already
— see §2. Separately, Eirik started a new petrol-palette design round (5 new/updated
beads, not part of the epic): `rw9j` (tokens, P1, **open PR #79, round 4 merged, round
5 findings known but unfixed**), `gwr` (alt text/captions, **closed**, merged as PR
#78), and three beads blocked on `rw9j` closing — `14k9`/`akv6`/`6dvg`
(header/footer/hero). Re-derive with:

```bash
bd epic status ugcportal-842j
bd ready
gh pr list --state open
gh pr view 79 --comments | tail -80   # round 5's findings, never fixed
```

**The one thing that needs a human or a fresh agent right now:** PR #79 (`rw9j`) is
sitting at round 4's merged state with round 5 review already run — five parallel
review forks found real issues (see §7.1) — but the main review agent died before
fixing any of them or posting round 5's verdict. Nothing is lost (the worktree was
clean, no uncommitted work), but round 5 has to be **re-run from scratch** by whoever
picks this up, because the findings exist only in this document and the orchestrator's
chat transcript, not in any PR comment. I already released the stale `refs/review-locks/pr-79`
ref and force-removed the dead agent's worktree; `bd show ugcportal-rw9j` will show an
expired lease, which a plain `bd update ugcportal-rw9j --claim` clears fine.

---

## 2. Decisions and why

### `r3h` merged buggy once, was caught, and was fixed — the bead is correct now, but the sequence is worth knowing

A subagent working `ugcportal-r3h` (pinned-uploader-banner false reason) opened PR #67,
ran `pr-review-merge`, and it merged — with its own K3 violation: the new banner text
said the uploader "does not appear in the list above" while they were, in fact, visibly
pinned at the top. A **later** review pass by the same agent caught this, reverted the
bad logic, and reapplied a corrected version as PR #72. The agent was then interrupted
(orchestrator context reset) **after** merging PR #67 but **before** merging PR #72 —
and in the gap, it had already closed the bead with `prs=gh-67`, i.e. pointing at the
buggy PR. The orchestrator caught this by independently diffing `origin/main`'s actual
file content against the bead's claimed fix, reopened the bead, and a fresh agent
finished the job: PR #72 merged, but **only after a round-2 reviewer caught that the
regression tests for K1/K2 didn't actually pin the specific wording** — they'd have
passed against the old, buggy banner text too (a vacuous assertion, confirmed by
mutation: reverting the wording left all 19 tests green). `prs` is now correctly
`gh-67,gh-72` on the closed bead.

**The generalizable lesson, worth repeating from the 2026-09-28 handoff:** a bead
closed with `prs` pointing at a merged-but-wrong PR is just as dangerous as one
pointing at an unmerged PR — `cut-release` trusts both equally. Verify the actual
*content* on `main`, not just that *a* PR merged, before trusting a close.

### `juo`'s safety comment repeated the exact mistake `0dh`'s reviewer caught a day earlier

Both `ugcportal-0dh` and `ugcportal-juo` (separate beads, separate agents, same
session) wrote a comment claiming a DOM-ancestor ordering guarantee between a new
`document`-level listener and React's synthetic listener — and in both cases the claim
was false, because this app's Next.js App Router hydrates `ReactDOM.hydrateRoot`
directly onto `document` itself (confirmed by reading
`node_modules/next/dist/client/app-index.js`), so there is no ancestor relationship;
the two listeners sit on the same node. Neither bug actually mattered in practice
(neither listener calls `stopPropagation`), but the *comment* asserted a structural
invariant that doesn't hold — this repo's named "Family 1" defect. The orchestrator
caught the pattern in `0dh`'s review forks and explicitly warned `juo`'s review agent
to check for the same thing before it started; it found and fixed the identical
defect. **If you're writing a comment about listener/event ordering anywhere in this
app, check hydration target first** — it's `document`, not a sub-node, and that fact
keeps surprising agents who assume otherwise from general React knowledge.

### The petrol design round's three product questions were answered by Eirik before work started

Before dispatching `rw9j` and `gwr`, the orchestrator asked Eirik directly (the beads'
own text said "the agent must ask the human" for these): display font (Fraunces,
**approved**), color-mode default (**follow OS `prefers-color-scheme`**, no in-app
toggle built yet), terracotta accent scope (**CTA only**, never on sign-in buttons).
Two smaller open questions (whether captions may contain links; nb/en language
split) were *not* escalated — the orchestrator picked defaults (plain-text captions,
Norwegian-only) and had the agent document them as overridable assumptions in the PR,
rather than stopping a second time for lower-stakes calls. If Eirik wants different
answers on those two, they're one-line changes, not re-architecture.

### `rw9j`'s phase boundary is a real human checkpoint, not a suggestion

The bead's own text requires Eirik to approve a screenshot of phase 1 (tokens, global
background, primary/secondary buttons) before phase 2 (cards, borders, form fields)
starts. The dispatched agent was explicitly told to stop after phase 1 and not touch
phase 2 — it has, correctly, stayed within that boundary across all four merged
rounds so far (the round-by-round fixes were all corrections to phase-1-scoped code,
never phase-2 scope creep). **Whoever picks up round 5 should preserve this boundary.**

---

## 3. Dead ends / mistakes this session — things to not repeat

- **Trusting a relayed round-leniency rule without checking the skill file.** The
  orchestrator told `rw9j`'s agent, mid-review, that round 4-5 allows "lows filed as
  beads, merge on no medium-or-above" — this is **wrong** for this repo today. Per
  `pr-review-merge` step 4b/5, that leniency only applies to an **`exact`** review
  chain (a genuinely independent reviewer identity). This repo's chain is **always
  `approx`** right now (no separate reviewer identity exists — that's `ugcportal-62b6`,
  still open), so the strict "any finding blocks, zero to merge" rule applies at
  *every* round, with round 6 as the only escape (escalate to a human, don't run a
  7th round). The agent caught the orchestrator's mistake itself, refused to loosen
  the gate on an instruction alone, and asked for confirmation before proceeding — this
  is the correct behavior and should be the expectation, not a surprise. `gwr`'s own
  agent independently made the identical mistake at its round 4 (misfiled 3 lows as a
  bead under the same wrong belief), caught itself after the orchestrator's correction
  propagated, and fixed them directly instead. **Read the actual chain-status output
  (`N approx` vs `N exact`) every round; don't assume which band applies.**
- **A bash heredoc nested inside `$(...)` inside double quotes breaks on any apostrophe
  or backtick in the body text.** Eirik's `claudedesign/beads_design_round.sh` script
  (used to create the `rw9j`/`14k9`/`akv6`/`6dvg`/`gwr` beads) hit this twice — first
  on a literal `Next.js'` apostrophe (`unexpected EOF while looking for matching` `''`),
  then on three backtick-quoted code spans (`` `npm run dev` `` etc., `bad substitution:
  no closing ')'`) once the apostrophe was fixed. This is a real, reproducible bash
  parsing gotcha (verified with a 5-line repro), not a one-off typo — the general
  pattern `VAR=$(cmd <<'EOF' ... text with ' or ` ... EOF)"` is fragile any time the
  heredoc is itself inside a quoted command-substitution argument. **Fixed by
  rewriting the script to write each heredoc to a temp file and pass it via `bd
  create --body-file`/`bd update --body-file` instead** — this sidesteps the nesting
  entirely and is the pattern to reuse for any future script that generates beads
  with multi-paragraph bodies containing natural prose (which will contain
  apostrophes).
- **Letting a subagent self-poll CI in a loop burns tokens for no benefit.** Early in
  this session, multiple agents ended repeated turns doing nothing but re-checking
  `gh pr checks` and reporting "still waiting" — one case cost ~450k tokens across four
  such turns before the orchestrator started polling CI itself in the background and
  relaying a single "CI is green, proceed" message instead. **If you are the
  orchestrator: poll CI yourself (`Bash` with `run_in_background: true`, looping on
  `gh pr checks`), and only resume the subagent once there's an actual state change to
  report.** Don't let a subagent re-enter just to check the same pending status again.

---

## 4. Claims to re-check before trusting

- **This document's own round/PR numbers.** By the nature of a handoff, they were
  true when written. `gh pr list --state open` and `bd epic status ugcportal-842j`
  are the ground truth.
- **Whether PR #66 (`qmxl`) is still open.** It's a clean, review-approved PR
  (zero blocking findings across 2 rounds) parked on Eirik because it touches
  `.github/workflows/ci.yml`, a sensitive path this repo's process requires a human
  to merge. Two low-severity follow-ups were filed and are NOT blockers:
  `ugcportal-7ko6` (duplicated placeholder-mapping between `ci.yml` and the pre-push
  hook) and `ugcportal-c8og` (a `$GITHUB_ENV` write that should use heredoc-delimiter
  form for multi-line safety, currently unreachable but latent). If PR #66 is still
  open when you read this, it just needs a `gh pr merge 66 --squash --delete-branch`
  from a human — nothing else is blocking it.
- **A real, live secret was found in a bead's notes field — treat as resolved per
  Eirik, but re-verify the assumption still holds if this repo's access model ever
  changes.** `ugcportal-5g9t`'s notes field contained a full accidental shell-`env`
  dump, including a live-looking `ANTHROPIC_API_KEY`. Eirik was told directly and
  said it's a personal key on a private, single-user repo — no rotation or redaction
  was requested, and none was done. The bead's notes were later overwritten anyway
  (an unrelated `bd update --notes` call replaced rather than appended, same footgun
  noted in §6) but the key may still be recoverable via `bd history ugcportal-5g9t`
  or the dolt-synced `refs/dolt/data` history. **If this repo's access assumptions
  ever change (a second contributor, a CI runner with read access to bead history,
  etc.), revisit this.**

---

## 5. Open questions — genuinely undecided, and whose they are

Carried over, unchanged, from the 2026-09-28 handoff (§5 there) — still nobody's but
Eirik's, still blocking: is this a marketplace or a portfolio (`p3v` vs `137`); does
`3ae` gate the v0.4.0 tag; ratify `9cs` §8. Nothing this session touched them.

**New, from this session:**

- **`rw9j` round 5's fixes are Eirik's to review eventually, not just a fresh agent's
  to apply.** The round-5 findings (§7.1) are all legitimate defects, but fixing them
  is routine review-response work, not a product decision — flagging only because the
  phase-1→phase-2 screenshot checkpoint means Eirik will be looking at this PR's
  output directly soon regardless.
- **Caption links and nb/en language split on `gwr`** (see §2) — Eirik hasn't been
  asked, a default was picked and documented. Revisit if he wants either changed;
  both are small, scoped changes against the shipped schema (`Media.caption` is a
  plain string column either way).

---

## 6. Two operational facts that will bite

1. **A `bd update --notes` call replaces, it does not append, unless you use
   `--append-notes`.** Two different agents this session made this mistake on two
   different beads (`r3h`'s reopen note, `5g9t`'s original notes including the leaked
   secret) — in both cases the prior content was overwritten by a close-summary call
   that used `--notes` instead of `--append-notes`. Recoverable via `bd history
   <id>`, but **use `--append-notes` by default** unless you specifically intend to
   replace.
2. **GitHub's check-runs API can report a job as perpetually `status: in_progress`
   even after it has actually completed with `conclusion: success`** — a real,
   reproduced-twice glitch this session (PRs #65 and #68, both independently stuck on
   `Guard package.json/package-lock.json version consistency`). `gh pr checks` will
   never show it as settled because it reads `status`, not `conclusion`. Confirmed via
   `gh api .../commits/<sha>/check-runs` showing the mismatch directly. **Fix: force a
   fresh CI run** (`gh api -X POST repos/.../actions/runs/<run-id>/rerun`) — this
   creates new check-run objects from scratch and clears the phantom state. A plain
   `git push --force-with-lease` with no new commit does *not* trigger a new run
   ("Everything up-to-date") and does not help.

---

## 7. Where the raw material lives / what's genuinely unfinished

### 7.1 PR #79 (`rw9j`) round 5 — the actual findings, verbatim from the review forks

These were posted to the orchestrator's chat, never to the PR. Whoever re-runs round 5
should treat these as a starting point, not gospel — re-verify each, since the
findings were never consolidated or cross-checked against each other:

1. **(Likely medium-or-above, CONFIRMED by direct measurement.)** Header/footer
   hairline border (`border-border`, applied globally via `* { @apply border-border }`
   in `globals.css`) goes nearly invisible in dark mode: measured contrast of
   `--color-line` against `--background` is **1.16:1** in dark mode (vs 11.6:1 light).
   Root cause: this PR repointed `--background` from `--color-surface-0` to
   `--paper`/`--petrol-900`, values disjoint from the surface-0..4 scale that
   `contrast.ts`'s `SURFACES`/`PAIRINGS` machinery actually checks — `--background`
   itself was deliberately excluded from `SURFACES` (per an existing code comment,
   "back when `--background` was one of SURFACES"), so no automated check, axe run,
   or the contrast gate itself would ever catch this. Needs a `divider-on-background`
   pairing added to `contrast.ts`.
2. A new e2e test (`e2e/petrol-theme.spec.ts`'s K1 test) is named as if it checks both
   page background *and* primary-button fill, but its body only reads
   `document.body`'s background color — no button element is ever queried. The button
   half of K1 is currently unverified by any automated check.
3. `no-raw-hex.test.ts`'s `HEX_COLOR` regex can false-positive on ordinary English
   text that happens to be hex-safe after a `#` (verified: `#deface`, and by extension
   `#decade`, `#cafe`, `#beef` would all trip it) — it scans raw text after only
   stripping comments, not string literals or URLs. Not a live failure today (nothing
   in-tree happens to contain such a string) but a brittle CI gate waiting to false-fail
   on an innocent doc link.
4. `destructive-focus-ring` (the focus ring on destructive/danger buttons) has no
   `PAIRINGS` entry checking it against its own `--destructive-surface` background —
   passes today (~4.75-5.33:1, measured directly) but is an unmonitored gap, the same
   shape as the `RING_OVERRIDE_SURFACES` gap round 3 already fixed for the plain
   `--ring`-on-old-surfaces case.
5. **Scope-creep note, not a bug:** two unrelated changes rode along in this
   styling-only PR — `src/app/upload/page.tsx`'s `auth()`→`getSession()` swap (safe,
   verified, but duplicates work `ugcportal-asg` already did and should have been a
   separate commit at minimum) and a new `requestedUploaderNotInListReason` branch in
   the admin rights page (also safe, also verified, also unrelated to tokens). Neither
   is broken; both are worth a one-line mention in the eventual review response about
   why they're there.
6. Three low-severity reuse/efficiency findings: a hand-rolled CSS declaration parser
   in `tokens.ts` that could delegate to the `postcss` dependency already used
   elsewhere in the same directory; `scan-source.ts`'s directory walker does a
   separate `statSync` per entry instead of using `readdirSync(dir, {withFileTypes:
   true})`; two test files each walk the source tree twice (once in a "finds files"
   sanity check, again in the real assertion) with no caching between the two `it`
   blocks.

Fixing #1 is very likely required (medium-or-above, real and currently reachable —
dark mode has been live in production tokens since round 1 of this PR). #2-#4 are
real but lower-urgency; on an `approx` chain they still block per §3's rule regardless
of severity, so they need *some* disposition (fix or a reasoned non-finding) before
round 5 can post a clean verdict, same as rounds 1-4 already did for their own findings.

### 7.2 Other raw material

`docs/releases/v0.4.0-working-notes.md` — the pre-existing narrative companion,
unchanged this session, still the place for the *why* of the v0.4.0-era work. This
session's work (the process-improvement epic's remainder, plus the start of the
design round) doesn't yet have an equivalent working-notes file; this handoff is the
only record. `docs/design/{tokens.css,forside.html,lightbox.html,tom-tilstand.html}`
are the adopted-but-static reference sketches the whole design round points at — they
were committed in round 3 of `rw9j`'s own PR (they hadn't been pushed to any branch
before that, so every "see docs/design/tokens.css" citation in rounds 1-2 of that PR's
own comments 404'd until round 3 fixed it).
