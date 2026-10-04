import { describe, expect, it } from "vitest";

import { stripComments } from "./scan-source";

/**
 * ugcportal-3wgp review round 3, MEDIUM (CONFIRMED, reproduced by the
 * reviewer): the previous two-regex `stripComments` had no notion of
 * "inside a string" at all, so a protocol-relative URL
 * (`"//stats.example/collect"`, no scheme, nothing before its `//` for the
 * old `:`-lookbehind to see) was mistaken for a real comment opener and
 * everything after it on the line — including live code — was erased. A
 * vendor host reached only through such a URL would have been invisible to
 * analytics-host.grep.test.ts's K6 scan, which runs its match against this
 * function's output.
 */
describe("stripComments", () => {
  it("strips a block comment", () => {
    expect(stripComments("const x = 1; /* a comment */ const y = 2;")).toBe(
      "const x = 1;   const y = 2;",
    );
  });

  it("strips a line comment to end of line", () => {
    expect(stripComments("const x = 1; // trailing comment\nconst y = 2;")).toBe(
      "const x = 1;  \nconst y = 2;",
    );
  });

  it("strips a multi-line block comment, collapsing it to one space", () => {
    expect(stripComments("a /* line one\nline two */ b")).toBe("a   b");
  });

  it("does not strip content inside a double-quoted string containing //", () => {
    const code = 'const url = "https://example.com/path";';
    expect(stripComments(code)).toBe(code);
  });

  it("does not strip content inside a single-quoted string containing //", () => {
    const code = "const url = 'https://example.com/path';";
    expect(stripComments(code)).toBe(code);
  });

  it("does not strip content inside a template literal containing //", () => {
    const code = "const url = `https://example.com/${path}`;";
    expect(stripComments(code)).toBe(code);
  });

  it("THE NAMED BUG: a protocol-relative URL in a string survives intact", () => {
    const code = 'const trackingSrc = "//stats.example/collect?x=trackerco";';
    expect(stripComments(code)).toBe(code);
  });

  it("handles an escaped quote inside a string without ending the string early", () => {
    const code = 'const s = "a\\"b // not a comment";';
    expect(stripComments(code)).toBe(code);
  });

  it("still strips a REAL trailing comment that follows a string on the same line", () => {
    // Guards against a regression the OTHER way: round 2 finding 9 fixed a
    // false positive from an un-stripped innocent comment, and this fix
    // must not reintroduce it by becoming "never strip a trailing //".
    expect(stripComments('const s = "value"; // a real comment\nconst t = 2;')).toBe(
      'const s = "value";  \nconst t = 2;',
    );
  });

  it("MUTATION CHECK: the naive (string-unaware) regex pair mishandles the named bug", () => {
    // Fixture mutation, not a production-code change: reproduces the exact
    // OLD implementation inline and confirms it fails the same assertion
    // the fixed function passes above — proving the test is actually
    // anchored to a real, previously-shipped defect rather than an
    // invented one.
    function naiveStripComments(source: string): string {
      return source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(?<!:)\/\/[^\n]*/g, " ");
    }
    const code = 'const trackingSrc = "//stats.example/collect?x=trackerco";';
    expect(naiveStripComments(code)).not.toBe(code);
    expect(naiveStripComments(code)).not.toContain("trackerco");
  });
});
