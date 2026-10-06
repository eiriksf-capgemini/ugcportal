#!/usr/bin/env node
/**
 * Conventional Commit PR title guard (ugcportal-euqi).
 *
 * Pulled out of .github/workflows/ci.yml's `guard-conventional-commit-title`
 * job so the bead-id pattern has a unit-tested home rather than a local
 * `grep -qE` a later edit could silently loosen or break. See
 * check-pr-title.test.mjs for the table this pattern is scored against.
 *
 * Accepts a release title (`chore(release): vX.Y.Z`, no bead id) or
 * `<type>(<scope>): <description> (<bead-id>)`. The bead-id group accepts
 * a top-level id (`ugcportal-qnq9`) and any depth of dot-numeric child
 * suffix: `bd prime`'s own text for `--parent` is "task under epic, subtask
 * under task", i.e. at least two levels (`ugcportal-qnq9.14`, then
 * `ugcportal-qnq9.14.1` for a subtask of that task), and nothing caps how
 * many times `--parent` can be applied again after that. Each dot segment
 * must still be non-empty and numeric -- a trailing dot, an empty segment
 * (`..`) or a non-numeric segment (`.a`) are rejected at any depth; see
 * check-pr-title.test.mjs's dotted-nesting and non-numeric-suffix cases for
 * where each of those is asserted.
 */
import { isMainModule } from "./lib/is-main.mjs";

const BEAD_ID = "[a-zA-Z0-9]+-[a-zA-Z0-9]+(?:\\.[0-9]+)*";
const TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";

export const PATTERN = new RegExp(
  `^chore\\(release\\): v[0-9]+\\.[0-9]+\\.[0-9]+$|^(?:${TYPES})\\([a-z0-9-]+\\)!?: .+ \\(${BEAD_ID}\\)$`,
);

/**
 * @param {string} title
 * @returns {boolean}
 */
export function isValidPrTitle(title) {
  return PATTERN.test(title);
}

function main() {
  const title = process.env.PR_TITLE ?? "";
  console.log(`PR title: ${title}`);
  if (!isValidPrTitle(title)) {
    console.error(
      "::error::PR title must follow Conventional Commits: <type>(<scope>): <description> (<bead-id>), e.g. 'feat(gallery): add lightbox (ugcportal-71y)' or a child bead 'fix(auth): x (ugcportal-qnq9.14)'. Scope and the trailing bead-id are both required (the only exception is a release commit: 'chore(release): vX.Y.Z'). Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. See CLAUDE.md > 'Conventional Commits & Release Notes'.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("PR title OK");
}

if (isMainModule(import.meta.url)) {
  main();
}
