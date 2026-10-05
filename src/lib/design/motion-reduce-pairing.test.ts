/**
 * K2 (ugcportal-ig4g): an interaction-triggered utility that sets scale/
 * translate/rotate/skew/transform/animation must be gated by `motion-safe:`
 * somewhere in its variant chain - must never ship ungated anywhere under
 * src/, as a source-scan test rather than a one-off grep - the same shape
 * as no-raw-hex.test.ts and dual-meaning-usage.test.ts, and sharing their
 * walker/comment-stripper via scan-source.ts (ugcportal-rw9j review round
 * 4) rather than a third hand-rolled copy of either.
 *
 * THE RULE, round 2 (PR #101 round-1 review): round 1 of this scan checked
 * for `motion-reduce:transform-none` co-occurring with a scale/translate/
 * rotate/skew utility in the same class string - which caught the ORIGINAL
 * bug shape, but a round-1 reviewer found it PROVABLY wrong about the fix:
 * swapping in `motion-reduce:scale-none` (this scan's own "fixed" fixture at
 * the time) is STILL broken, for an entirely different reason - CSS
 * SPECIFICITY, not property name (see containment.ts's own comment on
 * `GALLERY_TILE_IMAGE_CLASS` for the full explanation, confirmed against a
 * real browser). A scan that only watches for the property-name mismatch
 * cannot see that.
 *
 * So the rule is no longer about a GUARD at all. It is about the utility
 * itself: whenever an INTERACTION-TRIGGERED segment (see
 * `isInteractionTriggerSegment`'s own comment for the full, generated set -
 * deliberately not hand-listed here a second time, which is exactly what
 * made rounds 2 and 3 of this review each find "one more shape") sits next
 * to a DANGEROUS utility segment (`isInteractionTriggerSegment`'s sibling,
 * `DANGEROUS_UTILITY_SEGMENT` - same reasoning, not re-listed here), the
 * utility must carry `motion-safe:` somewhere in its variant chain.
 * `motion-safe:` moves the entire rule inside `@media (prefers-reduced-
 * motion: no-preference)`, so under `reduce` the rule does not exist in
 * the stylesheet at all - specificity never gets a chance to matter,
 * because there is no competing rule to out-rank. This one rule flags
 * every shape a `motion-reduce:`-only approach cannot tell apart: the
 * original `transform-none` pairing, the still-broken `scale-none`
 * pairing, and an interaction-triggered utility with NO guard at all - a
 * `motion-reduce:` override, present or absent, correct or not, is
 * irrelevant to whether the utility itself is actually safe.
 *
 * POSITION of `motion-safe:` in the chain does NOT matter (round-2 review,
 * PR #101: an earlier version of this scan required it to be the
 * OUTERMOST/first variant, which is not what Tailwind actually requires).
 * Confirmed by compiling all three orderings: `motion-safe:hover:scale-105`,
 * `hover:motion-safe:scale-105` and `sm:motion-safe:hover:scale-105` all
 * produce a rule nested inside `@media (prefers-reduced-motion: no-
 * preference)` regardless of where `motion-safe:` sits in the written
 * chain - each variant wraps its own selector or media condition around the
 * compiled rule independently of the others' order, so a media query's
 * presence anywhere in the chain is what gates the rule, not its position.
 * This scan accordingly checks PRESENCE of `motion-safe:` among a token's
 * variant segments, not which position it occupies.
 *
 * WHY TOKEN-LEVEL, not string-level: the previous version matched within one
 * extracted class-like STRING LITERAL (a `className`/constant's full text).
 * This version goes one level finer - each individual WHITESPACE-DELIMITED
 * TOKEN inside that string - because the new rule's signal (does THIS ONE
 * utility carry `motion-safe:` as its own prefix) is a property of one
 * token, not of what else happens to share its string. A side effect worth
 * stating plainly: this also means the offending signal can never be hidden
 * by splitting a class list across a multi-argument `cn(...)` call or a
 * concatenated string - each piece is still walked by the same whole-file
 * string-literal scan and the same per-token check, independently of how
 * many separate literals the source happens to spread a class list across
 * (proven by the `cn()`/concatenation fixtures below).
 *
 * Scope: every .tsx/.ts file under src/ (walkSourceFiles's own default
 * extensions), skipping test files only (`isTestFile`) - this is a
 * regression gate on SHIPPED class strings, same reasoning as
 * dual-meaning-usage.test.ts's identical exclusion. Comments are stripped
 * first (`stripComments`) so a doc comment merely DISCUSSING the old bug
 * (this file's own header, containment.ts's and button.tsx's comments)
 * cannot trip it - proven by its own describe block below.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "./scan-source";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function isExcluded(file: string): boolean {
  return isTestFile(file);
}

/**
 * Extracts every quoted string/template literal's CONTENT from a file's
 * (comment-stripped) source - the granularity a `className` string, a
 * `cn(...)` argument, or a concatenated piece of one actually is.
 * Deliberately NOT multi-line (`[^"\n]*` etc.): every class string this
 * codebase writes - including the backtick-templated ones that interpolate
 * another constant, e.g. `GALLERY_TILE_BASE_CLASS` - fits on one line. The
 * regex is global and this module always drives it with a `while (exec())`
 * loop, so EVERY literal in a file is visited, not just the first - a
 * multi-argument `cn("a", "b")` call or a concatenated `"a" + "b"` produces
 * two separate matches here, each checked independently (see the `cn()`/
 * concatenation fixtures below).
 */
const STRING_LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

/**
 * A scale/translate/rotate/skew/animate utility SEGMENT, OR an arbitrary
 * property/value spelling of the same four transform-family CSS
 * properties, anchored to the WHOLE segment (not a substring search) -
 * this function is only ever called on one already-isolated piece of a
 * token's variant chain (see `splitVariantSegments`), so there is no
 * surrounding text to accidentally match inside.
 *
 * NAMED utilities (`scale-110`, `-translate-y-0.5`, `rotate-6`, `skew-x-3`,
 * `animate-pulse`): optional leading `-` for Tailwind's negative-value
 * spelling; the longer `translate-x`/`translate-y`/`skew-x`/`skew-y`
 * alternatives are listed before their bare `translate`/`skew`
 * counterparts so the regex cannot stop one utility short.
 *
 * EXCLUDED (round-3 review, PR #101): the `-none` form of every named
 * utility here (`animate-none`, `scale-none`, `translate-none`, `rotate-
 * none` - `skew-none` does not exist as a Tailwind utility, confirmed, so
 * it is not a channel at all). Each REMOVES motion rather than applies it -
 * confirmed empirically, `hover:animate-none` compiles to a bare `@media
 * (hover: hover) { animation: none; }` - so a hover-triggered `*-none` is
 * the SAFE direction, the opposite of what this gate exists to catch, and
 * must never be flagged (this is also the shape `containment.ts`'s own
 * `motion-reduce:scale-none` belt-and-braces entry uses, on the OTHER side
 * of a `motion-reduce:` guard rather than a trigger, but the exclusion
 * applies regardless of which side of a guard a `*-none` sits on).
 *
 * ARBITRARY forms (round-2 and round-3 review): Tailwind's arbitrary-
 * property syntax (`[scale:1.1]`, `[translate:4px_0]`, `[rotate:6deg]`,
 * `[skew:3deg]`, `[transform:scale(1.04)]`) and its first-class arbitrary-
 * VALUE utility `transform-[scale(1.04)]` all compile identically to their
 * named-utility sibling when interaction-triggered - confirmed by compiling
 * each (e.g. `group-hover:[scale:1.1]` compiles to an ungated `scale: 1.1`,
 * exactly like `group-hover:scale-110`). `transform-none` (no brackets) is
 * excluded the same way the other `-none` forms are, by requiring a
 * literal `[` to open the `transform-[...]` arbitrary value - `transform-
 * none` never has one.
 */
const DANGEROUS_UTILITY_SEGMENT =
  /^(?:-?(?:scale|translate-x|translate-y|translate|rotate|skew-x|skew-y|skew|animate)-(?!none$)[\w.%[\]()-]+|\[(?:scale|translate|rotate|skew|transform):[^\]]*\]|transform-\[[^\]]*\])$/;

/**
 * Whether a variant SEGMENT (already stripped of any `/name` suffix - see
 * `variantStem`) means a utility only ever applies on an INTERACTION, not
 * unconditionally - exactly the condition the reduced-motion guard
 * actually matters for.
 *
 * GENERALISED (round-3 review, PR #101) rather than hand-listed one shape
 * at a time, which is what produced three successive review rounds each
 * finding "one more shape" this scan missed - scale/rotate/skew/animate/
 * transform as the property side (round 2), then position-independence and
 * peer-hover/focus-visible/focus-within/named-group/[transform:...]/
 * animate-* as the trigger side (round 2 again), now this. A fixed list
 * can always be one case short of whatever interaction variant someone
 * writes next; the cartesian PRODUCT of a small set of prefixes and stems,
 * plus the small set of Tailwind's state-ATTRIBUTE variant families, is
 * what this is reorganised around instead, so "is this combination
 * covered" is a question about the GENERATOR, not about whether someone
 * remembered to add a new string to a list.
 *
 * Two families, confirmed by compiling a representative of each:
 *
 * 1. PSEUDO-CLASS-SHAPED triggers: the cartesian product of
 *    `TRIGGER_PREFIXES` (no prefix, `group-`, `peer-`, `in-`, `not-`) and
 *    `BASE_TRIGGER_STEMS` (`hover`, `focus`, `focus-visible`, `focus-
 *    within`, `active`) - `group-hover`, `peer-focus-within`, `in-hover`,
 *    `not-active`, and so on. `in-*` (Tailwind v4's ancestor variant that
 *    needs no `group` class) and `not-*` (negation) compile to their own,
 *    equally real rules - confirmed `in-hover:scale-105` compiles inside
 *    `@media (hover: hover)` with an ancestor selector, and `not-hover:
 *    scale-105` compiles to an unconditional `:not(:hover)` rule PLUS an
 *    `@media not (hover: hover)` duplicate for touch devices - neither has
 *    anything to do with `prefers-reduced-motion` on its own.
 * 2. STATE-ATTRIBUTE triggers, which are not prefix+stem combinations at
 *    all: `aria-*` (`aria-expanded`, `aria-pressed`, ... and the arbitrary
 *    `aria-[...]` form), `data-[...]`, `has-[...]`, and the fully arbitrary
 *    `[&:hover]`-shaped selector variant (matched only when its bracket
 *    content names one of the same pseudo-classes `BASE_TRIGGER_STEMS`
 *    already covers, so `[&:last-child]` - nothing to do with interaction -
 *    is correctly NOT a trigger). Confirmed `aria-expanded:translate-y-px`,
 *    `data-[state=open]:scale-105` and `has-[:focus-visible]:translate-y-
 *    px` all compile with NO media gate of their own at all (a plain
 *    attribute/`:has()` selector), which is exactly button.tsx's and
 *    upload-form.tsx's own real, ungated press-motion shape this round
 *    fixed.
 *
 * What this does NOT claim to be exhaustive of, stated rather than
 * silently assumed: Tailwind's variant grammar is large (container
 * queries, `:nth-*`, print, etc.) and this still only recognises the
 * families a real interaction in this codebase has exercised so far. The
 * generator shape is what makes the NEXT one cheap to add, not a claim
 * that none remains.
 */
const BASE_TRIGGER_STEMS = [
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
] as const;

/** `group-`/`peer-` are selector-scoped (an ancestor carrying `group`/`peer`); `in-` is Tailwind v4's ancestor variant that needs no such class; `not-` is negation. `""` (no prefix) is the bare stem itself. */
const TRIGGER_PREFIXES = ["", "group-", "peer-", "in-", "not-"] as const;

const NAMED_TRIGGER_VARIANTS: ReadonlySet<string> = new Set(
  BASE_TRIGGER_STEMS.flatMap((stem) => TRIGGER_PREFIXES.map((prefix) => `${prefix}${stem}`)),
);

/** A fixed `aria-word` variant (`aria-expanded`, `aria-pressed`, ...) or the arbitrary `aria-[...]` form. */
const ARIA_STATE_VARIANT = /^aria-(?:[\w-]+|\[[^\]]*\])$/;
/** Tailwind's arbitrary data-attribute variant, `data-[state=open]` and similar. */
const DATA_STATE_VARIANT = /^data-\[[^\]]*\]$/;
/** Tailwind's `:has()` variant, `has-[:focus-visible]` and similar. */
const HAS_STATE_VARIANT = /^has-\[[^\]]*\]$/;
/** The fully arbitrary selector-variant escape hatch, `[&:hover]` and similar - a trigger only when its bracket content names one of `BASE_TRIGGER_STEMS`' own pseudo-classes, so an unrelated arbitrary selector (`[&:last-child]`) is correctly not one. */
const ARBITRARY_SELECTOR_VARIANT = /^\[&[^\]]*\]$/;
const ARBITRARY_SELECTOR_NAMES_A_TRIGGER_PSEUDO =
  /:(?:hover|focus-visible|focus-within|focus|active)\b/;

function isInteractionTriggerSegment(segment: string): boolean {
  const stem = variantStem(segment);
  if (NAMED_TRIGGER_VARIANTS.has(stem)) return true;
  if (ARIA_STATE_VARIANT.test(stem)) return true;
  if (DATA_STATE_VARIANT.test(stem)) return true;
  if (HAS_STATE_VARIANT.test(stem)) return true;
  if (
    ARBITRARY_SELECTOR_VARIANT.test(stem) &&
    ARBITRARY_SELECTOR_NAMES_A_TRIGGER_PSEUDO.test(stem)
  ) {
    return true;
  }
  return false;
}

/**
 * The part of a variant segment before an optional `/name` suffix
 * (`group-hover/button` into `group-hover`; `peer-hover/field` into `peer-
 * hover`) - Tailwind scopes a NAMED group/peer variant to `.group\/name`
 * rather than the unnamed `.group`, confirmed empirically, but the rule
 * this gate checks (is the trigger gated by `motion-safe:`) does not care
 * which ancestor the selector points at. Bracket/paren depth-aware, same
 * reasoning as `splitVariantSegments` below: an arbitrary value containing
 * a literal `/` (a URL, say) must not be mistaken for a name separator.
 */
function variantStem(segment: string): string {
  let depth = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === "/" && depth === 0) return segment.slice(0, index);
  }
  return segment;
}

/**
 * Splits one Tailwind utility TOKEN (already whitespace-isolated - see
 * `isUngatedInteractionMotionUtility` below) into its colon-separated
 * variant chain - `"motion-safe:group-hover:scale-[1.04]"` into
 * `["motion-safe", "group-hover", "scale-[1.04]"]` - respecting
 * bracket/paren depth, so a literal `:` INSIDE an arbitrary value is never
 * mistaken for a chain separator. Not a hypothetical: this codebase already
 * ships that exact shape in sibling tokens within class strings this scan
 * walks - `src/components/home/hero.tsx`'s `motion-safe:[animation-
 * delay:150ms]`, `src/components/ui/button.tsx`'s `[&_svg:not([class*=
 * 'size-'])]:size-4`, and `src/app/upload/upload-form.tsx`'s `has-
 * [:focus-visible]:border-ring`. A naive `token.split(":")` would cut
 * `motion-safe:[animation-delay:150ms]` into THREE pieces
 * (`["motion-safe", "[animation-delay", "150ms]"]`) instead of two logical
 * ones. None of those three examples happens to END in a scale/translate/
 * rotate/skew utility, so none is a live false positive today - but that is
 * this codebase's current shape, not a guarantee, and depth-aware
 * splitting costs nothing against the alternative of silently miscounting
 * the day one of them does.
 */
function splitVariantSegments(token: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of token) {
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    if (char === ":" && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

/**
 * Whether ONE whitespace-delimited token is an interaction-triggered
 * scale/translate/rotate/skew utility with no `motion-safe:` gate.
 *
 * Three shapes all return true here, deliberately - this is the whole point
 * of moving the rule off the old guard-pairing check: `"group-hover:scale-
 * [1.04]"` with a `motion-reduce:transform-none` SIBLING token elsewhere in
 * the same string (the original bug), the identical token with a
 * `motion-reduce:scale-none` sibling instead (still broken - see this
 * file's header), and the same token with no reduced-motion token anywhere
 * nearby at all. None of that context is read here on purpose: whether this
 * ONE token is safe depends only on whether IT carries `motion-safe:`, not
 * on what else happens to share its class string.
 */
function isUngatedInteractionMotionUtility(token: string): boolean {
  const segments = splitVariantSegments(token);
  if (segments.length < 2) return false;
  const utility = segments[segments.length - 1];
  if (!DANGEROUS_UTILITY_SEGMENT.test(utility)) return false;
  const variantSegments = segments.slice(0, -1);
  const hasTrigger = variantSegments.some((segment) =>
    isInteractionTriggerSegment(segment),
  );
  if (!hasTrigger) return false;
  // PRESENCE, not position (round-2 review, PR #101 - see this file's
  // header for the compiled-CSS evidence): `motion-safe:` gates the rule
  // wherever it sits in the chain, so `hover:motion-safe:scale-105` and
  // `sm:motion-safe:hover:scale-105` are exactly as gated as `motion-safe:
  // hover:scale-105`.
  return !variantSegments.includes("motion-safe");
}

/**
 * Every file (relative to `root`) with at least one class-like string
 * containing an ungated interaction-triggered scale/translate/rotate/skew
 * utility. Exported so the fixture tests below drive the real function
 * against a real directory on disk, same shape as
 * analytics-host.grep.test.ts's `findAnalyticsMarkerOffenders` - a mutation
 * check against a reimplementation would not catch a regression in this
 * function itself.
 */
export function findUngatedInteractionMotionUtilities(
  files: readonly string[],
  root: string,
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"), file);

    STRING_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    let offending = false;
    while ((match = STRING_LITERAL.exec(source)) !== null) {
      const literal = match[1] ?? match[2] ?? match[3] ?? "";
      for (const token of literal.split(/\s+/)) {
        if (token && isUngatedInteractionMotionUtility(token)) {
          offending = true;
          break;
        }
      }
      if (offending) break;
    }
    if (offending) {
      offenders.push(path.relative(path.dirname(root), file));
    }
  }
  return offenders;
}

describe("K2: every interaction-triggered scale/translate/rotate/skew/animate/transform utility carries motion-safe: somewhere in its chain", () => {
  const files = walkSourceFiles(SRC_ROOT, isExcluded);

  it("finds files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("ships no ungated such utility anywhere under src/", () => {
    const offenders = findUngatedInteractionMotionUtilities(files, SRC_ROOT);

    expect(
      offenders,
      `An interaction-triggered scale/translate/rotate/skew/animate/transform ` +
        `utility with no motion-safe: anywhere in its variant chain, found in: ` +
        `${offenders.join(", ")}. See isInteractionTriggerSegment's and ` +
        `DANGEROUS_UTILITY_SEGMENT's own comments in this file for exactly which ` +
        `variants and utilities that covers. Tailwind 4 compiles these ` +
        `utilities to their own standalone CSS properties with no reduced-` +
        `motion media context of their own, and a motion-reduce:* override on ` +
        `the result cannot reliably out-specificity them (see src/components/` +
        `gallery/containment.ts's GALLERY_TILE_IMAGE_CLASS comment) - gate the ` +
        `TRIGGERING utility itself with motion-safe: instead (motion-safe:` +
        `group-hover:scale-[...], etc - motion-safe: can go anywhere in the ` +
        `chain, not only first).`,
    ).toEqual([]);
  });
});

describe("findUngatedInteractionMotionUtilities (the real scanner, exercised over a real fixture on disk)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "motion-reduce-pairing-"));
    created.push(root);
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return root;
  }

  function scan(root: string): string[] {
    return findUngatedInteractionMotionUtilities(walkSourceFiles(root, isTestFile), root);
  }

  it("MUTATION CHECK: reports the original pre-fix shape (bare group-hover:scale, motion-reduce:transform-none)", () => {
    const root = fixture({
      "tile.ts": [
        "export const TILE_IMAGE_CLASS =",
        '  "h-full w-full object-cover transition-transform duration-300 ' +
          'ease-out group-hover:scale-[1.04] motion-reduce:transform-none ' +
          'motion-reduce:transition-none";',
      ].join("\n"),
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "tile.ts")]);
  });

  it("MUTATION CHECK: ALSO reports the still-broken 'fixed' shape (bare group-hover:scale, motion-reduce:scale-none) - round-1 review's finding", () => {
    // This is the fixture round-1 review found this scan WRONGLY treated as
    // clean: swapping `transform-none` for `scale-none` looks like a fix and
    // still is not one (CSS specificity - see this file's header and
    // containment.ts's own comment). The rule no longer cares what
    // `motion-reduce:` override is present, so this is caught the same way
    // as the original bug.
    const root = fixture({
      "tile.ts": [
        "export const TILE_IMAGE_CLASS =",
        '  "h-full w-full object-cover transition-transform duration-300 ' +
          'ease-out group-hover:scale-[1.04] motion-reduce:scale-none ' +
          'motion-reduce:transition-none";',
      ].join("\n"),
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "tile.ts")]);
  });

  it("MUTATION CHECK: reports the same utility with NO motion-reduce guard at all", () => {
    const root = fixture({
      "tile.ts": 'export const TILE_IMAGE_CLASS = "group-hover:scale-[1.04]";',
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "tile.ts")]);
  });

  it("MUTATION: the real fix (motion-safe: on the triggering utility) makes the scan report nothing", () => {
    // Required mutation for the three checks above, kept as a standing
    // assertion: the actual shape this bead ships, proving the "found
    // nothing" result is live rather than a scanner that silently stopped
    // looking.
    const root = fixture({
      "tile.ts": [
        "export const TILE_IMAGE_CLASS =",
        '  "h-full w-full object-cover transition-transform duration-300 ' +
          'ease-out motion-safe:group-hover:scale-[1.04] motion-reduce:scale-none ' +
          'motion-reduce:transition-none";',
      ].join("\n"),
    });

    expect(scan(root)).toEqual([]);
  });

  it("does not flag a plain, always-on scale/translate utility with no interaction trigger", () => {
    // Not every scale/translate utility is a reduced-motion concern - only
    // ones gated on an interaction variant actually ANIMATE on an
    // interaction. A static layout value like this is simply not this
    // scan's business.
    const root = fixture({
      "layout.ts": 'export const CARD_CLASS = "translate-x-4 scale-110";',
    });

    expect(scan(root)).toEqual([]);
  });

  it("does not flag a properly motion-safe-gated utility even alongside an unrelated plain one", () => {
    const root = fixture({
      "mixed.ts": [
        'export const A = "motion-safe:hover:scale-105 motion-reduce:scale-none";',
        'export const B = "translate-x-4";',
      ].join("\n"),
    });

    expect(scan(root)).toEqual([]);
  });

  it("ignores a comment that merely discusses the ungated shape, rather than shipping it", () => {
    const root = fixture({
      "documented.ts": [
        "/**",
        " * Do not write group-hover:scale-[1.04] motion-reduce:transform-none",
        " * here - it is a no-op, see ugcportal-ig4g.",
        " */",
        'export const CLASS = "h-full w-full object-cover";',
      ].join("\n"),
    });

    expect(scan(root)).toEqual([]);
  });

  it("catches an ungated utility inside a two-argument cn() call, in either argument position", () => {
    const root = fixture({
      "first-arg.ts":
        'export const A = cn("group-hover:scale-110", "text-sm font-medium");',
      "second-arg.ts":
        'export const B = cn("text-sm font-medium", "group-hover:scale-110");',
    });

    const result = scan(root);
    expect(result).toContain(path.join(path.basename(root), "first-arg.ts"));
    expect(result).toContain(path.join(path.basename(root), "second-arg.ts"));
    expect(result).toHaveLength(2);
  });

  it("catches an ungated utility split across a string concatenation", () => {
    const root = fixture({
      "concat.ts":
        'export const CLASS = "text-sm font-medium " + "group-hover:scale-110";',
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "concat.ts")]);
  });

  it.each([
    ["hover: translate", "hover:translate-x-4"],
    ["negative hover: translate-y", "hover:-translate-y-0.5"],
    ["group-hover: rotate", "group-hover:rotate-6"],
    ["active: translate (button.tsx's own shape, pre-fix)", "active:not-aria-[haspopup]:translate-y-px"],
    ["focus: skew", "focus:skew-x-3"],
    ["focus-visible: scale", "focus-visible:scale-105"],
    ["focus-within: scale", "focus-within:scale-105"],
    ["peer-hover: scale (round-2 review)", "peer-hover:scale-105"],
    ["NAMED group-hover/name: translate (round-2 review)", "group-hover/button:translate-y-px"],
    ["group-hover: arbitrary [transform:...] property (round-2 review)", "group-hover:[transform:scale(1.04)]"],
    ["hover: animate-* (round-2 review)", "hover:animate-pulse"],
  ])("also catches an ungated %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:hover:translate", "motion-safe:hover:translate-x-4"],
    ["motion-safe:group-hover:rotate", "motion-safe:group-hover:rotate-6"],
    [
      "motion-safe:active: translate (button.tsx's own shape, post-fix)",
      "motion-safe:active:not-aria-[haspopup]:translate-y-px",
    ],
    ["motion-safe:focus:skew", "motion-safe:focus:skew-x-3"],
    ["motion-safe:focus-visible:scale (round-2 review)", "motion-safe:focus-visible:scale-105"],
    ["motion-safe:focus-within:scale", "motion-safe:focus-within:scale-105"],
    ["motion-safe:peer-hover:scale (round-2 review)", "motion-safe:peer-hover:scale-105"],
    [
      "motion-safe:group-hover/name:translate (round-2 review)",
      "motion-safe:group-hover/button:translate-y-px",
    ],
    [
      "motion-safe:group-hover:[transform:...] (round-2 review)",
      "motion-safe:group-hover:[transform:scale(1.04)]",
    ],
    ["motion-safe:hover:animate-* (round-2 review)", "motion-safe:hover:animate-pulse"],
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * POSITION of `motion-safe:` (round-2 review, PR #101): a scan that
   * required `motion-safe:` to be first/outermost would wrongly flag both
   * of these - Tailwind gates the compiled rule by its PRESENCE in the
   * chain, not its position (see this file's own header for the compiled-
   * CSS evidence). Both are real, valid Tailwind - a responsive variant
   * (`sm:`) is free to sit outside `motion-safe:`, and a developer writing
   * the interaction variant first (`hover:motion-safe:...`) is just as
   * gated as writing `motion-safe:` first.
   */
  it.each([
    ["hover:motion-safe:scale (motion-safe not first)", "hover:motion-safe:scale-105"],
    ["sm:motion-safe:hover:scale (motion-safe in the middle)", "sm:motion-safe:hover:scale-105"],
  ])("does not flag %s - motion-safe: gates by presence, not position", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * The real, shipped shape `src/components/home/hero.tsx`'s
   * `HERO_DECORATIVE_SHAPE_CLASS` uses - `animate-*` gated by `motion-safe:`
   * but with NO interaction trigger at all (the fade-in runs on mount, not
   * on hover/focus/etc). Confirms widening `DANGEROUS_UTILITY_SEGMENT` to
   * include `animate-*` (round-2 review) did not turn this into a false
   * positive: no trigger segment means `isUngatedInteractionMotionUtility`
   * returns false before it ever reaches the `motion-safe:` check.
   */
  it("does not flag hero.tsx's own motion-safe:animate-[...] shape, which has no interaction trigger", () => {
    const root = fixture({
      "hero-like.ts":
        'export const CLASS = "motion-safe:animate-[home-fade-in_700ms_ease-out_both] motion-reduce:animate-none";',
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * ARBITRARY property/value forms (round-3 review, PR #101): each
   * confirmed by compiling it that it produces the SAME ungated shape as
   * its named-utility sibling - e.g. `group-hover:[scale:1.1]` compiles to
   * an ungated `scale: 1.1`, exactly like `group-hover:scale-110`.
   */
  it.each([
    ["arbitrary [scale:...] property", "group-hover:[scale:1.1]"],
    ["arbitrary [translate:...] property", "group-hover:[translate:4px_0]"],
    ["arbitrary [rotate:...] property", "group-hover:[rotate:6deg]"],
    ["arbitrary [skew:...] property", "group-hover:[skew:3deg]"],
    ["first-class transform-[...] arbitrary-value utility", "hover:transform-[scale(1.04)]"],
  ])("also catches an ungated %s", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:group-hover:[scale:...]", "motion-safe:group-hover:[scale:1.1]"],
    ["motion-safe:group-hover:[translate:...]", "motion-safe:group-hover:[translate:4px_0]"],
    ["motion-safe:group-hover:[rotate:...]", "motion-safe:group-hover:[rotate:6deg]"],
    ["motion-safe:group-hover:[skew:...]", "motion-safe:group-hover:[skew:3deg]"],
    ["motion-safe:hover:transform-[...]", "motion-safe:hover:transform-[scale(1.04)]"],
  ])("does not flag the same %s once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * THE `-none` EXCLUSION (round-3 review, PR #101): each of these REMOVES
   * motion rather than applying it - confirmed by compiling, e.g.
   * `hover:animate-none` compiles to a bare `@media (hover: hover) {
   * animation: none; }`, the SAFE direction, not the dangerous one this
   * gate exists to catch. None of these five should ever be flagged, with
   * or without a trigger, with or without motion-safe:.
   */
  it.each([
    ["hover:animate-none", "hover:animate-none"],
    ["hover:scale-none", "hover:scale-none"],
    ["hover:translate-none", "hover:translate-none"],
    ["hover:rotate-none", "hover:rotate-none"],
    ["hover:transform-none", "hover:transform-none"],
  ])("does not flag %s - it removes motion, it does not apply it", (_label, classString) => {
    const root = fixture({
      "none-form.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * STATE-ATTRIBUTE and further pseudo-class-shaped triggers (round-3
   * review, PR #101) - each confirmed by compiling it that the utility
   * compiles with NO `prefers-reduced-motion` gate at all when written
   * bare, same as every trigger above. `aria-expanded`/`has-[:focus-
   * visible]` are the two shapes this round's audit of the real tree found
   * and fixed in button.tsx/upload-form.tsx (see those files' own
   * comments); the rest complete the family these two belong to rather
   * than waiting for a fourth round to find them one at a time.
   */
  it.each([
    ["aria-expanded: translate (button.tsx's own pre-fix shape)", "aria-expanded:translate-y-px"],
    ["aria-pressed: scale", "aria-pressed:scale-105"],
    ["aria-selected: scale", "aria-selected:scale-105"],
    ["aria-checked: scale", "aria-checked:scale-105"],
    ["arbitrary aria-[...]: scale", "aria-[current=page]:scale-105"],
    ["data-[...]: scale", "data-[state=open]:scale-105"],
    ["has-[...]: translate (upload-form.tsx's own pre-fix shape)", "has-[:focus-visible]:translate-y-px"],
    ["in-hover: scale", "in-hover:scale-105"],
    ["in-focus: scale", "in-focus:scale-105"],
    ["not-hover: scale", "not-hover:scale-105"],
    ["arbitrary [&:hover]: scale", "[&:hover]:scale-105"],
  ])("also catches an ungated %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:aria-expanded:translate", "motion-safe:aria-expanded:translate-y-px"],
    ["motion-safe:aria-pressed:scale", "motion-safe:aria-pressed:scale-105"],
    ["motion-safe:aria-selected:scale", "motion-safe:aria-selected:scale-105"],
    ["motion-safe:aria-checked:scale", "motion-safe:aria-checked:scale-105"],
    ["motion-safe:arbitrary aria-[...]:scale", "motion-safe:aria-[current=page]:scale-105"],
    ["motion-safe:data-[...]:scale", "motion-safe:data-[state=open]:scale-105"],
    ["motion-safe:has-[...]:translate", "motion-safe:has-[:focus-visible]:translate-y-px"],
    ["motion-safe:in-hover:scale", "motion-safe:in-hover:scale-105"],
    ["motion-safe:in-focus:scale", "motion-safe:in-focus:scale-105"],
    ["motion-safe:not-hover:scale", "motion-safe:not-hover:scale-105"],
    ["motion-safe:arbitrary [&:hover]:scale", "motion-safe:[&:hover]:scale-105"],
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  it("does not flag an unrelated arbitrary selector that names no interaction pseudo-class", () => {
    // [&:last-child] has nothing to do with interaction or motion - this is
    // the false-positive ARBITRARY_SELECTOR_VARIANT's own pseudo-class
    // check exists to avoid (a blanket "any [&...] is a trigger" rule
    // would wrongly flag this).
    const root = fixture({
      "unrelated.ts": 'export const CLASS = "[&:last-child]:translate-y-px";',
    });

    expect(scan(root)).toEqual([]);
  });
});
