import { describe, expect, it, vi } from "vitest";

import { isTestFile, stripComments, stripCssComments } from "./scan-source";
import {
  legacyStripComments,
  round3StripComments,
  round5StripComments,
} from "./scan-source-legacy.test-support";

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
    expect(stripComments("const x = 1; /* a comment */ const y = 2;", "fixture.ts")).toBe(
      "const x = 1;   const y = 2;",
    );
  });

  it("strips a line comment to end of line", () => {
    expect(stripComments("const x = 1; // trailing comment\nconst y = 2;", "fixture.ts")).toBe(
      "const x = 1;  \nconst y = 2;",
    );
  });

  it("strips a multi-line block comment, collapsing it to one space", () => {
    expect(stripComments("a /* line one\nline two */ b", "fixture.ts")).toBe("a   b");
  });

  it("does not strip content inside a double-quoted string containing //", () => {
    const code = 'const url = "https://example.com/path";';
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  it("does not strip content inside a single-quoted string containing //", () => {
    const code = "const url = 'https://example.com/path';";
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  it("does not strip content inside a template literal containing //", () => {
    const code = "const url = `https://example.com/${path}`;";
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  it("THE NAMED BUG: a protocol-relative URL in a string survives intact", () => {
    const code = 'const trackingSrc = "//stats.example/collect?x=trackerco";';
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  it("handles an escaped quote inside a string without ending the string early", () => {
    const code = 'const s = "a\\"b // not a comment";';
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  it("still strips a REAL trailing comment that follows a string on the same line", () => {
    // Guards against a regression the OTHER way: round 2 finding 9 fixed a
    // false positive from an un-stripped innocent comment, and this fix
    // must not reintroduce it by becoming "never strip a trailing //".
    expect(stripComments('const s = "value"; // a real comment\nconst t = 2;', "fixture.ts")).toBe(
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
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  it("does not treat a real division operator as a regex literal", () => {
    const code = "const percent = (loaded / total) * 100; // a real comment\nconst y = 2;";
    expect(stripComments(code, "fixture.ts")).toBe(
      "const percent = (loaded / total) * 100;  \nconst y = 2;",
    );
  });

  it("treats a regex literal after 'return' as a regex, not division", () => {
    // Exactly this file's own isTestFile, and decision-form.test.tsx's
    // real `return /value="([^"]*)"/.exec(...)` — "return" ends in a
    // letter, so a naive last-character check would misclassify this as
    // division.
    const code = 'return /\\.(test|spec)\\.(tsx?|css)$/.test(file);';
    expect(stripComments(code, "fixture.ts")).toBe(code);
  });

  /**
   * Review round 5, LOW finding 1: the division-permitting character class
   * omitted `}` — a `/` right after an object literal's closing brace
   * (`{a:1} / 2`) was read as a regex START instead of division, so a REAL
   * block comment right after it survived stripping untouched (the
   * scanner thought it was still "inside a regex", scanning for a closing
   * `/` that isn't there until it bails at the newline — but by then the
   * comment's own `/*`/`*​/` never got the chance to be recognised as such).
   */
  it("treats a / right after an object literal's closing brace as division, not a regex start", () => {
    const code = "const x = {a:1} / 2; /* a real comment */ const y = 2;";
    expect(stripComments(code, "fixture.ts")).toBe("const x = {a:1} / 2;   const y = 2;");
  });

  /**
   * Review round 5, LOW finding 2: REGEX_PERMITTING_KEYWORDS omitted
   * "await" - "await" ends in a letter, same ambiguity as "return" above.
   * A fixture that merely checks `stripComments(code) === code` with no
   * quote/comment inside the regex body would pass either way here (the
   * misread-as-division path still copies characters through unchanged
   * when nothing inside the "regex" needs protecting) - that would be
   * exactly the "assertion that cannot fail" trap review-standards'
   * Family 3 sweep watches for. This fixture instead embeds a quote
   * character inside the regex pattern (same shape as the round-4 named
   * bug) FOLLOWED by a real trailing block comment: misreading the
   * leading `/` as division sends the quote through skipString as if it
   * opened a string, desyncing the scanner so the real comment after it
   * is no longer recognised as a comment and survives unstripped -
   * verified by hand-tracing both the "await"-aware and "await"-unaware
   * paths before committing to this fixture.
   */
  it("treats a regex literal after 'await' as a regex, not division (and still strips a real comment after it)", () => {
    // Inside an async body, which is where real `await` lives.
    //
    // Round 5's fixture had this at the top level of a file with no import
    // or export — a SCRIPT, not a module. Top-level `await` is only an
    // operator in a module, so in a script TypeScript falls back to its
    // `isAwaitExpression` lookahead, which treats `await` as an operator
    // only when an identifier, keyword or literal follows on the same
    // line; `/` is none of those, so it reads `await` as an identifier and
    // the `/` as division. Measured: in a module `await /abc/.test(s)`
    // parses clean with a real regex literal, in a script it does not.
    // The script shape now takes the fail-closed path, pinned by the test
    // below. The finding this fixture exists for — "a regex after `await`
    // is a regex, not division" — is unchanged.
    const code =
      'async function f(s) { await /name="([^"]*)"/i.test(s); /* real comment */ const z = 1; }';
    expect(stripComments(code, "fixture.ts")).toBe(
      'async function f(s) { await /name="([^"]*)"/i.test(s);   const z = 1; }',
    );
  });

  it("fails closed on a top-level `await /re/` in a script with no import or export", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const code = 'await /name="([^"]*)"/i.test(s); /* real comment */ const z = 1;';
      expect(stripComments(code, "fixture.ts")).toBe(code);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("did not parse cleanly");
    } finally {
      warn.mockRestore();
    }
  });

  it("MUTATION CHECK: without '}' in the division class, the block comment after {a:1} / 2 survives unstripped", () => {
    // Fixture mutation, not a production-code change: reproduces the
    // round-5 (pre-fix) stripComments inline (division class missing `}`)
    // and confirms it corrupts the exact fixture above by failing to
    // strip the trailing real comment — proving this test is anchored to
    // a real, previously-shipped defect rather than an invented one. This
    // was also confirmed directly against the real scan-source.ts via a
    // temporary revert-and-restore mutation check.
    const code = "const x = {a:1} / 2; /* a real comment */ const y = 2;";
    expect(round5StripComments(code)).toBe(code); // comment NOT stripped - the bug.
    expect(round5StripComments(code)).not.toBe(
      "const x = {a:1} / 2;   const y = 2;",
    );
  });

  it("strips a real comment that follows a regex literal on the same line", () => {
    const code = 'const x = /abc/.test(y); // a real comment\nconst z = 1;';
    expect(stripComments(code, "fixture.ts")).toBe(
      "const x = /abc/.test(y);  \nconst z = 1;",
    );
  });

  it("MUTATION CHECK: the round-3 (regex-unaware) scanner mishandles the round-4 named bug", () => {
    // Fixture mutation, not a production-code change: reproduces round 3's
    // actual shipped implementation (string-aware, regex-unaware) inline,
    // and confirms it corrupts the exact fixture above — proving this
    // test is anchored to a real, previously-shipped defect.
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

/**
 * ugcportal-ysub K1. Every fixture in this block is a shape the HAND-ROLLED
 * scanner (preserved verbatim as `legacyStripComments` in
 * scan-source-legacy.test-support.ts) got wrong, and that TypeScript's own
 * parser gets right for free. Each one asserts BOTH directions, as the bead
 * requires:
 *
 *   - what the parser-backed `stripComments` produces (every real comment
 *     gone, no non-comment text lost); and
 *   - that `legacyStripComments` produces something different and wrong, so
 *     the fixture is anchored to a defect that actually shipped rather than
 *     an invented one (review-standards family 3: an assertion whose needle
 *     cannot be absent is not coverage).
 *
 * The "wrong" assertion is spelled out as a concrete expected string, not
 * merely `not.toBe(code)` — a `not.toBe` would still pass if the legacy
 * scanner were quietly replaced by something that failed differently, or
 * not at all for the stated reason.
 */
describe("stripComments (ugcportal-ysub: TypeScript's lexer, not a hand-rolled one)", () => {
  /**
   * Item 1, MEDIUM (CONFIRMED by execution). The `)` that closes an
   * `if`/`while` CONDITION is indistinguishable, to a character-based
   * heuristic, from the `)` that closes a parenthesised VALUE — so a regex
   * literal in statement position right after it was read as division. The
   * regex here carries an ODD number of quote characters, so the first of
   * them then opened a phantom string that ran on to the next quote,
   * inverting the scanner's string parity: the `//` of an ordinary
   * `https://` URL after it read as a comment opener and the rest of the
   * file was erased from the scan.
   */
  const ITEM_1 =
    'if (header) /charset="/i.test(header);\n' +
    'const trackingSrc = "https://stats.example/x?trackerco";';

  it("THE ITEM-1 NAMED BUG: a regex after an if-condition's ) does not desync the scanner", () => {
    expect(stripComments(ITEM_1, "fixture.ts")).toBe(ITEM_1);
  });

  it("MUTATION CHECK: the hand-rolled scanner erases the live host after that same regex", () => {
    expect(legacyStripComments(ITEM_1)).toBe(
      'if (header) /charset="/i.test(header);\nconst trackingSrc = "https: ',
    );
    expect(legacyStripComments(ITEM_1)).not.toContain("trackerco");
  });

  /**
   * Item 2, MEDIUM (CONFIRMED by execution). A stylesheet is not
   * JavaScript: `url(https://cdn.example/bg.png)` is an ordinary UNQUOTED
   * CSS url token with no string quotes to protect it, so a JavaScript
   * lexer reads its `//` as a line comment and truncates the line —
   * hiding a hex literal after it from the K2 raw-hex gate. Fixed by not
   * handing CSS to a JavaScript lexer at all; no-raw-hex.test.ts dispatches
   * on the file extension (see its own `stripSourceComments`).
   */
  const ITEM_2 =
    ".hero { background: url(https://cdn.example/bg.png) no-repeat; border: 1px solid #14555f; }";
  const ITEM_2_TRUNCATED = ".hero { background: url(https: ";

  it("THE ITEM-2 NAMED BUG: stripCssComments keeps an unquoted url(https://...) intact", () => {
    expect(stripCssComments(ITEM_2)).toBe(ITEM_2);
  });

  it("stripCssComments still strips a real CSS block comment", () => {
    expect(stripCssComments(".a { /* note */ color: red; }")).toBe(".a {   color: red; }");
  });

  it("MUTATION CHECK: the hand-rolled scanner truncated that CSS line at the url's //", () => {
    // Why CSS needs its own stripper, in two different failure modes.
    //
    // The hand-rolled lexer read the `//` inside the unquoted url token as
    // a line comment and deleted the rest of the line, hex literal and
    // all — a false NEGATIVE for the K2 gate.
    expect(legacyStripComments(ITEM_2)).toBe(ITEM_2_TRUNCATED);
  });

  it("MUTATION CHECK: the parser-backed scanner refuses the same CSS outright", () => {
    // The parser-backed one does not truncate, because a stylesheet is not
    // a parseable program: it reports diagnostics and takes the
    // fail-closed path, handing the text back whole. That is safe for the
    // host grep but WRONG for the hex gate, which would then see every
    // commented-out hex literal in the file as live — a false POSITIVE.
    // Neither scanner can do CSS; `stripCssComments` is why that no longer
    // matters.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments(ITEM_2, "fixture.ts")).toBe(ITEM_2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("did not parse cleanly");
    } finally {
      warn.mockRestore();
    }
    // The concrete consequence: a CSS comment survives the JavaScript path.
    const commented = ".a { /* #14555f was here */ color: red; }";
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments(commented, "fixture.ts")).toContain("#14555f");
      expect(stripCssComments(commented)).not.toContain("#14555f");
    } finally {
      quiet.mockRestore();
    }
  });

  /**
   * Item 4, LOW. `of` is NOT a reserved word — it is contextual, and
   * `const of = 6; of / 2` is ordinary division. The hand-rolled scanner
   * listed it among the keywords that can only precede an expression, so
   * it read the `/` as a regex start, ran forward to the `/` inside the
   * next string literal, greedily ate the character after it as a regex
   * FLAG, and left the scanner mid-string — after which the real trailing
   * comment was no longer recognised as one.
   */
  const ITEM_4 = 'const half = of / 2; const label = "a/b"; // real comment\nconst z = 1;';

  it("THE ITEM-4 NAMED BUG: `of / 2` is division, and a real comment after it is still stripped", () => {
    expect(stripComments(ITEM_4, "fixture.ts")).toBe(
      'const half = of / 2; const label = "a/b";  \nconst z = 1;',
    );
  });

  it("MUTATION CHECK: the hand-rolled scanner leaves that comment unstripped", () => {
    expect(legacyStripComments(ITEM_4)).toBe(ITEM_4);
  });

  /**
   * Item 5, LOW. A postfix `++`/`--` ends a VALUE, so the `/` after it is
   * division. The hand-rolled scanner's division-permitting character
   * class had no `+`, so it tried to read a regex, found its "closing"
   * delimiter in the first `/` of the real `//` comment later on the line,
   * and the comment survived.
   */
  const ITEM_5 = "let i = 0; const r = i++ / 2; // real comment\nconst z = 1;";

  it("THE ITEM-5 NAMED BUG: `i++ / 2` is division, and a real comment after it is still stripped", () => {
    expect(stripComments(ITEM_5, "fixture.ts")).toBe("let i = 0; const r = i++ / 2;  \nconst z = 1;");
  });

  it("MUTATION CHECK: the hand-rolled scanner leaves that comment unstripped too", () => {
    expect(legacyStripComments(ITEM_5)).toBe(ITEM_5);
  });

  /**
   * Item 6, LOW. Regex flags are an identifier-character run, so
   * `/foo/instanceof` really does consume `instanceof` as (invalid) flags —
   * that part the hand-rolled scanner got right. What it got wrong is what
   * happens NEXT: having swallowed a keyword into the flag run, its
   * "previous word" heuristic then saw `instanceof` before the following
   * `/` and read THAT as another regex start, whose closing delimiter it
   * found in the first `/` of the real `//` comment — which therefore
   * survived. A deliberately lexer-level fixture: the point is which
   * characters belong to which token, not that anyone would write this.
   */
  const ITEM_6 = "const weird = /foo/instanceof/ 2; // real comment\nconst z = 1;";

  it("THE ITEM-6 NAMED BUG: greedy regex flags do not swallow the comment after them", () => {
    expect(stripComments(ITEM_6, "fixture.ts")).toBe("const weird = /foo/instanceof/ 2;  \nconst z = 1;");
  });

  it("MUTATION CHECK: the hand-rolled scanner leaves that comment unstripped as well", () => {
    expect(legacyStripComments(ITEM_6)).toBe(ITEM_6);
  });

  /**
   * Not one of the numbered items, and the reason this block is not just a
   * pile of `toBe(code)`: a replacement that quietly became "never strip
   * anything" would satisfy every "no non-comment text is lost" assertion
   * above while reintroducing round 2's finding 9 (an innocent comment
   * discussing a vendor tripping the K6 grep). These two assert the other
   * half of K1 — that every REAL comment is still removed.
   */
  it("MUTATION CHECK: the parser-backed scanner still strips plain comments", () => {
    expect(stripComments("/* block */ const a = 1; // line\nconst b = 2;", "fixture.ts")).toBe(
      "  const a = 1;  \nconst b = 2;",
    );
  });

  it("strips a comment sitting between two tokens of the same statement", () => {
    // A comment in front of a punctuation token rather than in front of a
    // statement. `ts.forEachChild` never visits the `;`, so this comment
    // is inside no node's range: it lives in the GAP between the end of
    // the last child and the end of the statement, and it is the gap scan
    // that finds it. Guards that specifically — a walk that only looked at
    // node boundaries would miss it.
    expect(stripComments("const a = 1 /* mid-statement */ ;", "fixture.ts")).toBe("const a = 1   ;");
  });

  /**
   * Review round 1 on this PR, finding 1, MEDIUM (CONFIRMED by execution):
   * the first version of this fix parsed EVERY file as TSX. `<` is the one
   * character TSX and TS genuinely disagree about — in a `.ts` file these
   * two lines are a generic arrow function and a type assertion, but read
   * as TSX each opens a JSX element that never closes, putting the whole
   * rest of the file inside what the parser believes is JSX TEXT. Comments
   * do not exist in JSX text, so NONE of them is stripped from there on,
   * which re-opens ugcportal-3wgp round 2's finding 9 (a comment merely
   * discussing the vendor tripping the K6 grep) and silently degrades the
   * hex and dual-meaning gates the same way.
   *
   * Two comments, not one, in each fixture: the defect is "everything from
   * here on", so a single-comment fixture could not tell "this one comment
   * was missed" apart from "the rest of the file was".
   */
  const GENERIC_ARROW = "const identity = <T>(x: T) => x; // c1\nconst y = 2; // c2\n";
  const ANGLE_ASSERTION = "const n = <number>value; // c1\nconst y = 2; // c2\n";

  it("THE ROUND-1 FINDING-1 BUG: a generic arrow in a .ts file does not blind the rest of the file", () => {
    expect(stripComments(GENERIC_ARROW, "fixture.ts")).toBe(
      "const identity = <T>(x: T) => x;  \nconst y = 2;  \n",
    );
  });

  it("MUTATION CHECK: the SAME source parsed as .tsx leaves both comments unstripped", () => {
    // Fixture mutation: only the extension changes, which is exactly the
    // defect (one dialect for every file). Under TSX, `<T>` opens a JSX
    // element and both comments survive.
    expect(stripComments(GENERIC_ARROW, "fixture.tsx")).toBe(GENERIC_ARROW);
  });

  it("a <number>value type assertion in a .ts file does not blind the rest of the file either", () => {
    expect(stripComments(ANGLE_ASSERTION, "fixture.ts")).toBe(
      "const n = <number>value;  \nconst y = 2;  \n",
    );
  });

  it("MUTATION CHECK: the same assertion parsed as .tsx leaves both comments unstripped", () => {
    expect(stripComments(ANGLE_ASSERTION, "fixture.tsx")).toBe(ANGLE_ASSERTION);
  });

  /**
   * Review round 1 on this PR, finding 2, MEDIUM (CONFIRMED by execution):
   * an unterminated `/*` runs to end of file, so stripping it erased every
   * remaining line — and a live analytics host on one of those lines
   * vanished before the K6 grep could see it, which is this bead's K3
   * "following should never happen" exactly. Now fails CLOSED: the source
   * comes back whole, a strict superset of the correctly-stripped text, so
   * every marker a caller hunts for is still there. The end-to-end version
   * of this, through the real grep, is in analytics-host.grep.test.ts.
   */
  const UNTERMINATED =
    'const a = 1; /* never closed\nconst trackingSrc = "https://stats.example/x?trackerco";\n';

  it("THE ROUND-1 FINDING-2 BUG: an unterminated block comment returns the source whole", () => {
    // Spied, not left to print (review round 3, finding 2): a green run
    // should be quiet, and a warning nobody silenced is a warning nobody
    // reads. Asserted rather than merely swallowed — this fixture takes
    // the fail-closed path, so the warning is part of what it is testing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments(UNTERMINATED, "fixture.ts")).toBe(UNTERMINATED);
      expect(stripComments(UNTERMINATED, "fixture.ts")).toContain("trackerco");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns, naming the file, when it falls back to scanning unstripped", () => {
    // Review round 2, LOW: failing closed SILENTLY is its own trap. The
    // gate that then fires says only "vendor name found in <file>", and
    // when the only mention really is in a comment the obvious reading of
    // that is "false positive, allowlist it" — permanently exempting a
    // file for a reason nobody wrote down.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stripComments(UNTERMINATED, "src/lib/evil.ts");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("src/lib/evil.ts");
      expect(warn.mock.calls[0][0]).toContain("unterminated block comment");
    } finally {
      warn.mockRestore();
    }
  });

  it("MUTATION CHECK: closing that comment strips it and warns about nothing", () => {
    // Fixture mutation for the warning above: ` */` added, nothing else.
    // If the warning fired on every call it would be noise rather than a
    // signal, and the assertion above could not fail.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stripComments(
        'const a = 1; /* now closed */\nconst trackingSrc = "https://stats.example/x?trackerco";\n',
        "src/lib/fine.ts",
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("MUTATION CHECK: closing that same comment strips it, and the host survives either way", () => {
    // Fixture mutation: ` */` added, nothing else. The fail-closed branch
    // must not be what the first assertion is really testing — with the
    // comment closed, the normal path runs and the comment IS stripped,
    // so "returns the source whole" has a failing case.
    const closed =
      'const a = 1; /* now closed */\nconst trackingSrc = "https://stats.example/x?trackerco";\n';
    expect(stripComments(closed, "fixture.ts")).toBe(
      'const a = 1;  \nconst trackingSrc = "https://stats.example/x?trackerco";\n',
    );
    expect(stripComments(closed, "fixture.ts")).toContain("trackerco");
  });

  it("treats `/*/` as unterminated — its last two characters are `*/`, but nothing closes it", () => {
    // Why the guard asks `indexOf("*/", pos + 2)` rather than "does the
    // comment's text end in `*​/`": the naive version calls this closed.
    const code =
      'const a = 1; /*/\nconst trackingSrc = "https://stats.example/x?trackerco";\n';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments(code, "fixture.ts")).toBe(code);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Review round 3, finding 7 (verified): TypeScript's parser is
   * recursive, and about a thousand nested parentheses overflow the stack.
   * Uncaught, that `RangeError` aborts the ENTIRE scan — every later file
   * goes unexamined and the gate reports nothing rather than reporting a
   * problem. A gate that stops running is worse than a gate that reads one
   * file conservatively, so this takes the same fail-closed path as an
   * unterminated comment: warn, and hand the source back whole.
   *
   * 20000 rather than the ~1000 where it first bites: stack headroom
   * varies by engine, platform and CI runner, and a fixture sitting near
   * the threshold would be flaky somewhere.
   */
  const DEEPLY_NESTED = `const deep = ${"(".repeat(20000)}1${")".repeat(20000)}; // c\n`;

  it("fails closed, loudly, on source too deeply nested for the parser", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments(DEEPLY_NESTED, "src/lib/deep.ts")).toBe(DEEPLY_NESTED);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("src/lib/deep.ts");
      expect(warn.mock.calls[0][0]).toContain("could not be parsed");
    } finally {
      warn.mockRestore();
    }
  });

  it("MUTATION CHECK: the same shape at a depth the parser handles IS stripped, quietly", () => {
    // Fixture mutation: the identical source at a nesting depth well
    // inside what the parser copes with. The comment is stripped and no
    // warning fires — so the assertion above has a failing case and is not
    // just describing what this function does to every input.
    const shallow = `const deep = ${"(".repeat(50)}1${")".repeat(50)}; // c\n`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments(shallow, "src/lib/shallow.ts")).not.toBe(shallow);
      expect(stripComments(shallow, "src/lib/shallow.ts")).not.toContain("// c");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("MUTATION CHECK: `/**/` is a real, empty, CLOSED comment and is still stripped", () => {
    // The other side of the `/*/` edge — one character longer and it is a
    // genuine comment, so the length-sensitive guard must not over-reach.
    expect(stripComments("const a = 1; /**/ const b = 2;", "fixture.ts")).toBe(
      "const a = 1;   const b = 2;",
    );
  });

  /**
   * Review round 4, CONFIRMED medium. The gap scan is only safe because
   * every literal in a CLEANLY PARSED file is a node; when TypeScript
   * error-recovers it skips tokens, and a gap can then start INSIDE a
   * string literal. At that point the gap scanner reads the `//` of an
   * ordinary `https://` URL as a line comment and deletes live source.
   *
   * One unterminated attribute string on line 1 is enough. Before the
   * parse-clean precondition, this returned
   * `<R a="\nexport const trackingSrc = "https: \n` — the live analytics
   * host gone, with no warning of any kind. Planted as a real file under
   * src/, the K6 grep stayed green; the end-to-end version of that is in
   * analytics-host.grep.test.ts.
   *
   * Checked in every dialect the scanner parses, because the shape of the
   * recovery differs per dialect and the invariant does not.
   */
  const ERROR_RECOVERY_REPRO =
    '<R a="\nexport const trackingSrc = "https://stats.example/x?trackerco";\n';

  it.each(["evil.tsx", "evil.jsx", "evil.js", "evil.mjs", "evil.cjs"])(
    "fails closed rather than deleting live source after an unterminated string (%s)",
    (fileName) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = stripComments(ERROR_RECOVERY_REPRO, fileName);
        expect(out).toBe(ERROR_RECOVERY_REPRO);
        expect(out).toContain("trackerco");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(fileName);
        expect(warn.mock.calls[0][0]).toContain("did not parse cleanly");
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("MUTATION CHECK: terminate that string and the same file strips normally, quietly", () => {
    // Fixture mutation: one closing quote added to line 1, nothing else.
    // The file parses, the gap invariant holds, the scan runs — and the
    // host is still there because it was never in a comment to begin
    // with. Without this, "returns the source unchanged" could be passing
    // because the scanner strips nothing from anything.
    const terminated =
      '<R a="" />;\nexport const trackingSrc = "https://stats.example/x?trackerco"; // c\n';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = stripComments(terminated, "fine.tsx");
      expect(out).not.toBe(terminated);
      expect(out).not.toContain("// c");
      expect(out).toContain("trackerco");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * `parseDiagnostics` is present at runtime but stripped from
   * TypeScript's published type declarations, so the precondition above
   * reads it through a cast. That makes it exactly the kind of dependency
   * that can rot silently: a rename, and the cast yields `undefined`, the
   * gate never fires, and the medium above comes back with every other
   * test still green.
   *
   * This asserts the field is really there, really an array, and really
   * non-empty for a known-bad source under the pinned TypeScript — so a
   * rename turns THIS red, pointing at the one line that needs changing.
   */
  it("GUARD: TypeScript still reports parseDiagnostics on a known-bad source", async () => {
    const ts = (await import("typescript")).default;
    const sourceFile = ts.createSourceFile(
      "broken.ts",
      "const a = (((;",
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown })
      .parseDiagnostics;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect((diagnostics as unknown[]).length).toBeGreaterThan(0);
  });

  it("GUARD: ...and reports none on a well-formed source", () => {
    // The other direction, so the guard above cannot pass on a field that
    // is simply always non-empty.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(stripComments("export const a = 1; // c\n", "fine.ts")).toBe(
        "export const a = 1;  \n",
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not mistake JSX text that merely looks like a comment for one", () => {
    const code = "export const X = <p>\n  // not a comment, just text with trackerco\n</p>;";
    expect(stripComments(code, "fixture.tsx")).toBe(code);
  });
});

describe("isTestFile", () => {
  it("excludes a *.test.ts(x)/*.spec.ts(x)/*.spec.css file", () => {
    expect(isTestFile("src/lib/legal/publishable.test.ts")).toBe(true);
    expect(isTestFile("src/components/gallery/gallery.focus.test.tsx")).toBe(true);
    expect(isTestFile("src/lib/design/no-raw-hex.spec.css")).toBe(true);
  });

  it("does NOT exclude src/lib/legal/legal-page.test-support.ts (ugcportal-qnq9.15 item 3)", () => {
    // Its own doc comment used to claim this file is excluded from this
    // scanner the same way vitest's own collection glob excludes it; it is
    // not — "test-support" has no `.test.`/`.spec.` segment for this regex
    // to match. Pins the comment, fixed in the same PR, to the predicate it
    // describes: whichever one changes without the other, this fails.
    expect(isTestFile("src/lib/legal/legal-page.test-support.ts")).toBe(false);
  });

  it("does NOT exclude the other *.test-support.* files in this repo either", () => {
    // Same shape, same reason — confirms item 3's finding is about this
    // regex in general, not a special case of the legal module.
    expect(isTestFile("src/components/gallery/gallery.test-support.tsx")).toBe(false);
    expect(isTestFile("src/components/consent/consent-test-support.tsx")).toBe(false);
  });
});
