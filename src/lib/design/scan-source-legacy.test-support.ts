/**
 * The hand-rolled comment scanner that `scan-source.ts`'s `stripComments`
 * used before ugcportal-ysub replaced it with TypeScript's own parser,
 * preserved VERBATIM so every fixture in scan-source.test.ts can be shown
 * to fail against it (the bead's K1 requires exactly that: "each fixture
 * fails against the current scanner").
 *
 * This is test support, not shipped code and not a fallback - nothing
 * outside scan-source.test.ts may import it. It is kept as a separate
 * module rather than as a function copied inline into the test file
 * because the test file already carried two such inline copies (the
 * round-3 and round-5 implementations) and a third would have made the
 * "what shipped when" history unreadable.
 *
 * Do not fix bugs in here. Every defect listed in `stripComments`'s own
 * doc comment is present in this function on purpose; a fix would quietly
 * turn the fixtures that depend on it into assertions that cannot fail
 * (review-standards family 3).
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

export function legacyStripComments(source: string): string {
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

  function isDivisionContext(): boolean {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    if (k < 0) return false;
    const c = out[k];
    if (/[A-Za-z0-9_$]/.test(c)) {
      let wordStart = k;
      while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(out[wordStart])) wordStart -= 1;
      const word = out.slice(wordStart + 1, k + 1);
      return !REGEX_PERMITTING_KEYWORDS.has(word);
    }
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
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Round 5's shipped `stripComments`: regex-literal aware, but with `}`
 * missing from the division-permitting character class, so a `/` right
 * after an object literal's closing brace (`{a:1} / 2`) read as a REGEX
 * start and the real block comment after it survived unstripped.
 *
 * Moved here from scan-source.test.ts (review round 3, finding 5), which
 * carried two historical scanners inline beside the one already extracted
 * into this module. Same rule as `legacyStripComments` above: do not fix
 * the bugs in it, they are the whole point.
 */
export function round5StripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  function isDivisionContext(): boolean {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    if (k < 0) return false;
    const c = out[k];
    if (/[A-Za-z0-9_$]/.test(c)) return true;
    return /[)\]'"`]/.test(c); // `}` missing - the round-5 bug.
  }
  function tryRegexLiteralEnd(): number | null {
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== "\n") {
      const c = source[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "[") { inClass = true; j += 1; continue; }
      if (c === "]") { inClass = false; j += 1; continue; }
      if (c === "/" && !inClass) {
        j += 1;
        while (j < n && /[a-zA-Z]/.test(source[j])) j += 1;
        return j;
      }
      j += 1;
    }
    return null;
  }
  while (i < n) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      out += " ";
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "/" && !isDivisionContext()) {
      const end = tryRegexLiteralEnd();
      if (end !== null) {
        out += source.slice(i, end);
        i = end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Round 3's shipped `stripComments`: string-aware, with no concept of a
 * regex literal at all, so a quote character used inside a regex pattern
 * desynced the string tracker and every line after it was scanned with
 * inverted "am I inside a string" parity.
 *
 * Moved here from scan-source.test.ts (review round 3, finding 5). Do not
 * fix the bugs in it either.
 */
export function round3StripComments(input: string): string {
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
