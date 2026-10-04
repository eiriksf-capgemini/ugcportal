/**
 * Shared file-walking and comment-stripping for the source-text scanners
 * this repo ships (ugcportal-rw9j review round 4): no-raw-hex.test.ts
 * (K2: no raw hex outside the tokens file), dual-meaning-usage.test.ts
 * (an audited allowlist of the four tokens whose meaning that bead split),
 * analytics-host.grep.test.ts (ugcportal-3wgp K6: the vendor host name
 * appears nowhere outside the gated loader) and privacy/content.test.ts.
 * Each used to carry its own near-identical copy of this; a third copy in
 * src/lib/design/usage.ts predates them and is NOT consolidated here - that
 * file has been through five separate review rounds finding five different
 * hand-curation gaps in its own walker/comment logic (see its header), and
 * folding a fresh module underneath it now risks reopening exactly that
 * class of bug in code this repo has already paid hard to get right. Two
 * genuinely new, this-bead copies sharing one implementation is the bounded
 * fix; touching usage.ts is not this bead's job.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

/** Every .tsx/.ts file under `root`, honouring `isExcluded`. */
export function walkSourceFiles(
  root: string,
  isExcluded: (file: string) => boolean,
  extensions: RegExp = /\.(tsx|ts)$/,
): string[] {
  const out: string[] = [];
  walk(root, out, isExcluded, extensions);
  return out;
}

function walk(
  dir: string,
  out: string[],
  isExcluded: (file: string) => boolean,
  extensions: RegExp,
): void {
  /*
   * round 5: one readdirSync(dir, { withFileTypes: true }) instead of a
   * readdirSync(dir) plus a separate statSync(full) per entry - half the
   * syscalls per directory, same result, since nothing under src/ is a
   * symlinked directory (Dirent.isDirectory() does not follow symlinks the
   * way statSync does; confirmed none exist in this tree, and a real one
   * would need this reconsidered).
   */
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, isExcluded, extensions);
      continue;
    }
    if (full.includes(`${path.sep}generated${path.sep}`)) continue;
    if (extensions.test(entry.name) && !isExcluded(full)) out.push(full);
  }
}

/**
 * Strips `/* *\/` and `//` comments from TS/TSX/JS/JSX source, using
 * TypeScript's OWN parser rather than a hand-rolled lexer (ugcportal-ysub).
 *
 * History, because the shape of this function is the whole point. Four
 * successive hand-written versions of it shipped, and each one was found
 * by a later review round to be erasing live code:
 *
 *   - a pair of regexes with no notion of "inside a string": a
 *     protocol-relative URL (`"//stats.example/collect"`) read as a comment
 *     opener, erasing the rest of the line (round 3, CONFIRMED medium);
 *   - string-aware but regex-literal-unaware: a quote character used
 *     literally inside a regex pattern (the real
 *     `/;\s*name\s*=\s*"([^"]*)"/i` in src/lib/request-body.ts) desynced
 *     the string tracker, scanning everything after it with inverted
 *     "am I inside a string" parity (round 4, CONFIRMED medium);
 *   - regex-aware, with a character-based `isDivisionContext` heuristic for
 *     the regex-versus-division ambiguity: `}` missing from the
 *     division-permitting set (round 5), then `)` closing an `if`/`while`
 *     condition read as the end of a VALUE and so as division (ugcportal-
 *     ysub item 1, CONFIRMED medium - a regex with an odd number of quotes
 *     right after such a `)` desynced the tracker and erased the rest of
 *     the file from the K6 scan), `of / 2` read as a regex start because
 *     "of" is not actually a reserved word (item 4), `i++ / 2` likewise
 *     (item 5), and regex flags consumed greedily so `/foo/instanceof`
 *     swallowed the keyword and a following block comment (item 6).
 *
 * Every one of those is the SAME defect - a hand-written approximation of
 * JavaScript's lexical grammar, found wanting one case at a time - so the
 * fix is to stop approximating. `typescript` is already a devDependency,
 * and the only consumers of this function are tests; its parser resolves
 * regex-versus-division, keywords, postfix operators, template literals
 * (including nested substitutions), JSX text and flag sequences correctly
 * by construction, because that is its job.
 *
 * How it works: parse the source, then walk every LEAF token and take the
 * comment ranges sitting in the trivia gap between the end of the previous
 * token and the start of this one. Leading comment ranges alone are not
 * enough - TypeScript reports a comment on the same line as preceding code
 * as a TRAILING range (`getLeadingCommentRanges` only starts collecting
 * after a line break), so both are asked and the union taken.
 *
 * Two details that are load-bearing:
 *
 *   - Ranges are clipped to `[token.getFullStart(), token.getStart())`.
 *     JSX TEXT cannot contain comments - `<p>see //example.com/x</p>` is
 *     literal text - but the trivia scanner, asked to scan from inside it,
 *     would happily report one. TypeScript's own `getTokenPosOfNode` has
 *     the same special case for exactly this reason, which makes a JsxText
 *     token's trivia gap empty and the clip drop the false positive.
 *   - The file is parsed as a MODULE (`setExternalModuleIndicator`).
 *     Otherwise a top-level `await` in a file with no import/export is, by
 *     the real language rules, an ordinary identifier - so `await /re/` is
 *     division and the regex is not a regex. Parsing everything as a
 *     module keeps `await` meaning `await`. The one file kind these
 *     scanners see that is NOT an ES module is `.cjs`, where a top-level
 *     `await` is a syntax error anyway - so there is no real CommonJS
 *     source this choice can misread, only invalid source it reads
 *     differently.
 *
 * Output shape is unchanged from every previous version, because callers
 * match patterns against it: each comment collapses to a single space, so
 * a token that abutted a comment never fuses with its neighbour, and
 * nothing else in the file moves. A line comment's own newline is NOT part
 * of its range, so line structure survives; a multi-line block comment
 * collapses to one space, same as before.
 *
 * This is for JavaScript-family source only. CSS is not JavaScript - see
 * `stripCssComments` below, and no-raw-hex.test.ts, which is the one
 * caller that scans both.
 */
export function stripComments(source: string): string {
  const sourceFile = ts.createSourceFile(
    "scan-source-input.tsx",
    source,
    {
      languageVersion: ts.ScriptTarget.Latest,
      // Force module parsing; see this function's doc comment ("await").
      // `externalModuleIndicator` is the field TypeScript's own parser
      // reads to decide whether to reparse for top-level await; it exists
      // at runtime but is stripped from the published type declarations,
      // hence the cast. There is no public `ModuleDetectionKind.Force`
      // equivalent on `createSourceFile`. Guarded rather than trusted: if
      // a future TypeScript renames it, scan-source.test.ts's `await`
      // fixture goes red instead of the scanner quietly regressing.
      setExternalModuleIndicator: (file) => {
        (file as ts.SourceFile & { externalModuleIndicator?: ts.Node }).externalModuleIndicator =
          file;
      },
    },
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const ranges: ts.CommentRange[] = [];
  const seenPositions = new Set<number>();

  function collectCommentsInGap(gapStart: number, gapEnd: number): void {
    if (gapEnd <= gapStart) return;
    for (const found of [
      ts.getLeadingCommentRanges(source, gapStart),
      ts.getTrailingCommentRanges(source, gapStart),
    ]) {
      for (const range of found ?? []) {
        if (range.end > gapEnd) continue;
        if (seenPositions.has(range.pos)) continue;
        seenPositions.add(range.pos);
        ranges.push(range);
      }
    }
  }

  function visit(node: ts.Node): void {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      collectCommentsInGap(node.getFullStart(), node.getStart(sourceFile));
      return;
    }
    for (const child of children) visit(child);
  }

  visit(sourceFile);

  ranges.sort((a, b) => a.pos - b.pos);

  let out = "";
  let copiedUpTo = 0;
  for (const range of ranges) {
    out += source.slice(copiedUpTo, range.pos) + " ";
    copiedUpTo = range.end;
  }
  return out + source.slice(copiedUpTo);
}

/**
 * Strips CSS comments - `/* *\/` and nothing else (ugcportal-ysub item 2).
 *
 * CSS has no `//` line comment. Running the JavaScript stripper over a
 * stylesheet was a CONFIRMED medium regression: `background: url(
 * https://cdn.example/x.png)` is a perfectly ordinary UNQUOTED CSS url
 * token, and the JS lexer read its `//` as a comment opener and truncated
 * the line - hiding any hex literal after it from the K2 raw-hex gate. The
 * pre-PR-#92 implementation avoided this by accident, with a `(?<!:)`
 * lookbehind; that lookbehind was what the protocol-relative-URL finding
 * (round 3) removed, trading one bug for another. Neither is needed once
 * the CSS caller simply stops being handed a JavaScript lexer.
 *
 * Deliberately a plain regex, not a tokenizer: `/* *\/` is the only comment
 * syntax CSS has, it does not nest, and the only text that can contain a
 * literal `/*` without starting a comment is a quoted string
 * (`content: "/*"`), which no stylesheet in this repo contains. Stated
 * rather than solved, same as the hex gate's own documented residuals -
 * the failure mode is a few characters of a string being blanked, not a
 * desync that erases the rest of the file.
 */
export function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** True for a `*.test.ts(x)`/`*.spec.ts(x)` or `*.spec.css` file - not shipped UI, so not worth scanning. */
export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(tsx?|css)$/.test(file);
}
