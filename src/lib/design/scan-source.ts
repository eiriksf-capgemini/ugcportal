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
import { readdirSync, statSync } from "node:fs";
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
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out, isExcluded, extensions);
      continue;
    }
    if (full.includes(`${path.sep}generated${path.sep}`)) continue;
    if (extensions.test(entry) && !isExcluded(full)) out.push(full);
  }
}

/**
 * Strips `/* *\/` and `//` line comments from TS/TSX/CSS source.
 *
 * The line-comment half uses a negative lookbehind for `:` rather than
 * usage.ts's `(^|[^:\w])` class-name boundary (ugcportal-rw9j review round
 * 1): that boundary also excludes any `//` immediately after a word
 * character with no separating space - `5//#abc123` left a genuine comment
 * un-stripped and reported a false-positive "raw hex" finding. The
 * lookbehind only has to avoid treating a URL's `://` as a comment opener;
 * neither caller of this function has class names to bound the way usage.ts
 * does.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<!:)\/\/[^\n]*/g, " ");
}

/** True for a `*.test.ts(x)`/`*.spec.ts(x)` or `*.spec.css` file - not shipped UI, so not worth scanning. */
export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(tsx?|css)$/.test(file);
}
