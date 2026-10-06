/**
 * Tests for the comment-claims audit (ugcportal-wzgw). Synthetic fixtures
 * are fed straight to the exported analysis functions, as
 * scripts/sweep-candidates.test.mjs does; the git plumbing in
 * scripts/lib/git-diff.mjs is exercised only through its pure diff parser --
 * except for the "working tree and --base" describe block near the end
 * (ugcportal-np1i), which needs a real git repository because the bugs it
 * guards against only exist in the interaction between git plumbing and the
 * filesystem, not in any pure function: a false "candidates found: 0" before
 * the first commit, a silently-ignored `--base=<ref>` (K1/K2), and several
 * further ways the same false zero could still happen that review rounds
 * on this PR reproduced directly -- an unresolvable `--base` falling
 * through silently (M1), a committed change plus an uncommitted edit to the
 * same file producing two line-numbering systems whose union pointed at
 * the wrong lines (M2), a required diff read failing without tripping the
 * K3 guardrail on a dirty tree (round 1 M3) or, the gap that survived that
 * fix, on a fully-committed CLEAN tree -- the ordinary `/pre-review` case
 * -- because the guardrail was gated on "is the tree dirty" rather than
 * "did the read succeed" (round 2 H1).
 *
 * Each fixture is shaped like a real finding from the v0.5.0 review rounds
 * (docs/process/review-rounds-v0.5.0.md, Part 1) or from this PR's own
 * review rounds, named in the test title.
 *
 * PR body mode (ugcportal-bn94) gets its own describe blocks below: pure
 * fixtures for auditBodyText/findQuotedSpans/tokenStillInDiff/
 * extractBodyLines against literal body/diff strings (no `gh` involved --
 * the same "pure function, literal fixture" shape
 * scripts/sweep-merged-branches.test.mjs uses for its own `gh`-adjacent
 * parsing), and one real-git-repo describe block proving `--body` reads
 * stdin and diffs the local working tree, and that its printed counts are
 * never summed with file mode's (K2).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  auditBodyText,
  auditContent,
  classifyClaimLine,
  extractBodyLines,
  extractComments,
  extractProseLines,
  findPathReferences,
  findQuotedSpans,
  parseArgs,
  referenceExists,
  tokenStillInDiff,
} from "./claims-audit.mjs";
import { parseUnifiedDiffAddedLines } from "./lib/git-diff.mjs";

const NO_EXISTING_FILES = { existingFiles: [] };

describe("classifyClaimLine", () => {
  it("flags an absolute claim (PR #102 round 1: a dedupe comment that said the opposite of what was measured)", () => {
    expect(classifyClaimLine("the outer cache() is not what makes the single-log guarantee hold")).toContain("ABSOLUTE");
    expect(classifyClaimLine("runs once per sign-in, never twice")).toContain("ABSOLUTE");
  });

  it("flags a measurement in prose (PR #86 round 1: two figures for one scenario in schema.prisma)", () => {
    expect(classifyClaimLine("roughly 5-6x faster at 200k rows, 1% published")).toContain("MEASUREMENT");
    expect(classifyClaimLine("the header measures 85px from 320px to 1440px")).toContain("MEASUREMENT");
    expect(classifyClaimLine("2588 tests green")).toContain("MEASUREMENT");
    expect(classifyClaimLine("contrast 3.18:1 on the muted surface")).toContain("MEASUREMENT");
  });

  it("does not call an identifier-shaped number a measurement", () => {
    expect(classifyClaimLine("see line 2 and HTTP 500")).toEqual([]);
    expect(classifyClaimLine("React 19 removed the warning")).toEqual([]);
  });

  it("flags a temporal claim that goes stale (PR #82 round 1: 'remains to be switched' in the PR that was the switch)", () => {
    expect(classifyClaimLine("the media-by-id route still has a private copy that remains to be switched")).toContain("TEMPORAL");
    expect(classifyClaimLine("TODO: swap to SITE_TAGLINE once #94 merges")).toContain("TEMPORAL");
  });

  it("flags review-history narration inside code (PR #94: a test named after a review round)", () => {
    expect(classifyClaimLine("HEADER_HEIGHT_PX (ugcportal-14k9 PR #94 review round 4/5)")).toContain("HISTORY");
    expect(classifyClaimLine("round 3 finding 5 -- reuse")).toContain("HISTORY");
  });

  it("reports an explicit empty list for an ordinary comment", () => {
    expect(classifyClaimLine("Build the mailto href from the fields.")).toEqual([]);
  });
});

describe("findPathReferences / referenceExists", () => {
  it("finds a path-shaped token with an optional line number", () => {
    expect(findPathReferences("see src/lib/routes.ts:50 and page.test.tsx")).toEqual([
      { token: "src/lib/routes.ts", line: 50 },
      { token: "page.test.tsx", line: null },
    ]);
  });

  it("ignores URLs", () => {
    expect(findPathReferences("per https://example.com/docs/index.html")).toEqual([]);
  });

  it("ignores a shell-variable fragment (found by running the audit over its own report)", () => {
    expect(findPathReferences("jq -s add > pr-$n-issue.json")).toEqual([]);
  });

  it("resolves a repo-relative path, a sibling-relative path and a bare filename", () => {
    const tracked = ["src/lib/routes.ts", "src/app/about/page.tsx", "src/app/about/page.test.tsx"];
    expect(referenceExists("src/lib/routes.ts", "src/app/about/page.tsx", tracked)).toBe(true);
    expect(referenceExists("./page.test.tsx", "src/app/about/page.tsx", tracked)).toBe(true);
    expect(referenceExists("routes.ts", "src/app/about/page.tsx", tracked)).toBe(true);
  });

  it("reports a file that no longer exists (PR #98 round 3: a comment citing configured-users.ts after its removal)", () => {
    const tracked = ["src/lib/sign-in-policy.ts", "src/lib/configured-user-link.ts"];
    expect(referenceExists("configured-users.ts", "src/lib/sign-in-policy.ts", tracked)).toBe(false);
  });
});

describe("extractComments", () => {
  it("finds line comments, block comments and JSDoc, with markers stripped", () => {
    const content = ["// top", "/* block", "   second */", "/**", " * doc line", " */", "const x = 1; // trailing", ""].join("\n");
    const comments = extractComments(content, "a.ts");
    expect(comments.map((c) => [c.line, c.text])).toEqual([
      [1, "top"],
      [2, "block\nsecond"],
      [4, "doc line"],
      [7, "trailing"],
    ]);
  });

  it("finds a comment inside a JSX expression and inside an empty block", () => {
    const content = ["function F() {", "  return <div>{/* jsx note */}</div>;", "}", "function g() { /* empty block note */ }", ""].join("\n");
    const texts = extractComments(content, "a.tsx").map((c) => c.text);
    expect(texts).toContain("jsx note");
    expect(texts).toContain("empty block note");
  });

  it("does not report the same comment twice when parent and child share leading trivia", () => {
    const content = ["// shared", "export const a = { b: 1 };", ""].join("\n");
    expect(extractComments(content, "a.ts")).toHaveLength(1);
  });

  it("does not mistake a string containing // for a comment", () => {
    const content = 'const url = "https://example.com"; // real\n';
    expect(extractComments(content, "a.ts").map((c) => c.text)).toEqual(["real"]);
  });

  it("reads the comment after the last statement", () => {
    const content = "const a = 1;\n// tail comment\n";
    expect(extractComments(content, "a.ts").map((c) => c.text)).toEqual(["tail comment"]);
  });
});

describe("extractProseLines", () => {
  it("takes every non-empty line of a Markdown file", () => {
    expect(extractProseLines("# Title\n\nbody\n", "doc.md")).toEqual([
      { line: 1, endLine: 1, text: "# Title" },
      { line: 3, endLine: 3, text: "body" },
    ]);
  });

  it("takes // lines from a Prisma schema and # lines from a shell script", () => {
    expect(extractProseLines("// ~46x faster\nmodel M {}\n", "schema.prisma")).toEqual([{ line: 1, endLine: 1, text: "~46x faster" }]);
    expect(extractProseLines("#!/bin/sh\n# never fails\necho hi\n", "run.sh").map((l) => l.text)).toEqual(["!/bin/sh", "never fails"]);
  });
});

describe("auditContent", () => {
  it("reports only comments on changed lines, each line tagged with its categories", () => {
    const content = ["// always true on every path", "const a = 1;", "// 85px tall", "const b = 2;", ""].join("\n");
    const out = auditContent(content, "a.ts", new Set([3]), NO_EXISTING_FILES);
    expect(out).toEqual([{ file: "a.ts", line: 3, categories: ["MEASUREMENT"], text: "85px tall", missingReferences: [] }]);
  });

  it("audits every comment when changedLines is null (--all-lines, the stale-sibling sweep)", () => {
    const content = ["// always true", "const a = 1;", "// 85px tall", ""].join("\n");
    expect(auditContent(content, "a.ts", null, NO_EXISTING_FILES)).toHaveLength(2);
  });

  it("reports a block comment at the line of the offending sentence, not the block's first line", () => {
    const content = ["/**", " * Plain description.", " * It never throws.", " */", "const a = 1;", ""].join("\n");
    const out = auditContent(content, "a.ts", new Set([1, 2, 3, 4]), NO_EXISTING_FILES);
    expect(out).toEqual([{ file: "a.ts", line: 3, categories: ["ABSOLUTE"], text: "It never throws.", missingReferences: [] }]);
  });

  it("names a referenced file that is not in the tree, and stays silent for one that is", () => {
    const content = ["// see configured-users.ts and routes.ts", "const a = 1;", ""].join("\n");
    const out = auditContent(content, "src/lib/a.ts", new Set([1]), { existingFiles: ["src/lib/routes.ts"] });
    expect(out).toEqual([
      { file: "src/lib/a.ts", line: 1, categories: [], text: "see configured-users.ts and routes.ts", missingReferences: ["configured-users.ts"] },
    ]);
  });

  it("stays silent for a reference to an untracked sibling (ugcportal-np1i round 3 L1: an untracked file is a real, existing file)", () => {
    const content = ["// see untracked-sibling.ts", "const a = 1;", ""].join("\n");
    const out = auditContent(content, "src/lib/a.ts", new Set([1]), {
      existingFiles: ["src/lib/routes.ts", "src/lib/untracked-sibling.ts"],
    });
    expect(out).toEqual([]);
  });

  it("is silent for a comment with no claim and no reference", () => {
    const content = "// build the href\nconst a = 1;\n";
    expect(auditContent(content, "a.ts", new Set([1]), NO_EXISTING_FILES)).toEqual([]);
  });

  it("audits Markdown prose line by line", () => {
    const content = "# Notes\n\nThe gate never fails open.\n";
    const out = auditContent(content, "docs/x.md", new Set([3]), NO_EXISTING_FILES);
    expect(out.map((c) => c.categories)).toEqual([["ABSOLUTE"]]);
  });

  it("ignores a file type it does not know how to read", () => {
    expect(auditContent("binary-ish", "image.png", null, NO_EXISTING_FILES)).toEqual([]);
  });
});

describe("parseUnifiedDiffAddedLines", () => {
  it("maps each file to the post-image line numbers it added", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +2,2 @@",
      "+added two",
      "+added three",
      "@@ -10 +12 @@",
      "-removed",
      "+replaced",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -0,0 +1 @@",
      "+new file line",
      "",
    ].join("\n");
    const out = parseUnifiedDiffAddedLines(diff);
    expect([...out.get("a.ts")]).toEqual([2, 3, 12]);
    expect([...out.get("b.md")]).toEqual([1]);
  });
});

describe("parseArgs", () => {
  it("accepts the space form", () => {
    expect(parseArgs(["--base", "origin/main"])).toEqual({ base: "origin/main", allLines: false });
  });

  it("accepts the equals form, which used to be silently ignored (ugcportal-np1i K2)", () => {
    expect(parseArgs(["--base=origin/main"])).toEqual({ base: "origin/main", allLines: false });
  });

  it("recognizes --all-lines, with and without an explicit --base", () => {
    expect(parseArgs(["--all-lines"])).toEqual({ base: undefined, allLines: true });
    expect(parseArgs(["--base", "origin/main", "--all-lines"])).toEqual({ base: "origin/main", allLines: true });
  });

  it("leaves base undefined when --base is not passed, so the caller falls back to resolveDefaultBase", () => {
    expect(parseArgs([])).toEqual({ base: undefined, allLines: false });
  });

  it("names the problem instead of silently keeping the default, for every broken --base spelling", () => {
    expect(parseArgs(["--base"]).error).toMatch(/requires a value/);
    expect(parseArgs(["--base="]).error).toMatch(/requires a value/);
    expect(parseArgs(["--base:origin/main"]).error).toMatch(/unknown flag/);
  });

  it("L1: rejects --base followed by another flag instead of swallowing it as the ref (round 1 finding 4)", () => {
    expect(parseArgs(["--base", "--all-lines"]).error).toMatch(/requires a value/);
    expect(parseArgs(["--base", "--base=origin/main"]).error).toMatch(/requires a value/);
  });

  it("L2: rejects an unknown flag by name instead of silently falling back to the default base (round 1 finding 5)", () => {
    // A one-letter typo of --base -- the PR body originally overclaimed this
    // was already rejected; it wasn't, because it isn't a --base-prefixed
    // string at all, just an unrecognized flag.
    expect(parseArgs(["--bas=foo"]).error).toMatch(/unknown flag: --bas=foo/);
    expect(parseArgs(["--verbose"]).error).toMatch(/unknown flag: --verbose/);
  });

  it("rejects a bare positional argument", () => {
    expect(parseArgs(["origin/main"]).error).toMatch(/unexpected argument: origin\/main/);
  });
});

describe("parseArgs: PR body mode (ugcportal-bn94)", () => {
  it("recognizes --pr <n> and --pr=<n> the same way", () => {
    expect(parseArgs(["--pr", "147"])).toEqual({ base: undefined, allLines: false, prNumber: 147 });
    expect(parseArgs(["--pr=147"])).toEqual({ base: undefined, allLines: false, prNumber: 147 });
  });

  it("recognizes --body, reading the body from stdin", () => {
    expect(parseArgs(["--body"])).toEqual({ base: undefined, allLines: false, bodyFromStdin: true });
  });

  it("names the problem for a missing or non-numeric --pr value, instead of silently falling back to file mode", () => {
    expect(parseArgs(["--pr"]).error).toMatch(/requires a PR number/);
    expect(parseArgs(["--pr", "abc"]).error).toMatch(/requires a PR number/);
    expect(parseArgs(["--pr="]).error).toMatch(/requires a PR number/);
    expect(parseArgs(["--pr=abc"]).error).toMatch(/requires a PR number/);
  });

  it("rejects --pr and --body combined -- two body sources is not a silent choice this script makes for you", () => {
    expect(parseArgs(["--pr", "147", "--body"]).error).toMatch(/mutually exclusive/);
  });

  it("rejects --all-lines combined with either PR-body source -- a body has no added-lines concept", () => {
    expect(parseArgs(["--pr", "147", "--all-lines"]).error).toMatch(/does not apply to PR-body mode/);
    expect(parseArgs(["--body", "--all-lines"]).error).toMatch(/does not apply to PR-body mode/);
  });

  it("rejects --base combined with --pr -- that PR's diff comes from `gh pr diff`, not a local ref", () => {
    expect(parseArgs(["--pr", "147", "--base", "origin/main"]).error).toMatch(/does not apply to --pr/);
  });

  it("allows --base combined with --body -- stdin mode diffs the local working tree against it", () => {
    expect(parseArgs(["--body", "--base", "origin/main"])).toEqual({ base: "origin/main", allLines: false, bodyFromStdin: true });
  });
});

describe("extractBodyLines", () => {
  it("takes every non-blank line of a PR body, 1-indexed, same granularity as a Markdown file's prose", () => {
    expect(extractBodyLines("## Summary\n\nFixed the bug.\n")).toEqual([
      { line: 1, text: "## Summary" },
      { line: 3, text: "Fixed the bug." },
    ]);
  });
});

describe("findQuotedSpans", () => {
  it("extracts a double-quoted span and a backtick code span, each once", () => {
    const text = 'the wrong "24 characters" vs `[ -n "$me" ]`';
    expect(findQuotedSpans(text)).toEqual(["24 characters", '[ -n "$me" ]']);
  });

  it("does not pair an ordinary contraction's apostrophes into a false span (no single-quote pattern at all)", () => {
    expect(findQuotedSpans("isn't related to won't happen")).toEqual([]);
  });

  it("ignores a lone punctuation mark too short to be a real referenced token", () => {
    expect(findQuotedSpans('a quoted "-" here')).toEqual([]);
  });
});

describe("tokenStillInDiff", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    "-const old = 1;",
    "+const kept = 1; // 24 characters max",
    " const unchanged = 2;",
  ].join("\n");

  it("finds a token on an ADDED line (PR #147, 2026-10-06: a 'deleted' number that was not)", () => {
    expect(tokenStillInDiff("24 characters", diff)).toBe(true);
  });

  it("finds a token on an unchanged CONTEXT line", () => {
    expect(tokenStillInDiff("unchanged", diff)).toBe(true);
  });

  it("does not count a token that only ever appeared on a REMOVED line as still present", () => {
    expect(tokenStillInDiff("const old", diff)).toBe(false);
  });

  it("ignores a match against a file-header line (+++ b/path / --- a/path), not real file content", () => {
    expect(tokenStillInDiff("a.ts", diff)).toBe(false);
  });

  it("returns false for an empty token rather than matching every line", () => {
    expect(tokenStillInDiff("", diff)).toBe(false);
  });
});

describe("auditBodyText (ugcportal-bn94)", () => {
  it("K1: reports a PR body's test count as a MEASUREMENT candidate with its line", () => {
    const body = "## Pre-review\n\n1. Gates: vitest 165 files / 3520 tests, all green.\n";
    expect(auditBodyText(body)).toEqual([
      {
        line: 3,
        text: "1. Gates: vitest 165 files / 3520 tests, all green.",
        categories: ["MEASUREMENT"],
        missingReferences: [],
        doneClaimStillPresent: [],
      },
    ]);
  });

  it("flags a DONE claim and confirms it against the diff (PR #147, 2026-10-06: a 'deleted' number that was still on an added line)", () => {
    const body = 'Eight fixed: one MEASUREMENT deleted (the wrong "24 characters"); five ABSOLUTEs weakened.\n';
    const diffText = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "+ * a label of at most 24 characters."].join("\n");
    expect(auditBodyText(body, { diffText })).toEqual([
      {
        line: 1,
        text: 'Eight fixed: one MEASUREMENT deleted (the wrong "24 characters"); five ABSOLUTEs weakened.',
        categories: ["DONE"],
        missingReferences: [],
        doneClaimStillPresent: ["24 characters"],
      },
    ]);
  });

  it("flags a DONE claim without the contradiction check when no diff is available -- still worth a human's look", () => {
    const body = "Both guards restored and fixed.\n";
    expect(auditBodyText(body)).toEqual([
      { line: 1, text: "Both guards restored and fixed.", categories: ["DONE"], missingReferences: [], doneClaimStillPresent: [] },
    ]);
  });

  it("flags 'both X corrected' and 'all N corrected' as DONE -- the verb alone matches, no separate aggregate pattern needed", () => {
    expect(auditBodyText("Both issues corrected.\n").map((c) => c.categories)).toEqual([["DONE"]]);
    expect(auditBodyText("All three findings corrected.\n").map((c) => c.categories)).toEqual([["DONE"]]);
  });

  it("is silent for an ordinary sentence with no claim, no reference and no done verb", () => {
    expect(auditBodyText("This PR adds a button to the gallery footer.\n")).toEqual([]);
  });

  it("names a file the body points at that does not exist in the tree, same REFERENCE semantics as a comment", () => {
    const out = auditBodyText("See configured-users.ts for details.\n", { existingFiles: ["src/lib/routes.ts"] });
    expect(out).toEqual([
      {
        line: 1,
        text: "See configured-users.ts for details.",
        categories: [],
        missingReferences: ["configured-users.ts"],
        doneClaimStillPresent: [],
      },
    ]);
  });

  it("K2: body-mode candidates are a wholly separate list from file-mode's, never unioned (a clean diff, a dirty body)", () => {
    const fileModeCandidates = auditContent("const a = 1;\n", "a.ts", new Set([1]), { existingFiles: [] });
    const bodyModeCandidates = auditBodyText("This never fails on any path.\n");
    // auditBodyText's signature takes no file-mode candidates as input, and
    // auditContent's takes no body text -- there is no shared accumulator
    // either could write into, so the two counts below cannot be summed by
    // accident; main()'s two printed banners (see the --body end-to-end
    // test below) keep that same separation all the way to stdout.
    expect(fileModeCandidates).toEqual([]);
    expect(bodyModeCandidates).toHaveLength(1);
  });
});

// --- fixture repo: working tree and --base (ugcportal-np1i) --------------
//
// Real git repositories in a mkdtemp directory, never the shared checkout
// (`bd memories shared-checkout-is-not-safe-for-agents`) and never a bare
// `git stash`. Every git subprocess below passes an explicit `cwd` on the
// fixture's own temp path and an env object that:
//   - unsets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/
//     GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_COMMON_DIR, so a GIT_DIR this
//     process inherited from somewhere up its own call stack (a fixture
//     test found, the morning this bead was filed, that the pre-push hook
//     exports GIT_DIR, and a fixture test that did not clear it
//     re-initialized the shared repository instead of its own temp one --
//     ugcportal-xxy2) cannot redirect any git call here into a different
//     repository;
//   - sets GIT_CEILING_DIRECTORIES to the temp parent, so git does not
//     walk up past it looking for a repository to attach to;
//   - sets GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL=/dev/null, so the
//     machine's own gitconfig (a global excludesfile, a signing key, an
//     unrelated identity) cannot change what a fixture test observes.
// Commit identity is passed per command via `-c user.name=... -c
// user.email=...`, never a persistent `git config user.name` -- a config
// write is itself a mutation of the fixture repo's state that would
// outlive the single command it was meant for.
const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "claims-audit.mjs");
const FIXTURE_PARENTS = [];

// M3 needs a real git call to fail on command -- not a repo that can be
// corrupted (which would risk acting on the shared checkout, exactly what
// ugcportal-xxy2 warns about) but a fake `git` placed earlier on PATH for
// one subprocess, which delegates to the real binary for everything except
// the one invocation under test. REAL_GIT is resolved once, outside any
// fixture repo, and passed into the wrapper by name (never re-resolved via
// a PATH the wrapper itself might be shadowing) so it cannot recurse into
// itself.
const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const BREAKING_GIT_WRAPPER = `#!/bin/sh
if [ "$1" = "diff" ] && [ "$2" = "-U0" ] && [ "$#" -eq 3 ]; then
  case "$3" in
    *...*) ;;
    *)
      if [ -n "$CLAIMS_AUDIT_BREAK_LINES_DIFF" ]; then
        echo "simulated git diff -U0 failure (ugcportal-np1i M3 test)" 1>&2
        exit 128
      fi
      ;;
  esac
fi
exec "$CLAIMS_AUDIT_REAL_GIT" "$@"
`;

function gitEnv(ceilingParent) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_COMMON_DIR;
  env.GIT_CEILING_DIRECTORIES = ceilingParent;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

/**
 * A fresh one-commit git repository in its own mkdtemp directory, with
 * helpers that always pass this fixture's own `cwd` and `env` explicitly.
 */
function makeFixtureRepo() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "claims-audit-fixture-"));
  FIXTURE_PARENTS.push(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  const env = gitEnv(parent);

  const git = (args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  const commit = (message) =>
    execFileSync(
      "git",
      ["-c", "user.name=claims-audit fixture", "-c", "user.email=claims-audit-fixture@example.invalid", "commit", "-m", message],
      { cwd: repo, env, encoding: "utf8" },
    );
  const writeFile = (name, content) => fs.writeFileSync(path.join(repo, name), content);
  const runScript = (args = []) => execFileSync("node", [SCRIPT_PATH, ...args], { cwd: repo, env, encoding: "utf8" });
  // Runs the script with cwd set to a subdirectory of the fixture repo,
  // rather than the repo root every other helper above uses -- the one
  // case round 3's H1 needs, since every other fixture test's `cwd: repo`
  // structurally could not have exposed a cwd-relative-path bug.
  const runScriptFrom = (subdir, args = []) => execFileSync("node", [SCRIPT_PATH, ...args], { cwd: path.join(repo, subdir), env, encoding: "utf8" });
  // PR body mode's `--body` source (ugcportal-bn94): pipes `stdin` in as the
  // PR body text, the same way the pre-review skill feeds a draft body in
  // before `gh pr create` has even run.
  const runScriptStdin = (args, stdin) => execFileSync("node", [SCRIPT_PATH, ...args], { cwd: repo, env, encoding: "utf8", input: stdin });

  git(["init", "--quiet", "--initial-branch=main"]);
  writeFile("README.md", "# fixture\n");
  git(["add", "README.md"]);
  commit("initial commit");

  return { repo, env, git, commit, writeFile, runScript, runScriptFrom, runScriptStdin };
}

afterEach(() => {
  // Each fixture gets its own mkdtemp parent, so removing it cannot touch a
  // sibling test's repo even if tests ran concurrently.
  while (FIXTURE_PARENTS.length > 0) {
    fs.rmSync(FIXTURE_PARENTS.pop(), { recursive: true, force: true });
  }
});

describe("working tree and --base (ugcportal-np1i)", () => {
  it("K1: reports a claim in an untracked file before any commit introduces it, instead of a false 'candidates found: 0'", () => {
    const { writeFile, runScript } = makeFixtureRepo();
    writeFile("new-file.ts", "// never fails on any path\nconst a = 1;\n");

    const out = runScript();

    expect(out).not.toMatch(/candidates found: 0\b/);
    expect(out).toContain("new-file.ts:1 [ABSOLUTE] never fails on any path");
    // L1: the default base (HEAD~1) never resolved here (there's only one
    // commit) and main() degraded to diffing HEAD -- the banner must say
    // so, not repeat the unresolvable default it never actually used.
    expect(out).toContain("(base HEAD)");
    expect(out).not.toContain("(base HEAD~1)");
  });

  it("K1: reports a claim added to an already-tracked file's unstaged edit", () => {
    const { writeFile, git, commit, runScript } = makeFixtureRepo();
    writeFile("tracked.ts", "const a = 1;\n");
    git(["add", "tracked.ts"]);
    commit("add tracked.ts");

    // Uncommitted edit: the line this test cares about is never committed.
    writeFile("tracked.ts", "const a = 1;\n// guaranteed to run exactly once\n");

    const out = runScript();

    expect(out).not.toMatch(/candidates found: 0\b/);
    expect(out).toContain("tracked.ts:2 [ABSOLUTE] guaranteed to run exactly once");
  });

  it("K2: --base <ref> and --base=<ref> diff against the same explicit ref, distinct from the default base", () => {
    const { writeFile, git, commit, runScript } = makeFixtureRepo();
    git(["branch", "root-ref"]); // tags the initial commit, two commits behind HEAD below

    writeFile("filler.ts", "// only reachable once\nconst x = 1;\n");
    git(["add", "filler.ts"]);
    commit("add filler.ts");

    writeFile("feature.ts", "// always true on every path\nconst a = 1;\n");
    git(["add", "feature.ts"]);
    commit("add feature.ts");

    const outSpaceForm = runScript(["--base", "root-ref"]);
    const outEqualsForm = runScript(["--base=root-ref"]);
    const outDefault = runScript([]); // no origin/main in this fixture -> falls back to HEAD~1

    expect(outEqualsForm).toBe(outSpaceForm);
    expect(outSpaceForm).toContain("filler.ts:1 [ABSOLUTE] only reachable once");
    expect(outSpaceForm).toContain("feature.ts:1 [ABSOLUTE] always true on every path");
    // HEAD~1 is the "add filler.ts" commit, which already contains
    // filler.ts -- so the default base cannot see it change. If --base=
    // were still silently ignored (the bug this guards against), the
    // equals-form run above would have matched this output instead of the
    // explicit-base one, since --base root-ref and the HEAD~1 fallback
    // would otherwise be indistinguishable by file list alone.
    expect(outDefault).not.toContain("filler.ts");
  });

  it("M1: an unresolvable --base refuses with a non-zero exit, never a 'candidates found' line (round 1 finding 1)", () => {
    const { runScript } = makeFixtureRepo(); // a clean tree -- no working-tree change to fall back to either

    let error;
    try {
      runScript(["--base", "this-ref-does-not-exist-anywhere"]);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.status).not.toBe(0);
    // The old process.exit(0) removed by this PR meant a bad --base still
    // printed a (misleadingly complete-looking) "candidates found: 0" line
    // on stdout with exit 0; refusing must mean that line never prints.
    expect(error.stdout ?? "").not.toMatch(/candidates found/);
  });

  it("M2: a file changed in a commit AND edited again uncommitted is read in one coordinate system (round 1 finding 2)", () => {
    const { writeFile, git, commit, runScript } = makeFixtureRepo();
    writeFile("tracked.ts", "line a\nline b\nline c\n");
    git(["add", "tracked.ts"]);
    commit("add tracked.ts, no claim yet");
    git(["branch", "root-ref"]); // tags the state before the claim exists

    writeFile("tracked.ts", "line a\n// never fails on any path\nline b\nline c\n");
    git(["add", "tracked.ts"]);
    commit("commit the claim at line 2");

    // Uncommitted: insert one unrelated line above everything, shifting the
    // claim (unchanged itself) from line 2 to line 3. The old design's
    // committedLinesByFile (HEAD-relative: {2}) unioned with
    // workingTreeLinesByFile (working-tree-relative: {1}, the new line)
    // never contained 3, so the still-present claim was silently dropped.
    writeFile("tracked.ts", "// unrelated\nline a\n// never fails on any path\nline b\nline c\n");

    const out = runScript(["--base", "root-ref"]);

    expect(out).not.toMatch(/candidates found: 0\b/);
    expect(out).toContain("tracked.ts:3 [ABSOLUTE] never fails on any path");
  });

  it("M3: refuses instead of a false count when the working-tree line-range read itself fails (round 1 finding 3)", () => {
    const { repo, env, writeFile } = makeFixtureRepo();
    writeFile("untracked.ts", "// an untracked claim, never checked\nconst a = 1;\n");

    const binParent = fs.mkdtempSync(path.join(os.tmpdir(), "claims-audit-git-wrapper-"));
    FIXTURE_PARENTS.push(binParent);
    fs.writeFileSync(path.join(binParent, "git"), BREAKING_GIT_WRAPPER, { mode: 0o755 });

    const breakingEnv = {
      ...env,
      PATH: `${binParent}:${env.PATH}`,
      CLAIMS_AUDIT_REAL_GIT: REAL_GIT,
      CLAIMS_AUDIT_BREAK_LINES_DIFF: "1",
    };

    let error;
    try {
      execFileSync("node", [SCRIPT_PATH], { cwd: repo, env: breakingEnv, encoding: "utf8" });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.status).not.toBe(0);
    expect(error.stdout ?? "").not.toMatch(/candidates found/);
    expect(error.stderr ?? "").toMatch(/could not diff HEAD against the working tree/);
  });

  it("H1: refuses on a clean, fully-committed tree when the diff read fails -- dirtiness is not the gate (round 2 finding 1)", () => {
    const { repo, env, writeFile, git, commit } = makeFixtureRepo();
    git(["branch", "root-ref"]);
    writeFile("feature.ts", "// never fails on any path\nconst a = 1;\n");
    git(["add", "feature.ts"]);
    commit("add feature.ts with a claim");
    // The working tree is now fully clean: nothing staged, nothing
    // unstaged, nothing untracked -- isWorkingTreeDirty() would have
    // returned false here, which is exactly the gap the old K3 guard had
    // (it never even gets called any more; this proves the replacement
    // guard fires without it).

    const binParent = fs.mkdtempSync(path.join(os.tmpdir(), "claims-audit-git-wrapper-"));
    FIXTURE_PARENTS.push(binParent); // outside the repo -- the wrapper's own directory must not itself make `repo` dirty
    fs.writeFileSync(path.join(binParent, "git"), BREAKING_GIT_WRAPPER, { mode: 0o755 });

    const breakingEnv = {
      ...env,
      PATH: `${binParent}:${env.PATH}`,
      CLAIMS_AUDIT_REAL_GIT: REAL_GIT,
      CLAIMS_AUDIT_BREAK_LINES_DIFF: "1",
    };

    let error;
    try {
      execFileSync("node", [SCRIPT_PATH, "--base", "root-ref"], { cwd: repo, env: breakingEnv, encoding: "utf8" });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.status).not.toBe(0);
    expect(error.stdout ?? "").not.toMatch(/candidates found/);
  });

  it("H1 (round 3): reports the same candidates run from a subdirectory as from the repo root", () => {
    const { repo, writeFile, git, commit, runScript, runScriptFrom } = makeFixtureRepo();
    // sibling.ts lives OUTSIDE nested/ on purpose: a repo-root-only pathspec
    // bug in listTrackedFiles/listUntrackedFiles (git ls-files defaults to
    // "cwd and below", a second, separate cwd-dependency from the path
    // FORMAT one `--full-name` alone fixes) would make this reference
    // falsely "not found" only from the subdirectory run, even after
    // readFileFromWorkingTree itself was fixed -- caught exactly this way
    // while verifying the fix, before `-- ':/'` was added alongside
    // `--full-name`.
    writeFile("sibling.ts", "const s = 1;\n");
    git(["add", "sibling.ts"]);
    fs.mkdirSync(path.join(repo, "nested"));
    writeFile("nested/feature.ts", "// never fails on any path, see sibling.ts\nconst a = 1;\n");
    git(["add", "nested/feature.ts"]);
    commit("add nested/feature.ts with a claim and sibling.ts");

    const fromRoot = runScript();
    const fromSubdir = runScriptFrom("nested");

    expect(fromRoot).not.toMatch(/candidates found: 0\b/);
    expect(fromRoot).toContain("nested/feature.ts:1 [ABSOLUTE] never fails on any path, see sibling.ts");
    expect(fromRoot).not.toMatch(/REFERENCE not found:/);
    // Before the fix, readFileFromWorkingTree resolved "nested/feature.ts"
    // against process.cwd() (here, .../repo/nested), so the lookup actually
    // opened .../repo/nested/nested/feature.ts, threw ENOENT, was caught by
    // the blanket "deleted file" handler, and silently produced
    // "candidates found: 0" with exit 0 -- reproduced below as plain
    // inequality with the root run, not just a bare zero check, so a
    // regression that drops the count to some OTHER wrong number (not
    // literally 0) would also fail this assertion, and so would the
    // sibling.ts-reference regression described above.
    expect(fromSubdir).toBe(fromRoot);
  });
});

describe("--body end-to-end, real git repo (ugcportal-bn94)", () => {
  it("audits a body piped on stdin against the local working tree's diff, confirming a DONE claim", () => {
    const { writeFile, git, commit, runScriptStdin } = makeFixtureRepo();
    writeFile("x.ts", "const a = 1;\n");
    git(["add", "x.ts"]);
    commit("add x.ts");
    writeFile("x.ts", 'const a = 1;\n// a label of at most 24 characters\nconst b = 2;\n');

    const body = 'Fixed: the stale comment with "24 characters" was deleted.\n';
    const out = runScriptStdin(["--body"], body);

    expect(out).toContain("--- claims-audit: PR BODY claims (source: stdin)");
    expect(out).toContain("body candidates found: 1");
    expect(out).toContain('DONE contradicted, still in diff: "24 characters"');
  });

  it("K2: --body's counts are printed in their own block, never summed with a separate file-mode run's", () => {
    const { writeFile, git, commit, runScriptStdin, runScript } = makeFixtureRepo();
    writeFile("clean.ts", "const a = 1;\n");
    git(["add", "clean.ts"]);
    commit("add clean.ts, nothing claim-shaped");

    const fileModeOut = runScript();
    const bodyModeOut = runScriptStdin(["--body"], "This never fails on any path.\n");

    expect(fileModeOut).toContain("candidates found: 0");
    expect(bodyModeOut).toContain("body candidates found: 1");
    // Neither run's output names the other's count: a clean file-mode run
    // and a dirty body-mode run over the SAME tree produce two independent
    // banners/numbers, not one run whose single total a dirty body could
    // hide behind a clean diff (or vice versa).
    expect(fileModeOut).not.toContain("body candidates found");
    expect(bodyModeOut).not.toMatch(/^candidates found:/m);
  });

  it("flags an empty body as an error rather than a silent zero", () => {
    const { runScriptStdin } = makeFixtureRepo();
    let error;
    try {
      runScriptStdin(["--body"], "\n\n");
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.status).not.toBe(0);
    expect(error.stderr ?? "").toMatch(/empty -- nothing to audit/);
  });
});
