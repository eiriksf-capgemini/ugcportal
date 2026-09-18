---
name: cut-release
description: Generate an easy-to-read release note from closed beads that haven't been released yet, grouped by conventional-commit type, linking each entry to its bead id and every PR that shipped it (a bead can have more than one), and compute the next semver version. Prepends the result to CHANGELOG.md and bumps package.json's version. Use when asked to "cut a release", "generate release notes", or "what's changed since the last release".
---

# Release Notes (ugcportal)

Usage: `/cut-release` (no arguments needed; run it whenever you want to cut a release from everything closed-but-unreleased).

This reads from **beads metadata**, not git history — every closed bead is expected to carry `metadata.cc_type`, `metadata.cc_scope`, and (if any PR shipped it) `metadata.prs`, per the policy in CLAUDE.md > "Conventional Commits & Release Notes". If a bead you expect to see is missing that metadata, fix the bead (`bd update <id> --set-metadata cc_type=... --set-metadata cc_scope=... --set-metadata prs=gh-N`) rather than guessing in this skill.

## 1. Find unreleased closed beads

```bash
bd list --status=closed --json
```

Filter to issues where `metadata.released_in` is **not** set — those are the ones this release will include. (A small Python/jq filter over the JSON is the easiest way; there's no CLI flag for "metadata key absent".)

If there are zero such issues, say so and stop — nothing to release.

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

`metadata.prs` is a comma-separated list like `gh-5,gh-7`. For each token, strip the `gh-` prefix to get the PR number and build a real link: `https://github.com/eiriksf-capgemini/ugcportal/pull/<n>` (confirm the org/repo slug via `gh repo view --json nameWithOwner` rather than hardcoding it, in case this is ever reused elsewhere). A bead with multiple entries in `prs` must show **all** of them, not just the first — that's the whole point of tracking it as a list.

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
```

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

This is what makes the skill idempotent — re-running it immediately after should find zero unreleased issues.

## 8. Ship it

Follow the repo's normal flow: branch, commit (`chore(release): v<version>` — a release commit legitimately isn't tied to a single bead, so it's fine without a bead-id suffix), push, open a PR via `gh pr create` with the generated changelog section as the PR body, ending with the repo's usual Claude Code attribution footer.

## 9. Report back

State the computed version, the bump reason (which issue(s) triggered feat/major), how many issues were included, and the PR URL.
