/**
 * K2 (ugcportal-ig4g): "a motion-reduce:transform-none guard paired with a
 * scale-*, translate-*, rotate-* or skew-* utility" must never happen
 * anywhere under src/, as a source-scan test rather than a one-off grep -
 * the same shape as no-raw-hex.test.ts and dual-meaning-usage.test.ts, and
 * sharing their walker/comment-stripper via scan-source.ts (ugcportal-rw9j
 * review round 4) rather than a third hand-rolled copy of either.
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
 * itself: any `hover:`/`group-hover:`/`active:`/`focus:`-TRIGGERED
 * `scale-*`/`translate-*`/`rotate-*`/`skew-*` utility must carry a
 * `motion-safe:` prefix as its OUTERMOST variant. `motion-safe:` moves the
 * entire rule inside `@media (prefers-reduced-motion: no-preference)`, so
 * under `reduce` the rule does not exist in the stylesheet at all -
 * specificity never gets a chance to matter, because there is no competing
 * rule to out-rank. This one rule flags all three shapes a `motion-reduce:`-
 * only approach cannot tell apart: the original `transform-none` pairing,
 * the still-broken `scale-none` pairing, and a hover utility with NO guard
 * at all - a `motion-reduce:` override, present or absent, correct or not,
 * is irrelevant to whether this utility is actually safe.
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
 * A scale/translate/rotate/skew utility SEGMENT, anchored to the WHOLE
 * segment (not a substring search) - this function is only ever called on
 * one already-isolated piece of a token's variant chain (see
 * `splitVariantSegments`), so there is no surrounding text to accidentally
 * match inside. Optional leading `-` for Tailwind's negative-value spelling
 * (`-translate-y-0.5`). The longer `translate-x`/`translate-y`/`skew-x`/
 * `skew-y` alternatives are listed before their bare `translate`/`skew`
 * counterparts so the regex cannot stop one utility short.
 */
const DANGEROUS_UTILITY_SEGMENT =
  /^-?(?:scale|translate-x|translate-y|translate|rotate|skew-x|skew-y|skew)-[\w.%[\]()-]+$/;

/**
 * The variant segments whose presence means a utility only ever applies on
 * an INTERACTION, not unconditionally - exactly the set the reduced-motion
 * guard actually matters for. `group-hover` is listed separately from
 * `hover` (not inferred from it containing the substring "hover") so this
 * set stays an explicit, auditable list rather than a substring heuristic
 * that could also match something like a hypothetical `peer-hover`.
 */
const TRIGGER_VARIANTS = new Set(["hover", "group-hover", "active", "focus"]);

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
  const hasTrigger = segments
    .slice(0, -1)
    .some((segment) => TRIGGER_VARIANTS.has(segment));
  if (!hasTrigger) return false;
  return segments[0] !== "motion-safe";
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

describe("K2: every hover/group-hover/active/focus scale-translate-rotate-skew utility is motion-safe-gated", () => {
  const files = walkSourceFiles(SRC_ROOT, isExcluded);

  it("finds files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("ships no ungated such utility anywhere under src/", () => {
    const offenders = findUngatedInteractionMotionUtilities(files, SRC_ROOT);

    expect(
      offenders,
      `A hover:/group-hover:/active:/focus:-triggered scale-*/translate-*/` +
        `rotate-*/skew-* utility with no motion-safe: prefix, found in: ` +
        `${offenders.join(", ")}. Tailwind 4 compiles these utilities to their ` +
        `own standalone CSS properties with no reduced-motion media context of ` +
        `their own, and a motion-reduce:* override on the result cannot reliably ` +
        `out-specificity them (see src/components/gallery/containment.ts's ` +
        `GALLERY_TILE_IMAGE_CLASS comment) - gate the TRIGGERING utility itself ` +
        `with motion-safe: instead (motion-safe:group-hover:scale-[...], etc).`,
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
    // ones gated on hover/group-hover/active/focus actually ANIMATE on an
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
  ])("does not flag the same %s utility once motion-safe-gated", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    expect(scan(root)).toEqual([]);
  });
});
