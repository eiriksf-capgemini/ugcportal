---
name: review-standards
description: ugcportal's review standards — the required sweep for this repo's four recurring defect families, the severity-gated stopping rule for review iteration (rounds 1-3 fix everything; round 4+ only a medium-or-above blocks and lows are filed as beads; hard cap at 6 rounds, then escalation to a human), and the scope freeze after first push. Read before pushing a branch for review, on every review round of a PR in this repo, and whenever deciding whether another round is worth running.
---

# Review standards (ugcportal)

Three rules govern what happens to a PR in this repo between first push and merge, and a fourth (section 5) governs the prose a fix round may add. They exist because the expensive failure here is not a badly written bead — it is a well-written bead that grinds through nine review rounds, the last two of which find a wrong comment and some duplicate log lines.

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

## 2. The required sweep — four recurring defect families

Two families accounted for a large share of all review rounds on this repo; a third hit twice. A fourth was added 2026-09-30 (`ugcportal-ws3`), from the same kind of evidence as the first three: measured directly against delivery logs rather than recalled, and named only after showing up repeatedly rather than once. Sweeping for the **class** costs one round and has repeatedly replaced several — agents asked to do this found further instances themselves, unprompted.

This sweep is **required**, not advisory, in two places:

- by the implementer, before the first push; and
- by the reviewer, on every review round (`pr-review-merge` step 4.1).

Each family must be **reported as checked, by name**, with what was found (including "nothing"). A silent skip is the failure mode this exists to make visible — if a report does not name all four, the sweep did not happen.

### Family 1 — a comment claims a guarantee the code does not make

Especially common in a comment written to record a *measurement*.

Real instances from this repo:

- a guard that cannot fire: `previewKey !== null` reading `undefined !== null` after the column left the `select`;
- a type constraint that does not constrain: `keyof` an optional-never property still yields the key, so `Pick` pulled blocked columns back out with real types;
- a memory figure documenting one code path of four;
- a doc line contradicting the table directly below it.

**The check:** re-read every comment, doc line and commit-message claim that says *never*, *always*, *guarantees*, *cannot*, or quotes a number, and confirm the code actually does that — on every path, not the one path you had in mind when you wrote it.

**Its scope is the whole file, not the diff's hunks.** A claim does not have to sit in a hunk to be falsified by one, and it does not have to be new to be wrong. On PR #207 (`ugcportal-z4nh`) three instances — an opening summary, a docstring, and the tool's own **printed output** — sat in one file from its first commit, and the last of them was not found until round 6, the cap, because each round in between read the fix it had arrived for. Note which one mattered most and which was found last: the printed one. A claim made to the tool's user is a claim like any other. The full account, the commands that establish it, and what it does *not* explain are in `pr-review-merge` step 4.2, deliberately in one place only — §5 below is about exactly what happens to a claim kept in two.

**This is not an instruction to re-read everything on every round.** The per-round sweep keeps its default scope; the whole-file obligation is carried by two bounded additions, each owned by a named round and each with an output that is absent when it was skipped — `pr-review-merge` 4.2 greps every file in the diff in full, but only after a fix that changed behaviour, and 4.3 reads every file top to bottom once per chain. Implementers get the same scope mechanically: `/pre-review`'s `claims-audit --all-lines` reads every line of every changed file, not only the added ones.

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

### Family 4 — sibling-omission: a fix applied to only one of several parallel structures

Named 2026-09-30 in `ugcportal-ws3`, which measured it directly against the round-by-round delivery logs of this repo's two worst-offending beads (`ugcportal-r1d`: 10 impl / 9 review rounds; `ugcportal-0ss`: 7/7) and found it accounted for roughly 8 of `r1d`'s 10 rounds. `r1d`'s own close reason names the same shape independently, in its own words, before `ws3` ever generalised it.

The shape: the codebase has two (or more) parallel structures that are supposed to move together — two audience-specific projections, two directions of a check, two response paths, two fields that must stay linked — and a round's fix lands on one of them, leaving its sibling with the exact bug the fix just removed from its pair. The next round finds the sibling, looking like a new defect, when it is the same one found again one structure over.

Real instances from this repo:

- `previewKey` was withheld as a field from an anonymous projection, but the same account id remained recoverable from the previewKey *string* — withholding a value is not the same as withholding what derives from it (`r1d`'s own close reason calls this its central lesson).
- a 409 "already has a preview" guard checked only `previewKey`, while the two listings it was protecting filtered on `previewKey` **and** `previewId` — a row could satisfy one sibling check and fail the other, becoming publishable-but-invisible.
- a listing-scope type made `previewKey`/`previewId` required so a defensive filter couldn't forget them, but left `publishedAt` optional — the field that mattered most was the one sibling nobody structurally required.
- one rights-clearance lookup, keyed on the wrong column, let a single clearance silently settle three separate rights layers (music / third-party / sponsorship) that each needed independent treatment.
- `Cache-Control` was set on a handler's 200 response but not its 400 path from the same handler — a happy path and its error path are siblings too.

**The check:** for every field, guard, projection, or response path touched by this diff, ask "does this same shape exist anywhere else — a second audience, a second direction, a second response path, a paired field?" If so, confirm the fix (or the bug) was checked against both, not just the one the diff happens to touch. Treat finding the sibling as the default next step after finding the first instance, not as an edge case to remember.

## 3. The stopping rule — severity gate, then a hard cap

"Round" means a review pass **that actually reviewed the diff** — a run that stopped at red CI or an unmergeable branch reviewed nothing and is not a round. `pr-review-merge` step 4b counts them from round markers the skill stamps on every comment that ends such a round, checks the resulting chain for forgery, edits, gaps and implausible round numbers, and covers the bootstrap for PRs whose history predates this rule. Step 1a serialises overlapping runs on a per-PR lock, so two of them cannot both stamp the same round and break the chain.

Exactly one row matches any given round.

| Round | What blocks the merge |
|---|---|
| 1-3 | **Any** finding, CONFIRMED or PLAUSIBLE, at any severity. Fix everything. |
| 4-5 | Any **medium-or-above**, CONFIRMED or unsettled. Lows are filed as beads and the PR merges. |
| 6 (the cap) | The same — but a blocker here goes to a **human**, not into a seventh round. Otherwise the PR merges with its lows filed. |
| 7+ | Only on an **exact** marker chain, anchored to the **latest** stop comment at or above round 6, with evidence someone acted since it. A full review still runs at full depth, but the only things that may block are the outstanding escalated blocker and any **medium-or-above** that is outstanding — whenever it was first raised. Severity, never age. It cannot start another round. (`pr-review-merge` step 5b.) |

Two things override the row, because they mean the *number* is in doubt rather than the findings. Both live in `pr-review-merge` step 4b, which is also where the reasoning is: markers are comments, and comments are untrusted input.

- **A `broken` chain does not merge at all.** A marker chain that fails its integrity checks is reviewed under the strict `1-3` rules and then, whatever they say, **does not merge — not even on a round that finds nothing**. A chain that cannot be read is a review history that cannot be read, and approving on it is approving on an unknown number of prior rounds. A human reopens counting with a chain-reset comment.
- **An `approx` chain uses the strict `1-3` rules at every round.** Whatever number it carries, any finding blocks and it merges only with zero findings; it may not auto-merge at the cap (it escalates to a human instead), and it may not enter the `7+` row. A chain is `approx` if it was bootstrapped, if a human reset it, **or if its markers were written by the PR's own author** — a count the beneficiary wrote is an asserted count, not a recorded one. An asserted count can bring the cap, and therefore a human, closer; it can never loosen the gate.

When the `7+` row's three requirements are not all met, `pr-review-merge` step 5 states the two outcomes: a chain that is not `exact`, or one with no stop comment at or above round 6 to anchor to, is **treated as round 6** — the cap; an anchor that *does* exist with nothing having happened since it means the escalation is **still outstanding**, so the PR does not merge and no new round is counted.

**What that means in this repo today:** the reviewer authenticates as the same account that opens the PRs (verified 2026-09-29 — `gh api user` and `gh pr view <n> --json author` both return `eiriksf-capgemini`), so every chain reads `approx` and **the lenient rounds 4-5 row is currently unreachable**: any finding blocks at every round, and a PR that still has one at round 6 goes to a human rather than merging with its lows filed. That is deliberate — the alternative is leniency unlocked by a number its beneficiary typed, which one forged comment can produce — and it is reversed by an identity change, not a code change: run review under a separate bot account or GitHub App and `exact` becomes reachable again.

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

## 5. Comment discipline — measurements belong in tests, and a fix adds no prose beyond what the finding needs

Measured 2026-10-05 on the nine PRs that closed the v0.5.0 cut (#94-#102; the full table is `docs/process/review-rounds-v0.5.0.md`, Part 1): of the 60 findings raised at review round 4 or later, 57 were lows, and **35 of those 57 (61%) were family 1** — a comment, docstring, test title or PR body claiming something the code does not do. Read against the rounds that produced them, those 35 split roughly in half: about half were **sentences written during a fix round** — a measurement typed into a comment (`#97` round 5: a `-2px` attributed to `--spacing`, which is `.25rem`), a "never" or "only" added to explain a fix (`#102` rounds 1-4: four rounds, one dedupe paragraph, the mechanism described backwards and then corrected in two of five places), a pointer at a sibling file (`#94` round 6: a comment citing a React 18 warning on React 19) — and about a third were **sentences a fix had left stale one structure over** (`#95` round 6: "three fail-closed exits" fixed in one file at round 5 and still standing in its test; `#96` round 5: a qualifier corrected in `pages.ts` at round 4 and uncorrected in the file that cross-references it). Each cost a full review round, because on an `approx` chain any finding blocks (section 3), and because the reviewer's job is to read exactly those sentences.

So the rule for anyone writing or fixing code in this repo:

- **A measurement belongs in a test, and the comment points at the test.** `85px`, `3.18:1`, `~46x`, `2588 tests`, `12,266 B gzipped` — if a number matters enough to write down, write the assertion that fails when it drifts and let the comment say `see site-header.height.test.ts`. A number in prose is a measurement nobody re-runs (`#86` round 1 carried two figures for the same scenario in one schema file, neither matching the back-of-envelope line between them).
- **A doc comment caps at the *why*.** What the code does is what the code says; how it was verified belongs in the test or the PR body; which review round asked for it belongs nowhere in the source. A test title or comment that narrates review history (`PR #94 review round 4/5`) is the cheapest sentence to leave stale and tells the next reader nothing they can check.
- **A fix round adds no prose beyond what the finding needs.** If the finding was "this guard cannot fire", the fix is the guard, not a paragraph about guards. Every new sentence is new family-1 surface for the next round; the implementer, not the reviewer, pays for it.
- **When a fix changes a claim, grep for its siblings before pushing.** The same statement usually exists in a docstring, a test comment, `docs/`, `env.example` and the PR body (`#102` found five copies over four rounds; `#98` round 3 found a bootstrap rule described the pre-fix way in three files). `node scripts/claims-audit.mjs --all-lines` lists every claim-shaped sentence in the changed files, and `node scripts/claims-audit.mjs --pr <n>` / `--body` (ugcportal-bn94) runs the same vocabulary, plus a DONE check, over the PR body itself — the one place a stale claim keeps landing that the file-scan can never see (`#147`'s body claiming a number was deleted when it was not; `#142`'s "copied verbatim" when a guard had been dropped). The `/pre-review` skill runs both: `--all-lines` over the changed files at step 4, `--body` over the drafted PR body at step 8.
- **A pointer names a thing that exists.** A comment that cites a file, an identifier, a contrast entry or an extension (`#98` round 3: `configured-users.ts`, deleted; `#97` round 1: a contrast entry that was never added; `#95` round 5: a `.mtsx` extension TypeScript does not have) is a claim like any other — check it the way you would check a `never`.

This does not change what the reviewer looks for — family 1 stays in the required sweep (section 2) — and it is not a licence to write fewer *useful* comments. It changes who catches the overclaim: the writer, before the push, with `claims-audit` beside them, rather than a reviewer at round 5 for the price of a round.
