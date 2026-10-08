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
import { readFileSync, readdirSync } from "node:fs";
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
 * that really does contain JSX always carries `.tsx`, `.jsx` or `.js`.
 * `.js`/`.mjs`/`.cjs` map to `ScriptKind.JS`, which already implies
 * TypeScript's JSX language variant, so a `.js` file with JSX in it
 * (which Next allows) still parses - and the TS-only `<T>()`/`<T>v`
 * ambiguity cannot arise there, because neither is valid JavaScript.
 * `.mts`/`.cts` map to plain TS: the flavour decides module resolution,
 * not syntax.
 *
 * The map is exported, and source-extensions.test.ts asserts it has an
 * entry for every extension in src/lib/source-extensions.mjs's list
 * (review round 3, finding 4) - so an extension added to the gate and the
 * lint rules cannot quietly fall through to the fallback here.
 */
/**
 * TypeScript's `'*\/' expected.` - an unterminated block comment. Named so
 * the fail-closed path can say which cause it hit; see `stripComments`.
 */
const UNTERMINATED_BLOCK_COMMENT = 1010;

export const SCRIPT_KIND_BY_EXTENSION: Readonly<Record<string, ts.ScriptKind>> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  // TypeScript's own module-flavoured extensions. Same dialect as `.ts`:
  // the flavour decides module resolution, not syntax. Neither can carry
  // JSX, because TypeScript defines no JSX variant for them - there is no
  // `.mtsx`/`.ctsx`, so JSX in an ESM- or CJS-flavoured TypeScript file
  // has to live in a plain `.tsx`.
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
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
 * Read one file and parse it, in the dialect `scriptKindFor` picks for it.
 *
 * WHY IT LIVES HERE. Every AST-based scanner in this repo opens with the
 * same five lines, and the two arguments that matter are the script kind and
 * `setParentNodes`. Getting the kind wrong parses a `.tsx` file as `.ts` and
 * reports nothing for every JSX file in the tree; omitting `setParentNodes`
 * makes a caller's `node.parent` check throw. Since this is exactly the
 * composition of `scriptKindFor` with a file read, it belongs beside it
 * rather than being copied per scanner - the same consolidation argument
 * `walkSourceFiles` and `stripComments` above are the result of.
 *
 * `setParentNodes` is ON for every caller rather than a parameter. The
 * callers that do not need `node.parent` pay a parse cost they would not
 * otherwise; a caller that needs it and does not get it is broken in a way
 * that only shows up at runtime, which is the worse of the two.
 */
export function sourceFileOf(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file),
  );
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
 * How it works: parse the source, check the parse was clean (see THE
 * PRECONDITION below - it is load-bearing, not a formality), then walk the
 * tree with `ts.forEachChild` and scan the GAPS between adjacent node
 * ranges for comments.
 *
 * Why the gaps, and why a plain scanner is safe in them: `forEachChild`
 * visits real NODES and skips bare tokens, so a comment in front of a
 * `;`, a `}` or an `else` is inside no node's range at all and a
 * node-only walk would miss it. The gaps are where those comments live.
 * And every string, template, regex literal and JSX text in a cleanly
 * parsed file IS a node, so the text between two adjacent node ranges can
 * only be punctuation, keywords, identifiers and trivia - nothing there
 * can disguise itself as a comment. That is the whole invariant, and it is
 * why the gap scan does not need to re-derive "am I inside a string".
 *
 * `visit` returning early on `ts.isToken(node)` is the other half of it.
 * A token's own text must never be scanned as a gap: a string, template
 * or regex literal, and JSX TEXT, can each contain something a scanner
 * reads as a comment opener while it is really live content
 * (`<p>see //example.com/x</p>`, `"https://stats.example/x"`). Descending
 * into one is precisely how a scanner comes to erase it - which is what
 * four earlier hand-written versions of this function did, one case at a
 * time.
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
 * TWO FAIL-CLOSED EXITS, both taking the same path - warn naming the
 * file and the cause, return `source` completely unstripped:
 *
 *   - the parse reported ANY diagnostic (round 4, CONFIRMED medium), which
 *     includes an unterminated block comment (round 1, finding 2) as
 *     TypeScript's code 1010. See THE PRECONDITION in the body for why
 *     this has to be all diagnostics rather than a chosen subset.
 *   - the parse or walk THREW (round 3, finding 7): roughly a thousand
 *     nested parentheses overflow TypeScript's recursive parser, and an
 *     uncaught `RangeError` aborts the entire scan rather than degrading
 *     one file.
 *
 * Returning the source whole is the conservative answer: the output is
 * then a strict superset of the correctly-stripped text, so every marker
 * a caller is hunting for is still present. Throwing was considered and
 * rejected - the gate still runs this way, and still names the offending
 * FILE in its own failure message, where a throw aborts the scan with a
 * stack trace and no path. Real source cannot reach any of these states
 * and still compile, which is asserted directly: every JS-family file
 * under src/ is checked to parse cleanly, so this path is never taken on
 * real source and cannot decay into background noise.
 *
 * This is for JavaScript-family source only. CSS is not JavaScript - see
 * `stripCssComments` below, and no-raw-hex.test.ts, which is the one
 * caller that scans both.
 */
export function stripComments(source: string, fileName: string): string {
  /**
   * Both fail-closed exits route through here (see the two bullets in
   * this function's doc comment: a parse diagnostic, which includes an
   * unterminated block comment, and a thrown parse). Says WHY at the
   * point it happens, and hands the source back whole.
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
      ts.ScriptTarget.Latest,
      // Parent pointers are not needed (round 3, finding 3): every
      // `getStart` call below passes `sourceFile` explicitly, which is
      // what `getStart` would otherwise walk up the parent chain to find.
      /* setParentNodes */ false,
      scriptKindFor(fileName),
    );

    /*
     * THE PRECONDITION (round 4, CONFIRMED medium). Everything below
     * depends on node ranges covering every literal in the file, and that
     * is only true of source TypeScript parsed without complaint. When the
     * parser ERROR-RECOVERS, it skips tokens, and a gap can then begin
     * INSIDE a string literal - at which point the gap scanner, which is
     * deliberately a plain scanner, reads the `//` of a perfectly ordinary
     * `https://` URL as a line comment and deletes live source.
     *
     * Reproduced in every dialect: a file whose first line is `<R a="` -
     * one unterminated attribute string - made the line after it, a live
     * `export const trackingSrc = "https://stats.example/x?umami"`, come
     * back as `export const trackingSrc = "https: ` with no warning at
     * all. Planted as a real file under src/, the K6 grep stayed green.
     *
     * So: if the parse was not clean, do not reason about it. This is the
     * same fail-closed exit as an unterminated comment and a thrown parse,
     * and it is deliberately ALL diagnostics rather than the subset that
     * looks dangerous - working out which error recoveries happen to keep
     * literals inside nodes is exactly the case-by-case lexical reasoning
     * this whole function exists to stop doing.
     *
     * `parseDiagnostics` is present at runtime but stripped from the
     * published type declarations, hence the cast; scan-source.test.ts
     * asserts a known-bad source really does produce a non-empty array
     * under the pinned TypeScript, so a rename turns that test red rather
     * than silently disabling this gate. It is also asserted to be EMPTY
     * for every JS-family file under src/ today, so the conservative path
     * is never taken on real source and cannot become background noise.
     */
    const parseDiagnostics = (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }).parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      /*
       * An unterminated block comment (round 1, finding 2) is a parse
       * diagnostic like any other - TypeScript reports it as 1010, `'*\/'
       * expected` - so it arrives here rather than needing its own check
       * after the walk. Named separately anyway, because it is by far the
       * likeliest real cause and "close the comment" is a much more useful
       * thing to read than "did not parse cleanly".
       */
      const unterminatedComment = parseDiagnostics.some(
        (diagnostic) => diagnostic.code === UNTERMINATED_BLOCK_COMMENT,
      );
      return scanUnstripped(
        unterminatedComment ? "unterminated block comment" : "did not parse cleanly",
      );
    }

    /*
     * One scanner, re-pointed at each gap (round 3, finding 3).
     *
     * Safe because of the precondition checked immediately above, and only
     * because of it: in a CLEANLY PARSED file every string, template,
     * regex literal and JSX text is a node, so a gap between two adjacent
     * node ranges holds nothing but punctuation, keywords, identifiers and
     * trivia, and nothing in it can disguise itself as a comment. Error
     * recovery breaks that - it skips tokens, so a gap can start inside a
     * string literal - which is why a file with any parse diagnostic never
     * reaches this code.
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
      // Load-bearing, not an optimisation: a token's own text must never
      // be scanned as a gap. See this function's doc comment.
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
