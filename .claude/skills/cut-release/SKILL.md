---
name: cut-release
description: Generate an easy-to-read release note from closed beads that haven't been released yet, grouped by conventional-commit type, linking each entry to its bead id and every PR that shipped it (a bead can have more than one), and compute the next semver version. Prepends the result to CHANGELOG.md, bumps package.json's version, and — once that change has merged to main — publishes a matching GitHub Release. Use when asked to "cut a release", "generate release notes", or "what's changed since the last release".
---

# Release Notes (ugcportal)

Usage: `/cut-release` (no arguments needed; run it whenever you want to cut a release from everything closed-but-unreleased).

## 0. Preconditions

Bail out and report rather than proceeding if: the working tree isn't clean (`git status --short` non-empty), or you're not starting from an up-to-date `main` (`git fetch origin main` then compare). Mutating `CHANGELOG.md`/`package.json` and tagging beads on top of a dirty or stale tree is how a release ends up not matching what's actually on `main`.

This reads from **beads metadata**, not git history — every closed bead is expected to carry `metadata.cc_type`, `metadata.cc_scope`, and (if any PR shipped it) `metadata.prs`, per the policy in CLAUDE.md > "Conventional Commits & Release Notes". If a bead you expect to see is missing that metadata, fix the bead (`bd update <id> --set-metadata cc_type=... --set-metadata cc_scope=... --set-metadata prs=gh-N`) rather than guessing in this skill.

## 1. Find unreleased closed beads

```bash
bd list --status=closed --json
```

Filter to issues where `metadata.released_in` is **not** set — those are candidates. (A small Python/jq filter over the JSON is the easiest way; there's no CLI flag for "metadata key absent".)

**Before including a candidate, verify it actually shipped.** `bd status=closed` only means the bead's work is done, not that its PR landed on `main`. For every `gh-N` token in the bead's `metadata.prs`, check `gh pr view N --json state,mergedAt` — if any PR isn't `MERGED`, drop that bead from this release (leave its `released_in` unset so a later run picks it up once it actually merges) and note it in your final report rather than silently skipping it. A bead with no `prs` at all has no PR to check and is not dropped here; the resolution rule below decides which section it renders under. Every token in `prs` must match `gh-<digits>` exactly (`GH-12`, `12`, `gh-12a` and an empty token from a stray comma do not): a bead with any malformed token is excluded from this release and from `C`, left without `released_in`, and named in the step-10 report; fix the bead's `prs` and re-run. **The run is INCOMPLETE while any malformed bead exists**: it may be the only `feat` or `breaking` bead, and the step-3 bump is computed without it. Do not proceed to steps 6-8 until the bead is fixed, or the human has accepted its exclusion by name. `scripts/cut-release-render.mjs` exits 3 in that case. Do not skip this check — a bead closed with an unmerged PR in `prs` has already happened once in this repo's history and produced a changelog entry for work that wasn't on `main`.

**Classify every surviving candidate by `metadata.resolution`.** `bd status=closed` also covers work closed without shipping anything (found cutting v0.7.0: beads closed as already implemented, not reproducible, or decided against were listed as Features and Fixes). The key `resolution` takes one of: `shipped` | `not-reproducible` | `wont-fix` | `duplicate` | `superseded`.

- `resolution` absent and `prs` non-empty: treated as `shipped`. This is the default, so no existing shipped bead needs retagging.
- `resolution` absent and `prs` empty: the fallback. The bead renders under "Closed without a change" (step 5), so existing beads closed without a PR need no retagging either.
- `resolution=shipped`, or any of the four non-shipped values, is taken as written; the four render under "Closed without a change".
- A `resolution` value outside the set above also renders under "Closed without a change" and is named in the step-10 report as unrecognised. It is never dropped.
- Normalisation: `resolution` and `prs` are trimmed; a blank or non-string value counts as absent; `resolution` values are case-sensitive, so `Shipped` is unrecognised.
- A bead with no `prs` that predates the PR workflow (e.g. early direct commits) falls under the fallback too. To keep it in the shipped sections, set `resolution=shipped` on it.

`scripts/cut-release-render.mjs` is the reference implementation of this classification, of step 5's grouping and of the repeated-PR check in step 10; `scripts/cut-release-render.test.mjs` runs it over a fixture. If this prose and that script disagree, fix whichever is wrong in the same PR.

**Report the denominator at every narrowing, and treat a zero at the FIRST
one as a failure of this step rather than as an empty backlog**
(`review-standards` section 6, mitigation 1). Three numbers, in this order:

```
closed beads returned by `bd list --status=closed --json`: <A>
of those, without `metadata.released_in`:                  <B>
of those, verified (every `gh-N` MERGED, or no prs): <C>
```

`A = 0` is not a release with nothing in it — this repo has hundreds of
closed beads, so `A = 0` means `bd list` failed, answered a different
question, or its JSON shape changed under the filter. Stop and say so; do
not continue to step 2 with an empty candidate set. The recorded instance
this guards against is a dependency filter that used the wrong field name
and reported "nothing is stuck" over a backlog with ten dead beads: every
figure on that report was plausible.

`C` counts every candidate that passed the PR check, "Closed without a change" candidates included: step 5 must render exactly `C` entries.

`B = 0` or `C = 0` with a healthy `A` **is** a real answer — everything
closed is already released, or has an unmerged or malformed PR link that
kept it out — and is reported as `A` closed, `B` unreleased, `C` verified
candidates (PR-merged, or closed without a change), not as a bare "nothing to release". Say so with all
three numbers and stop.

## 2. Read the current version

Read `version` from `package.json` at the repo root. That's the baseline this release bumps from (don't use git tags — they may not exist yet).

## 3. Determine the version bump

Across the unreleased issues that step 1 classified as shipped (beads under "Closed without a change" never contribute: a `wont-fix` bead with `cc_type=feat` or `breaking=true` does not raise the bump), look at each one's `metadata.cc_type` (and `metadata.breaking`, if set to `"true"`):

- Any issue has `metadata.breaking=true` → **major**
- Else any issue has `cc_type=feat` → **minor**
- Else → **patch**

(This mirrors the table in CLAUDE.md: feat=minor, fix=patch, everything else=patch when bundled with a release.)

Compute the new version from the current one (semver x.y.z): major bumps x, resets y and z to 0; minor bumps y, resets z to 0; patch bumps z.

## 4. Build the PR link list per bead

`metadata.prs` is a comma-separated list like `gh-5,gh-7`. Run `gh repo view --json nameWithOwner -q .nameWithOwner` once and use that value for every link — do not hardcode a slug. For each token, strip the `gh-` prefix to get the PR number and build the link: `https://github.com/<owner>/<repo>/pull/<n>`. A bead with multiple entries in `prs` must show **all** of them, not just the first — that's the whole point of tracking it as a list.

If a bead has no `prs` metadata, show the bead id with no PR links rather than inventing one. Under step 1's rule such a bead renders under "Closed without a change" unless it carries `resolution=shipped`, so a pre-PR-workflow direct-commit bead needs `resolution=shipped` set to be listed as shipped work.

## 5. Group and render

Group the unreleased issues by `cc_type` into sections, in this order, omitting any section with zero entries:

```
### ✨ Features        (cc_type = feat)
### 🐛 Fixes            (cc_type = fix)
### ⚡ Performance       (cc_type = perf)
### 📝 Documentation    (cc_type = docs)
### ♻️ Refactoring      (cc_type = refactor)
### 🧪 Tests            (cc_type = test)
### 🏗️ Build & CI       (cc_type = build or ci)
### 🔧 Chores           (cc_type = chore, style, revert)
### ❓ Other             (cc_type missing, empty, or not one of the above)
### 🚫 Closed without a change   (classified in step 1)
```

A candidate that step 1 classified as closed without a change renders under "Closed without a change" **instead of** its `cc_type` section, whatever its `cc_type`. That section is last, and for step 5a's rollup it is one more section with its own row.
The "Other" bucket exists so a typo'd or unset `cc_type` produces a *visible* entry demanding a fix, instead of the bead silently vanishing from the changelog while still getting marked `released_in` in step 7. Never drop an issue found in step 1 without rendering it somewhere. "Closed without a change" is rendered, not omitted, and the number of entries across all sections must equal step 1's `C`.

Each entry: `- **<title>** (\`<bead-id>\`, scope: <cc_scope>) — <PR links, comma-separated, or nothing if none>`. Under "Closed without a change", add the resolution after the scope (`resolution: wont-fix`; write `resolution: none` for the fallback).

Prepend a version header above the sections:

```markdown
## v<version> - <YYYY-MM-DD>
```

This header, the optional Cost Summary from step 5a immediately below, and the per-type sections above together make up **"the release notes"** for this version — referenced as that one combined unit everywhere below (steps 6, 8, and 9). Assemble them in this order: version header, then Cost Summary (if step 5a produces one), then the per-type sections.

## 5a. Cost summary

Add a per-type rollup of the cost metadata described in CLAUDE.md > "Token cost metadata" — but only if **at least one** included issue has a `cost_ite_impl`, `cost_ite_qa`, `tokens_impl` or `tokens_qa` field set. If none do, skip this whole step (an all-empty table is noise, not a summary); say so explicitly in your step 10 report either way.

**One unit per bead, never added across units (ugcportal-cii0).** Those fields come in two units: `cost_ite_*` is transcript-derived cost in input-token equivalents, `tokens_*` is the agent's final context size, not its cost (`docs/process/cost-performance-claims-v0.7.0-2026-10-16.md` section 1.2). Put each issue in exactly one of two tables: the **ITE** table if it has a `cost_ite_*` field that is a positive integer on a side not marked incomplete (next sentence; its `tokens_*` are then not read at all), otherwise the **context-size** table if it has any `tokens_*` field. A side marked incomplete — it carries a `cost_coverage_*` key, or a `cost_note_*` that does not begin `all transcripts present` (the note names missing transcripts, rounds without agent ids, rounds whose agents are not in the list, recorded agents dropped from the list, or a figure recorded before any agent list) — has **no accepted** `cost_ite_*` on that side, even if an earlier complete recording left one there that the `INCOMPLETE` write failed to unset: read that side as missing, never as a zero and never at the stale value, and name the issue in your step 10 report. A `cost_ite_*` that is `0`, negative, fractional or not a number is **not** an ITE figure — a 0 is what a transcript sum gives when no listed agent had a transcript, and it must not print as a measured zero cost: treat it as missing, use the issue's `tokens_*` instead, and name it in your step 10 report. A `tokens_impl` on an issue with `tokens_impl_convention=summed-snapshots` is a legacy sum of one agent's cumulative snapshots: treat it as missing and name the issue in your step 10 report. Read the convention trimmed, lower-cased and with `_` as `-`; any value other than `last-per-agent` or `summed-snapshots` is unknown, so treat that `tokens_impl` as missing too and name it. The same rule is implemented, and tested, as `costUnitOf` in `scripts/release-cost-report.mjs`; when the two disagree, that code is the reference.

In each table, reuse the exact same step-5 sections, including "Closed without a change", that step 5 already grouped — same buckets, same order, same membership — rather than recomputing or restating the bucketing rules here. Render one row per section, regardless of whether any issue in it has data in that table's unit (a section with zero data still gets a row of dashes, so the absence is visible rather than silently dropped). For each section: sum that table's Impl field and QA field separately across the section's issues *in that table*, and set `Total = Impl + QA` for that row. A missing field contributes 0 to its sum; if a value is present but isn't a plain integer, treat it as missing too (don't guess or round) and flag the malformed value in your step 10 report. Separately, count "Beads with data" as a fraction: numerator = the section's issues placed in that table, denominator = the section's total issue count from step 5.

Add a final **Total** row to each table: `Total = Impl + QA` there too, and its Impl/QA/Total/"Beads with data" cells are each the straight sum of that column down the per-section rows above (numerator-with-numerator, denominator-with-denominator for the fraction) — never inferred by inspecting whether other columns are zero. Never add a figure from one table to a figure from the other, in a cell, a total or the prose around them. Omit a table whose every row would be dashes.

```markdown
### 💰 Cost Summary

**Transcript cost (input-token equivalents)**

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 30,018,329 | 11,063,233 | 41,081,562 | 1/4 |
| 🔧 Chores | — | — | — | 0/1 |
| **Total** | **30,018,329** | **11,063,233** | **41,081,562** | **1/5** |

**Context-size, not cost** (beads with no accepted `cost_ite_*` figure (absent, 0, malformed, or on a side marked incomplete))

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 12,000 | 236,451 | 248,451 | 2/4 |
| 🔧 Chores | — | 129,674 | 129,674 | 1/1 |
| **Total** | **12,000** | **366,125** | **378,125** | **3/5** |

*Transcript cost is priced from local agent transcripts by `scripts/agent-pass-cost.mjs` in input-token equivalents: proportional to price only for a model priced at the standard ratios (two models whose cache read is cheaper are the exceptions), and a relative measure across models; it omits work done inline in an orchestrator session. The context-size table is each agent's final context window, not what it cost, and is not comparable with the first table or summable with it. A bead's figures can keep growing later from review on a follow-up fix without retroactively updating a past release — treat both as a lower bound, not the release's full or final cost.*
```

Use `—` rather than `0` for any Impl/QA/Total cell — including in the Total row — where the underlying sum is zero only because nothing contributing to it has the field set, so a reader doesn't mistake "no data" for "confirmed zero cost." Comma-format numbers for readability. Always keep the caveat line — it's what stops a partial figure, or a context-size figure, from being misread as the release's true or final cost.

## 6. Write it out

Prepend (not append — newest release on top) the release notes assembled in steps 5–5a to `CHANGELOG.md` at the repo root. If the file doesn't exist yet, create it with a `# Changelog` top-level header first.

Bump the version with `npm version <version> --no-git-tag-version` (not a manual edit) — it updates both `package.json` and `package-lock.json`'s `version` fields (the lockfile has it twice: at the root and under `packages[""]`) in one step. Deliberately **don't** use `npm install --package-lock-only` for this: it re-resolves every dependency against its declared range, so if anything pinned with a caret (most of this repo's deps) has a newer semver-compatible release upstream since the lockfile was last touched, it would rewrite that package's `resolved`/`integrity`/version entries too — an unreviewed transitive dependency bump riding along inside a PR this skill's own step 8 treats as trivially non-sensitive and auto-mergeable. `npm version` only ever touches the version fields, never dependency resolution.

## 7. Mark issues as released

For every issue included in this release, "Closed without a change" entries included (they are rendered here, and an untagged one would reappear in the next release):

```bash
bd update <id> --set-metadata released_in=v<version>
node scripts/bd-verify-metadata.mjs <id> released_in=v<version>
```

**The second line is not optional, and it is not decoration.** This step's
idempotency claim below rests entirely on the write having landed, and
`bd update` exiting 0 is not evidence of that: a mistyped key name writes a
real key and exits 0, leaving `released_in` absent and the bead eligible for
the *next* release too — a duplicate changelog entry for work already
shipped. `bd-verify-metadata` reads the bead back, asserts the value, and
prints the bead's whole metadata keyset, so a key written under a mistyped
name is visible beside the absent one it was meant to be. It exits non-zero
if the value is not there; **a non-zero exit here stops the step**, and the
bead it names is the one to fix by hand.

Report the read-back as a fraction in step 10: `tagged N/N beads
released_in=v<version>, all verified by read-back`. `N/N` with no read-back
behind it is the claim, not the evidence.

This is what makes the skill idempotent — re-running it immediately after should find zero unreleased issues. Steps 6 and 7 aren't atomic: if you're interrupted between writing `CHANGELOG.md` and finishing these `bd update` calls, check `CHANGELOG.md`'s top section before rerunning from step 1 — if it already contains the version you were about to write, finish tagging the remaining beads by hand instead of regenerating (which would duplicate the section).

## 7a. Reconcile the previous release's retrospective

A retrospective nobody converts into beads expires silently. Of the eight process changes in `docs/process/release-cost-v0.5.0-vs-v0.6.0.md` section 9, five still had no bead of any kind when v0.7.0 was being planned — items 2, 3, 4, 6 and 8, filed by hand on 2026-10-08 only because someone went looking (`ugcportal-p7x7`). **Writing a recommendation down is not tracking it.**

This step is **non-blocking**. It never stops a release. An unconverted recommendation is a tracker problem, not a reason to withhold a cut — file the bead, report it, carry on to step 8.

**1. Find the document.** Retrospectives live in `docs/process/`, named for the releases they compare (`release-cost-<prev>-vs-<this>.md`, `release-cost-<a>-to-<c>.md`). You want the one covering the release *before* the one you are cutting: by the time v0.7.0 is cut, v0.6.0's retrospective should be fully converted.

```bash
ls docs/process/release-cost-*.md
```

If no retrospective covers the previous release, say so in the step-10 report and go to step 8. A release can legitimately be the first, or its retrospective can still be in flight. "No document" is a *reported outcome*, never a silent pass.

**2. Read its recommendations.** Each retrospective ends in a numbered recommendations section (`## 9. Process changes for v0.7.0`, `## 6. Recommendations for v0.6.0`). The heading wording varies between documents; the numbered list does not.

**Assert before you judge, mechanically.** If you parsed zero recommendations, that is a failure *of this step*, not a clean document — the heading moved, the numbering changed, or you opened the wrong file. Step 3's command opens with the guard that enforces this (`[ "${total:-0}" -gt 0 ] || exit 1`); report the file and the heading you looked for, and stop this step, not the release. A check that matches nothing and reports success is this repo's family-3 defect, and it is the most likely way this step rots — so the guard is a command, not a sentence.

**3. Match each against the tracker.** A bead owning a retrospective recommendation carries `metadata.retro_source`, valued `<document-filename>#<item-number>`:

`<total>` below is the recommendation count from step 2, and the command answers the question directly — which item numbers are **missing** — rather than listing the ones present and leaving you to diff two lists by eye:

```bash
total=<the number of recommendations parsed in step 2>
[ "${total:-0}" -gt 0 ] || { echo "step 7a parsed zero recommendations: the heading moved, the numbering changed, or this is the wrong file. This is a failure of the step, not a clean document." >&2; exit 1; }

bd list --all --json \
  | jq -r --arg doc "release-cost-v0.5.0-vs-v0.6.0.md" --argjson total "$total" '
      [ .[]
        | select((.metadata.retro_source // "") | startswith($doc + "#"))
        | .metadata.retro_source | split("#")[1] | tonumber
      ] | unique as $have
      | ([ range(1; $total + 1) ] - $have) as $missing
      | "covered: \($have | join(", "))",
        (if ($missing | length) == 0
         then "all \($total) reconciled"
         else "MISSING: \($missing | join(", "))" end)'
```

Every line of that pipeline is load-bearing:

- **`tonumber` before `unique`** (a bug in this step's first draft). Sorting the item numbers as *strings* orders them `1, 10, 2, 3, …`, so any retrospective with ten or more recommendations is read wrong. `unique` on numbers sorts numerically.
- **`unique`, not a bare list** (also a first-draft bug). An item can legitimately be owned by more than one bead — item 5 of `release-cost-v0.5.0-vs-v0.6.0.md` is owned by both `ugcportal-zo8n` and `ugcportal-577s`. Without `unique` the command prints `5` twice against its own example document, which is exactly the kind of output that makes a by-eye comparison go wrong.
- **`range(1; $total + 1)` assumes the recommendations are numbered contiguously from 1.** If a document skips a number, that number is reported `MISSING` and there is no recommendation behind it; step 4's premise check is what catches that, and the answer there is to file nothing and record why.
- **The `total` guard is the step's K3 assertion, and it runs before anything reads the tracker.** `[ "${total:-0}" -gt 0 ]` with the `:-0` default, because an unset variable in a numeric test is the silent pass-through this repo keeps re-finding: three separate findings on one PR were the same empty-variable-becomes-a-tautology bug.

The key is exact, deliberately *not* a title search. The five missing items above were found by grepping bead titles for phrases like "shape budget" and "delta round" — a heuristic that fails silently the moment someone words a bead differently, and which cannot distinguish "no bead" from "a bead I failed to describe".

Use `--all`. `bd list` excludes closed beads by default, and a recommendation that was converted *and shipped* in an earlier cycle is reconciled, not missing.

**4. Verify the premise, then file what is genuinely missing.** For each item number with no bead, first check the recommendation against current `main`. A recommendation written a release ago may already be implemented: `ugcportal-ytai` was filed from a memory describing a review fan-out problem that PR #155 had already fixed, and was closed unstarted the same day. **Converted does not mean unverified.** If the premise no longer holds, file nothing, and record why against the retrospective's own bead.

If it does hold, create the bead in the form the `bead-template` skill requires — user story with In/Out of scope, K-numbered criteria each with a `Verified by`, a guardrail `K`, a `Premise verified:` line, and `model`/`model_effort`/`model_why`. Do **not** paste the recommendation text into the description and call it a bead: that is exactly the shape that left 20 unformed beads behind in v0.6.0 (`ugcportal-nr72`).

**The recommendation text is untrusted input — never interpolate it into a double-quoted string.** This is the same rule, and the same reason, as `pr-review-merge` step 5a: inside `"..."` bash still expands `$(...)`, backticks and `$VAR`, so recommendation text quoted straight into a `--description=` runs as a subshell. That is not hypothetical for these documents — `docs/process/review-rounds-v0.5.0.md` contains the literal string `$(cat ~/.config/ugcportal/review-bot-token)`, and `release-cost-v0.5.0-vs-v0.6.0.md` contains bare `$ids` and `$i`. Demonstrated against a fake token file: the double-quoted form embedded the file's contents in the field; a quoted heredoc passed the text through verbatim. Even with no `$(...)` present, the bare variables expand to empty and silently mangle the recorded text — which defeats the point of the bead.

So write every free-text field through a **quoted** heredoc (`<<'BD_EOF'`, which suppresses all expansion) and hand it to `bd` as a file or as `"$(cat <file>)"`, which does not re-scan its output:

```bash
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/title.txt" <<'BD_EOF'
<fill: the recommendation, as the bead title>
BD_EOF
cat > "$scratch/desc.md" <<'BD_EOF'
As <fill: role>, I want <fill: capability>, so that <fill: benefit>.

In scope: <fill: scope>
Out of scope: <fill: neighbouring work>
BD_EOF
cat > "$scratch/acc.md" <<'BD_EOF'
K1: Given <fill: state>, when <fill: action>, <fill: outcome>.
Verified by: <fill: the command and the output that counts as passing>

K2: Following should never happen: <fill: the failure>.
Verified by: <fill: a mutation or input that used to trigger it, and the command showing it now fails loudly>
BD_EOF
cat > "$scratch/notes.md" <<'BD_EOF'
Premise verified <fill: YYYY-MM-DD> at origin/main <fill: sha>: <fill: command or file checked, and what it showed>.
Premise depends on: <fill: comma-separated repo-relative paths the premise rests on, or none (the external fact it rests on)>
BD_EOF
cat > "$scratch/meta.json" <<'BD_EOF'
{"cc_type": "chore", "cc_scope": "process", "model": "sonnet", "model_effort": "high", "model_why": "<fill: one line, no double quote or backslash: why this tier fits>", "retro_source": "<fill: document.md#N>"}
BD_EOF

grep -l '<fill' "$scratch"/* && { echo "unfilled placeholder" >&2; exit 1; }

bd create "$(cat "$scratch/title.txt")" --type=task --priority=<fill: n> \
  --body-file "$scratch/desc.md" \
  --acceptance="$(cat "$scratch/acc.md")" \
  --notes="$(cat "$scratch/notes.md")" \
  --deps="discovered-from:<fill: retrospective-bead-id>" \
  --metadata @"$scratch/meta.json"
```

The delimiter is `BD_EOF` rather than `EOF` because a recommendation quoting a shell snippet can itself contain a line reading exactly `EOF`, which both of the documents checked do. If any text could contain `BD_EOF` too, change the delimiter again rather than trimming the text.

The title goes through a file and the metadata through `@file`, not through an inline `$(cat` heredoc inside the double quotes or a single-quoted `--metadata` string. On macOS `/bin/bash` 3.2.57 the inline form is parsed before the heredoc is read, so an unbalanced `)` in the recommendation ends the substitution early and any `$(...)` or backtick after it runs; a single-quoted JSON string ends at the first apostrophe, so `it's` in `model_why` ends the quote and a following `$(...)` runs. A quoted heredoc written to a file is read verbatim by bash and zsh alike, and `"$(cat "$scratch/title.txt")"` does not re-scan its output. The `grep -l '<fill'` line stops the block before a bead exists if any placeholder is left, and the metadata must stay valid JSON, so `model_why` and `retro_source` carry no double quote or backslash.

**5. Backfill `retro_source` on beads that already existed.** The first run against a given document finds recommendations whose beads exist but predate this convention. Set the key on those rather than filing duplicates — matching by hand once is what makes every later run exact.

**Why the pointer lives on the bead and not in the document.** The obvious design is to annotate each recommendation in the retrospective with its bead id. Don't. Step 8 relies on a release PR touching only `CHANGELOG.md`, `package.json` and `package-lock.json` — that three-file set is what makes it non-sensitive and auto-mergeable under `pr-review-merge`'s step-2 gate. Editing `docs/process/*.md` inside the release commit would widen that diff and silently invalidate the claim step 8 makes about it. On the bead, the pointer costs the release PR nothing.

**6. Report.** Step 10 states the document read, how many recommendations it held, how many were already converted, every bead id filed, and every recommendation deliberately not filed with its reason. If the step was skipped, name which branch of 1 or 2 caused it.

## 7b. Fresh-machine compose gate

Run this before step 8; it is the gate "validate `docker compose up` before closing" (Eirik, 2026-10-14), whose first run caught `401 UNAUTHORIZED` on the MinIO images (ugcportal-s2qp). A warm local image cache hides exactly that failure, so do not trust a `docker compose up` on your usual machine.

1. Run `node scripts/check-compose-images.mjs`. It resolves every registry image in `docker-compose.yml` over HTTP with an anonymous token, expands the braced forms `${VAR:-default}` and `${VAR-default}` to their default (an unbraced `$VAR` or other form is not expanded), prints each excluded image by name (`local (build)`; `local (allowlist)` for a bare `ugcportal` or `ugcportal-migrate` reference with no registry host or namespace, extendable with `--local-image <name>`; `unresolved-var` for a variable with no default or an unexpanded form; `no-image` for a service with neither image nor build) and the allowlist in its reach line, and exits non-zero on any non-200 or if it checked nothing. A non-zero exit blocks the release.
2. On a machine with Docker, run the stack from a cold registry-image cache. `ugcportal:<tag>` and `ugcportal-migrate:<tag>` are built locally and exist in no registry, so never remove them with `--rmi all`; remove only the registry images and rebuild the local two:
   ```bash
   docker compose down                                     # keeps the minio-data and app-data volumes
   docker compose config --images | grep -v '^ugcportal' | xargs docker image rm -f   # the registry images only (the minio pair)
   export $(npm run --silent docker:qa:build | tail -1)    # builds both local images, exports UGCPORTAL_IMAGE_TAG
   docker compose up --wait
   ```
   Then probe `/` and `/api/public/media` on the app port; both must answer without a 5xx. For a cold-volume run too, add `--volumes` to `docker compose down`, which **deletes** `minio-data` and `app-data` (uploaded media and the app database); do that only on a throwaway machine.
3. Record the outcome of both in the release PR body (script exit and the registry-images-checked line, and the two probe statuses). If there was no Docker machine, say so in the body rather than omitting the line.

The scheduled `compose-images.yml` workflow runs item 1 weekly between releases; it does not replace this step. A scheduled failure reaches a human only through GitHub's scheduled-workflow failure email, so this step is the backstop.

## 8. Ship it

This step commits and pushes — defer to CLAUDE.md's "Agent Context Profiles" for whether you may do that unprompted (Conservative default: report the generated changes and wait for explicit approval before committing/pushing; only proceed straight to branch/commit/push/PR if the user's request or the active profile already grants that authority).

Once authorized: branch, commit (`chore(release): v<version>` — a release commit legitimately isn't tied to a single bead, so it's fine without a bead-id suffix), push, open a PR via `gh pr create` with the release notes (steps 5–5a) plus step 7b's result line (script exit, registry-images-checked line, probe statuses, or "no Docker machine") as the PR body, ending with the repo's usual Claude Code attribution footer.

A release PR only ever touches `CHANGELOG.md`, `package.json`, and `package-lock.json`, so it isn't a sensitive path under `pr-review-merge`'s gate. If the active profile grants merge authority, run that skill against the PR you just opened; otherwise report the PR URL and wait for a human to merge it. Either way, do not proceed to step 9 until the PR has actually merged.

## 9. Publish the GitHub Release

Do this only after confirming the release PR from step 8 is merged (`gh pr view <n> --json state,mergedAt` shows `MERGED`) — never before, and never for a version that already has one.

1. Check for an existing release first: `gh release view v<version>`. If it already exists, skip this step and note that in your report (this makes the skill safe to re-run without double-publishing).
2. Write the release notes (steps 5–5a) to a scratch file, **without** the `## v<version> - <date>` header line (the GitHub Release UI already shows the tag and date) — e.g. via the `Write` tool to a path under the session's scratchpad directory. `CHANGELOG.md`, the release PR body, and the GitHub Release all derive from this one same set of release notes — don't let any one of the three channels drop the Cost Summary while the others keep it.
3. Read the release PR's actual base branch rather than assuming `main` — `gh pr view <n> --json baseRefName -q .baseRefName` — and create the release targeting that branch, so the tag lands on the merge commit rather than wherever `HEAD` happens to be:
   ```bash
   gh release create v<version> --title "v<version>" --notes-file <scratch-file> --target <base-ref>
   ```
   This creates the `v<version>` tag if it doesn't already exist — no separate `git tag`/`git push --tags` needed.

## 10. Report back

Start with any malformed-`prs` beads (the run is incomplete while they exist; see step 1), then state the computed version, the bump reason (which issue(s) triggered feat/major), step 1's three narrowing figures (`A` closed / `B` unreleased / `C` verified candidates: PR-merged or closed without a change), how many entries step 5 rendered under "Closed without a change" and the total rendered (which must equal `C`), the report lines `scripts/cut-release-render.mjs` prints, verbatim in form: `PR #<n> (<bead-id>) is already linked in an earlier release section: <versions>` (scan the `pull/<n>` links of every existing `## v` section, exact number match; the entry stays rendered rather than being silently re-announced or dropped), `<bead-id>: unrecognised resolution "<value>"`, `<bead-id>: malformed prs "<raw>" -- excluded from this release; fix the bead, then re-run`, and `<bead-id> dropped from this release: PR(s) not MERGED: <numbers>`, step 7's read-back fraction, how many issues were included, whether step 5a's Cost Summary was included or skipped (and why, if skipped, or note any malformed `tokens_impl`/`tokens_qa`/`cost_ite_*` value it ignored, and any `summed-snapshots` or unknown-convention value it treated as missing), the PR URL, and the GitHub Release URL (or why it was skipped/deferred).

Then step 7b's result next to 7a's: the script's exit and its registry-images-checked line, the two probe statuses (or that there was no Docker machine), and what the release PR body recorded.

Then step 7a's result, which is reported whether or not it filed anything: the retrospective document read and how many recommendations it held, how many were already converted, every bead id filed, and every recommendation deliberately not filed with its reason. If 7a was skipped or stopped, say which branch of its steps 1 or 2 caused it — a retrospective silently going unread is the failure this step exists to prevent, so "nothing to report" is never an acceptable rendering of it.
