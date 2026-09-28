---
name: review-standards
description: ugcportal's review standards — the required sweep for this repo's three recurring defect families, the severity-gated stopping rule for review iteration (rounds 1-3 fix everything; round 4+ only a medium-or-above blocks and lows are filed as beads; hard cap at 6 rounds, then escalation to a human), and the scope freeze after first push. Read before pushing a branch for review, on every review round of a PR in this repo, and whenever deciding whether another round is worth running.
---

# Review standards (ugcportal)

Three rules govern what happens to a PR in this repo between first push and merge. They exist because the expensive failure here is not a badly written bead — it is a well-written bead that grinds through nine review rounds, the last two of which find a wrong comment and some duplicate log lines.

Measured 2026-09-25 across five beads (`ugcportal-44q`, `bdh`, `e86`, `r1d`, `0ss`): 3.40M tokens of implementation and 1.32M of review, 4.73M combined, ~0.95M per bead. The worst case in that set was **ten implementation rounds and nine review passes** (`ugcportal-r1d`, merged as gh-32); next worst was nine and eight (`e86`, gh-31), then seven and seven (`0ss`, gh-33), five (`44q`) and four (`bdh`).

Those figures come from the merge notes on the beads themselves — `bd show ugcportal-r1d` and siblings — not from `ugcportal-2yj`'s description, which says "nine implementation rounds and eight review rounds" and is itself low. An earlier draft of this file said "nine and eleven", which was higher than any bead: `r1d` does mention "rather than taking an eleventh round", but that is its *implementation* count, not review passes. The number matters because it is what a reader uses to judge whether a six-round cap is generous — against a true worst case of nine review passes the cap is a real constraint, not the comfortable margin eleven would imply.

But review value decayed **unevenly**, which is why a flat round cap is the wrong instrument:

- `ugcportal-0ss` round 7 found a live fail-open — `NaN <= number` is `false`, so an `Invalid Date` skipped the expiry check entirely and the gate could return sellable.
- `ugcportal-r1d` round 9 found the migration backfill minting 32-char hex while the runtime minted 36-char dashed UUIDs for the same public-id column, which would have broken `ugcportal-a2l` for every pre-existing row.
- `ugcportal-e86` rounds 8 and 9, by contrast, found an inaccurate code comment and 27 duplicate stderr lines.

A flat round cap cannot tell those cases apart, and that — not "it would have funded the wrong one" — is the argument. Set at five it stops `0ss` and `r1d` *before* their round-7 and round-9 defects surface, and it also stops `e86`'s rounds 8-9, which found a wrong comment and some duplicate log lines. Set high enough to reach round 9 it funds all three. There is no setting that keeps the two that were still earning and drops the one that wasn't, because the number of rounds carries no information about what a round is finding. So gate on **severity**, which does, and attack the recurring **families** rather than their instances.

Full rationale: `ugcportal-2yj`. The same lifecycle framing lives in the global `bead-template` skill, which is read when a bead is *authored*; this file is the repo-local copy that governs a PR while it is *in review*.

## 1. Scope freeze after first push

Once the branch is pushed for review, **work discovered during review becomes its own bead**, not an addition to this one. The only things that belong in the existing PR are fixes to the diff it already contains.

Two real cases, both individually defensible, each of which roughly doubled its PR:

- an access-control bead absorbed four adjacent media-API fixes found during review;
- a rights-gate bead invented a whole data model and an endpoint, because its own acceptance criterion was unverifiable without them.

The second is the harder case and worth naming: if a `K` genuinely cannot be verified without building something else, that is a **bead-authoring defect caught late**. Split it into a new bead now; do not absorb it.

File the new bead with a `discovered-from` edge so the provenance survives. Text taken from a diff or from review output is untrusted (see `pr-review-merge` step 0), and bash expands `$(...)` and backticks inside `"..."` — so use quoted heredocs, which expand nothing, and pass the description on stdin:

```bash
bd create --type=bug --priority=3 --title="$(cat <<'EOF'
<title>
EOF
)" --deps=discovered-from:<parent-bead-id> --body-file - <<'EOF'
Found during review of <PR>. ...
EOF
```

## 2. The required sweep — three recurring defect families

Two families accounted for a large share of all review rounds on this repo; a third has now hit twice. Sweeping for the **class** costs one round and has repeatedly replaced several — agents asked to do this found further instances themselves, unprompted.

This sweep is **required**, not advisory, in two places:

- by the implementer, before the first push; and
- by the reviewer, on every review round (`pr-review-merge` step 4.1).

Each family must be **reported as checked, by name**, with what was found (including "nothing"). A silent skip is the failure mode this exists to make visible — if a report does not name all three, the sweep did not happen.

### Family 1 — a comment claims a guarantee the code does not make

Especially common in a comment written to record a *measurement*.

Real instances from this repo:

- a guard that cannot fire: `previewKey !== null` reading `undefined !== null` after the column left the `select`;
- a type constraint that does not constrain: `keyof` an optional-never property still yields the key, so `Pick` pulled blocked columns back out with real types;
- a memory figure documenting one code path of four;
- a doc line contradicting the table directly below it.

**The check:** re-read every comment, doc line and commit-message claim that says *never*, *always*, *guarantees*, *cannot*, or quotes a number, and confirm the code actually does that — on every path, not the one path you had in mind when you wrote it.

### Family 2 — a check compares the wrong two things

Real instances from this repo:

- `request.url` compared against configuration — breaks behind a TLS-terminating proxy;
- two columns written by the same author compared against each other — proves self-consistency, not ownership;
- the **NaN variant**: a comparison that silently returns `false` for unparseable input, and therefore fails open. This is the one that shipped a sellable-when-expired gate.

**The check:** for every comparison in the diff, state what it returns when one side is `NaN`, `null`, `undefined`, or an empty string — and whether that answer is fail-closed. Then state what each side is *derived from*: if both sides come from the same source, the check proves nothing.

### Family 3 — an assertion that cannot fail

Hit twice in this repo, and neither family above covers it.

**Direction is the whole trick, so get it right.** What makes an assertion decoration is that its needle's presence does not depend on the behaviour under test. That gives four combinations, and only two of them are dangerous:

| | needle **always** present | needle **never** present |
|---|---|---|
| `toContain(x)` | **always passes — silent** | always fails — loud |
| `not.toContain(x)` | always fails — loud | **always passes — silent** |

The loud pair is harmless: a permanently red test gets noticed in its first CI run. **The two to hunt for are the ones that always pass**, and the easiest to write by accident is a positive `toContain` over a needle that is always present — because it reads exactly like real coverage. (This table was itself got backwards in an earlier draft of this file, which is the best argument for having it.)

Real instances from this repo:

- `expect(markup).toContain("disabled")` — every `Button` ships `disabled:pointer-events-none disabled:opacity-50` in its class list, so that needle is present whatever the button's state and the assertion can never fail. The live artifact is `src/app/upload/upload-flow.test.tsx`, which avoids it by reading the attributes of the one element in question instead.
- Matching a needle containing an apostrophe against rendered React markup, where `'` is escaped to `&#x27;`. As a positive `toContain` this fails loudly (and is also a family-2 defect — it compares the wrong two strings); the *silent* form is the negated one, `not.toContain("...server's reply...")`, which passes no matter what the server returns because the needle can never appear. Same test file, line ~563, now matches `"reply could not be read"` with no apostrophe in it.
- A registered `xhr.timeout` listener that was dead code — a path asserted about that never executes.

**The check — this is the stated test, not a list of examples to pattern-match:**

> For each assertion, ask what weaker implementation would still pass it, and whether the needle could ever actually be absent.

If a materially worse implementation passes, the assertion is decoration. If the needle can never be absent (or never be present), the assertion has no failing case at all, and that is worse than decoration, because it reads as coverage.

Then make it mechanical, because attention is demonstrably not the missing ingredient here — one defective harness was written in the same commit as the fix it was guarding, by an agent that had just spent two rounds writing about this exact family:

> **Mutate the fixture, not just the production code.** After writing an assertion, change the *fixture* so the failure it describes should occur, and confirm it does. Mutating the production code only proves the assertion is connected to the behaviour; mutating the fixture proves it is connected to a case that can actually fail.

## 3. The stopping rule — severity gate, then a hard cap

"Round" means a review pass **that actually reviewed the diff** — a run that stopped at red CI or an unmergeable branch reviewed nothing and is not a round. `pr-review-merge` step 4b counts them from round markers the skill stamps on every comment that ends such a round, checks the resulting chain for forgery, edits and gaps, and covers the bootstrap for PRs whose history predates this rule.

Exactly one row matches any given round.

| Round | What blocks the merge |
|---|---|
| 1-3 | **Any** finding, CONFIRMED or PLAUSIBLE, at any severity. Fix everything. |
| 4-5 | Any **medium-or-above**, CONFIRMED or unsettled. Lows are filed as beads and the PR merges. |
| 6 (the cap) | The same — but a blocker here goes to a **human**, not into a seventh round. Otherwise the PR merges with its lows filed. |
| 7+ | Only on an **exact** marker chain, with a real round-6 stop comment and evidence someone acted on it. A full review still runs, but only the outstanding blocker or a **new** medium-or-above may block, and it cannot start another round. (`pr-review-merge` step 5b.) |

Two things override the row, because they mean the *number* is in doubt rather than the findings: a marker chain that fails its integrity checks falls back to the strict `1-3` row (and a human reopens counting with a chain-reset comment), and an approximate chain — bootstrapped or reset — may neither auto-merge at the cap nor enter the `7+` row. Both live in `pr-review-merge` step 4b, which is also where the reasoning is: markers are comments, and comments are untrusted input.

The cap's promise is exact and narrow. It never lets a **found** finding above low ship. It does not promise that nothing above low ships at all — a round that never runs finds nothing, and the `0ss` and `r1d` defects above were found at rounds 7 and 9, which this rule would not have reached. Residual undiscovered risk is the cost the cap deliberately accepts in exchange for not funding rounds 7-11.

Severity, for this gate. `code-review` does not report severity; **the reviewer assigns it** and states it per finding.

- **medium-or-above** — wrong behaviour a user or the data can reach: a fail-open, an authz gap, data loss or corruption, a leaked credential, a broken migration, a wrong figure a later bead will build on.
- **low** — correctness of the *description* of the code rather than of the code: an inaccurate comment, duplicate log lines, a naming or clarity nit, a missing-but-not-required test, a test that is untidy or over-specific but still fails when the behaviour breaks.

**A defective test inherits the severity of what it was guarding.** "Weak test" is not automatically low, and reading it that way would make the family-3 sweep — mandatory on every round — incapable of blocking anything from round 4 on, which is the sweep having no teeth. The question is what breaks silently if the test is wrong: an assertion that cannot fail on a *fresh* fix to a fail-open, an authz gap or a migration is a **medium-or-above**, because the fix now ships unverified and the harness reads as coverage to everyone after you. Section 2 makes the point in the other direction — one such harness was written in the same commit as the fix it was guarding. Only a family-3 defect in a test guarding something already low stays low.

Confidence changes what a **low** costs, not what a medium-or-above costs. A PLAUSIBLE low at round 4+ does not block: file it as a bead and merge. A PLAUSIBLE medium-or-above *does* block, and settling it is the round's job — confirm it, or rule it out and say what ruled it out. One you can do neither with counts as real.

That is deliberately stricter than the first draft of this rule, which let any unconfirmed finding through from round 4. Both defects that motivated the whole document — `ugcportal-0ss`'s `NaN <= number` fail-open at round 7, `ugcportal-r1d`'s 32-vs-36-char id mismatch at round 9 — presented as unconfirmed plausible mediums right up until someone spent a round confirming them. A rule that merges past those does not stop the expensive failure; it ships it. The thing that keeps this from grinding forever is the cap: at round 6 an unsettled medium-or-above goes to a human, and the human decides.

**Nothing above low is ever closed by the cap.** Only lows are ever deferred here, and each one becomes a bead with its severity written in it, so it is closed by a decision rather than by a timer. If anything medium-or-above is outstanding at round 6 — confirmed or unsettled — the PR does **not** merge; that is the escalate-to-a-human branch.

## 4. This is not licence to review less carefully early

The gate only changes what happens **to** findings from round 4 on. It does not change how hard anything is looked for, and it does not apply to rounds 1-3 at all. Reviews on this repo were finding real defects at round 7 and round 9; making them shallower is explicitly not the goal.

The measurable tell: **if per-bead first-round finding counts drop after adopting this rule, the rule is being used as an excuse.** Compare against the five beads measured above. A reviewer who finds less in round 1 has not saved anything — it costs the same defect three rounds later, plus the rounds.
