---
name: review-standards
description: ugcportal's review standards — the required sweep for this repo's four recurring defect families, the severity-gated stopping rule for review iteration (round 1 fixes everything; from round 2 only a medium-or-above blocks and lows are filed as beads; a text-only low may be fixed by the reviewer inside any round on an `exact` chain and then counts as fixed; hard cap at 6 rounds, then escalation to a human), the scope freeze after first push, and (section 6) the fail-loud rule for any instrument that can match nothing: print the match count before trusting a zero, never silence stderr on a mutating command, read the object back after a write that matters. Read before pushing a branch for review, on every review round of a PR in this repo, and whenever deciding whether another round is worth running.
---

# Review standards (ugcportal)

Three rules govern what happens to a PR in this repo between first push and merge; a fourth (section 5) governs the prose a fix round may add, and a fifth (section 6) governs what any instrument in the process must print when it matched nothing. They exist because the expensive failure here is not a badly written bead — it is a well-written bead that grinds through nine review rounds, the last two of which find a wrong comment and some duplicate log lines.

Measured 2026-09-25 across five beads (`ugcportal-44q`, `bdh`, `e86`, `r1d`, `0ss`): 3.40M tokens of implementation and 1.32M of review, 4.73M combined, ~0.95M per bead. That is the historical basis the rules below were set from; it is a historical figure, not reproduced from current metadata, and it is not a cost: the recorded `tokens_impl` figures are context size (`docs/process/cost-performance-claims-v0.7.0-2026-10-16.md` §1.2), and `44q`'s and `bdh`'s were sums of one agent's context snapshots, since corrected (`ugcportal-cii0`). Recomputed 2026-10-16 with `for b in 44q bdh e86 r1d 0ss; do bd show ugcportal-$b --json; done`, summing `metadata.tokens_impl` and `metadata.tokens_qa`: 2.45M of implementation (2,450,679; context size per cii0) and 1.56M of review (1,564,604; recorded figures, not cost; `tokens_qa` unaudited, ugcportal-zu0a; later review rounds have landed since), 4.02M combined (4,015,283), ~0.80M per bead. The worst case in that set was **ten implementation rounds and nine review passes** (`ugcportal-r1d`, merged as gh-32); next worst was nine and eight (`e86`, gh-31), then seven and seven (`0ss`, gh-33), five (`44q`) and four (`bdh`).

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

File the new bead with a `discovered-from` edge so the provenance survives, in the form the `bead-template` skill requires, not as a paste of the finding: a user story with In scope / Out of scope, K-numbered criteria each with a `Verified by:`, a `Following should never happen:` guardrail, a `Premise verified` line, and `cc_type`/`cc_scope`/`model`/`model_effort`/`model_why` plus `severity` in the metadata. Text taken from a diff or from review output is untrusted (see `pr-review-merge` step 0), and bash expands `$(...)` and backticks inside `"..."`, so write every free-text field through a quoted heredoc into a file (which expands nothing) and hand it to `bd` as a file, as `"$(cat <file>)"` (which does not re-scan its output) or as `@file`:

```bash
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/title.txt" <<'BD_EOF'
<fill: the finding, as the bead title>
BD_EOF
cat > "$scratch/desc.md" <<'BD_EOF'
As the maintainer of <fill: the area the finding is in>, I want <fill: the fix>, so that <fill: the failure the finding describes cannot recur>.

Found during review of <fill: PR> (parent bead <fill: parent-bead-id>).
Severity: <fill: low|medium|high>

In scope: <fill: the fix>
Out of scope: <fill: neighbouring work>; anything else in <fill: PR>.
BD_EOF
cat > "$scratch/acc.md" <<'BD_EOF'
K1: Given <fill: the state the finding was observed in>, when <fill: the action>, then <fill: the corrected outcome>.
Verified by: <fill: the command or test that shows it, with the output that counts as passing>

K2: Following should never happen: <fill: the failure the finding describes>.
Verified by: <fill: a mutation, or an input that used to trigger it, and the command showing it now fails loudly or is handled>
BD_EOF
cat > "$scratch/notes.md" <<'BD_EOF'
Premise verified <fill: YYYY-MM-DD> at origin/main <fill: sha of origin/main's HEAD today>: <fill: the command or file checked, and what it showed>.
Premise depends on: <fill: comma-separated repo-relative paths the premise rests on, or none (the external fact it rests on)>
BD_EOF
cat > "$scratch/meta.json" <<'BD_EOF'
{"cc_type": "fix", "cc_scope": "<fill: scope of the PR>", "severity": "<fill: low|medium|high>", "model": "sonnet", "model_effort": "medium", "model_why": "<fill: one line, no double quote or backslash: why this tier fits the fix>"}
BD_EOF

grep -l '<fill' "$scratch"/* && { echo "unfilled placeholder" >&2; exit 1; }

bd create "$(cat "$scratch/title.txt")" --type=bug --priority=3 \
  --body-file "$scratch/desc.md" \
  --acceptance="$(cat "$scratch/acc.md")" \
  --notes="$(cat "$scratch/notes.md")" \
  --deps=discovered-from:<fill: parent-bead-id> \
  --metadata @"$scratch/meta.json"
```

The `grep -l '<fill'` line stops the block with exit 1 before a bead exists if any placeholder is left, and the metadata must stay valid JSON, so no field carries a double quote or backslash. If any of the text could itself contain a line reading exactly `BD_EOF`, change the delimiter rather than trimming the text. The same form, for the same reason, is `pr-review-merge` step 5a and `cut-release` step 7a; the fuller account of why the inline title heredoc and a single-quoted `--metadata` string are unsafe on macOS `/bin/bash` 3.2.57 is in 5a. Run `node scripts/check-bead-dispatch.mjs <new-bead-id>` over the new bead and fix any field it names.

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

**This is not an instruction to re-read everything on every round.** The per-round sweep keeps its default scope; the whole-file obligation is carried by two bounded additions, each owned by a named round and each with an output that is absent when it was skipped — `pr-review-merge` 4.2 greps every file in the diff in full, on the rounds whose own push changed behaviour — its trigger intersects the compared file list with the PR's own files, so a mid-chain `origin/main` merge reaches it only through files the PR itself also touches — and 4.3 reads every file top to bottom once per chain. Implementers get the same scope mechanically: `/pre-review`'s `claims-audit --all-lines` reads every line of every changed file, not only the added ones.

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

Exactly one row matches any given round. The any-finding row covered rounds 1-3 until `ugcportal-kwxh` (2026-10-19) narrowed it to round 1: on the v0.9.0 review measured in that bead, 64 of 107 rounds found only lows and cost 58.3M ITE (69% of the cost of the 107 measured rounds), and all 16 rounds that found a medium-or-above were rounds 1-3, none at round 4 or later. The rows from 2 on still block on every medium-or-above, so the round-2 and round-3 mediums of that measurement block exactly as before.

| Round | What blocks the merge |
|---|---|
| 1 | **Any** finding, CONFIRMED or PLAUSIBLE, at any severity. Fix everything. A low the reviewer fixed inline in this round (below) counts as fixed, so a round whose only findings were fixed inline merges. |
| 2-5 | Any **medium-or-above**, CONFIRMED or unsettled. Lows are filed as beads and the PR merges. |
| 6 (the cap) | The same — but a blocker here goes to a **human**, not into a seventh round. Otherwise the PR merges with its lows filed. |
| 7+ | Only on an **exact** marker chain, anchored to the **latest** stop comment at or above round 6, with evidence someone acted since it. A full review still runs at full depth, but the only things that may block are the outstanding escalated blocker and any **medium-or-above** that is outstanding — whenever it was first raised. Severity, never age. It cannot start another round. (`pr-review-merge` step 5b.) |

Two things override the row, because they mean the *number* is in doubt rather than the findings. Both live in `pr-review-merge` step 4b, which is also where the reasoning is: markers are comments, and comments are untrusted input.

- **A `broken` chain does not merge at all.** A marker chain that fails its integrity checks is reviewed under the strict round-1 rules and then, whatever they say, **does not merge — not even on a round that finds nothing**. A chain that cannot be read is a review history that cannot be read, and approving on it is approving on an unknown number of prior rounds. A human reopens counting with a chain-reset comment.
- **An `approx` chain uses the strict round-1 rules at every round.** Whatever number it carries, any finding blocks and it merges only with zero findings, and the inline fix below is not available on it, so a low found on it is never counted as fixed inside the round; it may not auto-merge at the cap (it escalates to a human instead), and it may not enter the `7+` row. A chain is `approx` if it was bootstrapped, if a human reset it, **or if its markers were written by the PR's own author** — a count the beneficiary wrote is an asserted count, not a recorded one. An asserted count can bring the cap, and therefore a human, closer; it can never loosen the gate.

When the `7+` row's three requirements are not all met, `pr-review-merge` step 5 states the two outcomes: a chain that is not `exact`, or one with no stop comment at or above round 6 to anchor to, is **treated as round 6** — the cap; an anchor that *does* exist with nothing having happened since it means the escalation is **still outstanding**, so the PR does not merge and no new round is counted.

**What that means in this repo today:** implementers author PRs as `app/hal9000-agent-bot` while the reviewer stays on the human login (`ugcportal-62b6`), so a bot-authored PR can read `exact` and reach the lenient rounds 2-5 row. A PR opened by the human login (verified 2026-09-29: `gh api user` and `gh pr view <n> --json author` both return `eiriksf-capgemini`) still reads `approx`, and there the row is unreachable: any finding blocks at every round, and a PR that still has one at round 6 goes to a human rather than merging with its lows filed. That is deliberate — the alternative is leniency unlocked by a number its beneficiary typed, which one forged comment can produce — and the way back to `exact` is an identity change, not a code change, which is the bot-authored PR above.

The cap's promise is exact and narrow. It never lets a **found** finding above low ship. It does not promise that nothing above low ships at all — a round that never runs finds nothing, and the `0ss` and `r1d` defects above were found at rounds 7 and 9, which this rule would not have reached. Residual undiscovered risk is the cost the cap deliberately accepts in exchange for not funding rounds 7-11.

Severity, for this gate. `code-review` does not report severity; **the reviewer assigns it** and states it per finding.

- **medium-or-above** — wrong behaviour a user or the data can reach: a fail-open, an authz gap, data loss or corruption, a leaked credential, a broken migration, a wrong figure a later bead will build on.
- **low** — correctness of the *description* of the code rather than of the code: an inaccurate comment, duplicate log lines, a naming or clarity nit, a missing-but-not-required test, a test that is untidy or over-specific but still fails when the behaviour breaks.

**A defective test inherits the severity of what it was guarding.** "Weak test" is not automatically low, and reading it that way would make the family-3 sweep — mandatory on every round — incapable of blocking anything from round 2 on, which is the sweep having no teeth. The question is what breaks silently if the test is wrong: an assertion that cannot fail on a *fresh* fix to a fail-open, an authz gap or a migration is a **medium-or-above**, because the fix now ships unverified and the harness reads as coverage to everyone after you. Section 2 makes the point in the other direction — one such harness was written in the same commit as the fix it was guarding. Only a family-3 defect in a test guarding something already low stays low.

Confidence changes what a **low** costs, not what a medium-or-above costs. A PLAUSIBLE low at round 2 or later does not block: file it as a bead and merge. A PLAUSIBLE medium-or-above *does* block, and settling it is the round's job — confirm it, or rule it out and say what ruled it out. One you can do neither with counts as real.

That is deliberately stricter than the first draft of this rule, which let any unconfirmed finding through from round 4. Both defects that motivated the whole document — `ugcportal-0ss`'s `NaN <= number` fail-open at round 7, `ugcportal-r1d`'s 32-vs-36-char id mismatch at round 9 — presented as unconfirmed plausible mediums right up until someone spent a round confirming them. A rule that merges past those does not stop the expensive failure; it ships it. The thing that keeps this from grinding forever is the cap: at round 6 an unsettled medium-or-above goes to a human, and the human decides.

**Nothing above low is ever closed by the cap.** Only lows are ever deferred here, and each one becomes a bead with its severity written in it, so it is closed by a decision rather than by a timer. If anything medium-or-above is outstanding at round 6 — confirmed or unsettled — the PR does **not** merge; that is the escalate-to-a-human branch.

### A text-only low may be fixed by the reviewer inside the round

Decision: Eirik, 2026-10-19 (`ugcportal-kwxh`, In scope (c)). Measured basis: a fix pass plus a fresh round on a one-line docs PR cost about 600k ITE in v0.9.0, against a median round of 731k.

A **low** whose fix is text only — a comment, a doc sentence, a PR-body line, a commit subject — and whose fix the reviewer can state in full in the finding may be applied by the reviewer in the same round, instead of through a fix pass and a fresh round. **It is available in every round, round 1 included, on an `exact` chain, and never on an `approx` or `broken` one** (`pr-review-merge` step 4b). The round then ends by the gate with the finding counted as fixed: it is still recorded in the round's `findings_r<N>` (it was found), but it does not block, so a round 1 whose only finding is one inline-fixed low merges.

**A medium-or-above finding is never fixed inline and never deferred as a bead in place of blocking:** in every round it blocks, and at the cap it goes to a human, exactly as the table above says.

**A code change or a test change is never applied by the reviewer as an inline fix, and neither is any fix the reviewer cannot state exactly in the finding.** Those go through the table above: a fix pass by the implementer where the finding blocks (any finding at round 1, a medium-or-above at every round), a bead where it is a low from round 2 on an `exact` chain.

How it is applied and recorded, in this order, after `pr-review-merge` step 4's verdict and before `pr-review-merge` step 5's "Before any stamp" checks:

1. The finding states the fix in full: where (file and line, the PR body, or the PR title, which becomes the squash-merge commit subject), the text as it stands, and the text it becomes.
2. A file fix is one commit on the PR's head branch, pushed under the bot identity (`hal9000-agent-bot[bot]`, through the token recipe in `.claude/agents/worker-implementer.md`, "Author the PR as the bot"), touching only the text the finding named: `git diff --stat <reviewed-sha> <fix-sha>` lists exactly the files the round's `inline fix:` lines name in their `files=` fields (item 4). A PR-body or PR-title fix is a `gh pr edit` under the same identity, and has no commit.
3. Re-run the gate that applies to the fixed text — `node scripts/claims-audit.mjs` over a changed file, `node scripts/claims-audit.mjs --pr <n>` over a body line, the test file's own run for a comment inside a test file, and for a title the Conventional Commits guard (`PR_TITLE="<new title>" node scripts/check-pr-title.mjs`) — and then wait for the CI it starts before any label or merge: for a commit, CI on the fix commit; for a body or title edit, the Guards run that the `edited` event starts (`.github/workflows/ci.yml` runs the Guards job, which carries that title guard and is a required check, on every body or title edit). `pr-review-merge` step 5, "After an inline fix", says how both are read.
4. Record it in the comment that ends this round, one line per finding: `inline fix: <finding> <fix-sha | pr-body | pr-title> files=<path>[,<path>] gate=<command> -> <result> identity=<login the push or edit ran as>`, where `files=` names every file the fix commit touches and reads `files=-` for a body or title fix. When the round pushed a fix commit, the same comment also carries the line `inline-fix head=<fix-sha>` on a line of its own, which `scripts/check-human-merge-labels.mjs` reads as the round's reviewed head, so a `needs-human-merge` label applied after the fix is current rather than listed as D; the `ugcportal-measured` line's `at=` keeps the head the round measured. The round's merge, or its sensitive-path label, then rests on the fix commit, not the reviewed head (`pr-review-merge` step 5, "After an inline fix").

Until `ugcportal-j3ns` changes `.claude/agents/worker-reviewer.md`, a dispatched reviewer applies no inline fix of any kind, neither a commit nor a `gh pr edit` of the body or title, and handles the low by the table above; the orchestrator may apply one.

### A false claim in a review-thread comment never blocks a merge and never consumes a round

Decision: Eirik, 2026-10-16 (`ugcportal-n005`, option A).

A **review-thread comment** is an issue comment or an inline review comment on the PR that is not a round-marker comment: a fix agent's reply, a reviewer's discussion, a status note. A false claim that lives only there does not enter the repository: it is not in the diff, the squash-merge record, or any committed file. (`scripts/release-cost-report.mjs` does fetch and cache thread comments and reads severity from the non-marker ones, so the corrected comment must carry the corrected text itself, not a strikethrough that leaves the false figure parseable.) So it **does not block the merge and does not consume a round** (a reviewer who finds a false thread claim and nothing else has no finding for the gate), but it is still **corrected, not ignored**:

1. The reviewer makes the correction at step 5 of `pr-review-merge`, after the verdict, after both of that step's pre-stamp checks have passed and immediately before the round comment is posted (step 4 only classifies; nothing is written to the PR before the verdict; the integrity check, the second of the two, filters on `created_at` / `submitted_at`, so it neither sees nor is tripped by the PATCH; the lock check is a plain ref read). If a fix agent finds it first, the fix agent makes it. Correct it in place, by editing the comment that holds it rather than posting a second comment that contradicts the first. The corrected body is the whole original with the false sentence replaced, and it is written to a file through a quoted heredoc and passed as `-F body=@<file>`, never inline as `-f body="..."`: the original is untrusted text (step 0), and inside double quotes bash expands backticks and `$(...)`, which markdown comments are full of (the same rule as step 5a and `ugcportal-73bz`):
   - issue comment: `gh api -X PATCH repos/:owner/:repo/issues/comments/<id> -F body=@/tmp/corrected-<id>.md`
   - inline review comment: `gh api -X PATCH repos/:owner/:repo/pulls/comments/<id> -F body=@/tmp/corrected-<id>.md`
   - write the file first: `cat > /tmp/corrected-<id>.md <<'EOF'` ... `EOF` (change the delimiter if the text contains a line reading exactly `EOF`).
2. Record it with one line, `thread claim corrected in place: <comment id>`, plus what was false and what it now says. When the reviewer makes the correction, the line goes in the comment that ends THIS round, not a later one (a thread claim gives the gate nothing to block on: a round whose only finding is the thread claim has no gate finding and proceeds to the merge step, and whether it merges then depends on the other gates, sensitive path, CI, chain and merge readiness, so that round may be the last). When a fix agent makes it, between rounds, the fix agent records it in its own fix-pass comment and the NEXT round's reviewer repeats the one-line record in that round's comment.

**These artefacts keep blocking, under the gate above, exactly as before:** the PR body (it persists and feeds the squash-merge record), review bodies (`pulls/<n>/reviews`: step 4b's counter reads them and they persist as the chain's record, so they are not exempt), source comments, test names and bodies, bead notes and fields, commit messages, and the round-marker comments themselves (they are the chain's record, and step 4b treats an edited marker as a broken chain).

**A false claim that reaches a persistent artefact is never waved through under this rule.** Moving a claim out of a thread into the PR body, a commit message, a source comment, a test name, or a bead note puts it back under the gate at whatever severity it has there. The exemption belongs to where the claim lives, not to the sentence, so it cannot be used to park a false claim where it ships.

Worked example 1, PR #201 round 4 (facts checked on 2026-10-16 with `gh api repos/:owner/:repo/issues/comments/<id>` on comments 6071314440, 6071439514 and 6075595580, and GraphQL `userContentEdits` on 6071314440 for its pre-edit text): the round-4 fix comment (issue comment 6071314440) said, of a mutation, "Exactly one test failed", naming the SPACE non-terminator test, and "Every other test in the file still passed." The round-4 review comment (6071439514) re-ran the mutation, found five tests fail, not one, and was blocked on that alone (it paraphrases the claim as "failed exactly the SPACE non-terminator test ... and nothing else"; those quoted words are the reviewer's, not the original's). This is the reviewer case: under this rule the round-4 reviewer, who found the claim, makes the PATCH to comment 6071314440 at step 5 and records `thread claim corrected in place: 6071314440` plus what was false in round 4's own comment, so round 4 has no finding for the gate, and it merges if nothing else blocks (#201 was `approx` and no sensitive path was involved). The history went the other way: round 4 blocked on the claim, and the round-5 fix agent made the correction as a PATCH to 6071314440 and recorded it in its own reply (6075595580), which says `git diff --stat` for the round was empty and that it scanned the PR body for the claim and did not find it; the rule now prevents that round. The fix-agent case, where a fix agent finds a thread claim before any reviewer does, is the same PATCH recorded in the fix agent's own fix-pass comment and repeated by the next round's reviewer; #201 was not that case. Not verified here: the round-5 fix agent's grep of the worktree for the claim, recorded in the bead's notes (`ugcportal-n005`, premise of 2026-10-09) and not in 6075595580, and not re-run.

Worked example 2, the same claim moved: had the fix agent also copied "exactly one test fails" into the PR body's test section (or into a source comment above the mutated regex), that copy is a persistent artefact. It blocks at the round's row of the table above (a low blocks at round 1, and is filed as a bead from round 2 on an `exact` chain; on an `approx` chain, which #201 was, it blocks at every round), and editing the thread comment does not clear it: the PR body must be corrected too.

## 4. This is not licence to review less carefully early

The gate's deferral of lows only changes what happens **to** findings from round 2 on, and does not apply to round 1 at all; the inline fix changes who fixes a text-only low, in any round, not whether it is fixed. Neither changes how hard anything is looked for. Reviews on this repo were finding real defects at round 7 and round 9; making them shallower is explicitly not the goal.

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

## 6. An instrument that matched nothing must prove it looked

`ugcportal-kssp`. `docs/process/development-process.md` section 9, weakness 6
names this the most under-appreciated weakness in the process: **a check that
silently matched nothing reports success, and the wrong answer is always the
reassuring one** — which is why none of the instances below announced itself.
Six are on the record. Three from the v0.7.0 build:

- a dependency filter using the wrong field name reported "nothing is stuck"
  over a backlog with ten dead beads;
- `bd` writes whose stderr went to the null device were reported as applied
  when they had failed;
- a `||` fallback ran its second branch with the arguments reversed,
  *succeeded*, and recorded a graph edge backwards.

Three more on 2026-10-12, all from one session:

- `scripts/sweep-candidates.mjs` reported `candidates found: 0` on three PRs
  where the real figures were **4, 19 and 42** — twice because it ran before
  the work was committed and swept an empty diff, once because the new test
  files were still untracked;
- a reviewer reported `30 new tsc errors` where the truth was **23**, having
  measured without running `npm run build` first: its "7 pre-existing" were
  `PageProps` errors from a missing `.next/types`, and a gross total was
  reported as a delta;
- a reviewer read a **stale copy** of a skill out of the shared checkout and
  reported that `pr-review-merge` steps 4.2 and 4.3 do not exist. They do
  (`ugcportal-sv3l`).

### Which zeros matter

Not every empty result is a hazard, and treating them all as one produces
noise that trains everyone to skip the banner. The distinguishing property is
narrow:

> **An empty result is a hazard exactly when an empty result and a broken
> instrument render the same.**

A sweep that legitimately finds nothing is normal and common — and it is
*safe* as long as the output of a run that looked differs from the output of
a run that did not. So the question to ask of any instrument is not "could
this be zero?" but "if I broke this instrument right now, would its output
change?" If the answer is no, it needs one of the three mitigations below. If
the answer is yes — because it already prints a denominator, or already
refuses an input it could not read — it does not, and adding a banner to it
is cost without a property.

### The three mitigations

**1. Print the match count before trusting a zero.** Every set-returning step
states what it examined *before* what it found, and a run that examined
nothing says so in those words rather than printing `0`.

**2. Never silence stderr on a mutating command.** Enforced, not advised:
`scripts/check-silenced-stderr.mjs` scans every file under `scripts/` and
`.claude/skills/` line by line for the **seven stderr-discarding kinds in its
own `SILENCING_KINDS`** — the `2>`/`2>>` redirect to the null device,
the close form, the `&>`/`>&` both-streams shorthand, the null redirect
followed by stderr duped onto it, Python's `DEVNULL`, the `stdio` string
`"ignore"`, and an `stdio` array with `"ignore"` in slot 2 — and fails unless
each hit is allowlisted with a stated reason. Read that list rather than "every
site": a pattern set is what it matches. The count is checkable rather than
prose — the scanner throws on a kind not declared in `SILENCING_KINDS`, and
its test drives every member of it to a real hit — and the header's KNOWN
LIMITS names what it does not see (a redirect built from a variable, a `catch {}` that
swallows the message without naming stderr at all). The guard fails just as
loudly on an allowlist entry that matched nothing, on a malformed entry, or on
a run that scanned zero files. An allowlist entry is bound to **one line**:
the command must be on the hit's own line, unless the entry carries an
explicit `lineContains` naming the fragment on the redirect's line, which is
what lets a multi-line pipeline be exempted without exempting its neighbours.
It runs on every `vitest run` via `scripts/check-silenced-stderr.test.mjs`.

**3. Read the object back after a write that matters.** `bd update` exiting 0
is not evidence the value landed. `node scripts/bd-verify-metadata.mjs <id>
<key>=<value> ...` reads the bead back, asserts each value, and prints the
bead's whole metadata keyset — so a key written under a mistyped name is
visible beside the absent one it was meant to be. It exits `1` for a
mismatch, `2` for zero expectations (a verifier handed nothing to verify
never prints a pass), and `3` for a bead it could not read at all, because
"the write failed" and "I could not find out" are different answers.

On `bd` specifically: use **`--append-notes`, never `--notes`**. `--notes`
replaces the whole field and has destroyed notes on this repo twice. Verify
it with `notes~=<a substring that was there before>`.

### The output rule — what makes any of this checkable

The precedent is `pr-review-merge` step 4.2, which requires a round whose
grep falsified nothing to print the same block it would have printed had it
found something, every hit marked "still true", and `falsified=0` in the
marker. Generalised:

> **An empty result reported in the shape a non-empty result would have taken
> is evidence the check ran. An empty result reported as nothing at all
> cannot be told apart from a skip.**

That is the test to apply to any new rule in this file or in a skill: *could
a reviewer be found not to have done it?* A rule whose no-fire branch
produces no output is satisfiable by someone who did nothing, because "I
looked and it did not apply" and "I never looked" leave the same trace.

### Two kinds of report that need this and are not sets

- **A delta needs its baseline, measured the same way on the same tree.**
  "30 new tsc errors" is not a measurement until the baseline it was
  subtracted from is stated, with the command that produced it. On this repo
  that command is `npm run build` *then* `npx tsc --noEmit` — `tsconfig`
  includes `.next/types`, so a typecheck without a build invents `PageProps`
  errors and attributes them to the diff.
- **A "does not exist" needs the revision it was looked for in.** A grep that
  found nothing in a file proves nothing about the file unless the output
  says which copy was read. Name the path and the SHA (`git rev-parse HEAD`
  in the worktree you actually read), never "the repo".
