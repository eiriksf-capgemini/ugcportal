/**
 * Finds the alpha-modified colour utilities the components actually ship
 * (ugcportal-axu).
 *
 * The contrast gate can only measure pairings it has been told about. For an
 * opaque token that is fine, because the coverage tests derive the list from
 * the stylesheet. For a *translucent* one it is not: `ring-ring/80` and
 * `ring-ring/50` are different colours, the token list cannot tell them apart,
 * and nothing in globals.css records which alpha a component chose. So the
 * first push of this bead pinned exactly one alpha (`outline-ring/80`) with a
 * string literal in a test, and left `ring-ring/*`, `ring-destructive/*` and
 * `border-destructive/*` free to drift: dropping the focus ring to /50 would
 * have taken it to about 2.2:1 with the suite still green.
 *
 * This reads the alphas back out of the source instead, so the gate's coverage
 * follows the components rather than a hand-kept list.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tailwind utility namespaces that take a colour and therefore an alpha
 * modifier. Anything outside this list (`opacity-50`, `w-1/2`) is not a colour
 * and is not this gate's business.
 */
const COLOR_UTILITY_PREFIXES = [
  "bg",
  "text",
  "border",
  "ring",
  "inset-ring",
  "outline",
  "divide",
  "fill",
  "stroke",
  "shadow",
  "inset-shadow",
  "accent",
  "caret",
  "decoration",
  "from",
  "via",
  "to",
] as const;

const PREFIX_ALTERNATION = COLOR_UTILITY_PREFIXES.join("|");

// A utility may carry any number of variant prefixes (`focus-visible:`,
// `aria-invalid:`, `dark:hover:`), so match on the boundary before it.
const NUMERIC_ALPHA = new RegExp(
  String.raw`(?:^|[\s"'\`:\[(])(${PREFIX_ALTERNATION})-([a-z][a-z0-9-]*)\/(\d{1,3})(?![\w./-])`,
  "g",
);

// `bg-destructive/[.08]` and friends: a valid Tailwind alpha this scanner
// cannot turn into a number. Refused rather than skipped.
const ARBITRARY_ALPHA = new RegExp(
  String.raw`(?:^|[\s"'\`:\[(])(?:${PREFIX_ALTERNATION})-[a-z][a-z0-9-]*\/\[`,
);

export type AlphaUtilityUsage = {
  /** Path relative to the repo root, for error messages. */
  file: string;
  /** The utility as written, e.g. `ring-ring/80`. */
  utility: string;
  /** The custom property it reads, e.g. `--color-ring`. */
  property: string;
  /** The Tailwind modifier as an integer percentage, e.g. 80. */
  alphaPercent: number;
};

function fail(message: string): never {
  throw new Error(`[design/usage] ${message}`);
}

/**
 * Removes comments so prose about a utility is not mistaken for a use of it.
 * These files are TSX and CSS; neither has a string syntax that survives this
 * in a way that matters to a class-name scan.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\w])\/\/[^\n]*/g, "$1 ");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    // Tests describe behaviour; they do not render. Generated Prisma output
    // is not UI.
    if (/\.(test|spec)\./.test(entry)) continue;
    if (full.includes(`${path.sep}generated${path.sep}`)) continue;
    if (/\.(tsx|jsx|css)$/.test(entry)) out.push(full);
  }
}

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Every alpha-modified colour utility in the shipped source. */
export function findAlphaColorUtilities(
  root: string = SRC_ROOT,
): AlphaUtilityUsage[] {
  const files: string[] = [];
  walk(root, files);
  if (files.length === 0) fail(`no source files found under ${root}`);

  const found: AlphaUtilityUsage[] = [];
  for (const file of files) {
    const relative = path.relative(path.dirname(root), file);
    const source = stripComments(readFileSync(file, "utf8"));

    const arbitrary = ARBITRARY_ALPHA.exec(source);
    if (arbitrary) {
      fail(
        `${relative} uses an arbitrary alpha modifier (${arbitrary[0].trim()}...). ` +
          `The contrast gate can only measure a numeric one, so use e.g. /40 ` +
          `rather than /[.4] and add the pairing to PAIRINGS.`,
      );
    }

    NUMERIC_ALPHA.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUMERIC_ALPHA.exec(source)) !== null) {
      const alphaPercent = Number(match[3]);
      if (alphaPercent > 100) {
        fail(`${relative}: alpha modifier above 100 in "${match[1]}-${match[2]}/${match[3]}"`);
      }
      found.push({
        file: relative,
        utility: `${match[1]}-${match[2]}/${match[3]}`,
        property: `--color-${match[2]}`,
        alphaPercent,
      });
      // Overlapping matches: the boundary character is consumed, so step back
      // one to keep two adjacent utilities from hiding each other.
      NUMERIC_ALPHA.lastIndex -= 1;
    }
  }
  return found;
}
