/**
 * Tests for the Conventional Commit PR title guard (ugcportal-euqi).
 *
 * The originating defect (ugcportal-euqi): a PR titled
 * "docs(research): ... (ugcportal-qnq9.14)" failed
 * guard-conventional-commit-title because the old PATTERN's bead-id group,
 * ([a-zA-Z0-9]+-[a-zA-Z0-9]+)$, has no room for the dot-separated child
 * suffix bd creates with `--parent=<id>`. The `isValidPrTitle` table below is
 * what runs through `npm test` (vitest collects this file directly); the
 * separate `main() via the CLI` describe block further down is what actually
 * runs in CI, by spawning scripts/check-pr-title.mjs as `guard-conventional-
 * commit-title` does, with PR_TITLE set the same way. So a later regex edit
 * has something to fail, per the bead's K1 "Verified by" clause.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isValidPrTitle, PATTERN } from "./check-pr-title.mjs";

const CLI_PATH = fileURLToPath(new URL("./check-pr-title.mjs", import.meta.url));

/**
 * Spawns the real CLI entry point the way ci.yml does (PR_TITLE env var,
 * nothing on argv) and returns its exit code -- `execFileSync` throws on a
 * non-zero exit, with the code on `error.status`, rather than returning it.
 * @param {string | undefined} prTitle omit the key entirely to test "unset"
 * @returns {number}
 */
function runCli(prTitle) {
  const env = { ...process.env };
  if (prTitle === undefined) {
    delete env.PR_TITLE;
  } else {
    env.PR_TITLE = prTitle;
  }
  try {
    execFileSync("node", [CLI_PATH], { env, stdio: "pipe" });
    return 0;
  } catch (err) {
    return err.status;
  }
}

describe("isValidPrTitle", () => {
  it("accepts the real PR #89 title with a dotted child bead id", () => {
    expect(isValidPrTitle("docs(research): write up the finding (ugcportal-qnq9.14)")).toBe(true);
  });

  it("accepts a top-level (non-child) bead id", () => {
    expect(isValidPrTitle("feat(gallery): add lightbox with PhotoSwipe (ugcportal-71y)")).toBe(true);
  });

  it("accepts a release title with no bead id", () => {
    expect(isValidPrTitle("chore(release): v1.2.3")).toBe(true);
  });

  it("accepts a breaking-change marker before the colon", () => {
    expect(isValidPrTitle("feat(auth)!: require verified email (ugcportal-abc1)")).toBe(true);
  });

  // bd prime documents --parent as "task under epic, subtask under task" --
  // two levels -- with nothing capping further nesting after that, so a
  // subtask of a child task (ugcportal-qnq9.14.1) is a real id `bd` can
  // mint, and so is a subtask of *that* in principle. These three accept
  // tests are the depth boundary; the four reject tests below them are what
  // no depth makes valid.
  it("accepts a two-level (subtask-of-a-child-task) bead id", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-qnq9.14.1)")).toBe(true);
  });

  it("accepts a three-level bead id", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-qnq9.14.3.1)")).toBe(true);
  });

  it("rejects a dotted suffix with no digits", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-qnq9.)")).toBe(false);
  });

  it("rejects a dotted suffix that isn't numeric", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-qnq9.a)")).toBe(false);
  });

  it("rejects an empty segment between two dots", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-qnq9..1)")).toBe(false);
  });

  it("rejects a trailing dot after an otherwise-valid deeper suffix", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-qnq9.1.)")).toBe(false);
  });

  it("rejects a bead id with no suffix after the dash", () => {
    expect(isValidPrTitle("docs(research): x (ugcportal-)")).toBe(false);
  });

  // Guards the depth widening above the same way: tightening the suffix
  // back to "at most one level" must make the two accept tests above fail,
  // not just change PATTERN's source string. Proven directly, the same way
  // the optional-group guardrail further down proves its own regression.
  it("would fail the two- and three-level accept tests above if the suffix were tightened back to one level", () => {
    const tightenedSource = PATTERN.source.replace("(?:\\.[0-9]+)*", "(?:\\.[0-9]+)?");
    expect(tightenedSource).not.toBe(PATTERN.source); // the replace actually matched something
    const tightened = new RegExp(tightenedSource);
    expect(tightened.test("docs(research): x (ugcportal-qnq9.14.1)")).toBe(false); // the two-level case above
    expect(tightened.test("docs(research): x (ugcportal-qnq9.14.3.1)")).toBe(false); // the three-level case above
  });

  it("rejects a title with no bead id at all", () => {
    expect(isValidPrTitle("feat(x): y")).toBe(false);
  });

  it("rejects a title missing the required (scope)", () => {
    expect(isValidPrTitle("docs: write something (ugcportal-qnq9.14)")).toBe(false);
  });

  it("rejects an unknown commit type", () => {
    expect(isValidPrTitle("wip(gallery): still working (ugcportal-71y)")).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(isValidPrTitle("")).toBe(false);
  });

  // K2's guardrail: if the bead-id group were made optional (the way a
  // careless "fix" for a missing id might), this table should fail. Proven
  // directly below by regenerating PATTERN with that one group made
  // optional and asserting the mutated pattern now matches `feat(x): y` --
  // so this test is a guard against a specific regression, not just a
  // check of current behaviour.
  it("would fail this table if the bead-id group were made optional", () => {
    const widenedSource = PATTERN.source.replace(
      ` \\([a-zA-Z0-9]+-[a-zA-Z0-9]+(?:\\.[0-9]+)*\\)$`,
      `(?: \\([a-zA-Z0-9]+-[a-zA-Z0-9]+(?:\\.[0-9]+)*\\))?$`,
    );
    expect(widenedSource).not.toBe(PATTERN.source); // the replace actually matched something
    const widened = new RegExp(widenedSource);
    expect(widened.test("feat(x): y")).toBe(true); // the regression this guards against
  });
});

// The table above exercises `isValidPrTitle` directly; this block covers
// `main()`, `isMainModule(...)`, the `PR_TITLE ?? ""` default and the
// `process.exitCode = 1` path -- the parts CI actually runs -- by spawning
// the real CLI with PR_TITLE set (or deliberately unset) and reading its
// real exit code.
describe("main() via the CLI", () => {
  it("exits 0 for a valid title", () => {
    expect(runCli("docs(research): x (ugcportal-qnq9.14)")).toBe(0);
  });

  it("exits 1 for an invalid title", () => {
    expect(runCli("feat(x): y")).toBe(1);
  });

  it("exits 1 when PR_TITLE is unset", () => {
    expect(runCli(undefined)).toBe(1);
  });

  it("exits 1 when PR_TITLE is empty", () => {
    expect(runCli("")).toBe(1);
  });
});
