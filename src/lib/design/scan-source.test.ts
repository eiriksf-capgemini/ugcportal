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

  /**
   * ugcportal-3wgp review round 4, MEDIUM (CONFIRMED, reproduced by the
   * reviewer): a regex literal containing a quote character used as part
   * of its own pattern (not string syntax) desynced the round-3 string
   * tracker. Reproduces the exact shape from src/lib/request-body.ts's
   * real `DISPOSITION_NAME` constant.
   */
  it("THE ROUND-4 NAMED BUG: a regex literal containing a quote char does not desync the scanner", () => {
    const code =
      'const DISPOSITION_NAME = /;\\s*name\\s*=\\s*"([^"]*)"/i;\n' +
      'const trackingSrc = "https://stats.example/x?trackerco";';
    expect(stripComments(code)).toBe(code);
  });

  it("does not treat a real division operator as a regex literal", () => {
    const code = "const percent = (loaded / total) * 100; // a real comment\nconst y = 2;";
    expect(stripComments(code)).toBe(
      "const percent = (loaded / total) * 100;  \nconst y = 2;",
    );
  });

  it("treats a regex literal after 'return' as a regex, not division", () => {
    // Exactly this file's own isTestFile, and decision-form.test.tsx's
    // real `return /value="([^"]*)"/.exec(...)` — "return" ends in a
    // letter, so a naive last-character check would misclassify this as
    // division.
    const code = 'return /\\.(test|spec)\\.(tsx?|css)$/.test(file);';
    expect(stripComments(code)).toBe(code);
  });

  it("strips a real comment that follows a regex literal on the same line", () => {
    const code = 'const x = /abc/.test(y); // a real comment\nconst z = 1;';
    expect(stripComments(code)).toBe(
      "const x = /abc/.test(y);  \nconst z = 1;",
    );
  });

  it("MUTATION CHECK: the round-3 (regex-unaware) scanner mishandles the round-4 named bug", () => {
    // Fixture mutation, not a production-code change: reproduces round 3's
    // actual shipped implementation (string-aware, regex-unaware) inline,
    // and confirms it corrupts the exact fixture above — proving this
    // test is anchored to a real, previously-shipped defect.
    function round3StripComments(input: string): string {
      let result = "";
      let idx = 0;
      const len = input.length;
      function skipString(quote: string): number {
        let j = idx + 1;
        while (j < len && input[j] !== quote) {
          j += input[j] === "\\" ? 2 : 1;
        }
        return Math.min(j + 1, len);
      }
      while (idx < len) {
        const c = input[idx];
        if (c === '"' || c === "'" || c === "`") {
          const end = skipString(c);
          result += input.slice(idx, end);
          idx = end;
          continue;
        }
        if (c === "/" && input[idx + 1] === "*") {
          const close = input.indexOf("*/", idx + 2);
          result += " ";
          idx = close === -1 ? len : close + 2;
          continue;
        }
        if (c === "/" && input[idx + 1] === "/") {
          const newline = input.indexOf("\n", idx);
          result += " ";
          idx = newline === -1 ? len : newline;
          continue;
        }
        result += c;
        idx += 1;
      }
      return result;
    }

    const code =
      'const DISPOSITION_NAME = /;\\s*name\\s*=\\s*"([^"]*)"/i;\n' +
      'const trackingSrc = "https://stats.example/x?trackerco";';
    expect(round3StripComments(code)).not.toBe(code);
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
