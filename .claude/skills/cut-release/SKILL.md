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

**Before including a candidate, verify it actually shipped.** `bd status=closed` only means the bead's work is done, not that its PR landed on `main`. For every `gh-N` token in the bead's `metadata.prs`, check `gh pr view N --json state,mergedAt` — if any PR isn't `MERGED`, drop that bead from this release (leave its `released_in` unset so a later run picks it up once it actually merges) and note it in your final report rather than silently skipping it. A bead with no `prs` at all (pre-PR-workflow direct commit) is trusted as-is. Do not skip this check — a bead closed with an unmerged PR in `prs` has already happened once in this repo's history and produced a changelog entry for work that wasn't on `main`.

If there are zero verified-shipped issues, say so and stop — nothing to release.

## 2. Read the current version

Read `version` from `package.json` at the repo root. That's the baseline this release bumps from (don't use git tags — they may not exist yet).

## 3. Determine the version bump

Across all the unreleased issues found in step 1, look at each one's `metadata.cc_type` (and `metadata.breaking`, if set to `"true"`):

- Any issue has `metadata.breaking=true` → **major**
- Else any issue has `cc_type=feat` → **minor**
- Else → **patch**

(This mirrors the table in CLAUDE.md: feat=minor, fix=patch, everything else=patch when bundled with a release.)

Compute the new version from the current one (semver x.y.z): major bumps x, resets y and z to 0; minor bumps y, resets z to 0; patch bumps z.

## 4. Build the PR link list per bead

`metadata.prs` is a comma-separated list like `gh-5,gh-7`. Run `gh repo view --json nameWithOwner -q .nameWithOwner` once and use that value for every link — do not hardcode a slug. For each token, strip the `gh-` prefix to get the PR number and build the link: `https://github.com/<owner>/<repo>/pull/<n>`. A bead with multiple entries in `prs` must show **all** of them, not just the first — that's the whole point of tracking it as a list.

If a bead has no `prs` metadata (shipped via a direct commit predating the PR workflow, e.g. very early scaffolding work), just show the bead id with no PR links rather than inventing one.

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
```

The "Other" bucket exists so a typo'd or unset `cc_type` produces a *visible* entry demanding a fix, instead of the bead silently vanishing from the changelog while still getting marked `released_in` in step 7. Never drop an issue found in step 1 without rendering it somewhere.

Each entry: `- **<title>** (\`<bead-id>\`, scope: <cc_scope>) — <PR links, comma-separated, or nothing if none>`

Prepend a version header above the sections:

```markdown
## v<version> - <YYYY-MM-DD>
```

This header, the optional Cost Summary from step 5a immediately below, and the per-type sections above together make up **"the release notes"** for this version — referenced as that one combined unit everywhere below (steps 6, 8, and 9). Assemble them in this order: version header, then Cost Summary (if step 5a produces one), then the per-type sections.

## 5a. Cost summary

Add a per-type rollup of the same `tokens_impl`/`tokens_qa` bead metadata described in CLAUDE.md > "Token cost metadata" — but only if **at least one** included issue has either field set. If none do, skip this whole step (an all-empty table is noise, not a summary); say so explicitly in your step 10 report either way.

Reuse the exact same per-`cc_type` sections step 5 already grouped — same buckets, same order, same membership — rather than recomputing or restating the bucketing rules here. Render one row per section, regardless of whether any issue in it has cost data (a section with zero data still gets a row of dashes, so the absence is visible rather than silently dropped). For each section: sum `tokens_impl` and `tokens_qa` separately across its issues, and set `Total = Impl + QA` for that row. A missing `tokens_impl`/`tokens_qa` field contributes 0 to its sum; if a value is present but isn't a plain integer, treat it as missing too (don't guess or round) and flag the malformed value in your step 10 report. Separately, count how many of the section's issues have *either* field set as a "Beads with data" fraction (numerator = issues with data, denominator = the section's total issue count from step 5).

Add a final **Total** row: `Total = Impl + QA` there too, and its Impl/QA/Total/"Beads with data" cells are each the straight sum of that column down the per-section rows above (numerator-with-numerator, denominator-with-denominator for the fraction) — never inferred by inspecting whether other columns are zero.

```markdown
### 💰 Cost Summary

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 12,000 | 236,451 | 248,451 | 2/4 |
| 🔧 Chores | — | 129,674 | 129,674 | 1/1 |
| **Total** | **12,000** | **366,125** | **378,125** | **3/5** |

*Cost figures come from bead metadata (`tokens_impl`/`tokens_qa`) as recorded as of this release. `tokens_impl` is a best-effort manual estimate that isn't consistently recorded, and a bead's `tokens_qa` can keep growing later from review on a follow-up fix without retroactively updating a past release — treat these totals as a lower bound, not the release's full or final cost.*
```

Use `—` rather than `0` for any Impl/QA/Total cell — including in the Total row — where the underlying sum is zero only because nothing contributing to it has the field set, so a reader doesn't mistake "no data" for "confirmed zero cost." Comma-format numbers for readability. Always keep the caveat line — it's what stops a partial figure (which this will usually be, until `tokens_impl` is recorded more consistently) from being misread as the release's true or final cost.

## 6. Write it out

Prepend (not append — newest release on top) the release notes assembled in steps 5–5a to `CHANGELOG.md` at the repo root. If the file doesn't exist yet, create it with a `# Changelog` top-level header first.

Bump the version with `npm version <version> --no-git-tag-version` (not a manual edit) — it updates both `package.json` and `package-lock.json`'s `version` fields (the lockfile has it twice: at the root and under `packages[""]`) in one step. Deliberately **don't** use `npm install --package-lock-only` for this: it re-resolves every dependency against its declared range, so if anything pinned with a caret (most of this repo's deps) has a newer semver-compatible release upstream since the lockfile was last touched, it would rewrite that package's `resolved`/`integrity`/version entries too — an unreviewed transitive dependency bump riding along inside a PR this skill's own step 8 treats as trivially non-sensitive and auto-mergeable. `npm version` only ever touches the version fields, never dependency resolution.

## 7. Mark issues as released

For every issue included in this release:

```bash
bd update <id> --set-metadata released_in=v<version>
```

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

**Assert before you judge.** If you parsed zero recommendations, that is a failure *of this step*, not a clean document — the heading moved, the numbering changed, or you opened the wrong file. Report the file and the heading you looked for, and stop this step (not the release). A check that matches nothing and reports success is this repo's family-3 defect, and it is the most likely way this step rots.

**3. Match each against the tracker.** A bead owning a retrospective recommendation carries `metadata.retro_source`, valued `<document-filename>#<item-number>`:

```bash
bd list --all --json \
  | jq -r --arg doc "release-cost-v0.5.0-vs-v0.6.0.md" \
      '[.[] | select((.metadata.retro_source // "") | startswith($doc + "#"))]
       | map(.metadata.retro_source | split("#")[1]) | sort | join(", ")'
```

That is an exact key, deliberately *not* a title search. The five missing items above were found by grepping bead titles for phrases like "shape budget" and "delta round" — a heuristic that fails silently the moment someone words a bead differently, and which cannot distinguish "no bead" from "a bead I failed to describe".

Use `--all`. `bd list` excludes closed beads by default, and a recommendation that was converted *and shipped* in an earlier cycle is reconciled, not missing.

**4. Verify the premise, then file what is genuinely missing.** For each item number with no bead, first check the recommendation against current `main`. A recommendation written a release ago may already be implemented: `ugcportal-ytai` was filed from a memory describing a review fan-out problem that PR #155 had already fixed, and was closed unstarted the same day. **Converted does not mean unverified.** If the premise no longer holds, file nothing, and record why against the retrospective's own bead.

If it does hold, create the bead in the form the `bead-template` skill requires — user story with In/Out of scope, K-numbered criteria each with a `Verified by`, a guardrail `K`, a `Premise verified:` line, and `model`/`model_effort`/`model_why`. Do **not** paste the recommendation text into the description and call it a bead: that is exactly the shape that left 20 unformed beads behind in v0.6.0 (`ugcportal-nr72`).

```bash
bd create "<title>" --type=task --priority=<n> \
  --description="As a <role>, I want <capability>, so that <benefit>.

In scope: ...
Out of scope: ..." \
  --acceptance="K1: Given ..., when ..., <outcome>.
Verified by: ...

K2: Following should never happen: ...
Verified by: ..." \
  --notes="Premise verified <date>: <command or file checked>." \
  --deps="discovered-from:<retrospective-bead-id>" \
  --metadata='{"cc_type":"chore","cc_scope":"process","model":"sonnet","model_effort":"high","model_why":"...","retro_source":"release-cost-v0.5.0-vs-v0.6.0.md#2"}'
```

**5. Backfill `retro_source` on beads that already existed.** The first run against a given document finds recommendations whose beads exist but predate this convention. Set the key on those rather than filing duplicates — matching by hand once is what makes every later run exact.

**Why the pointer lives on the bead and not in the document.** The obvious design is to annotate each recommendation in the retrospective with its bead id. Don't. Step 8 relies on a release PR touching only `CHANGELOG.md`, `package.json` and `package-lock.json` — that three-file set is what makes it non-sensitive and auto-mergeable under `pr-review-merge`'s step-2 gate. Editing `docs/process/*.md` inside the release commit would widen that diff and silently invalidate the claim step 8 makes about it. On the bead, the pointer costs the release PR nothing.

**6. Report.** Step 10 states the document read, how many recommendations it held, how many were already converted, every bead id filed, and every recommendation deliberately not filed with its reason. If the step was skipped, name which branch of 1 or 2 caused it.

## 8. Ship it

This step commits and pushes — defer to CLAUDE.md's "Agent Context Profiles" for whether you may do that unprompted (Conservative default: report the generated changes and wait for explicit approval before committing/pushing; only proceed straight to branch/commit/push/PR if the user's request or the active profile already grants that authority).

Once authorized: branch, commit (`chore(release): v<version>` — a release commit legitimately isn't tied to a single bead, so it's fine without a bead-id suffix), push, open a PR via `gh pr create` with the release notes (steps 5–5a) as the PR body, ending with the repo's usual Claude Code attribution footer.

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

State the computed version, the bump reason (which issue(s) triggered feat/major), how many issues were included, whether step 5a's Cost Summary was included or skipped (and why, if skipped, or note any malformed `tokens_impl`/`tokens_qa` value it ignored), the PR URL, and the GitHub Release URL (or why it was skipped/deferred).

Then step 7a's result, which is reported whether or not it filed anything: the retrospective document read and how many recommendations it held, how many were already converted, every bead id filed, and every recommendation deliberately not filed with its reason. If 7a was skipped or stopped, say which branch of its steps 1 or 2 caused it — a retrospective silently going unread is the failure this step exists to prevent, so "nothing to report" is never an acceptable rendering of it.
