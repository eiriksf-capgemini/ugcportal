# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## Changing `.claude/settings.json` or `.claude/settings.local.json`

These files are edit/write-denied for all agents (`permissions.deny` in `.claude/settings.json`).
This is deliberate: a polecat previously self-modified `.claude/settings.json` inside its work
branch (adding permission entries) and it nearly got auto-merged to `main` by the Refinery
unreviewed.

If a task genuinely needs a change here:
- **Do not** try to work around the deny rule.
- Either open a dedicated PR against `origin/main` containing only that file change, for
  human review, **or** stop and hand the exact change (diff/snippet) to Eirik to apply manually.
- Never bundle a settings.json/settings.local.json change into an unrelated work branch — the
  Refinery does not treat these files specially and will merge them like any other diff.

## Conventional Commits & Release Notes

PR titles (and the resulting squash-merge commit) must follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description> (<bead-id>)
```

Example: `feat(gallery): add lightbox with PhotoSwipe (ugcportal-71y)`

`<scope>` and the trailing `(<bead-id>)` are both required. The one exception
is a release commit cut by the `cut-release` skill, which isn't tied to a
single bead: `chore(release): vX.Y.Z`.

Enforced by the `guard-conventional-commit-title` job in `.github/workflows/ci.yml`
on every PR. Valid `<type>` values and their semver impact:

| type       | meaning                                  | semver bump |
|------------|-------------------------------------------|-------------|
| `feat`     | new user-facing capability                | minor       |
| `fix`      | bug fix                                   | patch       |
| `docs`     | documentation only                        | patch\*     |
| `style`    | formatting, no logic change               | patch\*     |
| `refactor` | code change that's neither a fix nor feat | patch\*     |
| `perf`     | performance improvement                   | patch       |
| `test`     | adding/fixing tests only                  | patch\*     |
| `build`    | build system or dependencies              | patch\*     |
| `ci`       | CI/CD config                              | patch\*     |
| `chore`    | everything else (ops, reviews, cleanup)   | patch\*     |
| `revert`   | reverts a previous commit                 | patch       |

\* Types marked patch\* don't warrant a release on their own in most tooling,
but count as patch if bundled into a release alongside a `feat`/`fix`. A `!`
after the type/scope (e.g. `feat(auth)!: ...`) or a `BREAKING CHANGE:` footer
means **major**, regardless of type.

`<scope>` is a short kebab-case area of the codebase (e.g. `auth`, `gallery`,
`storage`, `ci`). Every tracked bead carries this same classification as
metadata (`bd show <id>` -> `metadata.cc_type` / `metadata.cc_scope`), plus
`metadata.prs` listing every merged PR that shipped it (comma-separated —
a bead can have more than one, e.g. a `feat` PR followed by a later `fix`
PR closing a gap). This metadata is the source of truth the release-notes
skill (`.claude/skills/cut-release/`) reads from — it does not parse git
history. `prs` must only ever list PRs that are actually merged; a bead
closed with a still-open PR in `prs` will make `cut-release` claim
unshipped work as released. When you close a bead, make sure
`cc_type`/`cc_scope`/`prs` are set:

```bash
bd update <id> --set-metadata cc_type=feat --set-metadata cc_scope=gallery --set-metadata prs=gh-71
```

## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
