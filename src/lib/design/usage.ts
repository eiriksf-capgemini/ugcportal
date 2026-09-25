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
 *
 * The rule this file tries to hold to, after round 2 of review found two more
 * holes in it: a scanner that silently sees nothing is worse than no scanner,
 * because the gate above it reports coverage it does not have. So every shape
 * it cannot resolve to a (token, alpha) pair is either *deliberately* excluded
 * with a reason (Tailwind's non-colour `text-sm/6` shorthands) or made to
 * throw with advice (interpolated alphas, arbitrary alphas, arbitrary colour
 * values). It never just skips.
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

/**
 * Two of those namespaces are overloaded, and their non-colour forms take a
 * slash modifier that has nothing to do with alpha:
 *
 *   text-sm/6      font-size 0.875rem with line-height 1.5rem
 *   shadow-lg/20   shadow size lg at 20% shadow-colour opacity
 *
 * `text-sm/6` is ordinary, idiomatic Tailwind, and ugcportal-71y and
 * ugcportal-n3c will write it. Before this list existed it parsed as the
 * colour `sm` at 6% alpha and failed the suite with "unknown token
 * --color-sm", in a file the author had not touched. These are the complete
 * scale names for both namespaces, so anything else under `text-`/`shadow-`
 * is still treated as a colour and still checked.
 */
const NON_COLOR_SCALE_NAMES: Record<string, readonly string[]> = {
  text: [
    "xs",
    "sm",
    "base",
    "lg",
    "xl",
    "2xl",
    "3xl",
    "4xl",
    "5xl",
    "6xl",
    "7xl",
    "8xl",
    "9xl",
  ],
  shadow: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "none", "inner"],
  "inset-shadow": ["2xs", "xs", "sm", "none"],
};

const PREFIX_ALTERNATION = COLOR_UTILITY_PREFIXES.join("|");

// A utility may carry any number of variant prefixes (`focus-visible:`,
// `aria-invalid:`, `dark:hover:`), so match on the boundary before it.
const BOUNDARY = String.raw`(?:^|[\s"'\`:\[(])`;

const NUMERIC_ALPHA = new RegExp(
  String.raw`${BOUNDARY}(${PREFIX_ALTERNATION})-([a-z0-9][a-z0-9-]*)\/(\d{1,3})(?![\w./-])`,
  "g",
);

/**
 * Shapes that are colour utilities but that this scanner cannot turn into a
 * (token, alpha) pair. Each throws with advice rather than being skipped,
 * because skipping is how a colour ships unmeasured.
 */
const UNRESOLVABLE = [
  {
    // `bg-destructive/[.08]` - a valid Tailwind alpha, not a number here.
    pattern: new RegExp(
      String.raw`${BOUNDARY}(${PREFIX_ALTERNATION})-([a-z0-9][a-z0-9-]*)\/\[`,
      "g",
    ),
    advice:
      "uses an arbitrary alpha modifier. The contrast gate can only measure a " +
      "numeric one, so write e.g. /40 rather than /[.4] and add the pairing to PAIRINGS",
    ignoreNonColorScale: true,
  },
  {
    // `ring-ring/${alpha}` - the alpha is not knowable from the source.
    pattern: new RegExp(
      String.raw`${BOUNDARY}(${PREFIX_ALTERNATION})-([a-z0-9][a-z0-9-]*)\/\$\{`,
      "g",
    ),
    advice:
      "interpolates its alpha modifier. The contrast gate cannot know what it " +
      "resolves to, so write the alpha literally and add the pairing to PAIRINGS",
    ignoreNonColorScale: true,
  },
  {
    // `bg-[var(--ring)]/50`, `bg-[oklch(...)]/50` - an arbitrary colour value
    // carrying an alpha. Slips past NUMERIC_ALPHA entirely, since the name is
    // not a bare word.
    pattern: new RegExp(
      String.raw`${BOUNDARY}(${PREFIX_ALTERNATION})-(\[[^\]]*\])\/\d`,
      "g",
    ),
    advice:
      "applies an alpha to an arbitrary colour value. Use a design token so the " +
      "gate can resolve and measure it",
    ignoreNonColorScale: false,
  },
] as const;

export type AlphaUtilityUsage = {
  /** Path relative to the scanned root's parent, for error messages. */
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

function isNonColorScaleName(prefix: string, name: string): boolean {
  return NON_COLOR_SCALE_NAMES[prefix]?.includes(name) ?? false;
}

/**
 * Removes comments so prose about a utility is not mistaken for a use of it.
 * These files are TS/TSX and CSS; neither has a string syntax that survives
 * this in a way that matters to a class-name scan.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\w])\/\/[^\n]*/g, "$1 ");
}

/**
 * Every extension that can hold a class name.
 *
 * Round 2 of review: this used to be .tsx/.jsx/.css only, so moving
 * `buttonVariants` into a plain .ts file - an ordinary cva split, and the
 * obvious next refactor - would have silently dropped three of the four
 * measured alphas, while `outline-ring/80` in globals.css kept the
 * focus-ring test green on its own.
 */
const SCANNED_EXTENSIONS = /\.(tsx?|jsx?|mts|cts|mjs|cjs|css)$/;

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
    if (SCANNED_EXTENSIONS.test(entry)) out.push(full);
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

    for (const { pattern, advice, ignoreNonColorScale } of UNRESOLVABLE) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        pattern.lastIndex -= 1;
        const [, prefix, name] = match;
        // `text-sm/[1.6]` is a font-size with an arbitrary line-height, not a
        // colour with an arbitrary alpha. Advising the author about PAIRINGS
        // there would be nonsense, so skip it the same way the numeric scan
        // does - and keep looking, because a real offender may follow.
        if (ignoreNonColorScale && isNonColorScaleName(prefix, name)) continue;
        fail(`${relative}: "${prefix}-${name}/..." ${advice}.`);
      }
    }

    NUMERIC_ALPHA.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUMERIC_ALPHA.exec(source)) !== null) {
      // Overlapping matches: the boundary character is consumed, so step back
      // one to keep two adjacent utilities from hiding each other.
      NUMERIC_ALPHA.lastIndex -= 1;

      const [, prefix, name, modifier] = match;
      if (isNonColorScaleName(prefix, name)) continue;

      const alphaPercent = Number(modifier);
      if (alphaPercent > 100) {
        fail(`${relative}: alpha modifier above 100 in "${prefix}-${name}/${modifier}"`);
      }
      found.push({
        file: relative,
        utility: `${prefix}-${name}/${modifier}`,
        property: `--color-${name}`,
        alphaPercent,
      });
    }
  }
  return found;
}
