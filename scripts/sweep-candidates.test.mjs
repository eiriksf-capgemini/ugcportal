/**
 * Tests for the review-sweep candidate enumerator (ugcportal-plp6).
 *
 * These pass synthetic fixtures directly to the exported analysis functions
 * rather than fabricating git history, since the "verified by" clauses on
 * ugcportal-plp6 ask for exactly that: run the two checks against a fixture
 * shaped like the real defect and confirm what's flagged.
 */
import { describe, expect, it } from "vitest";

import { findObjectLikeBlocks, findSiblingGuardOmissions, findToContainCandidates } from "./sweep-candidates.mjs";

describe("findToContainCandidates", () => {
  it("lists a toContain call by file:line with its literal needle", () => {
    // The real historical example from this repo (review-standards/SKILL.md
    // section 2): every Button ships disabled:* classes, so this needle is
    // always present and the assertion can never fail.
    const content = `test("shows disabled state", () => {\n  expect(markup).toContain("disabled");\n});\n`;
    const candidates = findToContainCandidates(content, "example.test.tsx");
    expect(candidates).toEqual([{ file: "example.test.tsx", line: 2, negated: false, needle: '"disabled"' }]);
  });

  it("distinguishes the negated form", () => {
    const content = `expect(markup).not.toContain("server's reply");\n`;
    const candidates = findToContainCandidates(content, "example.test.tsx");
    expect(candidates).toEqual([{ file: "example.test.tsx", line: 1, negated: true, needle: '"server\'s reply"' }]);
  });

  it("reports an explicit zero count rather than staying silent", () => {
    const content = `test("something else", () => {\n  expect(value).toBe(true);\n});\n`;
    expect(findToContainCandidates(content, "example.test.tsx")).toEqual([]);
  });

  it("finds a call whose argument spans multiple lines", () => {
    // Real shape in this repo: src/lib/sign-in-policy.test.ts:172.
    const content = 'expect(x).toContain(\n  "foo"\n);\n';
    const candidates = findToContainCandidates(content, "example.test.ts");
    expect(candidates).toEqual([{ file: "example.test.ts", line: 1, negated: false, needle: '"foo"' }]);
  });

  it("does not truncate a needle that itself contains a call with nested parens", () => {
    const content = "expect(x).toContain(String(count));\n";
    const candidates = findToContainCandidates(content, "example.test.ts");
    expect(candidates).toEqual([{ file: "example.test.ts", line: 1, negated: false, needle: "String(count)" }]);
  });

  it("closes a string ending in an escaped backslash, not one escaped char short", () => {
    // A naive "is the immediately preceding char a backslash" check reads
    // the closing quote of `"value\\"` as escaped (it's preceded by `\`),
    // when that `\` is itself escaped by the one before it -- the string
    // really does end there.
    const content = 'expect(x).toContain("value\\\\");\nexpect(y).toBe(true);\n';
    const candidates = findToContainCandidates(content, "example.test.ts");
    expect(candidates).toEqual([{ file: "example.test.ts", line: 1, negated: false, needle: '"value\\\\"' }]);
  });

  it("does not miscount a paren inside a regex character class", () => {
    const content = "expect(x).toContain(/[(]/);\nexpect(y).toBe(true);\n";
    const candidates = findToContainCandidates(content, "example.test.ts");
    expect(candidates).toEqual([{ file: "example.test.ts", line: 1, negated: false, needle: "/[(]/" }]);
  });
});

describe("findObjectLikeBlocks", () => {
  it("does not mistake a control-flow block for an object literal", () => {
    const content = `if (x) {\n  id: true,\n}\n`;
    expect(findObjectLikeBlocks(content)).toEqual([]);
  });

  it("finds an object literal assigned to a const", () => {
    const content = `const x = {\n  id: true,\n  name: true,\n};\n`;
    const blocks = findObjectLikeBlocks(content);
    expect(blocks).toHaveLength(1);
    expect([...blocks[0].fieldLines.keys()]).toEqual(["id", "name"]);
  });

  it("ignores braces inside string and template literals", () => {
    const content = 'const x = {\n  id: true,\n  label: "{not a field}",\n  tpl: `also {not a field}`,\n};\n';
    const blocks = findObjectLikeBlocks(content);
    expect(blocks).toHaveLength(1);
    expect([...blocks[0].fieldLines.keys()]).toEqual(["id", "label", "tpl"]);
  });

  it("ignores a brace inside a regex literal field value", () => {
    const content = "const real = {\n  id: true,\n  re: /foo}/,\n  name: true,\n};\n";
    const blocks = findObjectLikeBlocks(content);
    expect(blocks).toHaveLength(1);
    expect([...blocks[0].fieldLines.keys()]).toEqual(["id", "re", "name"]);
  });

  it("finds every field on a compact one-line literal, not just the first", () => {
    const content = "const x = { id: true, name: true, extra: true };\n";
    const blocks = findObjectLikeBlocks(content);
    expect(blocks).toHaveLength(1);
    expect([...blocks[0].fieldLines.keys()]).toEqual(["id", "name", "extra"]);
  });

  it("does not mistake an interface body for an object literal", () => {
    const content = "interface FooProps {\n  id: string;\n  name: string;\n  role: string;\n}\n";
    expect(findObjectLikeBlocks(content)).toEqual([]);
  });

  it("does not mistake a class body for an object literal", () => {
    const content = "class Foo extends Bar {\n  id: string;\n  name: string;\n  role: string;\n}\n";
    expect(findObjectLikeBlocks(content)).toEqual([]);
  });

  it("closes a string field value ending in an escaped backslash, without corrupting the rest of the file", () => {
    // Round-2 finding: the naive escape check left `inDouble` stuck true
    // after a value like "C:\\", so every later brace in the file was
    // silently read as still being inside that string.
    const content = 'const a = {\n  path: "C:\\\\",\n};\n\nconst b = {\n  id: true,\n};\n';
    const blocks = findObjectLikeBlocks(content);
    expect(blocks).toHaveLength(2);
    expect([...blocks[0].fieldLines.keys()]).toEqual(["path"]);
    expect([...blocks[1].fieldLines.keys()]).toEqual(["id"]);
  });
});

describe("findSiblingGuardOmissions", () => {
  // Modeled on ugcportal-r1d's round-4/round-6 defect: two sibling
  // selects sharing the same fields, where a fix touched one and not
  // the other.
  const fixture = [
    "export const PublicPreviewSelect = {",
    "  id: true,",
    "  previewId: true,",
    "  previewKey: true,",
    "};",
    "",
    "export const AdminPreviewSelect = {",
    "  id: true,",
    "  previewId: true,",
    "  previewKey: true,",
    "};",
    "",
  ].join("\n");

  it("flags the untouched sibling when a shared field's line was changed in only one literal", () => {
    // Simulates a diff that changed line 4 (PublicPreviewSelect.previewKey)
    // and nothing else.
    const changedLines = new Set([4]);
    const candidates = findSiblingGuardOmissions(fixture, changedLines, "select.ts");
    expect(candidates).toEqual([{ file: "select.ts", field: "previewKey", touchedLine: 4, siblingLine: 10 }]);
  });

  it("flags nothing when both siblings' copies of the field were changed", () => {
    const changedLines = new Set([4, 10]);
    expect(findSiblingGuardOmissions(fixture, changedLines, "select.ts")).toEqual([]);
  });

  it("flags nothing when fewer than 3 fields are shared", () => {
    const twoFieldFixture = ["const a = {", "  id: true,", "  name: true,", "};", "", "const b = {", "  id: true,", "  other: true,", "};"].join(
      "\n",
    );
    expect(findSiblingGuardOmissions(twoFieldFixture, new Set([2]), "x.ts")).toEqual([]);
  });

  it("flags nothing when the changed line is outside any object literal", () => {
    const changedLines = new Set([6]); // the blank line between the two blocks
    expect(findSiblingGuardOmissions(fixture, changedLines, "select.ts")).toEqual([]);
  });
});
