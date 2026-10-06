#!/usr/bin/env node
/**
 * Sensitive-file-bundling guard (ugcportal-6hmh).
 *
 * Pulled out of .github/workflows/ci.yml's "Fail if .claude/settings*.json
 * or CLAUDE.md is bundled with other changes" step so the decision logic has
 * a unit-tested home instead of a bare `grep -Ex ... && exit 1` that can't
 * distinguish two different shapes of PR:
 *
 *   - "sensitive file bundled with other changes"           -> fail
 *   - "the PR changes only sensitive file(s)" (no bundling)  -> pass
 *
 * Originating defect: the old step failed on *any* sensitive file touched,
 * regardless of whether anything else changed, so PR #113 -- a CLAUDE.md-only
 * PR, exactly the dedicated-PR-for-human-review shape CLAUDE.md's own policy
 * demands -- was red on this check by construction. A sensitive-file-only PR
 * passing this CI guard does not make it eligible for pr-review-merge's
 * auto-merge: that skill's own sensitive-path step (see
 * .claude/skills/pr-review-merge/SKILL.md) independently routes any
 * `.claude/**` or `CLAUDE.md` diff to a human, regardless of what CI says.
 *
 * Sensitive paths are matched exactly (not as a substring) against each
 * changed file, mirroring the original step's `grep -Ex`: a changed file
 * must match one of these patterns in its entirety to count as sensitive.
 * Which paths count as sensitive, and pr-review-merge's own sensitive-path
 * list, are both out of scope for this script -- see the bead.
 */
import { isMainModule } from "./lib/is-main.mjs";

export const SENSITIVE_PATTERN = /^(?:\.claude\/settings(?:\.local)?\.json|CLAUDE\.md)$/;

/**
 * @param {string[]} changedFiles repo-root-relative paths of every file the
 *   PR (or push) changed
 * @returns {{ ok: boolean, sensitive: string[], nonSensitive: string[] }}
 *   `ok` is true when there is nothing to split out: no sensitive file
 *   changed at all, or every changed file is sensitive. `ok` is false only
 *   when at least one sensitive file is changed alongside at least one
 *   non-sensitive file.
 */
export function checkSensitiveFiles(changedFiles) {
  const sensitive = changedFiles.filter((f) => SENSITIVE_PATTERN.test(f));
  const nonSensitive = changedFiles.filter((f) => !SENSITIVE_PATTERN.test(f));
  const ok = sensitive.length === 0 || nonSensitive.length === 0;
  return { ok, sensitive, nonSensitive };
}

function main() {
  const raw = process.env.CHANGED_FILES ?? "";
  const changedFiles = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  console.log("Changed files:");
  console.log(changedFiles.join("\n"));

  const { ok, sensitive, nonSensitive } = checkSensitiveFiles(changedFiles);

  if (!ok) {
    console.error(
      `::error::This PR touches ${sensitive.join(", ")} alongside other changes (${nonSensitive.join(", ")}). Per CLAUDE.md policy, changes to .claude/settings.json, .claude/settings.local.json, or CLAUDE.md must go through a dedicated PR for human review and must never be bundled with unrelated work. Split this change out.`,
    );
    process.exitCode = 1;
    return;
  }

  if (sensitive.length > 0) {
    console.log(
      `Sensitive-file-only PR (${sensitive.join(", ")}): guard passes. Still routed to a human for merge by pr-review-merge's sensitive-path check, independent of this result.`,
    );
  } else {
    console.log("No sensitive files changed.");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
