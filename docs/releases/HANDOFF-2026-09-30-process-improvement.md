# Handoff — the process-improvement phase (`ugcportal-842j`)

Written 2026-09-30, compiled from `bd` bead notes, PR close reasons, and `gh pr list` — not from a
single session's first-hand transcript the way `HANDOFF-2026-09-28.md` was (that phase's work
spanned several sessions and several PRs authored across them). Where this document states a fact,
it is sourced from a specific bead or PR; re-derive rather than trust, same rule as last time.

Read `bd prime` first, then this.

---

## 1. Current state, in one paragraph

**Do not trust the numbers in this section — re-derive them.** At the time of writing: epic
`ugcportal-842j` is **11/18 children closed (61%)** per `bd epic status ugcportal-842j`. Every PR
this document names (51, 53, 54, 55, 56, 57, 58, 59, 60) was confirmed merged directly via
`gh pr list --state merged`, not taken from bead notes alone. One more bead, `ugcportal-62b6`, is a
real open follow-up discovered *from* this phase's work (out of `ugcportal-1xf`) but is not one of
the 18 counted above — it was filed after the epic's scope was frozen.

Re-derive with:

```bash
bd epic status ugcportal-842j
bd children ugcportal-842j --pretty
gh pr list --state merged --limit 20
```

Parked on Eirik: `ugcportal-62b6` carries the `human` label (a bot-account/GitHub-App decision).
`ugcportal-0xw` is the re-measurement that actually confirms whether the routing fix recovered
real spend — it has not run yet.

---

## 2. Decisions and why

### The subagent-routing fix landed outside the repo, not inside it

`ugcportal-9ak` (the original diagnosis) asked for one line in `ugcportal`'s own
`.claude/settings.json`: `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`. That file is edit/write-denied for
agents by deliberate policy, so the fix needed Eirik to apply it by hand. What actually happened
(`ugcportal-2tc`, closed 2026-09-29): Eirik applied the env var to his **global**
`~/.claude/settings.json` instead, confirmed live via `env | grep CLAUDE`. Confirmed directly
while writing this document that `ugcportal`'s own `.claude/settings.json` still has no such env
block — the repo-local fix was never made. This was a knowing tradeoff, not an oversight: it stops
the leak for Eirik's own sessions on this machine, but a different machine, a different
contributor, or a CI run gets none of it. If this repo ever gets a second contributor or an
autonomous CI-triggered agent run, re-open the repo-local version of this fix rather than assuming
the global one covers it.

### Why review-gate leniency is currently unreachable, on purpose

`ugcportal-1xf` found that a genuine review-round marker chain could be extended by one forged
comment into the lenient rounds-4–5 band. The fix (`gh-59`) requires that an "exact" (trusted)
chain's markers not be authored by the PR's own account. In this repo, review runs as the same
GitHub identity that authors the PRs (`gh api user` and `gh pr view --json author` return the same
login) — so every chain here now reads `approx`, and `approx` never enters the lenient band. That
is `ugcportal-62b6`'s open problem: the only real fix is a separate reviewing identity (bot account
or GitHub App), not another integrity check, because *any* artifact the skill can read can be
written by whoever holds the reviewing token. Do not try to special-case this in the skill itself —
that was considered and rejected for the same reason the original forgery was possible: it can't
distinguish a genuine marker from one the beneficiary wrote.

### Why the pre-push mechanical gate extends the existing hook instead of adding new tooling

`ugcportal-2pnq`'s spike measured local mechanical checks (lint/typecheck/test/build) at ~16s
combined versus CI's ~94s mechanical-step time (131s full job), and recommended adding them —
but to the **existing** git-tracked `.beads/hooks/pre-push` (which already owns
`core.hooksPath` and has a documented extension point), not a new tool like husky. Reasoning:
`beads` already manages that hook; adding a second hook-management layer risks the two fighting
over `core.hooksPath`.

### Why the bead-level cost dataset (`ugcportal-bf7`) is not being used to recalibrate model tiers yet

`sonnet`-tagged and `opus`-tagged beads cost about the same to build and review across this
repo's closed-bead history (662k vs 718k avg `tokens_impl`) — nowhere near the ~2.5× the
list-price ratio between the tiers predicts. Tempting conclusion: the tiers don't matter. Real
conclusion, stated explicitly in `bf7`'s close reason and `harness-cost-controls/SKILL.md` §6: the
`sonnet` tag was **decorative** for most of this dataset's window, because the routing bug (§ above)
meant an unmarked spawn silently inherited Opus regardless of the bead's own tag — the fix landed
2026-09-29, near the end of the measured window. Re-run the comparison after a dozen or so beads
close with the fix actually in effect before treating a persisting sonnet-close-to-opus figure as
real.

---

## 3. Dead ends — things tried and abandoned

**Do not retry these without new information.**

- **A hand-rolled scanner for the pre-push sweep-candidate enumerator** (`ugcportal-5dr6`/`plp6`,
  rounds 1–3). The first version of `scripts/sweep-candidates.mjs` scanned diffs for
  `toContain`-style assertions and unguarded sibling fields with hand-written string/regex logic.
  Round 1 found 10 bugs in it. Round 2 found 4 more in the *same* logic. Round 3's finding was not
  another bug — it was that patching a hand-rolled parser one edge case at a time was itself the
  wrong response, so the parsing core was rewritten onto the `typescript` package's real AST.
  Round 4 then found one genuine medium (an env-var empty-value bug that would have silently broken
  local builds) plus a few lows, filed rather than chased further (`ugcportal-lykb`, `cchw`). The
  general lesson, not scoped to this one script: **if review round 2 is still finding new edge
  cases in a hand-written scanner over structured syntax, stop patching and reach for a real
  parser** — the edge-case surface of a hand-rolled lexer is unbounded in a way a real parser's
  isn't.
- **Closing the marker-forgery hole with a stronger integrity check alone** (`ugcportal-1xf`).
  Considered and rejected: any additional corroboration check (a second marker, a cross-referenced
  comment, a signed timestamp) can be written by whoever holds the reviewing token, same as the
  original marker. The only fix that actually closes the hole is separating the identity that
  writes the marker from the identity that benefits from it — see `ugcportal-62b6`.
- **Treating the `ANOMALY_KEYS` guard as a completeness guarantee** (`ugcportal-4il`). The guard
  added in `gh-51` stops a *listed* counter key from vanishing silently, but it does not guarantee
  a *new* drop path gets a key added at all — someone still has to remember, by hand, at both the
  increment site and the declaration. The `drop()` chokepoint added in `gh-57` is the actual fix:
  every early exit from the per-line scan loop now goes through one helper, so a future silent-drop
  path shows up as a different-looking line in a review diff instead of blending into a list of
  near-identical `continue` statements.

---

## 4. Claims in the repo you should re-check before trusting

- **The ~$795 figure in `harness-cost-controls/SKILL.md` §4 is a pre-fix baseline, not a confirmed
  recovered saving.** `ugcportal-0xw`, the bead that re-runs the measurement over a window entirely
  after the routing fix (2026-09-29 onward), has not run as of this writing. Until it does, that
  number describes what *would have been* recoverable, not what has been.
- **`harness-cost-controls/SKILL.md` §1 still frames the `.claude/settings.json` edit as an
  outstanding manual task for "a human to apply by hand."** That's true for a repo-local,
  versioned fix — nobody has done that — but it undersells that a *different*, non-versioned,
  single-machine version of the fix is already live (see § 2 above). A reader skimming only that
  section could reasonably conclude nothing has happened yet. Flagged here rather than fixed:
  `.claude/skills/**` is out of scope for this document to edit.
- **The sonnet/opus cost-parity finding in `SKILL.md` §6 is explicitly not yet meaningful** — see
  § 2 above. Don't cite the 662k/718k figures as evidence that model tier doesn't matter; the
  dataset that produced them was contaminated by the very bug the phase fixed.
- **`CLAUDE.md`'s team-maintainer bullet and severity-gate section are now current** (`gh-55`,
  `ugcportal-7yr7`) — confirmed by reading the file directly while compiling this document. This
  was stale before this phase; it is not stale now.

---

## 5. Open questions — genuinely undecided, and whose they are

**Eirik's, and they block real evidence:**

1. **Does the routing fix actually recover the spend it should?** `ugcportal-0xw` needs to run over
   a clean post-2026-09-29 window before anyone quotes a recovered-dollar figure as fact.
2. **Is the identity-separation migration for review worth doing now?** `ugcportal-62b6` — stand up
   a bot account or GitHub App for `pr-review-merge`, migrate existing in-flight PRs' marker chains
   (which will read `broken` under the new identity until a documented reset comment is posted),
   and get the lenient rounds-4–5 band back. Real cost either way: doing nothing keeps every review
   at the strict 1–3 rule set indefinitely.

**Open and nobody's yet:**

- `ugcportal-ju4` — no in-repo automatic check exists yet for the routing regression recurring
  silently (this phase's own K6 gap, carried over from `9ak`).
- `ugcportal-ws3` — why some beads take ten review rounds is still unanswered; flagged as adjacent
  to, but distinct from, the cost-per-round question this phase closed out.
- `ugcportal-qmxl`, `lykb`, `cchw` — small, low-priority residuals (CI env-var wiring; two
  narrow assumptions in the pre-push hook and sweep-candidate script about checked-out HEAD).

---

## 6. Deliberate non-goals

- **Loosening the exact/approx chain distinction to get lenient rounds back without an identity
  change.** Considered and rejected as part of `ugcportal-1xf`'s fix — it would re-open the exact
  forgery hole the fix closed. The only legitimate way back to `exact` is `ugcportal-62b6`.
- **Recalibrating `CLAUDE.md`'s model-fit tiers off the current bead-level dataset.** `bf7` found a
  reason the data can't support that yet (see § 2); doing it anyway risks encoding a routing bug as
  a tier-fit conclusion.
- **Reducing review depth or round count to bank the cost savings from this phase.** Still `9ak`'s
  K5 and still a guardrail: this phase's own review rounds caught a live forgery exploit and a
  denial-of-service bug in the review gate itself. Cost work may change what a round costs; it may
  not remove one.

---

## 7. Operational facts that will bite

1. **Every review chain in this repo currently reads `approx`, not `exact`.** Any PR carrying so
   much as one low-severity finding into round 6 will escalate to a human rather than auto-merge
   with lows filed, because the lenient band is unreachable until `62b6` lands. This is not a bug —
   it's the accepted cost of closing the forgery hole — but it will look like the severity gate
   "not working as documented" if you haven't read this handoff.
2. **The subagent-routing fix will not travel with the repo.** Clone this repo on another machine,
   hand it to another contributor, or run it under CI, and the Opus-inheritance bug from `9ak` is
   back, because the fix lives in one person's global `~/.claude/settings.json`, not in anything
   version-controlled here.

---

## 8. Where the raw material lives

`bd show <id> --json` for every bead named above is the primary source for this document — bead
notes here are unusually detailed (several run to 3,000+ words per bead) and are the authoritative
record of what was tried, measured, and decided. `~/second-brain/03-professional/AI-USAGE-ECONOMICS.md`
carries the cost-economics narrative this whole phase traces back to, updated 2026-09-30 with a
"what actually happened" section mirroring this document's §§ 1–2. Where the two disagree, the
`bd` bead record is authoritative on *what* shipped and *when*; the second-brain note is written
for a different audience (the underlying investigation, not this repo's mechanics) and should not
be treated as more current.
