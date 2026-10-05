/**
 * Tests for the comment-claims audit (ugcportal-wzgw). Synthetic fixtures
 * are fed straight to the exported analysis functions, as
 * scripts/sweep-candidates.test.mjs does; the git plumbing in
 * scripts/lib/git-diff.mjs is exercised only through its pure diff parser.
 *
 * Each fixture is shaped like a real finding from the v0.5.0 review rounds
 * (docs/process/review-rounds-v0.5.0.md, Part 1), named in the test title.
 */
import { describe, expect, it } from "vitest";

import { auditContent, classifyClaimLine, extractComments, extractProseLines, findPathReferences, referenceExists } from "./claims-audit.mjs";
import { parseUnifiedDiffAddedLines } from "./lib/git-diff.mjs";

const NO_TRACKED = { trackedFiles: [] };

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
    const out = auditContent(content, "a.ts", new Set([3]), NO_TRACKED);
    expect(out).toEqual([{ file: "a.ts", line: 3, categories: ["MEASUREMENT"], text: "85px tall", missingReferences: [] }]);
  });

  it("audits every comment when changedLines is null (--all-lines, the stale-sibling sweep)", () => {
    const content = ["// always true", "const a = 1;", "// 85px tall", ""].join("\n");
    expect(auditContent(content, "a.ts", null, NO_TRACKED)).toHaveLength(2);
  });

  it("reports a block comment at the line of the offending sentence, not the block's first line", () => {
    const content = ["/**", " * Plain description.", " * It never throws.", " */", "const a = 1;", ""].join("\n");
    const out = auditContent(content, "a.ts", new Set([1, 2, 3, 4]), NO_TRACKED);
    expect(out).toEqual([{ file: "a.ts", line: 3, categories: ["ABSOLUTE"], text: "It never throws.", missingReferences: [] }]);
  });

  it("names a referenced file that is not in the tree, and stays silent for one that is", () => {
    const content = ["// see configured-users.ts and routes.ts", "const a = 1;", ""].join("\n");
    const out = auditContent(content, "src/lib/a.ts", new Set([1]), { trackedFiles: ["src/lib/routes.ts"] });
    expect(out).toEqual([
      { file: "src/lib/a.ts", line: 1, categories: [], text: "see configured-users.ts and routes.ts", missingReferences: ["configured-users.ts"] },
    ]);
  });

  it("is silent for a comment with no claim and no reference", () => {
    const content = "// build the href\nconst a = 1;\n";
    expect(auditContent(content, "a.ts", new Set([1]), NO_TRACKED)).toEqual([]);
  });

  it("audits Markdown prose line by line", () => {
    const content = "# Notes\n\nThe gate never fails open.\n";
    const out = auditContent(content, "docs/x.md", new Set([3]), NO_TRACKED);
    expect(out.map((c) => c.categories)).toEqual([["ABSOLUTE"]]);
  });

  it("ignores a file type it does not know how to read", () => {
    expect(auditContent("binary-ish", "image.png", null, NO_TRACKED)).toEqual([]);
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
