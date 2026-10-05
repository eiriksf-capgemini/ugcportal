---
name: pre-review
description: The implementer's own review pass on a branch, run BEFORE opening the PR in this repo — build, typecheck, lint and the full test suite against the branch merged with current origin/main, the repo's guard suites named, the four-family sweep with scripts/sweep-candidates.mjs, a comment-claims audit with scripts/claims-audit.mjs (every never/always/cannot/only/exactly/guarantees/ensures, every measurement, every pointer, with the evidence beside it), a fixture-mutation check for every new assertion, and a diff-hygiene pass. Produces the checklist block the PR body must carry. Use when a bead's implementation is complete and the next step would be `git push` / `gh pr create`; also when a reviewer asks whether pre-review ran.
---

# Pre-review (ugcportal)

Usage: run this on the implementation branch, in your own worktree, after the last commit you intend to push and before `gh pr create`. It takes ten to twenty minutes of agent time. It exists because of a measurement: in the v0.5.0 cut the median feature PR took six review rounds; across the 10-04/05 batch (#80-#103) 53% of the rounds that ran found only lows; and across the nine PRs that closed the cut (#94-#102), 61% of the lows raised at round 4 or later were a comment claiming something the code does not do (`docs/process/review-rounds-v0.5.0.md`, Parts 1-2). Most of those lows were visible on the branch before the PR existed. A review round costs 100k-300k tokens and 15-40 minutes; this pass costs one.

What it is not: it does not replace `pr-review-merge`, it does not change the severity gate or the round cap (`review-standards` section 3), and passing it is not a merge condition — the reviewer still runs the full sweep at round 1. It is the implementer doing first what the reviewer would otherwise do at round 1 for the price of a round.

**Every step reports a result by name in the checklist (step 7), including "nothing found".** A step you skipped is written as skipped, with why. The checklist goes in the PR body; a PR body without it tells the reviewer pre-review did not run.

Run git only inside your worktree, never in the main checkout (`bd memories shared-checkout-is-not-safe-for-agents`).

## 1. Merge current main first, then the mechanical gates — in CI's order

```bash
git fetch origin main
git merge --no-edit origin/main          # resolve conflicts now, not at review round 4
npm run lint
npx vitest run                           # record files/tests counts for the checklist
npm run build                            # build BEFORE typecheck: tsconfig includes .next/types
npm run typecheck
```

Why against merged main and not the branch alone: the v0.5.0 cut broke `main` for 65 minutes on 2026-10-05 when #95, #97 and #98 merged within six minutes of each other, each green on its own branch and each red on `main` — #94 had just landed a test asserting exactly one `h-14` in `site-header.tsx`, and #97 had added a `text-ink` use that the dual-meaning audit did not know about (`gh run list --branch main`, runs 37274930436, 37274982787, 37275420480; all failed in the `Test` step). #94 itself spent its round 4 largely on a conflict with #92 that had merged under it. The pre-push hook (`.beads/hooks/pre-push`) runs the same four commands, but on whatever your branch happens to be based on; this step runs them on what `main` will actually become.

If the merge brings in conflicts in a file your bead did not need to touch, resolve them in a separate commit so the reviewer can see your diff and the merge apart (`gh pr diff` against the merge base shows only yours).

## 2. The guard suites, named

The whole suite ran in step 1; this step is about *reading* the results of the guards that fail on `main` when two branches meet, so you know they passed on the merged tree rather than assuming it:

```bash
npx vitest run src/lib/design eslint-gated-script.test.ts \
  src/components/consent/analytics-host.grep.test.ts \
  src/components/site-header.height.test.ts \
  src/components/home/front-page-strings.test.tsx
```

| Guard | What it pins | Red on `main` or in review when |
|---|---|---|
| `src/lib/design/dual-meaning-usage.test.ts` | every (file, token, count) use of `text-ink`, `text-ink-muted`, `text-foreground`, `text-primary` etc. is audited against the background it renders on | #97 added `hero.tsx` `text-ink` without an entry (main red 2026-10-05) |
| `src/lib/design/contrast.test.ts`, `no-raw-hex.test.ts`, `motion-reduce-pairing.test.ts` | every token pairing meets WCAG, no hex literal outside the palette, no interaction motion without a reduced-motion gate | #79 rounds 1-5 (seven WCAG regressions), #101 round 1 |
| `src/components/site-header.height.test.ts` | the header's constants equal the compiled Tailwind values and `site-header.tsx` has exactly one `h-14` | #95/#98 merges (main red 2026-10-05) |
| `eslint-gated-script.test.ts`, `analytics-host.grep.test.ts` | no script loads outside the consent gate, by mechanism and by vendor name | #92 rounds 1-6, #95 |
| `src/components/home/front-page-strings.test.tsx` | the front page's visible strings and language | #97 |

If your diff adds a guard of this kind, it belongs in this table (edit this file in the same PR — `.claude/skills/**` is a sensitive path, so a human merges, which is right for a change to what pre-review checks).

## 3. The four-family sweep, with the enumerator beside you

```bash
node scripts/sweep-candidates.mjs       # Family 3 toContain needles; Family 4 sibling literals
```

Then the four questions from `review-standards` section 2, answered in writing per family, including "nothing":

1. **Family 1 — a comment claims a guarantee the code does not make.** Step 4 below is the mechanical half of this; the judgement half is: for every claim it lists, which test or which line of code makes it true on every path?
2. **Family 2 — a check compares the wrong two things.** For every comparison in the diff: what does it return for `NaN`, `null`, `undefined`, `""`? Is that fail-closed? Are both sides derived from different sources? (#85 round 1: a storage-outage classifier keyed on error *shape* in a catch that also wrapped the database call; #91 round 1: a provider recorded per user but judged per session.)
3. **Family 3 — an assertion that cannot fail.** Step 5 below. The `toContain` list from the enumerator is the start, not the whole set.
4. **Family 4 — sibling omission.** For every field, guard, projection, response path or *sentence* you touched: where else does the same shape live? The enumerator sees literal siblings in one file only. The cases that cost rounds were cross-file (#93 round 2: a curation tag stripped on the site but still emitted by the API; #96 round 1: the same `SITE_DESCRIPTION` string #94 had just removed from the gallery heading; #102 rounds 2-3: one corrected sentence with four uncorrected copies). `grep` for the identifier, the string and the claim.

What the sweep does not catch, and is not expected to: the mediums that were found by *execution* — a real 500 when `getSession` rejects in the assembled app (#97 round 2), two configured people merged by driving `@auth/core`'s real `handleLoginOrRegister` (#98 round 1), `SQLITE_BUSY` in a third of e2e runs (#101 round 1), text drawn over a near-white decorative shape measured at 1:1 (#97 round 1). If your bead has a real flow (sign-in, upload, a page under a failing dependency), step 6 is where you drive it.

## 4. The comment-claims audit

```bash
node scripts/claims-audit.mjs             # claim-shaped sentences on the lines this branch added
node scripts/claims-audit.mjs --all-lines # every comment in every changed file: the stale-sibling sweep
```

Expect tens of lines on a code PR and hundreds on a PR that adds documentation (run on its own branch, this skill's PR listed 268, most of them in the report and in the script's own header, which is prose about claims); read code files first, Markdown last. It lists, per `file:line`, every comment or prose sentence that is **ABSOLUTE** (never / always / cannot / only / exactly / guarantees / ensures / impossible / unreachable / by construction), a **MEASUREMENT** (a number with a unit: `85px`, `3.18:1`, `~46x`, `2588 tests`), **TEMPORAL** (still / not yet / currently / once #94 merges / TODO), **HISTORY** (review-round narration in code or a test title), or a **REFERENCE** to a file that `git ls-files` does not have. It judges nothing; you do, one line at a time, under `review-standards` section 5:

- an **ABSOLUTE** gets the evidence beside it (`// never null: the Prisma select requires it, see route.test.ts "rejects a null id"`) or is weakened to what the code does;
- a **MEASUREMENT** moves into a test that fails when it drifts, and the comment points at the test; if no test is worth writing, the number is not worth keeping;
- a **TEMPORAL** sentence is either true at this head (and will be true at merge) or deleted — "remains to be switched" in the PR that is the switch cost #82 a round;
- **HISTORY** is deleted from code and test titles; it belongs in the PR body and the bead;
- a **REFERENCE not found** is fixed or named as a dependency file.

Measured on the v0.5.0 PRs, this step alone would have removed: #86 round 1 (three of four lows: two measurements of one scenario in `schema.prisma`, a type guard the comment said constrained), #102 round 1 (three of four lows: a dedupe mechanism described backwards), #100 rounds 1-2 (three of five lows), #98 round 1 (a comment citing a file that does not exist; "runs once per sign-in" — twice), #97 round 1 (a contrast entry that does not exist; a reference to a heading #94 was removing), #101 round 1 (seven comment items), #95 round 5 (six family-1 lows, including a `.mtsx` extension TypeScript does not have). It would not have caught a claim that is wrong but contains none of the trigger words — #94 round 5's "no listeners attached" was found by reading the component; keep reading.

## 5. The fixture-mutation check, for every new assertion

List what you added:

```bash
git diff origin/main...HEAD -U0 -- '*.test.*' '*.spec.*' | grep -nE '^\+.*(expect\(|toHaveCSS|toMatchSnapshot)'
```

For **each** new assertion, in the test's own fixture, change the thing the assertion describes so the failure *should* occur, run the file, watch it fail, restore. Mutating production code proves the assertion is connected to the behaviour; mutating the fixture proves it is connected to a case that can actually fail (`review-standards` section 2, family 3). Record the count in the checklist: `N new assertions, N fixture-mutated, each failed`.

Three shapes that passed a self-reported "mutation check" in v0.5.0 and cost a round each, so the self-report alone is not the evidence:

- **A "mutation check" test that asserts against a local string and never calls the code.** #83 round 1 (medium) and round 3 (medium, the same shape again), #92 round 1 (medium): the test re-implemented the logic inline and would pass whatever the route emitted. A mutation check is a step you perform and report, not a test you keep.
- **A needle that is present (or absent) whatever the code does.** #97 round 1: an `øl` word-boundary regex that can never match (`\b` is ASCII-only without the `u` flag); #96 round 2: `not.toContain('id="get-in-touch"')`, a needle nothing renders; #101 round 1 (medium): a test titled "fixing the fixture makes the scan report nothing" asserting a class string the PR's own comment said was still broken.
- **A test that exercises the dead layer.** #102 round 1: the shared-promise mock proved the `WeakSet` dedupe while the live `cache()` layer, the one that actually holds in a render, was only verifiable on a server.

A fresh fix to a fail-open, an authz gap or a migration whose test has no failing case is a **medium**, not a weak test (`review-standards` section 3).

## 6. Drive the real flow, if the bead has one

Not every bead has one; say so if not. When it does, the rounds that found mediums in v0.5.0 found them here, and nothing in steps 1-5 substitutes:

- a page or route under a failing dependency (`getSession` rejecting, the database down, object storage unreachable): load it on `npm run dev` and read the status and the log — #97 round 2 found a 500 this way; #102 round 1 verified the fix the same way;
- an auth change: drive `@auth/core`'s real `handleLoginOrRegister` with the real adapter against a temporary database — #98 rounds 1-3 found five mediums this way and nothing else would have;
- a visual or motion change: Playwright against a dev server in the browsers you claim, at 320px and desktop, in both colour schemes, under `prefers-reduced-motion: reduce` where relevant — #94 round 1, #97 round 1 and #101 round 1 were measurements;
- an e2e spec that touches the database: run it three times under `fullyParallel` before trusting it — #101 round 1 reproduced `SQLITE_BUSY` in about a third of runs.

Write down what you ran and what you saw, with the command. "Verified by execution: `/` and `/about` answer 200 with one log line each when `getSession` rejects" is evidence; "tested locally" is not.

## 7. Diff hygiene, then the checklist

```bash
git diff origin/main...HEAD --stat                       # every file is the bead's; no hunk from a sibling branch
git log origin/main..HEAD --format='%s%n%b' | grep -c 'Co-Authored-By: Claude'   # the attribution line this repo uses
```

Four cheap lows from v0.5.0: a hunk that belonged to another PR (#82 round 1, then round 2 when the fix commit said it was removed and it was not), the wrong `Co-Authored-By` (#91 round 1), a `docs(...)` title on a PR that added a route handler (#83 round 5), a PR body still carrying a claim the code had dropped two rounds earlier (#98 rounds 5-6). Check the PR title's type against the diff, and reread the PR body against the final diff — the body is prose and the claims audit does not see it.

Then paste this into the PR body, filled in. Every line is a fact you observed, with the number or the word "nothing"; nothing here is a promise.

```markdown
## Pre-review (`/pre-review`, run on <head sha> merged with origin/main at <main sha>)

1. Gates on merged main: lint clean; vitest <files> files / <tests> tests; build ok; typecheck ok.
2. Guard suites: <list the ones that apply>, all green on the merged tree. New guard added: <none | name, added to pre-review step 2>.
3. Four-family sweep (`sweep-candidates`: <n> toContain candidates, <n> sibling candidates):
   - Family 1: <what you checked, what you found>
   - Family 2: <every comparison, NaN/null/empty answer, fail-closed yes/no>
   - Family 3: see 5.
   - Family 4: <identifiers/strings/claims grepped, siblings found and fixed | nothing>
4. Claims audit (`claims-audit`): <n> candidates; ABSOLUTE <n> (evidence added / weakened: <n>/<n>), MEASUREMENT <n> (moved to tests: <n>, deleted: <n>), TEMPORAL <n>, HISTORY <n> (removed), REFERENCE not found <n> (fixed). `--all-lines`: <n> stale siblings corrected.
5. Fixture mutation: <n> new assertions, <n> fixture-mutated, each failed as described; <exceptions, with why>.
6. Real flow driven: <command and observation | none, because ...>.
7. Diff hygiene: <n> files, all in scope; attribution on <n>/<n> commits; title type <type> matches the diff; PR body reread against the final diff.
```

If a step found something and you fixed it, say so in the line — a finding pre-review caught is the whole point, not something to hide. If it found something you chose not to fix, say that too, and why; the reviewer will otherwise find it at round 1 for the price of a round.

## What this does and does not buy

Pre-review is aimed at the round-1 finding count (the bead's target: halve it) and at the family-1 tail. On the v0.5.0 PRs it would have removed roughly half the round-1 lows and most of the rounds 4-6 lows in #94-#102; it would have removed none of the execution-found mediums unless step 6 was run with the real flow, and none of the reuse / simplification / efficiency lows that `code-review`'s cleanup angles raise on a large diff (#93 round 1: twelve of thirteen; #90 round 2: nine of nine) — those are a different population, filed at round 4+ on an `exact` chain and otherwise `/simplify` before the PR is the closest local equivalent. The measurement that tells whether this skill is earning its keep is in `docs/process/review-rounds-v0.5.0.md`, Part 3, item 2.
