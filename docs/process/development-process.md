# How ugcportal is built: from a prompt to a retrospective

Bead: `ugcportal-ag06`. Written 2026-10-09 at `77fb833`.

This describes the process as it is actually practised, including the parts
that do not work. It is not a proposal and it is not aspirational. Where a
rule has a number in it, the number came from a measurement, and the
measurement is cited.

The process exists today as enacted behaviour spread across five project
skills, three user skills, 51 `bd` memories, three sections of `CLAUDE.md`,
and a running error log. Each piece is individually documented. Nothing
described how they fit together, which is what this is for.

**Who does what.** Eirik owns direction, scope, and every attestation. An
orchestrating agent owns the queue, the briefs, and the records. Subagents
implement and review. The division matters because several failures below
come from one of the three doing another's job.

---

## 1. The unit of work

The unit is the **bead**: one issue in `bd`, carrying a user story, scope
lines, numbered acceptance criteria, a verified premise, and metadata. One
bead becomes one pull request. One pull request merges or it does not.

This is the single most load-bearing choice in the process. Everything else
is a consequence of it:

- a bead that cannot be verified by the person finishing it is a bead that
  cannot be honestly closed, so criteria must be self-contained;
- a bead whose premise has expired is work that should not start, so
  premises are checked before writing and re-checked before dispatch;
- a pull request that grows past its bead loses the thing that bounded it,
  so scope freezes at first push.

The failure mode the unit is defending against is not "a bad feature". It
is **work that looks finished because its record says so**.

---

## 2. Phase 1 — a prompt becomes a user story

Work starts as something Eirik says, usually loosely: a frustration, a
screenshot, a decision made away from the keyboard. It is not yet a task.

What happens is a **drift**: the prompt is restated as a user story of the
form *As a `<role>`, I want `<capability>`, so that `<benefit>`* and handed
back. The restatement is where the real question gets asked, because a
prompt describes a symptom and a story has to name a beneficiary.

The `create-user-story` user skill covers this shape generally. In practice
the drift is done inline, in conversation, and its output goes straight into
a bead's description.

**Why the "so that" clause is not decoration.** It is the only part of the
story that can be checked against reality later. A capability can be built
exactly as described and still deliver no benefit; the benefit clause is
what a retrospective measures against. Two examples from this repo where
the clause did the work:

- A bead asked for three numeric hobby-versus-business tax triggers. The
  benefit clause would have read "so that we know when to register a
  business". Asked directly, Eirik's answer was that this is a hobby that
  will never replace either day job — so the triggers were **withdrawn, not
  deferred** (`ugcportal-qnq9.13`). The capability was well specified and
  pointless.
- A bead to build third-party contributor machinery survived, but was
  deprioritised, once the beneficiary was named: only Eirik and Gry publish
  and sell.

**What goes wrong here.** The drift invents a beneficiary the user never
mentioned, and the invented beneficiary justifies scope nobody asked for.
The guard is to name the beneficiary explicitly and let Eirik reject it —
cheaply, in a sentence, before a bead exists.

---

## 3. Phase 2 — a user story becomes a bead

Governed by the **`bead-template`** user skill, which is the required form,
not a style guide.

A bead has: the user story; an explicit `In scope:` and `Out of scope:`
line; numbered `K` criteria each with a literal `Verified by:` clause; at
least one guardrail criterion phrased *"Following should never happen: …"*;
a `Premise verified:` line in the notes; and metadata (`cc_type`,
`cc_scope`, `model`, `model_effort`, `model_why`).

Three checks happen **before** the bead is written, and they matter more
than the form:

1. **Premise check.** Verify the central assumption against the actual
   environment, usually with one command, and record what you checked.
2. **Self-contained criteria.** Every `K` must be verifiable by whoever
   finishes *this* bead, on the day they finish it, with only what this bead
   delivers.
3. **Scope lines are mandatory.** `Out of scope:` is the single most
   effective line in the form — it is what stops an implementer quietly
   absorbing adjacent work — and it should name the bead that owns each
   excluded thing.

**Why `Out of scope` earns that claim.** Two cases, each individually
defensible, each of which roughly doubled its pull request: an
access-control bead absorbed four adjacent media-API fixes found during
review; a rights-gate bead invented a data model and an endpoint because its
own criterion was unverifiable without them. The second is the instructive
one — a criterion that cannot be verified without building something else is
a **bead-authoring defect caught late**, and check 2 above is what should
have caught it.

**The guardrail criterion is where the value is.** Write it against the
failure that would actually hurt — data loss, a leaked credential, an authz
bypass, an unwatermarked original — not as a restatement of the positive
criterion. A worked example from this release: a bead for per-item licence
terms (`ugcportal-74w.1`) has as its guardrail *"an item is offered for sale
showing licence terms that grant more than its own rights clearances
support"*. That is the one way the feature makes things **worse** than the
status quo, and it is not visible from the positive criteria at all.

**What goes wrong here.**

- *A bead written on a false premise.* Three instances this release. One
  proposed removing an "unused" dependency that `src/app/globals.css`
  imports on line 125 — removal would have broken the build and the suite.
  One claimed seed scripts and committed fixtures existed; neither did. One
  described work already finished.
- *An empty bead.* `ugcportal-74w.1` sat open at P2 inside a release
  line-up as a **title with no body** — no description, criteria, notes or
  metadata — eligible for dispatch to an implementer with nothing to build
  from. Filing a follow-up bead is only half the obligation; an empty bead
  is a placeholder that looks like tracked work.
- *A stale title after a descope.* `ugcportal-yzo7` shipped as "price and
  licence" and delivered price only. Its notes recorded the descope honestly
  and it filed the follow-up correctly — but the title, the `In scope:` line
  and `K1` were all left asserting the undelivered half, so anyone checking
  that bead before building something adjacent is told the feature exists.
  Memory: `amend-the-title-when-you-descope-not-just-the-notes`. **A closing
  note is an addition to the record, not a correction of it.** Notes are
  read last; titles first.

---

## 4. Phase 3 — the release line-up is audited before work starts

Before a release's beads are dispatched, the whole line-up is audited.
`docs/process/premise-audit-v0.7.0-2026-10-08.md` is the worked example and
`docs/process/backlog-review-2026-10-06.md` its predecessor.

The audit asks three questions of every bead in the line-up:

1. **Is the premise still true?** Premises expire silently. A bead verified
   three weeks ago against a codebase that has since moved is a bead with an
   unverified premise, regardless of what its notes say.
2. **Is the dependency graph sound?** Cycles, and — more commonly — beads
   whose every blocking path terminates in deferred or non-existent work.
3. **Is anything unowned?** The v0.7.0 audit found **eighteen ownership
   gaps**: behaviour the code implements, or the law requires, that no bead
   claimed.

It paid for itself immediately: at least two builds were prevented that
would have been wasted, and the eighteen gaps became beads.

**The mechanical half is now a script.** `scripts/check-unreachable-beads.mjs`
(`ugcportal-z4nh`, merged in PR #207) walks `blocks` edges and reports every
open bead whose every blocking path ends in deferred or missing work. A
dependency cycle is deliberately **not** a third termination reason — the
walk treats a back-edge as resolved — and the script's own header says so,
because it is the thing a reader expects next to the other two. Its first
live run on the real backlog
flagged **ten**, of which seven were in the v0.7.0 line-up — including two
review beads (`5x8` security, `rma` architecture) gated behind features that
will not be built this release. A security review that waits for Stripe and
Instagram before it can start is a review that never happens.

The distinction worth preserving: the script answers "can this bead ever
reach `bd ready`", which is mechanical. The audit answers "should this bead
exist", which is not.

**What goes wrong here.** Both audits were scoped to the release line-up, so
beads labelled `backlog` were never walked — which is why the script found
three stuck beads the hand audit had not. Scope your sweep wider than the
thing you are about to ship, or say explicitly that you did not.

---

## 5. Phase 4 — one bead, one pull request, bounded review

### 5.1 Dispatch

An implementer agent gets a brief. The brief names the bead, the setup, the
quality bar, and the boundaries. Concurrency is held to **three** implementer agents in practice, and never
two on the same `cc_scope`. This is current orchestrator practice, **not a
codified rule** — `ugcportal-yzmp` proposes making it one and is still OPEN;
its own premise records that no cap exists in any enforced form.

Mandatory setup, because each has burned a session:

- a **private git worktree** — the main checkout is shared, and agents run
  `git` only in their own tree and `bd` only in the main checkout
  (`shared-checkout-is-not-safe-for-agents`);
- **`npx prisma generate`** after `npm install` — without it 8 test files
  silently fail to *collect*, so the suite reports a plausible but low total
  rather than erroring (`a-fresh-git-worktree-without-npx-prisma-generate`,
  `silent-test-file-collection-drop-the-same-failure`);
- **capped vitest workers** (`VITEST_MAX_FORKS=3 VITEST_MAX_THREADS=3`) when
  several agents run (`cap-vitest-workers-when-many-agents-run`); a prior
  agent drove load average to 299 on a 10-core machine
  (`never-start-load-generators-in-agent-briefs`).

**The rule that governs briefs**, learned three times this release at
increasing cost: *never enumerate a set in a brief from memory*
(`never-enumerate-a-set-in-a-brief-from-memory`). Paste the grep with the
command that produced it, or tell the implementer to derive the set and
report what they find. Three stale enumerations shipped into briefs in one
session — a test baseline, a bead id that had never existed, and a
four-item list of scope consumers that was really six. **Two were harmless
for exactly one reason: the brief asked the agent to re-derive the set and
report discrepancies, so the error surfaced as a finding instead of a silent
gap.** Brief an expected result as *a check to be explained*, never as *a
specification to be matched*.

Related: `verify-every-bead-id-before-putting-it-in-a-brief`. A bead ID
reads as authoritative because it looks like it came from the tracker, even
when it came from a comment someone typed.

### 5.2 Implementation

The implementer builds, tests, runs the gate (`lint`, `test`, `build`,
`typecheck` — all four, in that order: `typecheck` must follow `build`,
which is the order `.github/workflows/ci.yml` runs them in), and opens one PR with a Conventional Commit title
carrying the bead id. `CLAUDE.md` holds the type table and its semver
mapping.

Before pushing, the implementer runs a self-sweep for the four recurring
defect families (§5.4) and `/pre-review` with `scripts/claims-audit.mjs`.

**The discipline that makes a test worth having:** *mutate the fixture, not
just the production code* (`mutate-the-fixture-not-just-the-production-code`).
Change the expected value, confirm the test goes red, change it back. An
assertion that cannot fail is treated as inheriting the severity of whatever
it guards — so a dead assertion over a security gate is medium-or-above, not
a nit.

### 5.3 Review, and the stopping rule

A separate reviewer agent runs the **`pr-review-merge`** skill against the
PR. Each pass stamps a round marker comment. A pass that stopped at red CI
reviewed nothing and does not count as a round.

| Round | What blocks the merge |
|---|---|
| 1–3 | **Any** finding, CONFIRMED or PLAUSIBLE, at any severity. Fix everything. |
| 4–5 | Any **medium-or-above**, confirmed or unsettled. Lows are filed as beads and the PR merges. |
| 6 (cap) | The same — but a blocker here goes to a **human**, not a seventh round. |
| 7+ | Only on an **exact** marker chain, anchored to the latest stop comment at or above 6, with evidence someone acted since it. See `pr-review-merge` step 5b, which is operative — `CLAUDE.md`'s phrasing of this row is stale relative to it. |

**Why severity and not a flat count.** Measured 2026-09-25 across five beads:
3.40M tokens of implementation, 1.32M of review, ~0.95M per bead, with a
worst case of **ten implementation rounds and nine review passes**
(`ugcportal-r1d`). Value decayed *unevenly*: `0ss` round 7 found a live
fail-open (`NaN <= number` is `false`, so an `Invalid Date` skipped an expiry
check and the gate could return sellable); `r1d` round 9 found a migration
backfill minting 32-char hex where the runtime minted 36-char dashed UUIDs
for the same column; `e86` rounds 8 and 9, by contrast, found an inaccurate
comment and 27 duplicate stderr lines.

The argument is **not** that a flat cap would have funded the wrong one.
**There is no cap setting that keeps the two still earning and drops the one
that was not** — at five it stops all three, including `0ss` and `r1d`
*before* their defects surface; set high enough to reach round 9 it funds all
three. The number of rounds carries no information about what a round is
finding. Severity does. See `.claude/skills/review-standards/SKILL.md` §
opening, which is the operative source; `ugcportal-2yj` has the full
rationale.

**Confidence changes what a low costs, never what a medium costs.** From
round 4 an unsettled plausible medium blocks exactly as a confirmed one
does. Both late-round defects that motivated the rule presented as
unconfirmed plausible mediums before anyone ran them down.

**The gate's lenient band has never been legitimately reached in this
repo.** (It was applied by mistake three times in v0.5.0 — PRs #60, #61,
#75 — which is a separate defect, not an exception to this.) The
reviewer and the PR author are the same GitHub account, so every marker
chain computes as `approx` rather than `exact`, and an `approx` chain runs
the strict rounds-1–3 rule at *every* round. Cost of that, measured: one P3
bead consumed **987k review tokens**. The fix is a separate reviewer
identity (`ugcportal-62b6`) — a bot account or GitHub App — and it is
pending on Eirik. This is the largest known inefficiency in the process and
it is structural, not behavioural.

### 5.4 The four recurring defect families

Most review rounds go to a handful of shapes. Sweeping for the *class* costs
one round and repeatedly replaces several.

1. **A comment claims a guarantee the code does not make.** A guard that
   cannot fire; a documented memory figure covering one code path of four; a
   doc line contradicting the table below it. Especially common in a comment
   written to record a *measurement*. In v0.5.0's late rounds this was **35
   of 57 lows (61%)**.
2. **A check compares the wrong two things.** A request-derived value
   against configuration; two columns written by the same author (which
   proves only self-consistency); or the NaN/null variant, where a
   comparison silently returns `false` for unparseable input and **fails
   open**. A live instance this release: a dependency filter matched nothing
   because of a wrong field name, so every bead read as unblocked and the
   walk reported "nothing is stuck" — *the wrong answer was the reassuring
   one* (`bd-show-json-and-bd-list-json-have-different-dependency-shapes`).
3. **An assertion that cannot fail.** The needle is present, or absent,
   regardless of what the code does. The test is one question: *what weaker
   implementation would still pass this, and could the needle ever actually
   be absent?* Distrust the needle that is **always present** — that is the
   property that makes the direction of an assertion easy to get backwards.
4. **Sibling omission.** One instance is fixed and its siblings are not.
   When you grep for siblings, **grep the subject** — the function, the
   field, the mechanism — **not the sentence you just fixed**. Patterning
   the search on your own wording finds copies of your wording and is blind
   to independent phrasings of the same claim, which is exactly where an
   uncorrected sibling hides (`sibling-grep-the-subject-not-the-sentence`).

A sharp illustration of family 4 from this release, on `ugcportal-z4nh`:
round 1 found an untested cycle guard in `buildChain`, plus two unasserted
branches — `formatReport`'s `(none)` line and `formatChain`'s
deferred-with-date branch. The fixes were correct. Round 2 then found that
`formatChain`'s *cycle-note* branch — two lines from the date branch round 1
had just fixed, in the same function — had the identical gap. **The fix
landed directly beside a second instance of its own defect.**

### 5.5 Scope freeze

From first push, work discovered during review becomes **its own bead** with
a `discovered-from` edge, not an addition to the PR in flight. Every
deferred finding is filed with its severity recorded — nothing above low is
ever closed by the cap rather than by a decision.

### 5.6 Merge and close-out

On merge: squash, then clean up through `scripts/sweep-merged-branches.mjs`
rather than by hand. It retargets any open PR based on the branch before
deleting it, because deleting a branch an open PR lists as base auto-closes
that PR and GitHub refuses both reopen and base-change afterwards — observed
three times in one day (`stacked-prs-close-when-base-branch-deleted`).
**Read the script's output rather than assuming success.**

Then the bead is closed with `cc_type`, `cc_scope`, `prs` (merged PRs only —
a closed bead listing an open PR makes release tooling claim unshipped work
as released), `tokens_impl`, and `tokens_qa` accumulated per round.

---

## 6. Phase 5 — the retrospective

Two instruments, with different jobs.

**The cost reports** (`docs/process/release-cost-*.md`) are generated from
bead metadata by `scripts/release-cost-report.mjs` and answer *what did this
release cost and which way is it moving*. Selected findings:

| Measure | v0.4.0 | v0.5.0 | v0.6.0 |
|---|---:|---:|---:|
| Beads shipped | 38 | 54 | 85 |
| Recorded cost per bead | 568k | 565k | 560k |
| Median review rounds per PR | — | 4 | 2 |
| PRs reaching the 6-round cap | — | 11 | 1 |

Per-bead cost has been **flat within 1.5% across three releases** while
per-bead *review* cost fell and throughput rose. The cost did not disappear;
it moved out of late rounds and into round 1, which is now 68% of review
spend. That is the intended direction.

**The round analyses** (`docs/process/review-rounds-v0.5.0.md`) answer *why*
and are the more valuable of the two. That one found: 53% of rounds found
only lows; **every one of 11 cap escalations to Eirik ended in a merge**,
changing no outcome while adding 30 minutes to 7.5 hours of latency each;
and the cause the bead had not named — implementers *did* self-report the
four-family sweep in 14 of 14 PR bodies, and the reviewer still found a
family-1 item at round 1 in 13 of them. **A self-administered sweep without
a mechanical list in front of it is weak.** `/pre-review` and
`scripts/claims-audit.mjs` exist because of that finding.

**The error log.** `ugcportal-fbng` collects process errors and rule
violations as they happen, in two sections: orchestrator errors and
agent-side errors. Writing it *during* the release rather than after is
deliberate — the cause of an error is legible for about an hour and
reconstructed wrongly thereafter.

The **`retro`** user skill covers the general retrospective shape.

**What goes wrong here.** The retrospective measures what is recorded, and
recording is itself a behaviour that decays: v0.4.0 has review figures for
only 16 of 38 beads, so its review-cost row is a loose lower bound and its
"review share" of 23% is an artefact rather than a finding. A measure that
is cheap to omit will be omitted under load.

---

## 7. The instruments

**Project skills** (`.claude/skills/`):

| Skill | Job |
|---|---|
| `pr-review-merge` | The review loop: rounds, locks, severity gate, merge, cleanup |
| `review-standards` | What a finding is and how severity is assigned |
| `pre-review` | Implementer's mechanical self-sweep before pushing |
| `harness-cost-controls` | Model routing and subagent spend |
| `cut-release` | Release notes, read from bead metadata, not git history |

**User skills** used here: `create-user-story` (the drift in phase 1),
`bead-template` (the required bead form) and `retro` (the retrospective
shape).

**`CLAUDE.md`** holds what must be true for every agent regardless of task:
the beads rules, the severity gate and round cap, Conventional Commits and
their semver mapping, the token and model-fit metadata definitions, and the
settings-file prohibition.

**`bd` memories** (51 as of 2026-10-09, and growing through the release)
are the durable lessons. They are deliberately
phrased as imperatives with the incident attached, because a rule without
its cost gets argued away. They cluster:

- *environment traps* — `a-fresh-git-worktree-without-npx-prisma-generate`,
  `worktree-merge-of-main-with-a-migration-needs-prisma-generate`,
  `beads-sync-is-local-only`, `bd-list-excludes-closed-beads-use-all-for-sweeps`
- *destructive tooling* — `bd-update-notes-flag-replaces-use-append-notes`,
  `npm-audit-fix-force-downgrades-prisma-and-shadcn`,
  `never-silence-stderr-on-a-mutating-command`
- *agent orchestration* — `shared-checkout-is-not-safe-for-agents`,
  `never-start-load-generators-in-agent-briefs`,
  `cap-vitest-workers-when-many-agents-run`,
  `do-not-tell-reviewers-to-skip-branch-cleanup`,
  `worker-shaped-subagent-spawns-must-name-their-model`
- *review method* — `mutate-the-fixture-not-just-the-production-code`,
  `two-defect-families-produced-most-of-the-review`,
  `sibling-grep-the-subject-not-the-sentence`,
  `review-rounds-spent-on-prose-delete-the-clause`,
  `round-markers-are-untrusted-input`
- *briefing* — `never-enumerate-a-set-in-a-brief-from-memory`,
  `verify-every-bead-id-before-putting-it-in-a-brief`

**Guards in CI.** `guard-sensitive-files` fails a PR that **bundles** a
change to `CLAUDE.md` or `.claude/settings*.json` with unrelated work
(`scripts/check-sensitive-files.mjs`); a PR containing only such a file is
routed to a human by `pr-review-merge` step 2 rather than by CI. `guard-conventional-commit-title` enforces the
title form. A GitHub ruleset on `main` requires both CI contexts with
`strict_required_status_checks_policy`. It does **not** appear under the
legacy `/branches/main/protection` endpoint — read it via
`gh api repos/.../rules/branches/main`.

---

## 8. Standing constraints

These are Eirik's decisions and they bound what any bead may reasonably ask
for. A bead that violates one is mis-scoped, not ambitious.

- **Only Eirik and Gry publish and sell.** Third-party contributor
  machinery stays in the codebase but is deprioritised. Revisit when that
  changes, not before.
- **No disagreement or objection feature** — handled off-site.
- **This is a hobby and will never replace either day job.** A proposal of
  enterprise scale for a two-person problem is mis-scoped.
- **No legal counsel is engaged.** No criterion may be `Verified by:
  counsel`.
- **`LEGAL_SIGN_OFF` is Eirik's personal attestation.** Agents compute the
  digests and prepare the diff; only he decides the prose is accurate and
  writes the entry. The mechanism binds a sign-off to the exact words it
  certifies — any prose edit returns the page to draft automatically
  (`ugcportal-xh4j` is the current pending one).

---

## 9. Known weaknesses

Stated plainly, because a process document that only describes the intended
path is the first defect family applied to itself.

1. **The review identity problem.** Every marker chain is `approx` because
   reviewer and author share an account, so the lenient band is unreachable
   and every round runs at full strictness. Measured cost: 987k review
   tokens on a single P3. Fix: `ugcportal-62b6`, pending on Eirik.
2. **The orchestrator is the least-reviewed participant.** Implementers and
   reviewers are checked by each other; the orchestrator's briefs, bead
   edits and metadata writes are checked by nobody. Every error in section A
   of `ugcportal-fbng` is an orchestrator error, and several were caught
   only because an agent happened to re-derive something.
3. **Premises expire faster than they are re-checked.** The audit exists
   because of this and is itself a point-in-time artefact. Two beads were
   re-verified at `54d88ca` and dispatched against `77fb833`, eighteen
   commits later.
4. **Recording decays under load.** Token metadata, `prs`, and premise lines
   are all written by hand at the moment of least patience — after the work
   is done.
5. **Review finds claims far more readily than logic.** Across the v0.7.0
   rounds, the overwhelming majority of blocking findings were false or
   unsupported claims rather than logic defects. That is partly a compliment
   to the implementers and partly a warning about what review is good at.

   The flat version of this claim — "review never found a logic defect" —
   is **false**, and worth stating carefully because the document asserted
   it in an earlier draft. Review did find logic defects, and the conditions
   under which it did are the useful part:

   - **when a brief pointed it at a layer nobody had looked at.** `#207`
     round 4 found that `bd list --all` silently omits gate, infra and
     template beads, so a bead gated on a *closed* gate would be reported
     as permanently stuck. Three prior rounds had concentrated on the
     rendering layer; round 4's brief said explicitly that this is the
     condition under which a logic defect gets waved through.
   - **when a fix round regressed something.** `#201` round 6 caught a
     confirmed regression against real data.

   What review did **not** catch is the two logic defects that were already
   in the first push, both found instead by *executing something against
   reality*:

   - a `NOT: { listing: { is: { depictsPeople: true } } }` that is wrong
     under SQL three-valued logic on a nullable column, and would have hidden
     every published triage-started row on the site — caught by the
     implementer's own TS-vs-Prisma agreement test on PR #200, before review
     saw it;
   - a preview route that served image bytes with no rights gate, so a
     photograph whose clearance lapsed vanished from all five listing
     surfaces while staying downloadable at the stable URL the sitemap had
     already given to crawlers — caught by an implementer's **premise check
     before designing** (`ugcportal-nffp`).

   A test comparing two implementations, and a probe against a real
   database. Neither was reading. That is the sharper lesson, and it argues
   for
   `Verified by:` naming an executed probe whenever the criterion is about
   runtime behaviour rather than about source text.
6. **The instruments themselves fail open.** This is defect family 2 — the
   null/undefined variant — applied to the process rather than to the code,
   and it is the most under-appreciated weakness here. A check that silently
   matches nothing reports success: a dependency filter using the wrong
   field name reported "nothing is stuck" over a backlog with ten dead
   beads; `bd` writes silenced with `2>/dev/null` were reported as applied
   when they had failed; a `||` fallback ran its second branch with the
   arguments reversed and *succeeded*, recording a graph edge backwards.
   In every case **the wrong answer was the reassuring one**, which is why
   none of them announced itself. Three mitigations, all cheap and none yet
   systematic: print the match count before trusting a zero; never silence
   stderr on a mutating command; read the object back after a write that
   matters.

7. **The cap has rarely bound on a real disagreement.** In v0.5.0, eleven
   of eleven escalations ended in a merge, making the human step latency
   rather than judgement. It is not a clean 11/11 beyond that cut: v0.6.0's
   #109 filed three findings at escalation, and in v0.7.0 Eirik authorised a
   different fix after a regression on #201 (`ugcportal-fbng` A10). The
   weakness is that the default outcome is approval, which trains the human
   to approve — not that the step has never mattered.

---

## 10. The shortest version

1. A prompt becomes a user story with a named beneficiary and a benefit
   clause that can later be checked.
2. The story becomes a bead with scope lines, self-contained criteria, a
   guardrail aimed at the failure that would actually hurt, and a premise
   verified by a command.
3. Before the release, every bead's premise, reachability and ownership is
   audited — because the expensive failure is not a bad bead, it is a bead
   that was right once.
4. One bead becomes one PR, reviewed under a severity gate rather than a
   flat round count, with scope frozen at first push and every test proven
   able to fail.
5. Afterwards, cost and rounds are measured, errors are read back, and the
   rules that failed are rewritten with the incident attached.
