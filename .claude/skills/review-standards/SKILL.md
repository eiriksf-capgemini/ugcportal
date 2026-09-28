---
name: review-standards
description: ugcportal's review standards — the required sweep for this repo's three recurring defect families, the severity-gated stopping rule for review iteration (rounds 1-3 fix everything; round 4+ only a CONFIRMED medium-or-above blocks; hard cap at 6 rounds), and the scope freeze after first push. Read before pushing a branch for review, on every review round of a PR in this repo, and whenever deciding whether another round is worth running.
---

# Review standards (ugcportal)

Three rules govern what happens to a PR in this repo between first push and merge. They exist because the expensive failure here is not a badly written bead — it is a well-written bead that grinds through nine review rounds, the last two of which find a wrong comment and some duplicate log lines.

Measured 2026-09-25 across five beads (`ugcportal-44q`, `bdh`, `e86`, `r1d`, `0ss`): 3.40M tokens of implementation and 1.32M of review, 4.73M combined, ~0.95M per bead. Individual beads reached nine implementation rounds and eleven review passes.

But review value decayed **unevenly**, which is why a flat round cap is the wrong instrument:

- `ugcportal-0ss` round 7 found a live fail-open — `NaN <= number` is `false`, so an `Invalid Date` skipped the expiry check entirely and the gate could return sellable.
- `ugcportal-r1d` round 9 found the migration backfill minting 32-char hex while the runtime minted 36-char dashed UUIDs for the same public-id column, which would have broken `ugcportal-a2l` for every pre-existing row.
- `ugcportal-e86` rounds 8 and 9, by contrast, found an inaccurate code comment and 27 duplicate stderr lines.

A five-round cap would have stopped the two that were still earning and kept funding the one that wasn't. So gate on **severity**, and attack the recurring **families** rather than their instances.

Full rationale: `ugcportal-2yj`. The same lifecycle framing lives in the global `bead-template` skill, which is read when a bead is *authored*; this file is the repo-local copy that governs a PR while it is *in review*.

## 1. Scope freeze after first push

Once the branch is pushed for review, **work discovered during review becomes its own bead**, not an addition to this one. The only things that belong in the existing PR are fixes to the diff it already contains.

Two real cases, both individually defensible, each of which roughly doubled its PR:

- an access-control bead absorbed four adjacent media-API fixes found during review;
- a rights-gate bead invented a whole data model and an endpoint, because its own acceptance criterion was unverifiable without them.

The second is the harder case and worth naming: if a `K` genuinely cannot be verified without building something else, that is a **bead-authoring defect caught late**. Split it into a new bead now; do not absorb it.

File the new bead with a `discovered-from` edge so the provenance survives:

```bash
bd create --title="..." --type=bug --priority=3 \
  --description="Found during review of <PR>. ..." \
  --deps=discovered-from:<parent-bead-id>
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

Hit twice in this repo, and neither family above covers it. Real instances:

- `expect(markup).not.toContain("disabled")` — every `Button` ships `disabled:pointer-events-none disabled:opacity-50` in its class list, so the needle is *always* present and the assertion passes in both directions;
- matching `"server's reply"` against rendered React markup, where the apostrophe is escaped to `&#x27;` — so the needle can *never* be present, and the assertion passes no matter what the server returns;
- a registered `xhr.timeout` listener that was dead code — a path asserted about that never executes.

**The check — this is the stated test, not a list of examples to pattern-match:**

> For each assertion, ask what weaker implementation would still pass it, and whether the needle could ever actually be absent.

If a materially worse implementation passes, the assertion is decoration. If the needle can never be absent (or never be present), the assertion has no failing case at all, and that is worse than decoration, because it reads as coverage.

Then make it mechanical, because attention is demonstrably not the missing ingredient here — one defective harness was written in the same commit as the fix it was guarding, by an agent that had just spent two rounds writing about this exact family:

> **Mutate the fixture, not just the production code.** After writing an assertion, change the *fixture* so the failure it describes should occur, and confirm it does. Mutating the production code only proves the assertion is connected to the behaviour; mutating the fixture proves it is connected to a case that can actually fail.

## 3. The stopping rule — severity gate, then a hard cap

"Round" means a completed review pass on the PR. `pr-review-merge` step 4b has the command that counts them and the caveats on that count.

| Round | What blocks the merge |
|---|---|
| 1-3 | **Any** CONFIRMED or PLAUSIBLE finding. Fix everything. |
| 4-6 | Only a **CONFIRMED medium-or-above** finding. Low findings are filed as beads and the PR merges. |
| 7+ | Does not exist. At 6 rounds the PR either merges with its remainder filed, or goes to a human. |

Severity, for this gate:

- **medium-or-above** — wrong behaviour a user or the data can reach: a fail-open, an authz gap, data loss or corruption, a leaked credential, a broken migration, a wrong figure a later bead will build on.
- **low** — correctness of the *description* of the code rather than of the code: an inaccurate comment, duplicate log lines, a naming or clarity nit, a test that is weak but not wrong, a missing-but-not-required test.

A PLAUSIBLE finding at round 4+ does not block: either confirm it this round, or file it as a bead at its suspected severity. "Plausible and possibly serious" is a reason to spend the round confirming it, not a reason to keep the PR open indefinitely.

**Nothing above low is ever closed by the cap.** Every deferred finding becomes a bead, with its severity written in the bead, so it is closed by a decision rather than by a timer. If the remainder at round 6 contains a CONFIRMED medium-or-above, the PR does **not** merge — that is the escalate-to-a-human branch.

## 4. This is not licence to review less carefully early

The gate only changes what happens **to** findings from round 4 on. It does not change how hard anything is looked for, and it does not apply to rounds 1-3 at all. Reviews on this repo were finding real defects at round 7 and round 9; making them shallower is explicitly not the goal.

The measurable tell: **if per-bead first-round finding counts drop after adopting this rule, the rule is being used as an excuse.** Compare against the five beads measured above. A reviewer who finds less in round 1 has not saved anything — it costs the same defect three rounds later, plus the rounds.
