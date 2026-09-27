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
 * That claim has been wrong five times now (round 2: `.ts` files not walked;
 * round 3: `bg-[var(--x)]/[.5]` fell between three unresolvable-shape
 * patterns; ugcportal-j4j round 1: a side/offset-qualified utility
 * mis-resolved to a token that does not exist, and a fractional alpha matched
 * no pattern; ugcportal-j4j round 2: `text-shadow-lg/20` - a real namespace
 * this module did not know about - hard-failed on ordinary Tailwind, and
 * `placeholder-primary/50` - another one - was silently skipped; ugcportal-j4j
 * round 3: `scrollbar-track` and every `mask-*-from`/`mask-*-to` - real
 * namespaces the same round-2 derivation had already found - were still
 * routed through a hand-written 5-entry background/foreground Set and came
 * out misclassified). Every round patched the reported cases and left the
 * next shape unenumerated, because first the namespace list, then the
 * background/foreground classification, was hand-curated: a person
 * recalling Tailwind's utility namespaces from memory, however carefully,
 * cannot be complete, because completeness is a property of the *installed
 * Tailwind version*, not of anyone's memory - and the lesson generalises to
 * any set in this file with that same property, not only the one most
 * recently named.
 *
 * So as of ugcportal-j4j round 2, the namespace list is not hand-curated at
 * all. `discoverColorNamespaces` below asks the actual installed Tailwind
 * (via `@tailwindcss/node`'s design-system API, loaded from this repo's own
 * globals.css) which utility namespaces accept a colour with an alpha
 * modifier, by checking which ones produce a real completion for a
 * guaranteed-present reference colour (`red-500`) that carries Tailwind's
 * alpha-modifier signature. Whatever Tailwind 4.3.3 (or whatever version is
 * installed when the suite runs) says exists, is what this module covers -
 * not a list someone wrote down once and Tailwind quietly grew past.
 *
 * The name-form axis has the same problem one level down: `text-shadow-lg`
 * and `shadow-lg` are non-colour presets sharing a namespace with a genuine
 * colour form (`text-shadow-primary`, `shadow-primary`), and which bare words
 * are presets rather than colours is exactly as unenumerable by hand as the
 * namespace list was. `isNonColorOverload` below asks the same installed
 * Tailwind to compile the candidate and checks whether the result actually
 * assigns a colour (`color-mix(` on a non-alpha declaration) - the real,
 * load-bearing difference between `--tw-text-shadow-alpha` (a preset's own
 * opacity, not a colour) and `--tw-text-shadow-color: color-mix(...)` (an
 * actual colour token). Derived, not curated, the same way.
 *
 * Background/foreground role (ugcportal-j4j round 3 finding 2) is the one
 * set in this space Tailwind genuinely has no opinion on - "which side of a
 * WCAG pairing does this namespace's colour play" is this codebase's own
 * modelling decision, not a structural fact - so it cannot be derived the
 * same way the two axes above are. `isBackgroundRole` below still avoids
 * memorising specific namespace names: it is expressed as rules over the
 * *shape* of whatever namespace `discoverColorNamespaces` returns (does it
 * end in `from`/`via`/`to`, `-track`, `-offset`), so a namespace matching one
 * of those shapes is covered automatically, including ones Tailwind adds
 * after this was written.
 *
 * The syntax space this module covers, as three independent axes:
 *
 * Namespace: whatever `discoverColorNamespaces` returns this run. Known
 * (2026-09-27, Tailwind 4.3.3) to include the bare namespaces (`bg`, `text`,
 * `border`, `ring`, `inset-ring`, `outline`, `divide`, `fill`, `stroke`,
 * `shadow`, `inset-shadow`, `accent`, `caret`, `decoration`, `from`, `via`,
 * `to`, `placeholder`, `drop-shadow`, `text-shadow`, `scrollbar-thumb`,
 * `scrollbar-track`), the border logical/physical sides (`border-t/r/b/l`,
 * `border-s/e`, `border-x/y`, and the block-logical `border-bs`/`border-be`),
 * `ring-offset`, and the mask gradient stops (`mask-t/r/b/l/x/y-from/to`,
 * `mask-linear-from/to`, `mask-radial-from/to`, `mask-conic-from/to`). This
 * list is what the derivation found, not what defines it - it will drift as
 * Tailwind does, and that is the point.
 *
 * Name form, one of:
 *   - a bare scale name (`primary`, `surface-2`), resolved to `--color-<name>`
 *     if `isNonColorOverload` says it mixes a colour, excluded if not.
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
 *     and this module does not need to parse it. Resolving it end to end
 *     also needed `contrast.ts`'s `parseTokenReference` and its coverage-key
 *     construction to stop assuming an integer (ugcportal-j4j round 2
 *     finding 3) - a fractional alpha that the scanner sees but nothing
 *     downstream can ever satisfy is not an improvement on skipping it.
 *   - an arbitrary value in brackets (`/[.5]`), refused with advice.
 *   - an interpolation (`` /${alpha} ``), refused with advice.
 *
 * Every (namespace x name-form x alpha-form) cell either resolves to a
 * (token, alpha) pair, is excluded with a derived reason, or throws with
 * advice - never silently drops the utility. usage.test.ts pins a
 * representative case of every row (not the full cross product, which
 * multiplies out to thousands of cases for no more coverage of the *logic*),
 * plus a structural test on `discoverColorNamespaces` itself, so a change
 * that stops handling a row is a red test, not a quiet regression.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import postcss from "postcss";

import { GLOBALS_CSS_PATH } from "./tokens";

/**
 * The slice of `@tailwindcss/node`'s (marked `__unstable__` by Tailwind
 * itself) design-system API this module actually uses. Typed locally rather
 * than importing the upstream type: the package's own shipped `.d.ts` has
 * broken internal references (`Cannot find module './intellisense'` etc.)
 * that only stay invisible because this repo's tsconfig sets
 * `skipLibCheck: true`. A local, minimal type is what this file actually
 * relies on, and does not depend on that upstream file being fixed.
 */
export type TailwindDesignSystem = {
  getClassList(): (readonly [string, { modifiers?: readonly string[] }])[];
  candidatesToCss(classes: string[]): (string | null)[];
};

/**
 * A colour Tailwind's default theme always ships, used purely as a probe: it
 * is never written by a component, only used to ask "does this namespace
 * accept a colour with an alpha modifier at all". Any real project colour
 * (`primary`, `border`, ...) would work too since the design system below is
 * loaded from this repo's own globals.css, but a built-in name means the
 * probe does not depend on this repo's token names staying the same.
 */
const PROBE_COLOR = "red-500";

/**
 * Tailwind's own answer to "which modifiers does this class accept" is a
 * generic per-namespace fact - it does not distinguish a genuine colour
 * completion from a same-namespace preset that also takes a percentage
 * modifier for an unrelated reason (`text-shadow-lg/50` is a preset at 50%
 * of its own opacity; `text-shadow-primary/50` is a colour at 50% alpha; both
 * report the identical modifier list). So this signature only proves a
 * *namespace* supports colour+alpha somewhere in it (true for both examples
 * above), never that one specific *name* within it is a colour. That
 * distinction needs `isNonColorOverload` below, which compiles the specific
 * candidate instead of reading namespace-level metadata.
 */
function hasAlphaModifierSignature(modifiers: readonly string[]): boolean {
  return modifiers.length > 5 && modifiers.every((m) => /^\d{1,3}$/.test(m));
}

/**
 * Every Tailwind utility namespace that accepts a colour and therefore an
 * alpha modifier, asked of the installed Tailwind rather than recalled from
 * memory (ugcportal-j4j round 2, findings 1 and 2: `text-shadow` and
 * `placeholder` are both real namespaces a hand-curated list had missed).
 *
 * For every class Tailwind's design system can produce, keeps the ones
 * ending in `-red-500` (PROBE_COLOR) whose available modifiers carry the
 * alpha-modifier signature, and strips the probe suffix - i.e. "does
 * `<candidate>-red-500` exist and take a `/50`-style modifier". `red-500` is
 * an unambiguous colour (never a preset keyword under any namespace), so a
 * match here is solid evidence the namespace itself supports colour+alpha,
 * with none of the preset-vs-colour ambiguity `isNonColorOverload` has to
 * resolve for a specific bare name.
 *
 * Sorted longest-first: this feeds a regex alternation, which matches the
 * first alternative that fits at a position, not the longest, so a compound
 * namespace (`ring-offset`, `border-t`) must be tried before a shorter one it
 * starts with (`ring`, `border`) or the shorter one wins and swallows the
 * qualifier as part of the colour name (ugcportal-j4j round 1 finding 1).
 * Sorting derives that ordering instead of relying on someone placing new
 * entries correctly by hand.
 */
export function discoverColorNamespaces(
  designSystem: TailwindDesignSystem,
): string[] {
  const suffix = `-${PROBE_COLOR}`;
  const namespaces: string[] = [];
  for (const [name, meta] of designSystem.getClassList()) {
    if (!name.endsWith(suffix)) continue;
    if (!hasAlphaModifierSignature(meta.modifiers ?? [])) continue;
    namespaces.push(name.slice(0, -suffix.length));
  }
  return namespaces.sort((a, b) => b.length - a.length);
}

/**
 * True if `${prefix}-${name}` is a real Tailwind utility whose modifier means
 * something other than colour alpha - a preset's own opacity
 * (`text-shadow-lg/50`, `shadow-lg/20`), a line-height (`text-sm/6`) - rather
 * than a colour this module should resolve and measure.
 *
 * Derived by compiling the actual candidate (at a fixed probe alpha; only
 * whether it compiles and what it sets matters, not the value) and looking
 * for a *declaration* - a specific property being assigned, not just a
 * substring anywhere in the output - that carries Tailwind's own
 * colour-compositing signature (`color-mix(`), on a property that is not
 * itself the alpha slot (anything ending `-alpha`, which every preset this
 * gate has found sets alongside its own hardcoded fallback colour, and which
 * would trivially "contain" whatever value it holds regardless of whether a
 * real colour is involved).
 *
 * ugcportal-j4j round 3 finding 3: the first version of this checked whether
 * `color-mix(` appeared anywhere in the whole compiled string, which is
 * right for every case actually compiled while building this (confirmed:
 * every genuine colour+alpha combination emits it, on every discovered
 * namespace, including keyword colours - `current`, `transparent`, `black`,
 * `white` - which a var()-only check would have missed), but is checking a
 * specific implementation detail of the current Tailwind minor version
 * rather than a structural fact. Scoping the check to an actual declaration,
 * excluding the alpha slot by name, is the closest available approximation
 * of "does this assign a colour" without a stable public API for it -
 * Tailwind's own `@property` registrations for these custom properties are
 * inconsistently typed (`syntax: "<color>"` only for a few namespaces,
 * `syntax: "*"` for most, including some that are genuinely colours), so
 * that path was tried and does not generalise either. usage.test.ts pins
 * this behaviour with a live sweep across every namespace `discoverColorNamespaces`
 * finds, specifically so that a future Tailwind version changing this
 * internal mechanism turns into a red test rather than a silent narrowing.
 *
 * Returns false - "treat it as an attempted colour" - when the candidate
 * does not compile at all. That is not this function's call to make: it
 * might be a genuinely undeclared token (a typo, or a colour someone forgot
 * to add to globals.css), and the existing "is this a design token" check in
 * contrast.test.ts already reports that case with better advice than this
 * function could. Silently excluding it here would be the exact mistake this
 * module's header spends so many words warning against.
 */
const nonColorOverloadCache = new Map<string, boolean>();
/** Exported for usage.test.ts's live sweep across every discovered namespace. */
export function isNonColorOverload(
  designSystem: TailwindDesignSystem,
  prefix: string,
  name: string,
): boolean {
  const key = `${prefix}-${name}`;
  const cached = nonColorOverloadCache.get(key);
  if (cached !== undefined) return cached;

  const [css] = designSystem.candidatesToCss([`${key}/50`]);
  let result: boolean;
  if (css === null) {
    result = false;
  } else {
    let sawColorAssignment = false;
    postcss.parse(css).walkDecls((decl) => {
      if (/-alpha$/i.test(decl.prop)) return;
      if (decl.value.includes("color-mix(")) sawColorAssignment = true;
    });
    result = !sawColorAssignment;
  }
  nonColorOverloadCache.set(key, result);
  return result;
}

/**
 * Loaded from this repo's own globals.css (not bare `tailwindcss`), so the
 * design system knows every project custom token (`primary`, `border`,
 * `surface-0`, ...) as well as Tailwind's built-in defaults - both matter:
 * `discoverColorNamespaces` only needs a Tailwind default (PROBE_COLOR) to
 * exist, but `isNonColorOverload` classifies whatever specific name a
 * component actually wrote, which is usually a project token.
 *
 * Top-level await rather than making `findAlphaColorUtilities` async: every
 * caller today (usage.test.ts, contrast.test.ts) uses it synchronously, and
 * loading the design system is a one-time, sub-200ms cost per test file, not
 * per call (`nonColorOverloadCache` above and the design system itself are
 * both module-scoped).
 *
 * Exported so usage.test.ts's structural checks on the derivation itself can
 * reuse this instance rather than loading a second copy.
 */
export const designSystem: TailwindDesignSystem = await __unstable__loadDesignSystem(
  `@import ${JSON.stringify(GLOBALS_CSS_PATH)};`,
  { base: path.dirname(GLOBALS_CSS_PATH) },
);

const COLOR_UTILITY_PREFIXES = discoverColorNamespaces(designSystem);

/**
 * Which half of a pairing a namespace produces. `bg-primary/80` is a surface
 * that text will sit ON; `ring-ring/80` is a mark drawn OVER one. Round 3 of
 * ugcportal-axu review: without this distinction the coverage check only
 * asked "is this colour measured at this alpha anywhere", and --ring and
 * --primary resolve to the same literal — so a `bg-primary/80` text
 * background read as already covered by the --ring/80 focus-ring pairing,
 * which is checked at 3:1. Reproduced before fixing: the suite stayed green
 * with muted text on that fill at 1.71:1.
 *
 * Unlike COLOR_UTILITY_PREFIXES, this is NOT something Tailwind's design
 * system exposes: "which side of a contrast pairing does this namespace's
 * colour play" is a WCAG-pairing modelling decision this codebase makes, not
 * a structural fact - there is no Tailwind API that says "ring-offset is a
 * backdrop". ugcportal-j4j round 3 finding 2: a hand-written 5-entry Set
 * still has exactly the hand-curation problem this bead exists to close -
 * `scrollbar-track` (the channel a scrollbar thumb slides in - a backdrop,
 * same relationship `bg` has to text) and every `mask-*-from`/`mask-*-to`
 * (a mask gradient stop - the same backdrop role as the plain gradient
 * stops `from`/`via`/`to` already covered) were missing, defaulting to
 * foreground and routed through the wrong threshold.
 *
 * So this is expressed as rules over the *shape* of whatever namespace
 * string `discoverColorNamespaces` returns, not a memorised list of specific
 * names - a namespace matching one of these shapes is background-role
 * automatically, including one Tailwind adds after this was written, without
 * anyone updating a list by hand:
 *
 *   - `bg` exactly: the one namespace that sets `background-color` directly.
 *   - ends in `from`, `via` or `to` (a gradient stop, `-` separated or bare):
 *     covers the plain background gradient (`from`/`via`/`to`) and every
 *     `mask-*-from`/`mask-*-to` mask-gradient stop the same way - a gradient
 *     stop is a backdrop whether it feeds `background-image` or `mask-image`.
 *   - ends in `-track`: the channel a thumb/handle slides in
 *     (`scrollbar-track`), the backdrop to `scrollbar-thumb`.
 *   - ends in `-offset`: the colour exposed in the gap around a mark
 *     (`ring-offset`) - the backdrop that mark is drawn over.
 *
 * Everything else defaults to foreground. That default is itself a
 * deliberate, bounded choice, not a silent one: a namespace this reasoning
 * cannot place is far more likely to be a mark drawn on something (the
 * common case - text, borders, rings, shadows, fills, strokes) than a fill
 * itself, and usage.test.ts sweeps every namespace `discoverColorNamespaces`
 * currently returns through this function, so a new namespace landing on
 * the wrong side of that default is a visible test failure to reconsider,
 * not a silent misclassification.
 */
export function isBackgroundRole(prefix: string): boolean {
  if (prefix === "bg") return true;
  if (/(?:^|-)(?:from|via|to)$/.test(prefix)) return true;
  if (prefix.endsWith("-track")) return true;
  if (prefix.endsWith("-offset")) return true;
  return false;
}

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

      // 1. Is this a colour at all? Some namespaces are overloaded with a
      //    preset that also takes a modifier, and an arbitrary value may be
      //    a length rather than a colour.
      if (name.startsWith("[")) {
        if (isNonColorArbitraryValue(name)) continue;
        fail(
          `${relative}: "${written}..." applies an alpha to an arbitrary colour ` +
            `value. Use a design token so the gate can resolve and measure it.`,
        );
      }
      if (isNonColorOverload(designSystem, prefix, name)) continue;

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
        role: isBackgroundRole(prefix) ? "background" : "foreground",
        prefix,
      });
    }
  }
  return found;
}
