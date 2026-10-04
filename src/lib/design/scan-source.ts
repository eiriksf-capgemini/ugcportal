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
 * Which dialect to parse a file as (ugcportal-ysub review round 1,
 * finding 1, CONFIRMED medium).
 *
 * Parsing everything as TSX was wrong, and wrong in a direction that is
 * easy to miss: `<` is the one character whose meaning TSX and TS
 * genuinely disagree about. In a `.ts` file, `const identity = <T>(x: T)
 * => x` is a generic arrow function and `const n = <number>value` is a
 * type assertion; read as TSX, both open a JSX element that never closes,
 * and from there every comment in the rest of the file sits inside what
 * the parser believes is JSX TEXT - where comments do not exist, so none
 * of them is stripped. Reproduced: with `// c1` and `// c2` after such a
 * line, both survived. That re-opens ugcportal-3wgp round 2's finding 9
 * (a comment merely DISCUSSING the vendor tripping the K6 grep) and
 * quietly degrades the hex and dual-meaning gates the same way.
 *
 * TS is the fallback for an unrecognised extension rather than TSX,
 * deliberately: TSX is the dialect that loses information, and a file
 * that really does contain JSX always carries one of the four extensions
 * named here. `.js`/`.mjs`/`.cjs` map to `ScriptKind.JS`, which already
 * implies TypeScript's JSX language variant, so a `.js` file with JSX in
 * it (which Next allows) still parses - and the TS-only `<T>()`/`<T>v`
 * ambiguity cannot arise there, because neither is valid JavaScript.
 *
 * The map is exported, and source-extensions.test.ts asserts it has an
 * entry for every extension in src/lib/source-extensions.mjs's list
 * (review round 3, finding 4) - so an extension added to the gate and the
 * lint rules cannot quietly fall through to the fallback here.
 */
export const SCRIPT_KIND_BY_EXTENSION: Readonly<Record<string, ts.ScriptKind>> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
};

export function scriptKindFor(fileName: string): ts.ScriptKind {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return SCRIPT_KIND_BY_EXTENSION[extension] ?? ts.ScriptKind.TS;
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
 *     module keeps `await` meaning `await`. The file kinds these scanners
 *     see that are NOT ES modules are the CommonJS ones - `.cjs`, and
 *     `.cts` if one is ever added - where a top-level `await` is a syntax
 *     error anyway, so there is no real CommonJS source this choice can
 *     misread, only invalid source it reads differently.
 *
 * Output shape is unchanged from every previous version, because callers
 * match patterns against it: each comment collapses to a single space, so
 * a token that abutted a comment never fuses with its neighbour, and
 * nothing else in the file moves. A line comment's own newline is NOT part
 * of its range, so line structure survives; a multi-line block comment
 * collapses to one space, same as before.
 *
 * `fileName` is REQUIRED, and is the real path of the file being scanned
 * (a plausible one, for a unit fixture). It is what picks the dialect -
 * see `scriptKindFor` - and there is deliberately no default: the dialect
 * that would have to be the default is the one that silently gets `.ts`
 * files wrong, so "forgot to pass it" must be a compile error rather than
 * a quiet mis-parse (ugcportal-ysub review round 1, finding 1).
 *
 * UNTERMINATED BLOCK COMMENT: returns `source` completely unstripped
 * (round 1, finding 2, CONFIRMED). A `/*` with no `*\/` after it runs to
 * end of file, so stripping it erases every remaining line - and a live
 * analytics host on one of those lines then vanished before the K6 grep
 * could see it, which is exactly the "following should never happen" this
 * bead's K3 names. Returning the source whole is the fail-CLOSED answer:
 * the output is then a strict superset of the correctly-stripped text, so
 * every marker a caller is hunting for is still present. The alternative
 * considered was throwing; returning unstripped is better here because
 * the gate still runs and still names the offending FILE in its own
 * failure message, where a throw aborts the whole scan with a stack trace
 * and no path. Real source cannot reach this state and still compile, so
 * the cost of the conservative answer is zero in practice.
 *
 * This is for JavaScript-family source only. CSS is not JavaScript - see
 * `stripCssComments` below, and no-raw-hex.test.ts, which is the one
 * caller that scans both.
 */
export function stripComments(source: string, fileName: string): string {
  /**
   * Both fail-closed exits (review round 2, and round 3 finding 7). Says
   * WHY at the point it happens, and hands the source back whole.
   *
   * Failing closed silently is its own trap: the gate that then fires
   * reports only "vendor name found in <file>", and the obvious reading of
   * that - when the only mention really is in a comment - is "false
   * positive, add it to the allowlist", which permanently exempts a file
   * for a reason nobody recorded. Naming the cause is what makes the right
   * fix the obvious one.
   *
   * Returning the source whole is the conservative answer: the output is
   * then a strict SUPERSET of the correctly-stripped text, so every marker
   * a caller is hunting for is still present. A throw would abort the
   * whole scan with a stack trace and no path; this leaves the gate
   * running and naming the offending file in its own failure message.
   */
  function scanUnstripped(cause: string): string {
    console.warn(`[scan-source] ${fileName}: ${cause}, scanned unstripped`);
    return source;
  }

  const ranges: ts.CommentRange[] = [];
  const seenPositions = new Set<number>();

  try {
    const sourceFile = ts.createSourceFile(
      fileName,
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
      // Parent pointers are not needed (round 3, finding 3): every
      // `getStart` call below passes `sourceFile` explicitly, which is
      // what `getStart` would otherwise walk up the parent chain to find.
      /* setParentNodes */ false,
      scriptKindFor(fileName),
    );

    /*
     * One scanner, re-pointed at each gap (round 3, finding 3). The walk
     * below is `ts.forEachChild`, which visits real NODES and skips bare
     * tokens - so a comment sitting in front of a `;`, a `}` or an `else`
     * is inside no node's range at all, and a node-only walk would miss
     * it. What IS true is that every string, template, regex literal and
     * JSX text in the file is a node, so the text BETWEEN two adjacent
     * node ranges can only ever be punctuation, keywords, identifiers and
     * trivia. Nothing in a gap can disguise itself as a comment, and that
     * is exactly what makes it safe to hand those gaps - and only those
     * gaps - to a plain scanner.
     */
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ false,
      ts.LanguageVariant.Standard,
    );

    const collectCommentsInGap = (gapStart: number, gapEnd: number): void => {
      if (gapEnd <= gapStart) return;
      scanner.setText(source, gapStart, gapEnd - gapStart);
      let token = scanner.scan();
      while (token !== ts.SyntaxKind.EndOfFileToken) {
        if (
          token === ts.SyntaxKind.SingleLineCommentTrivia ||
          token === ts.SyntaxKind.MultiLineCommentTrivia
        ) {
          const pos = scanner.getTokenStart();
          if (!seenPositions.has(pos)) {
            seenPositions.add(pos);
            ranges.push({ kind: token, pos, end: scanner.getTokenEnd() });
          }
        }
        token = scanner.scan();
      }
    };

    const visit = (node: ts.Node): void => {
      // A token's own text is never a gap. A string, template or regex
      // literal, and JSX TEXT, can each contain something a scanner would
      // read as a comment opener while it is really live content
      // (`<p>see //example.com/x</p>`) - descending into one is precisely
      // how a scanner comes to erase it.
      if (ts.isToken(node)) return;
      let cursor = node.getStart(sourceFile);
      ts.forEachChild(node, (child) => {
        collectCommentsInGap(cursor, child.getStart(sourceFile));
        visit(child);
        cursor = child.end;
      });
      collectCommentsInGap(cursor, node.end);
    };

    // The file's own leading trivia sits before `sourceFile.getStart()`,
    // so the walk - which starts there - cannot reach it.
    collectCommentsInGap(0, sourceFile.getStart(sourceFile));
    visit(sourceFile);
  } catch (cause) {
    /*
     * Round 3, finding 7 (verified): TypeScript's parser is recursive, and
     * roughly a thousand nested parentheses overflow the stack - a
     * `RangeError` that, uncaught, aborts the ENTIRE scan rather than
     * degrading one file. A gate that stops running is worse than a gate
     * that reads one file conservatively, so this takes the same
     * fail-closed path as an unterminated comment.
     */
    return scanUnstripped(
      `could not be parsed (${cause instanceof Error ? cause.name : "unknown error"})`,
    );
  }

  /*
   * Fail closed on an unterminated block comment (round 1, finding 2).
   * `indexOf` rather than "does the range's text end in `*\/`": the latter
   * calls `/*\/` terminated, since its last two characters ARE `*\/` even
   * though the scanner never found a closer after the opener. Asking the
   * question the scanner itself asks - is there a `*\/` anywhere after
   * `pos + 2` - has no such edge. It cannot false-positive either: a
   * genuinely terminated comment's own closer is at `end - 2`, which is
   * always at or after `pos + 2`.
   */
  for (const range of ranges) {
    if (
      range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      source.indexOf("*/", range.pos + 2) === -1
    ) {
      return scanUnstripped("unterminated block comment");
    }
  }

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
 * Duplicated, knowingly: src/lib/design/tokens.ts has the same regex as a
 * private `stripComments`. NOT consolidated - the two differ in what they
 * replace a comment WITH (that one erases it, this one leaves a space so
 * two tokens cannot fuse), and importing this module would pull `node:fs`
 * and the `typescript` devDependency into tokens.ts's graph for a
 * one-line regex. Change one, look at the other.
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
