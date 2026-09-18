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

## 6. Write it out

Prepend (not append — newest release on top) this section to `CHANGELOG.md` at the repo root. If the file doesn't exist yet, create it with a `# Changelog` top-level header first. Also update `version` in `package.json` to the new value.

## 7. Mark issues as released

For every issue included in this release:

```bash
bd update <id> --set-metadata released_in=v<version>
```

This is what makes the skill idempotent — re-running it immediately after should find zero unreleased issues. Steps 6 and 7 aren't atomic: if you're interrupted between writing `CHANGELOG.md` and finishing these `bd update` calls, check `CHANGELOG.md`'s top section before rerunning from step 1 — if it already contains the version you were about to write, finish tagging the remaining beads by hand instead of regenerating (which would duplicate the section).

## 8. Ship it

This step commits and pushes — defer to CLAUDE.md's "Agent Context Profiles" for whether you may do that unprompted (Conservative default: report the generated changes and wait for explicit approval before committing/pushing; only proceed straight to branch/commit/push/PR if the user's request or the active profile already grants that authority).

Once authorized: branch, commit (`chore(release): v<version>` — a release commit legitimately isn't tied to a single bead, so it's fine without a bead-id suffix), push, open a PR via `gh pr create` with the generated changelog section as the PR body, ending with the repo's usual Claude Code attribution footer.

A release PR only ever touches `CHANGELOG.md` and `package.json`, so it isn't a sensitive path under `pr-review-merge`'s gate. If the active profile grants merge authority, run that skill against the PR you just opened; otherwise report the PR URL and wait for a human to merge it. Either way, do not proceed to step 9 until the PR has actually merged.

## 9. Publish the GitHub Release

Do this only after confirming the release PR from step 8 is merged (`gh pr view <n> --json state,mergedAt` shows `MERGED`) — never before, and never for a version that already has one.

1. Check for an existing release first: `gh release view v<version>`. If it already exists, skip this step and note that in your report (this makes the skill safe to re-run without double-publishing).
2. Write the same grouped notes built in step 5 to a scratch file, **without** the `## v<version> - <date>` header line (the GitHub Release UI already shows the tag and date) — e.g. via the `Write` tool to a path under the session's scratchpad directory.
3. Create the release, targeting the branch the PR merged into (normally `main`) so the tag lands on the merge commit rather than wherever `HEAD` happens to be:
   ```bash
   gh release create v<version> --title "v<version>" --notes-file <scratch-file> --target main
   ```
   This creates the `v<version>` tag if it doesn't already exist — no separate `git tag`/`git push --tags` needed.

## 10. Report back

State the computed version, the bump reason (which issue(s) triggered feat/major), how many issues were included, the PR URL, and the GitHub Release URL (or why it was skipped/deferred).
