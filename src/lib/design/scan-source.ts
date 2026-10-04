/**
 * Shared file-walking and comment-stripping for the two source-text scanners
 * this design system ships (ugcportal-rw9j review round 4): no-raw-hex.test.ts
 * (K2: no raw hex outside the tokens file) and dual-meaning-usage.test.ts
 * (an audited allowlist of the four tokens whose meaning this bead split).
 * Both used to carry their own near-identical copy of this; a third copy in
 * src/lib/design/usage.ts predates both and is NOT consolidated here - that
 * file has been through five separate review rounds finding five different
 * hand-curation gaps in its own walker/comment logic (see its header), and
 * folding a fresh module underneath it now risks reopening exactly that
 * class of bug in code this repo has already paid hard to get right. Two
 * genuinely new, this-bead copies sharing one implementation is the bounded
 * fix; touching usage.ts is not this bead's job.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

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
 * Strips `/* *\/` and `//` comments from TS/TSX/CSS source, honouring
 * string, template-literal, AND regex-literal boundaries.
 *
 * ugcportal-3wgp review round 3 (CONFIRMED medium, reproduced by the
 * reviewer): the previous version was a pair of regexes with no notion of
 * "inside a string" at all. Its line-comment half specifically excluded a
 * `//` immediately preceded by `:`, to avoid treating a URL's `://` as a
 * comment opener - but a PROTOCOL-RELATIVE URL (`"//stats.example/collect"`,
 * no scheme, no leading `:`) has nothing before its `//` for that lookbehind
 * to see, so the regex treated it as a real comment start and erased the
 * rest of the line - including a live, executed string literal, not a
 * comment at all. A vendor host reached only via such a URL would have been
 * invisible to analytics-host.grep.test.ts's K6 scan after this function ran
 * (confirmed: `src = "//stats.example/x?umami"` stripped to `src = "`).
 *
 * ugcportal-3wgp review round 4 (CONFIRMED medium, reproduced by the
 * reviewer): round 3's rewrite tracked string boundaries but had no concept
 * of a REGEX LITERAL. A quote character used literally inside one (not as
 * string syntax) desyncs the string tracker - e.g.
 * src/lib/request-body.ts's own `DISPOSITION_NAME = /;\s*name\s*=\s*"([^"]*)"/i`
 * has two `"` characters that are part of the regex's own pattern, not a
 * string boundary; the round-3 scanner read the first as a string OPENING
 * quote and started hunting for a close, landing on a `"` elsewhere in the
 * pattern instead of synchronising back up - from there, anything later in
 * the file is scanned with the wrong "am I inside a string" parity, which
 * can un-protect (or wrongly protect) real content arbitrarily far past
 * this point, "blinding the grep to anything after it in that file" per the
 * review's own framing.
 *
 * Regex literals are now tracked as a third kind of protected span, same
 * treatment as a string: copied through untouched, with its own `[...]`
 * character-class and `\`-escape handling (a literal `/` inside `[...]`
 * does not end the regex). The hard part is knowing a `/` is a regex
 * OPENING delimiter rather than a division operator - this is the same
 * "regex vs divide" ambiguity every real JS tokenizer resolves using the
 * PRECEDING token, not the character itself. `isDivisionContext` below
 * approximates that: a `/` is division if the last significant source
 * character is alphanumeric/`_`/`$`/`)`/`]`/`}`/a closing quote (the end
 * of a value, e.g. `a / b`, `(x) / 2`, `"s" / 1`, `{a:1} / 2` - the `}`
 * case added in review round 5, finding 1) UNLESS that trailing word is
 * itself a keyword that can only precede an expression (`return`,
 * `await` - round 5, finding 2 - `typeof`, `instanceof`, `in`, `of`,
 * `new`, `void`, `delete`, `yield`, `case`, `do`, `else`, `throw`,
 * `default` - real cases of exactly this shape exist in this repo today,
 * e.g. `return /value="([^"]*)"/.exec(...)` in decision-form.test.tsx,
 * and this file's own `isTestFile` below).
 * Checked empirically against every real division (`MAX_UPLOAD_BYTES / 10`,
 * `height / 2`, ...) and every real regex literal across the whole src/
 * tree via no-raw-hex.test.ts/dual-meaning-usage.test.ts/K6's own suites,
 * all passing unchanged.
 *
 * If the scan for a regex's closing `/` reaches a newline first (a real
 * regex literal can never contain a literal, unescaped line break) or
 * reaches EOF, that is this heuristic admitting it misread a division as a
 * regex start: it backs out and treats the opening `/` as an ordinary
 * character instead of consuming the rest of the file as "inside a regex" -
 * bounding a wrong guess to one character rather than corrupting
 * everything after it, the same failure mode this whole fix exists to
 * close.
 *
 * A nested template literal inside a `${...}` substitution
 * (`` `a${`b`}c` ``) is out of scope - this repo's own source never does
 * that, and the three real callers (no-raw-hex.test.ts,
 * dual-meaning-usage.test.ts, this bead's K6 grep) all only need "don't
 * mistake a URL, regex pattern, or other string/regex content for a
 * comment", not full lexical correctness.
 */
const REGEX_PERMITTING_KEYWORDS = new Set([
  "return",
  "await",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "void",
  "delete",
  "yield",
  "case",
  "do",
  "else",
  "throw",
  "default",
]);

export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  function skipString(quote: string): number {
    let j = i + 1;
    while (j < n && source[j] !== quote) {
      j += source[j] === "\\" ? 2 : 1;
    }
    return Math.min(j + 1, n);
  }

  /**
   * Returns the end index of a regex literal starting at `i` (pointing at
   * its opening `/`), or `null` if no valid closing `/` is found before a
   * newline or EOF - signalling "this `/` was not actually a regex start".
   */
  function tryRegexLiteralEnd(): number | null {
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== "\n") {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "[") {
        inClass = true;
        j += 1;
        continue;
      }
      if (c === "]") {
        inClass = false;
        j += 1;
        continue;
      }
      if (c === "/" && !inClass) {
        j += 1;
        while (j < n && /[a-zA-Z]/.test(source[j])) j += 1;
        return j;
      }
      j += 1;
    }
    return null;
  }

  /** Is the `/` at `i` a division operator (vs. a regex literal start)? */
  function isDivisionContext(): boolean {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    if (k < 0) return false; // start of file: regex allowed
    const c = out[k];
    if (/[A-Za-z0-9_$]/.test(c)) {
      let wordStart = k;
      while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(out[wordStart])) wordStart -= 1;
      const word = out.slice(wordStart + 1, k + 1);
      return !REGEX_PERMITTING_KEYWORDS.has(word);
    }
    // Round 5, finding 1: `}` was missing — a `/` right after a closing
    // brace that ends an object literal (`{a:1} / 2`) is division, not a
    // regex start. (A `}` that closes a BLOCK or function body instead,
    // immediately followed by a genuine new regex-literal STATEMENT, is a
    // real ambiguity no character-based heuristic can perfectly resolve
    // without full nesting context — out of scope here, same as the
    // file's own stated "not full lexical correctness" boundary. Checked
    // empirically: every real `}` immediately followed by `/` in this
    // repo's src/ tree today is either inside an already-protected
    // template literal or a JSX self-closing `/>` that the "no closing /
    // before a newline" fallback already handles safely either way.)
    return /[)\]}'"`]/.test(c);
  }

  while (i < n) {
    const ch = source[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(ch);
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      out += " ";
      i = close === -1 ? n : close + 2;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      out += " ";
      i = newline === -1 ? n : newline;
      continue;
    }

    if (ch === "/" && !isDivisionContext()) {
      const end = tryRegexLiteralEnd();
      if (end !== null) {
        out += source.slice(i, end);
        i = end;
        continue;
      }
      // Could not find a closing `/` before a newline/EOF: this was not a
      // regex literal after all (the heuristic guessed wrong) - fall
      // through and treat it as a single ordinary character instead of
      // guessing further.
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** True for a `*.test.ts(x)`/`*.spec.ts(x)` or `*.spec.css` file - not shipped UI, so not worth scanning. */
export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(tsx?|css)$/.test(file);
}
