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
 * ARBITRARY forms (round-2, round-3 and round-4 review): Tailwind's
 * arbitrary-property syntax (`[scale:1.1]`, `[translate:4px_0]`,
 * `[rotate:6deg]`, `[skew:3deg]`, `[transform:scale(1.04)]`,
 * `[animation:wiggle_1s_infinite]`) and its first-class arbitrary-VALUE
 * utility `transform-[scale(1.04)]` all compile identically to their
 * named-utility sibling when interaction-triggered - confirmed by compiling
 * each (e.g. `group-hover:[scale:1.1]` compiles to an ungated `scale: 1.1`,
 * exactly like `group-hover:scale-110`; `hover:[animation:wiggle_1s_
 * infinite]` compiles to an ungated `animation: wiggle 1s infinite`,
 * exactly like `hover:animate-pulse`). `transform-none` (no brackets) is
 * excluded the same way the other `-none` forms are, by requiring a
 * literal `[` to open the `transform-[...]` arbitrary value - `transform-
 * none` never has one.
 *
 * LONGHAND and CUSTOM-PROPERTY arbitrary forms (round-5 review): the same
 * channel, one level more specific. `[animation-name:...]`,
 * `[animation-duration:...]` and `[transition:...]` each confirmed
 * compiling to an equally ungated longhand declaration (`hover:
 * [animation-name:wiggle]` compiles to a bare `animation-name: wiggle`).
 * `[--tw-translate-y:...]` and `[--tw-scale-x:...]` (explicitly asked for
 * in review) confirmed compiling to an ungated CUSTOM PROPERTY
 * declaration - Tailwind's OWN named `translate-y-*`/`scale-*` utilities
 * are themselves implemented by setting these same custom properties
 * (confirmed in the compiled output of the named utilities earlier in
 * this file's own history), so setting one directly via arbitrary syntax
 * is the identical bypass the named-utility checks above exist for, one
 * layer down. GENERALISED (same reasoning as `isInteractionTriggerSegment`
 * below) to every axis of all four transform-family custom properties
 * Tailwind defines - `--tw-translate-{x,y,z}`, `--tw-scale-{x,y,z}`,
 * `--tw-rotate-{x,y,z}`, `--tw-skew-{x,y}` (confirmed present in the
 * compiled `@property` preamble) - rather than hand-listing only the two
 * axes review happened to name, which is exactly the shape that produced
 * four prior rounds of "one more axis/shape" on this file. The `[xyz]`
 * character class below also accepts the non-existent `skew-z`; that is a
 * harmless OVER-match (no real Tailwind utility ever writes it, so
 * nothing legitimate is affected) in the same safe direction this round's
 * fix to `ARBITRARY_SELECTOR_TRIGGER_PSEUDO` accepts, not a claim every
 * combination is a real Tailwind custom property.
 */
const DANGEROUS_UTILITY_SEGMENT =
  /^(?:-?(?:scale|translate-x|translate-y|translate|rotate|skew-x|skew-y|skew|animate)-(?!none$)[\w.%[\]()-]+|\[(?:scale|translate|rotate|skew|transform|animation|animation-name|animation-duration|transition|--tw-(?:translate|scale|rotate|skew)-[xyz]):[^\]]*\]|transform-\[[^\]]*\])$/;

/**
 * Whether a variant SEGMENT (already stripped of any `/name` suffix - see
 * `variantStem`) means a utility only ever applies on an INTERACTION, not
 * unconditionally - exactly the condition the reduced-motion guard
 * actually matters for.
 *
 * GENERALISED (round-3 review, PR #101) rather than hand-listed one shape
 * at a time, which is what produced five successive review rounds each
 * finding "one more shape" this scan missed - scale/rotate/skew/animate/
 * transform as the property side (round 2), then position-independence and
 * peer-hover/focus-visible/focus-within/named-group/[transform:...]/
 * animate-* as the trigger side (round 2 again), then the state-attribute
 * families (round 3), then (round 4) the SAME prefix product applied to
 * those state-attribute families too, a wider arbitrary-selector match,
 * and two more base stems, then (round 5) the BARE word forms of `has-*`
 * and `data-*` (this family had only ever covered their BRACKETED forms),
 * longhand/custom-property arbitrary properties, and a regex precision fix.
 * A fixed list can always be one case short of whatever interaction variant
 * someone writes next; the cartesian PRODUCT of a small set of prefixes
 * and stems, plus a small set of Tailwind's state-ATTRIBUTE variant
 * families (themselves also prefixable), is what this is reorganised
 * around instead, so "is this combination covered" is a question about
 * the GENERATOR, not about whether someone remembered to add a new string
 * to a list.
 *
 * Two families, confirmed by compiling a representative of each:
 *
 * 1. PSEUDO-CLASS-SHAPED triggers: the cartesian product of
 *    `TRIGGER_PREFIXES` (no prefix, `group-`, `peer-`, `in-`, `not-`) and
 *    `BASE_TRIGGER_STEMS` (`hover`, `focus`, `focus-visible`, `focus-
 *    within`, `active`, `open`, `checked`) - `group-hover`, `peer-focus-
 *    within`, `in-hover`, `not-active`, `peer-checked`, and so on. `in-*`
 *    (Tailwind v4's ancestor variant that needs no `group` class) and
 *    `not-*` (negation) compile to their own, equally real rules -
 *    confirmed `in-hover:scale-105` compiles inside `@media (hover: hover)`
 *    with an ancestor selector, and `not-hover:scale-105` compiles to an
 *    unconditional `:not(:hover)` rule PLUS an `@media not (hover: hover)`
 *    duplicate for touch devices - neither has anything to do with
 *    `prefers-reduced-motion` on its own. `open` (`:is([open], :popover-
 *    open, :open)` - a `<details>`/`<dialog>`/popover's own open state) and
 *    `checked` (`:checked` - a checkbox/radio) were added in round 4,
 *    confirmed the same way.
 *
 *    NOT added, stated rather than silently omitted: `enabled`/`disabled`
 *    (a capability a control has, not a momentary interaction a visitor
 *    performs - nothing gestures a button into `disabled`, so there is no
 *    hover-shaped "this just happened" moment for `prefers-reduced-motion`
 *    to matter for), `target`/`visited` (URL-fragment navigation and link
 *    history respectively - neither fires from a hover/click/keypress on
 *    THIS element, and `:visited` in particular carries its own, unrelated
 *    privacy constraints on what CSS may even read from it), and
 *    `starting` (`@starting-style` - confirmed it compiles to exactly that
 *    at-rule, not a plain rule at all; it describes an element's OWN
 *    mount/removal transition, not a response to hovering/focusing/
 *    clicking it, which is a real but DIFFERENT reduced-motion question -
 *    entry/exit animation - this gate does not claim to answer, the same
 *    boundary that already excludes hero.tsx's own mount-time fade-in,
 *    which has no interaction trigger either).
 *
 *    NOT ADDED EITHER (ugcportal-61pv): eight further real Tailwind
 *    pseudo-class variants, each confirmed by compiling it that it produces
 *    an equally ungated rule - so each is a live gap in the same SHAPE as
 *    every trigger above, closed the same way `enabled`/`disabled` above
 *    already are: what each one reports is a CAPABILITY or a DATA FACT about
 *    the element, not a momentary pointer/keyboard event, so there is no
 *    hover-shaped "this just happened" moment for `prefers-reduced-motion`
 *    to matter for.
 *      - `inert` (compiles to `:is([inert], [inert] *)`) - the `inert`
 *        attribute is set by script or markup, never by a visitor's click,
 *        hover or keypress on this element.
 *      - `user-invalid`/`user-valid` (`:user-invalid`/`:user-valid`) - the
 *        CSS spec requires the control to have been interacted with before
 *        either can match, but what they REPORT once that is true is the
 *        value's VALIDITY, which can also flip with no interaction at all
 *        (a script assigning `.value`) - the same reason `:invalid`/`:valid`
 *        themselves have never been in this trigger set.
 *      - `placeholder-shown` (`:placeholder-shown`) - true exactly when the
 *        field is empty, a fact about its current value rather than about
 *        anything that just happened to it.
 *      - `indeterminate` (`:indeterminate`) - set on a checkbox/radio by
 *        script (`el.indeterminate = true`); no HTML user gesture produces
 *        it directly.
 *      - `autofill` (`:autofill`) - the BROWSER filled the field in the
 *        background; not a click/hover/keypress the visitor aimed at it.
 *      - `default` (`:default`) - marks whichever option/button a form
 *        already designates as its default, a markup fact fixed at render
 *        time, not a response to anything the visitor does.
 *      - `required` (`:required`) - a capability/constraint of the field,
 *        the same shape as `disabled`/`enabled` above.
 *    Each is pinned by its own fixture below (the same `it.each` block
 *    `enabled`/`disabled`/`target`/`visited`/`starting` already use), so a
 *    future widening of `BASE_TRIGGER_STEMS` to include one of these without
 *    revisiting this reasoning fails loudly rather than silently.
 *
 * 2. STATE-ATTRIBUTE triggers: `aria-*` (`aria-expanded`, `aria-pressed`,
 *    ... and the arbitrary `aria-[...]` form), `data-*` (round 5: both the
 *    bare `data-open`/`data-active`/any `data-<word>` form AND the
 *    arbitrary `data-[...]` form - only the latter was covered before this
 *    round) and `has-*` (round 5, same gap: both the bare `has-hover`/
 *    `has-open`/etc form - via `TRIGGER_PREFIXES`'s own `"has-"` entry,
 *    the SAME cartesian product as family 1 above, since `has-<pseudo>` IS
 *    a prefix+stem combination even though `aria-*`/`data-*` are not - and
 *    the bracketed `has-[...]` form)
 *    - the bracketed forms (`data-[...]`, `has-[...]`) are NOT prefix+stem
 *      combinations themselves, but (round 4) each STILL composes with the
 *      same `group-`/`peer-`/`in-`/`not-` prefixes (`STATE_ATTRIBUTE_
 *      PREFIXES`, deliberately NOT including `has-` - see that constant's
 *      own comment for why) as the pseudo-class stems above, confirmed by
 *      compiling one of each: `group-data-[state=open]:scale-105`,
 *      `peer-aria-expanded:translate-y-px`, `in-has-[:focus-visible]:
 *      translate-y-px` and `not-aria-expanded:translate-y-px` all compile
 *      to real, equally ungated rules (an attribute selector composed onto
 *      `.group`/`.peer`, an ancestor selector, and a `:not()` wrapper
 *      respectively) - `stripTriggerPrefix` strips a leading prefix before
 *      testing a segment against these three patterns, the same way
 *      `NAMED_TRIGGER_VARIANTS` bakes the product directly into its set.
 *    - plus the fully arbitrary selector-variant escape hatch (`[&:hover]`
 *      and the wider shapes round 4 added - see `isArbitrarySelectorTrigger`
 *      below), matched only when its bracket content names one of
 *      `BASE_TRIGGER_STEMS`' own pseudo-classes, so an unrelated arbitrary
 *      selector (`[&:last-child]`) is correctly NOT a trigger.
 *    Confirmed `aria-expanded:translate-y-px`, `data-[state=open]:
 *    scale-105` and `has-[:focus-visible]:translate-y-px` all compile with
 *    NO media gate of their own at all (a plain attribute/`:has()`
 *    selector) - these three strings are SYNTHETIC PROBES of variants this
 *    codebase already uses (button.tsx's `aria-expanded:`, upload-form.tsx's
 *    `has-[:focus-visible]:`), not quotes of anything those files actually
 *    ship: both files' own real usages pair these variants with `border`/
 *    `background`/`outline`/`underline` utilities, never a scale/translate/
 *    rotate/skew/animate/transform one, and the real-tree scan below
 *    confirms that - an earlier version of this comment wrongly claimed
 *    these strings as something "this round fixed" in those files; round 4
 *    corrected that after the gate's own maintainer pointed out neither
 *    file contains either string (round-3 review had already reported, and
 *    this round confirmed again, that the real-tree scan finds zero
 *    offenders).
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
  "open",
  "checked",
] as const;

/** `group-`/`peer-` are selector-scoped (an ancestor carrying `group`/`peer`); `in-` is Tailwind v4's ancestor variant that needs no such class; `not-` is negation; `has-` (round-5 review) is Tailwind's bare `:has(:pseudo)` form - `has-hover:scale-105` compiles to `.has-hover\:scale-105:has(:hover)`, confirmed, the bare-word sibling of the bracketed `has-[:focus-visible]` form `HAS_STATE_VARIANT` below already covers. `""` (no prefix) is the bare stem itself. */
const TRIGGER_PREFIXES = ["", "group-", "peer-", "in-", "not-", "has-"] as const;

const NAMED_TRIGGER_VARIANTS: ReadonlySet<string> = new Set(
  BASE_TRIGGER_STEMS.flatMap((stem) => TRIGGER_PREFIXES.map((prefix) => `${prefix}${stem}`)),
);

/**
 * The prefixes that compose with the STATE-ATTRIBUTE families
 * (`stripTriggerPrefix` below) - deliberately NARROWER than
 * `TRIGGER_PREFIXES` above, and NOT including `"has-"` (round-5 review,
 * found the hard way): `has-` already has its OWN dedicated bracketed-form
 * regex (`HAS_STATE_VARIANT`), and stripping it here too would eat the
 * `has-` off the FRONT of `has-[:focus-visible]` before that regex ever
 * saw it, leaving a stem (`[:focus-visible]`) neither `HAS_STATE_VARIANT`
 * (which requires the literal `has-` it just lost) nor
 * `isArbitrarySelectorTrigger` (which requires the stem to START with
 * `[`, not `h`) can recognise - silently un-flagging the exact
 * `has-[:focus-visible]:translate-y-px` shape this gate exists to catch.
 * Confirmed by this bead's own fixture suite failing when `"has-"` was
 * (wrongly) included here.
 */
const STATE_ATTRIBUTE_PREFIXES = ["group-", "peer-", "in-", "not-"] as const;

/** Strips one leading `group-`/`peer-`/`in-`/`not-` prefix, if present, before a segment is tested against the state-attribute patterns below - see this function's own call site's comment for the compiled evidence that Tailwind composes these families with the same four prefixes the pseudo-class stems use. */
function stripTriggerPrefix(stem: string): string {
  for (const prefix of STATE_ATTRIBUTE_PREFIXES) {
    if (stem.startsWith(prefix)) return stem.slice(prefix.length);
  }
  return stem;
}

/** A fixed `aria-word` variant (`aria-expanded`, `aria-pressed`, ...) or the arbitrary `aria-[...]` form. */
const ARIA_STATE_VARIANT = /^aria-(?:[\w-]+|\[[^\]]*\])$/;
/** Tailwind's bare `data-<word>` variant (`data-open`, `data-active`, `data-hover`, any `data-<word>` - confirmed each compiles to an ungated attribute selector) or the arbitrary `data-[...]` form - symmetric with `ARIA_STATE_VARIANT` above (round-5 review: the bare form was missing). */
const DATA_STATE_VARIANT = /^data-(?:[\w-]+|\[[^\]]*\])$/;
/** Tailwind's `:has()` variant, `has-[:focus-visible]` and similar - the BRACKETED form; the bare `has-<pseudo>` form (`has-hover`, `has-open`, ...) is covered separately, via `TRIGGER_PREFIXES`'s own `"has-"` entry. */
const HAS_STATE_VARIANT = /^has-\[[^\]]*\]$/;

/**
 * The pseudo-class names `isArbitrarySelectorTrigger` looks for inside an
 * arbitrary selector's bracket content - the same set `BASE_TRIGGER_STEMS`'
 * own plain pseudo-classes cover.
 *
 * `(?![a-z-])`, not a trailing `\b` (round-4 review, found while adding the
 * `[.sidebar:hover_&]` fixture): Tailwind's arbitrary-value syntax writes a
 * literal space as `_` (so `[.sidebar:hover_&]` compiles the real selector
 * `.sidebar:hover &`), and `_` is a WORD character in regex terms - `\b`
 * between "hover" and "_" never fires, so `\bhover\b`-style matching missed
 * this real, compiling shape entirely.
 *
 * The `-` in the lookahead's character class is round-5 review's own
 * fix, for a case the round-4 comment here overclaimed: with only
 * `(?![a-z])`, `:focus-visiblex` (not a real pseudo-class) still MATCHED -
 * not via the `focus-visible` alternative (its own lookahead correctly
 * rejects the trailing `x`), but by the regex engine BACKTRACKING to the
 * bare `focus` alternative, whose lookahead only checked for a following
 * LETTER and so accepted the `-` right after it. `focus-visible`/`focus-
 * within` are listed before bare `focus` so the regex prefers the longer
 * match first, but alternation still falls back to the shorter one on
 * failure - excluding a following `-` too closes that fallback, because
 * no real CSS pseudo-class name is `focus` followed by a literal `-` that
 * ISN'T immediately `-visible` or `-within` (both already matched, and
 * matched first, by their own longer alternatives). Residual, stated
 * rather than silently fixed further: this still accepts the harmless
 * over-match `:hoverboard` style name sharing a PREFIX with no trailing
 * `-` or letter (e.g. a hypothetical `:hoverfoo)`, which nothing in this
 * codebase's real CSS vocabulary produces) - the safe direction for a
 * gate whose job is to flag a possible motion risk, not a CSS selector
 * parser.
 */
const ARBITRARY_SELECTOR_TRIGGER_PSEUDO =
  /:(?:hover|focus-visible|focus-within|focus|active)(?![a-z-])/;

/**
 * Whether `stem` is Tailwind's fully arbitrary selector-variant escape
 * hatch - a single well-formed bracketed segment whose content contains
 * BOTH a literal `&` (Tailwind's "insert the compiled selector here"
 * placeholder) and one of `ARBITRARY_SELECTOR_TRIGGER_PSEUDO`'s pseudo-
 * classes, ANYWHERE in that content - not only as a leading `[&:pseudo]`
 * prefix (round 4 review): `[&[data-open]:hover]` (the pseudo-class comes
 * AFTER a nested bracket) and `[.sidebar:hover_&]` (the `&` comes LAST,
 * after an ancestor selector) are both real, equally ungated forms,
 * confirmed by compiling each - `[&:last-child]` still correctly does not
 * match, since `:last-child` names no pseudo-class this gate recognises as
 * interaction-related.
 *
 * A FUNCTION rather than one regex, because `[&[data-open]:hover]` needs
 * the OUTER bracket's content located past a correctly nested INNER
 * bracket - a charset like `[^\]]*` stops at the first `]`, which belongs
 * to the inner bracket, not the outer one - so this walks bracket depth
 * itself, the same technique `splitVariantSegments`/`variantStem` already
 * use, rather than assuming a single, flat pair of brackets.
 */
function isArbitrarySelectorTrigger(stem: string): boolean {
  if (stem.length < 2 || stem[0] !== "[" || stem[stem.length - 1] !== "]") return false;
  let depth = 0;
  for (let index = 0; index < stem.length; index += 1) {
    if (stem[index] === "[") depth += 1;
    else if (stem[index] === "]") {
      depth -= 1;
      // The outer brackets must close exactly at the end of the string -
      // closing early (depth back to 0 before the final character) means
      // this is not one well-formed bracketed segment.
      if (depth === 0 && index !== stem.length - 1) return false;
    }
  }
  if (depth !== 0) return false;
  const content = stem.slice(1, -1);
  return content.includes("&") && ARBITRARY_SELECTOR_TRIGGER_PSEUDO.test(content);
}

function isInteractionTriggerSegment(segment: string): boolean {
  const stem = variantStem(segment);
  if (NAMED_TRIGGER_VARIANTS.has(stem)) return true;
  const unprefixed = stripTriggerPrefix(stem);
  if (ARIA_STATE_VARIANT.test(unprefixed)) return true;
  if (DATA_STATE_VARIANT.test(unprefixed)) return true;
  if (HAS_STATE_VARIANT.test(unprefixed)) return true;
  if (isArbitrarySelectorTrigger(stem)) return true;
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

// ugcportal-9faa: a single real-tree walk + per-file stripComments pass
// (findUngatedInteractionMotionUtilities, below), already computed once for
// this describe — real CPU work a busy machine can push past the 5s
// default on its own. Explicit timeout, not a bigger global default; see
// analytics-host.grep.test.ts and throttled-log.no-sibling-copy.test.ts for
// the same shape of fix and the measurements behind it.
describe("K2: every interaction-triggered scale/translate/rotate/skew/animate/transform utility carries motion-safe: somewhere in its chain", { timeout: 15_000 }, () => {
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
   * bare, same as every trigger above. `aria-expanded:translate-y-px` and
   * `has-[:focus-visible]:translate-y-px` are SYNTHETIC PROBES - they pair
   * a variant this codebase genuinely uses (button.tsx's `aria-expanded:`,
   * upload-form.tsx's `has-[:focus-visible]:`) with a dangerous utility
   * NEITHER file actually pairs it with (both only ever use these variants
   * with `border`/`background`/`outline`/`underline`, confirmed by
   * grepping both files - see the real-tree scan below, which reports zero
   * offenders). An earlier version of this comment wrongly called these
   * two "button.tsx's/upload-form.tsx's own pre-fix shape" and claimed this
   * round fixed them there; it did not, because neither file ships either
   * string.
   */
  it.each([
    ["aria-expanded: translate (a probe of button.tsx's own variant, synthetic utility)", "aria-expanded:translate-y-px"],
    ["aria-pressed: scale", "aria-pressed:scale-105"],
    ["aria-selected: scale", "aria-selected:scale-105"],
    ["aria-checked: scale", "aria-checked:scale-105"],
    ["arbitrary aria-[...]: scale", "aria-[current=page]:scale-105"],
    ["data-[...]: scale", "data-[state=open]:scale-105"],
    ["has-[...]: translate (a probe of upload-form.tsx's own variant, synthetic utility)", "has-[:focus-visible]:translate-y-px"],
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
    // the false-positive isArbitrarySelectorTrigger's own pseudo-class
    // check exists to avoid (a blanket "any [&...] is a trigger" rule
    // would wrongly flag this).
    const root = fixture({
      "unrelated.ts": 'export const CLASS = "[&:last-child]:translate-y-px";',
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * THE PREFIX PRODUCT applied to state-attribute families too (round-4
   * review, PR #101): `stripTriggerPrefix` means `group-`/`peer-`/`in-`/
   * `not-` compose with `data-[...]`/`aria-*`/`has-[...]` exactly as they
   * do with the plain pseudo-class stems - each pairing below confirmed by
   * compiling it before being added here.
   */
  it.each([
    ["group-data-[...]: scale", "group-data-[state=open]:scale-105"],
    ["peer-data-[...]: scale", "peer-data-[state=open]:scale-105"],
    ["in-data-[...]: scale", "in-data-[state=open]:scale-105"],
    ["not-data-[...]: scale", "not-data-[state=open]:scale-105"],
    ["group-aria-expanded: translate", "group-aria-expanded:translate-y-px"],
    ["peer-aria-expanded: translate", "peer-aria-expanded:translate-y-px"],
    ["in-aria-expanded: translate", "in-aria-expanded:translate-y-px"],
    ["not-aria-expanded: translate", "not-aria-expanded:translate-y-px"],
    ["group-has-[...]: translate", "group-has-[:focus-visible]:translate-y-px"],
    ["peer-has-[...]: translate", "peer-has-[:focus-visible]:translate-y-px"],
    ["in-has-[...]: translate", "in-has-[:focus-visible]:translate-y-px"],
    ["not-has-[...]: translate", "not-has-[:focus-visible]:translate-y-px"],
  ])("also catches an ungated %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:group-data-[...]:scale", "motion-safe:group-data-[state=open]:scale-105"],
    ["motion-safe:peer-data-[...]:scale", "motion-safe:peer-data-[state=open]:scale-105"],
    ["motion-safe:in-data-[...]:scale", "motion-safe:in-data-[state=open]:scale-105"],
    ["motion-safe:not-data-[...]:scale", "motion-safe:not-data-[state=open]:scale-105"],
    ["motion-safe:group-aria-expanded:translate", "motion-safe:group-aria-expanded:translate-y-px"],
    ["motion-safe:peer-aria-expanded:translate", "motion-safe:peer-aria-expanded:translate-y-px"],
    ["motion-safe:in-aria-expanded:translate", "motion-safe:in-aria-expanded:translate-y-px"],
    ["motion-safe:not-aria-expanded:translate", "motion-safe:not-aria-expanded:translate-y-px"],
    ["motion-safe:group-has-[...]:translate", "motion-safe:group-has-[:focus-visible]:translate-y-px"],
    ["motion-safe:peer-has-[...]:translate", "motion-safe:peer-has-[:focus-visible]:translate-y-px"],
    ["motion-safe:in-has-[...]:translate", "motion-safe:in-has-[:focus-visible]:translate-y-px"],
    ["motion-safe:not-has-[...]:translate", "motion-safe:not-has-[:focus-visible]:translate-y-px"],
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * [animation:...] arbitrary property (round-4 review, PR #101): the same
   * channel as [transform:...]/[scale:...]/etc, confirmed compiling to an
   * ungated `animation:` declaration exactly like `hover:animate-pulse`.
   */
  it("also catches an ungated hover:[animation:...] arbitrary property", () => {
    const root = fixture({
      "other-utility.ts":
        'export const CLASS = "hover:[animation:wiggle_1s_infinite]";',
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it("does not flag the same hover:[animation:...] once motion-safe-gated", () => {
    const root = fixture({
      "other-utility.ts":
        'export const CLASS = "motion-safe:hover:[animation:wiggle_1s_infinite]";',
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * WIDER arbitrary-selector shapes (round-4 review, PR #101): the pseudo-
   * class does not have to come first, and the `&` does not have to come
   * first either - see `isArbitrarySelectorTrigger`'s own comment for the
   * compiled evidence behind each.
   */
  it.each([
    [
      "[&[data-open]:hover] (pseudo-class after a nested bracket)",
      "[&[data-open]:hover]:scale-105",
    ],
    [
      "[.sidebar:hover_&] (& comes last, after an ancestor selector)",
      "[.sidebar:hover_&]:scale-105",
    ],
  ])("also catches an ungated %s arbitrary selector", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    [
      "motion-safe:[&[data-open]:hover]",
      "motion-safe:[&[data-open]:hover]:scale-105",
    ],
    [
      "motion-safe:[.sidebar:hover_&]",
      "motion-safe:[.sidebar:hover_&]:scale-105",
    ],
  ])("does not flag the same %s arbitrary selector once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  it("STILL does not flag [&:last-child] with the widened arbitrary-selector match", () => {
    // Re-asserted against the WIDENED isArbitrarySelectorTrigger (round 4),
    // not just the original narrower one - :last-child names no pseudo-
    // class this gate recognises as interaction-related, regardless of how
    // generously the bracket's own shape is now parsed.
    const root = fixture({
      "unrelated.ts": 'export const CLASS = "[&:last-child]:translate-y-px";',
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * NEW base stems open/checked (round-4 review, PR #101): each confirmed
   * to compile ungated (`:is([open], :popover-open, :open)` / `:checked`),
   * and each composes with the same prefixes as every other base stem.
   */
  it.each([
    ["open: scale", "open:scale-105"],
    ["group-open: scale", "group-open:scale-105"],
    ["checked: scale", "checked:scale-105"],
    ["peer-checked: translate", "peer-checked:translate-x-5"],
  ])("also catches an ungated %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:open:scale", "motion-safe:open:scale-105"],
    ["motion-safe:group-open:scale", "motion-safe:group-open:scale-105"],
    ["motion-safe:checked:scale", "motion-safe:checked:scale-105"],
    ["motion-safe:peer-checked:translate", "motion-safe:peer-checked:translate-x-5"],
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  it.each([
    ["enabled:scale-105", "enabled:scale-105"],
    ["disabled:scale-105", "disabled:scale-105"],
    ["target:scale-105", "target:scale-105"],
    ["visited:scale-105", "visited:scale-105"],
    ["starting:scale-105", "starting:scale-105"],
    // ugcportal-61pv: eight further state/capability variants, confirmed by
    // compiling each that it produces an equally ungated rule - see
    // BASE_TRIGGER_STEMS's own comment for the per-variant reasoning.
    ["inert:scale-105", "inert:scale-105"],
    ["user-invalid:scale-105", "user-invalid:scale-105"],
    ["user-valid:scale-105", "user-valid:scale-105"],
    ["placeholder-shown:scale-105", "placeholder-shown:scale-105"],
    ["indeterminate:scale-105", "indeterminate:scale-105"],
    ["autofill:scale-105", "autofill:scale-105"],
    ["default:scale-105", "default:scale-105"],
    ["required:scale-105", "required:scale-105"],
  ])(
    "does not treat %s as an interaction trigger (deliberately excluded - see BASE_TRIGGER_STEMS's own comment)",
    (_label, classString) => {
      const root = fixture({
        "excluded-variant.ts": `export const CLASS = "${classString}";`,
      });

      expect(scan(root)).toEqual([]);
    },
  );

  /**
   * BARE has-* family (round-5 review): `has-hover`/`has-open`/etc, the
   * word-form sibling of the already-covered bracketed `has-[...]` form -
   * each confirmed compiling to an ungated `:has(:pseudo)` selector.
   */
  it.each([
    ["has-hover: scale", "has-hover:scale-105"],
    ["has-focus: scale", "has-focus:scale-105"],
    ["has-focus-visible: scale", "has-focus-visible:scale-105"],
    ["has-focus-within: scale", "has-focus-within:scale-105"],
    ["has-active: scale", "has-active:scale-105"],
    ["has-checked: translate", "has-checked:translate-y-px"],
    ["has-open: scale", "has-open:scale-105"],
  ])("also catches an ungated %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:has-hover:scale", "motion-safe:has-hover:scale-105"],
    ["motion-safe:has-focus:scale", "motion-safe:has-focus:scale-105"],
    ["motion-safe:has-focus-visible:scale", "motion-safe:has-focus-visible:scale-105"],
    ["motion-safe:has-focus-within:scale", "motion-safe:has-focus-within:scale-105"],
    ["motion-safe:has-active:scale", "motion-safe:has-active:scale-105"],
    ["motion-safe:has-checked:translate", "motion-safe:has-checked:translate-y-px"],
    ["motion-safe:has-open:scale", "motion-safe:has-open:scale-105"],
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * BARE data-* family (round-5 review), symmetric with aria-*: any
   * `data-<word>`, each confirmed compiling to an ungated attribute
   * selector.
   */
  it.each([
    ["data-open: scale", "data-open:scale-105"],
    ["data-active: scale", "data-active:scale-105"],
    ["data-focus: scale", "data-focus:scale-105"],
    ["data-hover: scale", "data-hover:scale-105"],
    ["arbitrary data-<word>: scale", "data-whatever:scale-105"],
  ])("also catches an ungated %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    ["motion-safe:data-open:scale", "motion-safe:data-open:scale-105"],
    ["motion-safe:data-active:scale", "motion-safe:data-active:scale-105"],
    ["motion-safe:data-focus:scale", "motion-safe:data-focus:scale-105"],
    ["motion-safe:data-hover:scale", "motion-safe:data-hover:scale-105"],
    ["motion-safe:data-<word>:scale", "motion-safe:data-whatever:scale-105"],
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  /**
   * ARBITRARY LONGHAND and CUSTOM-PROPERTY forms (round-5 review): each
   * confirmed compiling to an equally ungated declaration when
   * interaction-triggered, the same channel as [transform:...]/
   * [animation:...] one level more specific.
   */
  it.each([
    ["hover: arbitrary [animation-name:...]", "hover:[animation-name:wiggle]"],
    ["hover: arbitrary [animation-duration:...]", "hover:[animation-duration:1s]"],
    ["hover: arbitrary [transition:...]", "hover:[transition:transform_1s]"],
    ["group-hover: arbitrary [--tw-translate-y:...]", "group-hover:[--tw-translate-y:10px]"],
    ["group-hover: arbitrary [--tw-scale-x:...]", "group-hover:[--tw-scale-x:1.1]"],
  ])("also catches an ungated %s", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });

  it.each([
    [
      "motion-safe:hover:[animation-name:...]",
      "motion-safe:hover:[animation-name:wiggle]",
    ],
    [
      "motion-safe:hover:[animation-duration:...]",
      "motion-safe:hover:[animation-duration:1s]",
    ],
    [
      "motion-safe:hover:[transition:...]",
      "motion-safe:hover:[transition:transform_1s]",
    ],
    [
      "motion-safe:group-hover:[--tw-translate-y:...]",
      "motion-safe:group-hover:[--tw-translate-y:10px]",
    ],
    [
      "motion-safe:group-hover:[--tw-scale-x:...]",
      "motion-safe:group-hover:[--tw-scale-x:1.1]",
    ],
  ])("does not flag the same %s once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });

  it("does not flag :focus-visiblex as a trigger inside an arbitrary selector (round-5 review)", () => {
    // The fixture that caught the ARBITRARY_SELECTOR_TRIGGER_PSEUDO
    // overclaim this round corrected - see that regex's own comment.
    const root = fixture({
      "unrelated.ts": 'export const CLASS = "[&:focus-visiblex]:translate-y-px";',
    });

    expect(scan(root)).toEqual([]);
  });
});
