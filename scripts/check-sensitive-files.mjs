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
 * must match one of these patterns in its entirety to count as sensitive --
 * see check-sensitive-files.test.mjs's "matches sensitive paths exactly, not
 * as a substring" case, which asserts a file like `docs/CLAUDE.md.bak` does
 * not count. Which paths count as sensitive, and pr-review-merge's own
 * sensitive-path list, are both out of scope for this script -- see the bead.
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
/**
 * Splits `CHANGED_FILES` into paths, and classifies the two ways it can
 * arrive carrying nothing (ugcportal-kssp, mitigation 1).
 *
 * This guard used to read `process.env.CHANGED_FILES ?? ""`, which turned an
 * absent or empty variable into `[]` and printed **"No sensitive files
 * changed."** -- the same line a genuinely clean PR gets, from a guard whose
 * whole job is to stop a `.claude/settings*.json` or `CLAUDE.md` change
 * riding into `main` bundled with other work. The CI step that fills it
 * (`.github/workflows/ci.yml`: `CHANGED_FILES=$(git diff --name-only
 * "origin/${BASE_REF}...HEAD")`) yields an empty string whenever that `git
 * diff` resolves but matches nothing -- a shallow checkout, a base ref that
 * already contains HEAD, a variable renamed at one end and not the other.
 * The guard then passed, and read as having checked.
 *
 * A pull request that changes zero files does not exist, so zero changed
 * files is never a real answer here: it is always a fact about the input,
 * not about the PR. Both empty shapes therefore FAIL rather than pass, and
 * they are reported separately because they point at different mistakes --
 * `unset` means the variable never reached this process (renamed, not
 * exported, step deleted), `empty` means it arrived carrying nothing (the
 * `git diff` ran and matched nothing).
 *
 * @param {string | undefined} raw
 * @returns {{files: string[], verdict: "ok" | "unset" | "empty"}}
 */
export function classifyChangedFilesInput(raw) {
  if (raw === undefined || raw === null) return { files: [], verdict: "unset" };
  const files = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { files, verdict: files.length === 0 ? "empty" : "ok" };
}

export function checkSensitiveFiles(changedFiles) {
  const sensitive = changedFiles.filter((f) => SENSITIVE_PATTERN.test(f));
  const nonSensitive = changedFiles.filter((f) => !SENSITIVE_PATTERN.test(f));
  const ok = sensitive.length === 0 || nonSensitive.length === 0;
  return { ok, sensitive, nonSensitive };
}

function main() {
  const { files: changedFiles, verdict } = classifyChangedFilesInput(process.env.CHANGED_FILES);

  if (verdict !== "ok") {
    console.error(
      verdict === "unset"
        ? "::error::CHANGED_FILES is not set, so this guard examined 0 files. That is a broken check, not a clean PR -- the workflow step that computes it did not run, or the variable was renamed. See .github/workflows/ci.yml."
        : "::error::CHANGED_FILES is set but empty, so this guard examined 0 files. A pull request that changes nothing does not exist, so this is the input, not the PR -- check the `git diff --name-only \"origin/${BASE_REF}...HEAD\"` that fills it. See .github/workflows/ci.yml.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Changed files (${changedFiles.length}):`);
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
    // The count is part of the sentence, not an aside: "no sensitive files
    // among 0" is the broken-instrument reading and "no sensitive files
    // among 23" is the clean one, and the verdict check above has already
    // made the first of those impossible to reach (ugcportal-kssp).
    console.log(`No sensitive files among the ${changedFiles.length} file(s) this PR changes.`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
