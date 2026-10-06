/**
 * K2 (ugcportal-rw9j): "no raw hex values in components outside the tokens/
 * theme file". A grep-style CI check, run as a vitest test (so it is part of
 * `npm test`, already in CI's `quality` job) rather than a separate lint rule
 * - this repo's own ESLint config has no custom-rule mechanism set up, and a
 * plain source scan here does not need one.
 *
 * Scope: every .tsx and .css file under src/, which is where a component
 * could actually render a literal colour (in JSX, in a `style={}`, or in a
 * stylesheet) - EXCEPT:
 *
 *   - src/app/globals.css, the tokens/theme file itself. That is where every
 *     hex literal in this app's palette is meant to live (see its own
 *     "ONE THEME PER MODE" and petrol-palette comments).
 *   - src/lib/design/**, the colour-contrast engine (color.ts, contrast.ts,
 *     tokens.ts, usage.ts) and its tests. That code's whole job is parsing
 *     and reasoning about arbitrary hex/oklch strings as DATA - a hex literal
 *     there is a worked example or a test fixture, not a component choosing
 *     its own colour outside a token.
 *   - *.test.ts(x) elsewhere, for the same "fixture, not shipped UI" reason
 *     (confirmed empty today - this repo's components do not inline hex
 *     anywhere - but excluded on principle rather than happening to pass).
 *
 * .ts files outside src/lib/design are NOT excluded as a category: a future
 * hex literal smuggled into, say, an email template or OG-image generator
 * would still be a K2 violation and this still has to see it.
 *
 * The file walker and comment stripper are shared with dual-meaning-
 * usage.test.ts via scan-source.ts (ugcportal-rw9j review round 4) rather
 * than duplicated here a second time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  isTestFile,
  stripComments,
  stripCssComments,
  walkSourceFiles,
} from "./scan-source";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SCANNED_EXTENSIONS = /\.(tsx|ts|css)$/;

/**
 * Matches a CSS hex colour literal: #rgb, #rgba, #rrggbb or #rrggbbaa.
 *
 * `(?![0-9a-fA-F])`, not a trailing `\b` (round 5, code-review): `\b` fails
 * to match when the hex run is immediately followed by a non-hex WORD
 * character with no separator - verified, `"#14555fsolid".match(HEX_COLOR)`
 * and `"#14555fx".match(HEX_COLOR)` both returned `null` against the old
 * pattern, so a raw hex literal abutting another identifier with no
 * whitespace would ship undetected. The negative lookahead asks the
 * narrower, correct question - "is the next character also a valid hex
 * digit" - which still rejects a run that is really a prefix of a longer
 * one (`#1234567`, 7 digits, matches neither length) while no longer
 * rejecting a run followed by an unrelated word character.
 */
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/g;

/**
 * round 5: the bare HEX_COLOR regex false-positives on ordinary English
 * words that happen to be hex-safe after a `#` - verified: `#deface`,
 * `#decade`, `#cafe`, `#beef` all match. A digit-required filter was
 * considered and rejected: it would also silently stop catching a REAL
 * violation using a common all-letter shorthand (`#fff`, `#ccc`, `#eee`),
 * which this codebase has no fewer legitimate reasons to guard against than
 * any other hex literal - trading a narrow, undemonstrated false-positive
 * risk for a broader, real false-negative one is the wrong direction for a
 * gate whose job is exactly this.
 *
 * The concrete, demonstrated channel instead: a same-page anchor,
 * `href="#main-content"` (src/components/app-shell.tsx) today, where a
 * future slug-shaped id (`href="#cafe-section"`) would trip the regex and
 * is not a colour. Stripped the same way `stripComments` already neutralises
 * comments, rather than filtering matches after the fact, so the file's line
 * numbers/structure are otherwise untouched and a hex literal elsewhere on
 * the same line is still caught.
 *
 * Residual, stated rather than solved: a hex-shaped English word OUTSIDE an
 * href (a hashtag-style tag placeholder, say) is still a latent false
 * positive this does not close. No such channel exists in this codebase
 * today (confirmed: no hashtag-prefixed string literal anywhere in scanned
 * source) - full immunity needs real string-literal-aware parsing, which is
 * a disproportionate rewrite of a grep-style gate for a channel that does
 * not exist yet; fix it when it does.
 */
const HREF_FRAGMENT = /\bhref\s*=\s*(["'])#[^"'\n]*\1/g;

function stripHrefFragments(source: string): string {
  return source.replace(HREF_FRAGMENT, (match) => " ".repeat(match.length));
}

/**
 * ugcportal-ysub item 2, CONFIRMED medium: this gate scans `.css` as well
 * as `.tsx`/`.ts`, and a stylesheet is not JavaScript. Handing a `.css`
 * file to the JavaScript comment stripper made `background: url(https://
 * cdn.example/x.png)` — an ordinary UNQUOTED CSS url token, which has no
 * string quotes for a JS lexer to protect it with — read as a `//` line
 * comment and truncated, hiding any hex literal later on that same line
 * from this scan entirely.
 *
 * CSS gets `stripCssComments` (`/* *\/` only, the only comment syntax CSS
 * has); everything else gets the TypeScript-parser-backed `stripComments`.
 * Keyed on the file extension rather than on content sniffing, because the
 * walker already knows which extension it matched.
 */
function stripSourceComments(file: string, contents: string): string {
  return file.endsWith(".css") ? stripCssComments(contents) : stripComments(contents, file);
}

const EXCLUDED_FILES = new Set([path.join(SRC_ROOT, "app", "globals.css")]);
const DESIGN_LIB_DIR = path.join(SRC_ROOT, "lib", "design") + path.sep;

function isExcluded(file: string): boolean {
  if (EXCLUDED_FILES.has(file)) return true;
  if (file.startsWith(DESIGN_LIB_DIR)) return true;
  if (isTestFile(file)) return true;
  return false;
}

describe("HEX_COLOR", () => {
  it("matches a hex literal immediately followed by a non-hex word character", () => {
    expect("#14555fsolid".match(HEX_COLOR)).toEqual(["#14555f"]);
    expect("#14555fx".match(HEX_COLOR)).toEqual(["#14555f"]);
  });

  it("still rejects a run that is really a prefix of a longer one", () => {
    expect("#1234567".match(HEX_COLOR)).toBeNull();
  });
});

describe("stripHrefFragments", () => {
  it("blanks an href anchor so it cannot read as a hex colour", () => {
    const stripped = stripHrefFragments('<a href="#cafe-section">Jump</a>');
    expect(stripped).not.toContain("#cafe-section");
    expect(stripped.match(HEX_COLOR)).toBeNull();
  });

  it("leaves a real hex literal on an unrelated line untouched", () => {
    const stripped = stripHrefFragments(
      '<a href="#cafe-section">Jump</a>\nconst x = "#14555f";',
    );
    expect(stripped.match(HEX_COLOR)).toEqual(["#14555f"]);
  });

  it("does not touch a non-fragment href", () => {
    const stripped = stripHrefFragments('<a href="/gallery">Gallery</a>');
    expect(stripped).toContain('href="/gallery"');
  });
});

/**
 * ugcportal-ysub item 2 (CONFIRMED medium): the exact shape this gate was
 * blind to — an unquoted `url(https://...)` in a stylesheet, with a raw hex
 * literal after it on the same line. Driven through the same dispatch
 * function the real scan above uses, so a regression that routes `.css`
 * back through the JavaScript stripper fails here.
 */
describe("stripSourceComments (ugcportal-ysub item 2: CSS is not JavaScript)", () => {
  const CSS_WITH_URL =
    ".hero { background: url(https://cdn.example/bg.png) no-repeat; border: 1px solid #14555f; }";

  it("keeps an unquoted url(https://...) and the hex literal after it on the same line", () => {
    const stripped = stripSourceComments("/src/app/theme.css", CSS_WITH_URL);
    expect(stripped).toBe(CSS_WITH_URL);
    expect(stripped.match(HEX_COLOR)).toEqual(["#14555f"]);
  });

  it("still strips a real CSS block comment", () => {
    expect(
      stripSourceComments("/src/app/theme.css", ".a { /* #14555f was here */ color: red; }"),
    ).toBe(".a {   color: red; }");
  });

  it("MUTATION CHECK: routing the same CSS through the .ts path stops stripping comments at all", () => {
    // Fixture mutation, not a production-code change: the ONLY difference
    // is the file extension handed to the dispatcher, which is exactly the
    // defect (a .css file scanned by a JavaScript lexer).
    //
    // What goes wrong has changed shape since this check was written, and
    // the new shape is worth pinning: a stylesheet is not a parseable
    // program, so the JavaScript path reports diagnostics and takes its
    // fail-closed exit, handing the text back whole. Nothing is truncated
    // any more — but nothing is STRIPPED either, so a hex literal sitting
    // inside a CSS comment reads to this gate as a live one. A false
    // positive rather than the old false negative; still not CSS.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const commented = ".a { /* #14555f was here */ color: red; }";
      expect(stripSourceComments("/src/app/theme.ts", commented)).toContain("#14555f");
      expect(stripSourceComments("/src/app/theme.css", commented)).not.toContain("#14555f");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Memoised (round 5): "finds files to scan" and the real assertion below it
 * both need the file list, and the source tree does not change mid-run, so
 * walking it twice bought nothing but a second filesystem traversal.
 */
let cachedFiles: string[] | undefined;
function scannedFiles(): string[] {
  return (cachedFiles ??= walkSourceFiles(SRC_ROOT, isExcluded, SCANNED_EXTENSIONS));
}

// ugcportal-9faa: scannedFiles() above already memoizes the real-tree walk
// (`cachedFiles ??=`), so there is nothing redundant left to cache here —
// the remaining cost is reading and scanning every file's content for a raw
// hex literal, real work a busy machine can push past the 5s default on
// its own. Explicit timeout, not a bigger global default; see
// analytics-host.grep.test.ts and throttled-log.no-sibling-copy.test.ts for
// the same shape of fix and the measurements behind it.
describe("no raw hex colour literals outside the tokens file", { timeout: 15_000 }, () => {
  it("finds files to scan", () => {
    expect(scannedFiles().length).toBeGreaterThan(10);
  });

  it("ships no hex colour literal in a .tsx/.ts/.css file other than the tokens file", () => {
    const files = scannedFiles();

    const offenders: string[] = [];
    for (const file of files) {
      const source = stripHrefFragments(stripSourceComments(file, readFileSync(file, "utf8")));
      const matches = source.match(HEX_COLOR);
      if (matches) {
        const relative = path.relative(path.dirname(SRC_ROOT), file);
        offenders.push(`${relative}: ${matches.join(", ")}`);
      }
    }

    expect(
      offenders,
      "Raw hex colour literal(s) found outside src/app/globals.css. Every " +
        "colour in a component must resolve through a design token - add the " +
        "value to globals.css (or reuse an existing token) and reference it " +
        "via a Tailwind utility or var(), rather than writing the hex " +
        `directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
