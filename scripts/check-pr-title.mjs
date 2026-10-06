#!/usr/bin/env node
/**
 * Conventional Commit PR title guard (ugcportal-euqi).
 *
 * Pulled out of .github/workflows/ci.yml's `guard-conventional-commit-title`
 * job so the bead-id pattern has a unit-tested home instead of only a local
 * `grep -qE` a later edit could silently loosen or break. See
 * check-pr-title.test.mjs for the table this pattern is scored against.
 *
 * Accepts a release title (`chore(release): vX.Y.Z`, no bead id) or
 * `<type>(<scope>): <description> (<bead-id>)`. The bead-id group accepts
 * both a top-level id (`ugcportal-qnq9`) and exactly one dot-separated child
 * suffix (`ugcportal-qnq9.14`, how `bd create --parent=<id>` numbers a
 * child) -- but not a second level of nesting (`ugcportal-qnq9.14.3`) and
 * not a non-numeric or empty suffix (`ugcportal-qnq9.`, `ugcportal-qnq9.a`).
 */
import { isMainModule } from "./lib/is-main.mjs";

const BEAD_ID = "[a-zA-Z0-9]+-[a-zA-Z0-9]+(?:\\.[0-9]+)?";
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
