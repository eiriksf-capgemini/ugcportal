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
- **Team-maintainer (active for this repo — opted in 2026-09-18 by Eirik Sander-Fjeld)**: When a feature/bead's implementation is complete and quality gates (lint, test, typecheck, build) pass, agents commit, push a branch, and open a PR (Conventional Commit title, see below) without waiting for a separate go-ahead per change. Then run the code-review process (the `pr-review-merge` skill) against that PR: if CI is green, the diff touches no sensitive paths (see settings.json guard above), and no finding blocks under the severity gate below, auto-approve and squash-merge into `main`; otherwise leave a review comment explaining the blocker and stop for a human. Close the bead (with `cc_type`/`cc_scope`/`prs` metadata set) once merged. A current "do not commit" / "do not push" / "do not merge" instruction in the conversation always overrides this default for that instance.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items. When
   closing a bead whose work is done, set `cc_type`/`cc_scope`/`prs` and a
   best-effort `tokens_impl` estimate (see "Token cost metadata" below);
   `tokens_qa` is recorded separately by `pr-review-merge` once review runs.
   Once a bead's PR has actually merged, closing it also means cleaning up
   after it — the origin branch and the implementer's local worktree and
   branch (ugcportal-nvg0) — not just flipping the bead's status.
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer (current default for this repo, unless current instructions forbid it):
   git checkout -b <type>/<bead-id>-<slug>
   git add <files>
   git commit -m "<type>(<scope>): <description> (<bead-id>)"
   git push -u origin <type>/<bead-id>-<slug>
   gh pr create --title "<type>(<scope>): <description> (<bead-id>)" --body "..."
   # Then: run the pr-review-merge skill against the new PR.
   #   - clean (CI green, no sensitive paths, no blocking findings) -> squash-merge to main
   #   - otherwise -> leave a review comment and stop for a human

   # Once that PR has merged (by the skill, or by a human doing the same
   # thing by hand): remove the origin branch, this worktree, and its local
   # branch all through the same tested script the merge step itself uses
   # (ugcportal-nvg0, ugcportal-hvaf) -- not by hand. It retargets any open
   # PR currently based on this branch before deleting it: deleting a branch
   # an open PR still lists as base auto-closes that PR, and GitHub refuses
   # both reopen and base-change once the base ref is gone (observed three
   # times in one day: #126, #120, #123). Run this from the main checkout,
   # not from inside the worktree it may remove:
   node scripts/sweep-merged-branches.mjs --branch <type>/<bead-id>-<slug> --execute
   # Read its output rather than assuming success: "removed origin/..."
   # (confirm with git ls-remote --heads origin <type>/<bead-id>-<slug> --
   # must print nothing), then "removed worktree ..." and
   # "deleted local branch ..." for this worktree and its branch. A line
   # reading "kept origin/...: <reason>" instead means the remote branch is
   # not gone, most likely because an open PR based on it could not be
   # safely retargeted -- leave it for a human rather than forcing it. The
   # manual git push origin --delete this replaces is not a fallback to
   # reach for by hand here -- it is only what the script's own
   # deleteRemoteBranch runs internally, and only once retargeting is
   # already verified clear.
   ```
   For drift that built up before this step existed, or from a merge that
   bypassed it, `node scripts/sweep-merged-branches.mjs` lists every stale
   remote branch and worktree across the whole repo (same rule as above —
   a branch's PR must be `MERGED`, not just open or closed, and a dirty or
   locked worktree is kept either way; see
   `scripts/sweep-merged-branches.test.mjs` for the asserted cases);
   `--execute` removes what it lists, retargeting any OPEN PR currently based
   on a branch it's about to delete — to the first still-existing base in
   the chain that branch's own merged PR recorded, not a dangling
   intermediate branch an earlier sweep already deleted — and re-checking
   live, immediately before the delete, that nothing new appeared while
   retargeting was in flight; either gap keeps the branch with a reported
   reason instead of deleting it (ugcportal-hvaf). See
   `.claude/skills/pr-review-merge/SKILL.md` step 7.
5. **Hand off** - Summarize changes, validation, issue status, PR/merge outcome, and any blocked sync/commit/push/merge step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit, push, or merge without clear authority from the active profile or the current user request.
- If a required sync, push, or merge is blocked, stop and report the exact command and error.
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

## Review iteration: severity gate and round cap

Review rounds on a PR are bounded. Rationale and the measurement behind it:
`ugcportal-2yj`. Operative detail: `.claude/skills/review-standards/SKILL.md`
and `.claude/skills/pr-review-merge/SKILL.md` (steps 4, 4.1, 4b, 5, 5a, 5b).
A "round" is a pass that actually reviewed the diff — a run that stopped at red
CI reviewed nothing and does not count. Exactly one row below matches each round.

| Round      | What blocks the merge |
|------------|------------------------|
| 1-3        | **Any** finding, CONFIRMED or PLAUSIBLE, at any severity. Fix everything. |
| 4-5        | Any **medium-or-above**, confirmed or unsettled. Lows are filed as beads and the PR merges. |
| 6 (cap)    | The same — but a blocker here goes to a **human**, not into a seventh round. Otherwise the PR merges with its lows filed. |
| 7+         | Only on an **exact** marker chain, with a real round-6 stop comment and evidence someone acted on it. Then a scoped verification pass on what they fixed — never a fresh hunt. |

Confidence changes what a **low** costs, not what a medium-or-above costs: from
round 4 an unsettled plausible medium blocks exactly as a confirmed one does.
`code-review` does not report severity — **the reviewer assigns it** and states
it per finding. A defective test inherits the severity of what it guards, so an
assertion that cannot fail over a fresh fail-open fix is medium-or-above, not a
"weak test" nit.

Every deferred finding becomes a bead with its severity recorded and a
`discovered-from` edge to the parent — nothing above low is ever closed by the
cap rather than by a decision. Implementers: from round 4, stop grinding on low
findings and file them. Reviewers: this is not licence to review less carefully
in rounds 1-3; if first-round finding counts drop, the rule is being misused.

Scope freeze applies from first push: work discovered during review becomes its
own bead, not an addition to the PR in flight.

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

### Token cost metadata

Two more metadata fields track the cost of a bead, in tokens, alongside
`cc_type`/`cc_scope`/`prs`:

- `tokens_impl` — cost of building the feature (everything up to opening
  the PR). There's no clean automatic measurement for this today, since it
  happens inline in the main conversation rather than as a separately
  measurable agent run. Set it as a best-effort estimate from the session's
  own token accounting when closing the bead; note in the bead's notes if
  the number is rough.
- `tokens_qa` — cost of the post-implementation QA/review pass. Each
  individual figure is exact: the `pr-review-merge` skill runs the
  `code-review` skill as a forked subagent, and forked-agent completions
  report an exact `subagent_tokens` figure, which `pr-review-merge` records
  as `tokens_qa` on the bead parsed from the PR title automatically — you
  don't need to set it by hand unless running review manually outside that
  skill. If review runs more than once for the same bead (e.g. a fix-up
  pass after findings), the figure accumulates rather than overwrites — but
  the accumulation itself is a best-effort read-then-write (`bd` has no
  compare-and-swap for metadata), so treat the running total as an
  approximation, not a guaranteed-exact ledger, if reviews on the same bead
  could ever overlap. `pr-review-merge` skips recording entirely (rather
  than guessing) when there's no real subagent run to measure, e.g. its
  manual-review fallback path.

```bash
bd update <id> --set-metadata tokens_impl=42000 --set-metadata tokens_qa=107768
```

### Model-fit metadata

Three more fields estimate which model is best suited to *doing* the bead, so
work can be routed to the cheapest model that will actually do the job well
instead of defaulting everything to the most capable one:

- `model` — a **tier label**, one of `haiku` | `sonnet` | `opus` | `fable`.
  Deliberately not a pinned model ID (`claude-opus-5`): IDs go stale on every
  model generation and would force a bulk rewrite of every bead. Mapping as of
  2026-09-24 — `haiku` -> `claude-haiku-4-5`, `sonnet` -> `claude-sonnet-5`,
  `opus` -> `claude-opus-5`, `fable` -> `claude-fable-5-1`. When a new
  generation ships, update this mapping, not the beads.
- `model_effort` — `low` | `medium` | `high` | `xhigh` | `max`, the
  `output_config.effort` level to pair with the tier. `high` is the default;
  `xhigh` is the sweet spot for hard coding/agentic work; `max` is for the rare
  bead where correctness matters more than cost.
- `model_why` — one line justifying the pick, so the estimate is auditable and
  cheap to revise.

Rough tier guidance used for the existing backlog:

| tier     | shape of work                                                                 |
|----------|-------------------------------------------------------------------------------|
| `haiku`  | mechanical and fully specified — scaffolds, config from vendor docs, a one-line CI guard |
| `sonnet` | well-trodden implementation — a documented library wired in, standard CRUD, conventional manifests |
| `opus`   | multi-system integration, security/money correctness, third-party API quirks, anything with a wide blast radius |
| `fable`  | judgment over code — security and architecture reviews, legal/GDPR rights analysis |

These are estimates, not measurements. The `tokens_impl`/`tokens_qa` figures
above are the calibration signal: if a `sonnet` bead consistently costs what an
`opus` bead costs, the estimate was wrong — fix the bead, and the guidance here.
Nothing reads these fields automatically yet; they inform the human or agent
picking a model before starting work.

```bash
bd update <id> --set-metadata model=opus --set-metadata model_effort=xhigh \
  --set-metadata model_why="money plus webhook idempotency; duplicate orders are the expensive failure"
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
