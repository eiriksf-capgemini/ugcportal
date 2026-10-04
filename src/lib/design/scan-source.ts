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
 * string and template-literal boundaries.
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
 * This is a tiny single-pass scanner instead: it tracks whether the current
 * position is inside a `'`/`"`/`` ` `` string (honouring `\`-escapes) and
 * only treats `//`/`/* ` as comment openers OUTSIDE one. A nested template
 * literal inside a `${...}` substitution (`` `a${`b`}c` ``) is out of scope -
 * this repo's own source never does that, and the two real callers
 * (no-raw-hex.test.ts, dual-meaning-usage.test.ts) plus this bead's K6 grep
 * all only need "don't mistake a URL or any other string content for a
 * comment", not full lexical correctness.
 */
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

    out += ch;
    i += 1;
  }

  return out;
}

/** True for a `*.test.ts(x)`/`*.spec.ts(x)` or `*.spec.css` file - not shipped UI, so not worth scanning. */
export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(tsx?|css)$/.test(file);
}
