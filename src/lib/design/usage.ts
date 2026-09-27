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
 *
 * That claim has been wrong twice before (round 2: `.ts` files not walked;
 * round 3: `bg-[var(--x)]/[.5]` fell between three unresolvable-shape
 * patterns). Both times the fix handled the reported case and left the next
 * one unenumerated. ugcportal-j4j's round found a third and fourth: a
 * side/offset-qualified utility (`border-t-border/50`, `ring-offset-ring/50`)
 * mis-resolved to a token that does not exist instead of the real one, and a
 * fractional alpha (`bg-primary/12.5`) matched no pattern at all and was
 * silently dropped.
 *
 * So rather than patch those two and stop, here is the syntax space this
 * module claims to cover, as two independent axes - which axis a given
 * utility sits on was checked by actually compiling a candidate for it
 * against Tailwind 4.3.3 (the version vendored in this repo) with
 * `@tailwindcss/postcss` and inspecting the output, not assumed from reading
 * the docs (see the ugcportal-j4j PR description for the compiled examples):
 *
 * Namespace (which CSS custom property it targets), one of:
 *   - a bare namespace: `bg`, `text`, `border`, `ring`, `inset-ring`,
 *     `outline`, `divide`, `fill`, `stroke`, `shadow`, `inset-shadow`,
 *     `accent`, `caret`, `decoration`, `from`, `via`, `to`.
 *   - a border logical/physical side, which is a colour utility in its own
 *     right (`border-top-color`, not "`border` at side `t`"): `border-t`,
 *     `border-r`, `border-b`, `border-l`, `border-s`, `border-e`, `border-x`,
 *     `border-y`. Confirmed compiling; `divide-x-<color>` and
 *     `outline-t-<color>` were tried against the same compiler and do NOT
 *     compile - Tailwind has no side-qualified colour for those namespaces,
 *     so they are deliberately not in this list and fall through to the bare
 *     `divide`/`outline` branch, where an unresolvable name is caught by the
 *     unknown-token check downstream rather than misread as a qualifier.
 *   - `ring-offset`, a distinct custom property (`--tw-ring-offset-color`)
 *     from `ring`, the same way `inset-ring` already was. Confirmed
 *     compiling.
 * Each namespace above the qualified pair shares a literal prefix with a
 * shorter one already in this list (`ring-offset` / `ring`,
 * `border-t` / `border`), so ordering inside COLOR_UTILITY_PREFIXES matters:
 * regex alternation matches the first alternative that fits at a position,
 * not the longest one, so the qualified form must be listed first or it is
 * never reached.
 *
 * Name form, one of:
 *   - a bare scale name (`primary`, `surface-2`), resolved to `--color-<name>`.
 *   - an arbitrary value that is a length, number or similar non-colour value
 *     such as `[0.8rem]` (deliberately excluded - `isNonColorArbitraryValue`).
 *   - an arbitrary value that IS a colour, such as `[#fff]` or `[var(--x)]`.
 *     This gate has no token to measure it against - an arbitrary value is
 *     definitionally not one of the declared design tokens - so it always
 *     refuses with advice rather than resolving, the same as an unresolvable
 *     alpha does.
 *
 * Alpha form, one of:
 *   - an integer percentage (`/50`).
 *   - a fractional percentage (`/12.5`) - confirmed compiling; Tailwind
 *     requires at least one leading digit, so `/.5` alone does not compile
 *     and this module does not need to parse it.
 *   - an arbitrary value in brackets (`/[.5]`), refused with advice.
 *   - an interpolation (`` /${alpha} ``), refused with advice.
 *
 * Every (namespace x name-form x alpha-form) cell either resolves to a
 * (token, alpha) pair, is excluded by name with a stated reason, or throws
 * with advice - never silently drops the utility. usage.test.ts pins a
 * representative case of every row of this matrix (not the full cross
 * product, which multiplies out to hundreds of cases for no more coverage of
 * the *logic*), so a change that stops handling one is a red test, not a
 * quiet regression.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tailwind utility namespaces that take a colour and therefore an alpha
 * modifier. Anything outside this list (`opacity-50`, `w-1/2`) is not a colour
 * and is not this gate's business.
 *
 * Order matters here in a way it would not for a list of literal strings
 * tried in parallel: this feeds a regex alternation, which matches the first
 * alternative that fits at a position, not the longest. `border-t`,
 * `ring-offset` and the rest of the compound entries share a literal prefix
 * with a shorter entry later in this list (`border`, `ring`), so a compound
 * entry must be listed before the shorter one it starts with, or the shorter
 * one always wins and swallows the qualifier as part of the name
 * (ugcportal-j4j finding 1: `border-t-border/50` resolved to the nonexistent
 * `--color-t-border` instead of `--color-border`, because bare `border`
 * matched first and the qualifier `t-` was read as part of the colour name).
 */
const COLOR_UTILITY_PREFIXES = [
  // Border side/logical colour qualifiers. Each is a real, distinct property
  // (`border-top-color`, `border-inline-start-color`, ...), confirmed
  // compiling against Tailwind 4.3.3. `divide` and `outline` were checked
  // against the same compiler and have no side-qualified colour form, so they
  // are deliberately not given entries here - see the module header.
  "border-t",
  "border-r",
  "border-b",
  "border-l",
  "border-s",
  "border-e",
  "border-x",
  "border-y",
  // A distinct custom property (`--tw-ring-offset-color`) from `ring`, the
  // same way `inset-ring` already is below. Confirmed compiling.
  "ring-offset",
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

/**
 * Which half of a pairing a namespace produces. `bg-primary/80` is a surface
 * that text will sit ON; `ring-ring/80` is a mark drawn OVER one. Round 3 of
 * review: without this distinction the coverage check only asked "is this
 * colour measured at this alpha anywhere", and --ring and --primary resolve
 * to the same literal — so a `bg-primary/80` text background read as already
 * covered by the --ring/80 focus-ring pairing, which is checked at 3:1.
 * Reproduced before fixing: the suite stayed green with muted text on that
 * fill at 1.71:1.
 *
 * `ring-offset` is included too: `--tw-ring-offset-color` is the colour
 * exposed in the gap between an element and its focus ring, i.e. the surface
 * a ring is drawn OVER, the same relationship `bg` has to text.
 */
const BACKGROUND_PREFIXES = new Set(["bg", "from", "via", "to", "ring-offset"]);

const PREFIX_ALTERNATION = COLOR_UTILITY_PREFIXES.join("|");

// A utility may carry any number of variant prefixes (`focus-visible:`,
// `aria-invalid:`, `dark:hover:`), so match on the boundary before it.
const BOUNDARY = String.raw`(?:^|[\s"'\`:\[(])`;

/**
 * One pattern for the whole space, rather than a resolvable pattern plus a
 * list of unresolvable ones.
 *
 * That split is what let `bg-[var(--x)]/[.5]` through in round 2: an
 * arbitrary colour *and* an arbitrary alpha matched neither the numeric
 * pattern (its name is not a bare word) nor the arbitrary-alpha pattern (same
 * reason) nor the arbitrary-colour pattern (which required a numeric alpha).
 * Three patterns, three near-misses, silently skipped — in a file whose header
 * promises it never just skips.
 *
 * A Tailwind alpha modifier is exactly one of three things: a number (integer
 * or fractional - `/50`, `/12.5`; Tailwind requires at least one leading
 * digit, `/.5` alone does not compile, see the module header), an arbitrary
 * value in brackets, or an interpolation. Enumerating all three against both
 * name forms means a colour utility carrying an alpha cannot miss. Anything
 * whose modifier is none of those (`bg-linear-to-r/oklch`, the gradient
 * interpolation keyword) is not an alpha at all, and is correctly not
 * matched.
 *
 * ugcportal-j4j finding 3: the numeric branch used to be `\d{1,3}`, an
 * integer only. `bg-primary/12.5` matched none of the three alternatives -
 * not an integer, not bracketed, not an interpolation - and was silently
 * dropped, the exact "never just skips" contract this module claims to hold.
 */
const ALPHA_UTILITY = new RegExp(
  String.raw`${BOUNDARY}(${PREFIX_ALTERNATION})-(\[[^\]]*\]|[a-z0-9][a-z0-9-]*)\/(\$\{|\[[^\]]*\]|\d+(?:\.\d+)?(?![\w.-]))`,
  "g",
);

/**
 * An arbitrary value that is a length or a bare number, so not a colour.
 *
 * `text-[0.8rem]/5` is a font size with a line height, and button.tsx already
 * ships `text-[0.8rem]`. Treating it as a colour made the suite hard-fail with
 * advice about PAIRINGS, one character away from code already in the repo.
 * Tailwind's own `length:`/`number:`/`percentage:` hints are honoured too.
 */
function isNonColorArbitraryValue(value: string): boolean {
  const inner = value.slice(1, -1).trim();
  if (/^(length|number|percentage|integer|angle|ratio):/.test(inner)) return true;
  if (/^(color|image|url):/.test(inner)) return false;
  return /^-?[\d.]+([a-z%]*)$/.test(inner);
}

export type AlphaUtilityUsage = {
  /** Path relative to the scanned root's parent, for error messages. */
  file: string;
  /** The utility as written, e.g. `ring-ring/80`. */
  utility: string;
  /** The custom property it reads, e.g. `--color-ring`. */
  property: string;
  /**
   * The Tailwind modifier as a percentage, e.g. 80, or 12.5 for a fractional
   * alpha (ugcportal-j4j finding 3). Not necessarily an integer.
   */
  alphaPercent: number;
  /** Whether the colour is painted behind content or over it. */
  role: "background" | "foreground";
  /**
   * The matched namespace exactly as it appears in COLOR_UTILITY_PREFIXES,
   * e.g. `text`, `border-t`, `ring-offset`. Exposed so a consumer that cares
   * about more than background/foreground - the contrast gate's threshold
   * check, which `text` and `ring` hold to different bars - can tell them
   * apart without re-deriving it from `utility`.
   */
  prefix: string;
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

    ALPHA_UTILITY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ALPHA_UTILITY.exec(source)) !== null) {
      // The boundary character is consumed, so step back one or two adjacent
      // utilities hide each other.
      ALPHA_UTILITY.lastIndex -= 1;

      const [, prefix, name, modifier] = match;
      const written = `${prefix}-${name}/${modifier}`;

      // 1. Is this a colour at all? Two namespaces are overloaded, and an
      //    arbitrary value may be a length rather than a colour.
      if (name.startsWith("[")) {
        if (isNonColorArbitraryValue(name)) continue;
        fail(
          `${relative}: "${written}..." applies an alpha to an arbitrary colour ` +
            `value. Use a design token so the gate can resolve and measure it.`,
        );
      }
      if (isNonColorScaleName(prefix, name)) continue;

      // 2. It is a colour. Can the alpha be resolved to a number?
      if (modifier.startsWith("${")) {
        fail(
          `${relative}: "${written}" interpolates its alpha modifier. The contrast ` +
            `gate cannot know what it resolves to, so write the alpha literally ` +
            `and add the pairing to PAIRINGS.`,
        );
      }
      if (modifier.startsWith("[")) {
        fail(
          `${relative}: "${written}" uses an arbitrary alpha modifier. The contrast ` +
            `gate can only measure a numeric one, so write e.g. /40 rather than ` +
            `/[.4] and add the pairing to PAIRINGS.`,
        );
      }

      const alphaPercent = Number(modifier);
      if (alphaPercent > 100) {
        fail(`${relative}: alpha modifier above 100 in "${written}"`);
      }
      found.push({
        file: relative,
        utility: written,
        property: `--color-${name}`,
        alphaPercent,
        role: BACKGROUND_PREFIXES.has(prefix) ? "background" : "foreground",
        prefix,
      });
    }
  }
  return found;
}
