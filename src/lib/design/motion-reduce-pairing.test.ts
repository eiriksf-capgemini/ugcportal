/**
 * K2 (ugcportal-ig4g): "a motion-reduce:transform-none guard paired with a
 * scale-*, translate-*, rotate-* or skew-* utility" must never happen
 * anywhere under src/, as a source-scan test rather than a one-off grep -
 * the same shape as no-raw-hex.test.ts and dual-meaning-usage.test.ts, and
 * sharing their walker/comment-stripper via scan-source.ts (ugcportal-rw9j
 * review round 4) rather than a third hand-rolled copy of either.
 *
 * WHY THIS IS A REAL BUG CLASS, NOT A STYLE NIT: Tailwind 4's
 * `scale-*`/`translate-*`/`rotate-*`/`skew-*` utilities compile to the
 * STANDALONE CSS properties `scale`/`translate`/`rotate` - not to
 * `transform` - confirmed empirically for both the gallery tile's hover
 * scale (src/components/gallery/containment.ts, this bead) and the empty
 * state's hover lift (src/components/home/empty-state.tsx, PR #97) by
 * compiling globals.css and reading the generated rule. A
 * `motion-reduce:transform-none` guard sitting next to one of these
 * utilities therefore overrides a property the element never uses, and the
 * real one - `scale`/`translate`/`rotate` - is left completely unguarded:
 * under `prefers-reduced-motion: reduce`, the element still jumps straight
 * to its hovered scale/offset/angle with no transition (a SEPARATE
 * `motion-reduce:transition-none`, where present, kills the transition but
 * not the end value it was transitioning to).
 *
 * WHY "pairED ON THE SAME ELEMENT" AND NOT JUST "SAME FILE": a file can
 * legitimately contain an unrelated `motion-reduce:transform-none` on one
 * element and an unrelated `scale-*` on another - that is not this bug.
 * This scan matches within one extracted class-like STRING LITERAL (the
 * granularity a `className`/constant actually is in this codebase), not
 * across a whole file, and `describe("does not flag an unrelated pairing
 * in the same file ...")` below is the fixture that proves that distinction
 * is real rather than assumed.
 *
 * Scope: every .tsx/.ts file under src/ (walkSourceFiles's own default
 * extensions), skipping test files only (`isTestFile`) - this is a
 * regression gate on SHIPPED class strings, same reasoning as
 * dual-meaning-usage.test.ts's identical exclusion. Comments are stripped
 * first (`stripComments`) so a doc comment merely DISCUSSING the old bug
 * (this file's own header, containment.ts's and empty-state.tsx's comments)
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
 * (comment-stripped) source - the granularity a `className` string or a
 * `"...”`-typed class constant (`GALLERY_TILE_IMAGE_CLASS`, etc.) actually
 * is. Deliberately NOT multi-line (`[^"\n]*` etc.): every class string this
 * codebase writes - including the backtick-templated ones that interpolate
 * another constant, e.g. `GALLERY_TILE_BASE_CLASS` - fits on one line, and a
 * single-line match is enough to catch the real bug shape (one guard and
 * one utility inside the one string Tailwind actually compiles) without
 * having to parse template-literal interpolation.
 */
const STRING_LITERAL =
  /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

/**
 * A Tailwind `scale-*`/`translate-*`/`translate-x-*`/`translate-y-*`/
 * `rotate-*`/`skew-x-*`/`skew-y-*` utility, with or without a variant
 * prefix (`group-hover:`, `hover:`, `motion-safe:`, ...) and with or
 * without Tailwind's leading `-` for a negative value. The longer
 * `translate-x`/`translate-y`/`skew-x`/`skew-y` alternatives are listed
 * before their bare `translate`/`skew` counterparts so the regex engine
 * cannot stop one utility short (`translate-x` matched as plain `translate`
 * followed by a separate, unconsumed `-x`).
 *
 * `(?<![\w-])` before the (optional) negative sign is what keeps this from
 * matching inside an unrelated identifier - the character immediately
 * before a REAL utility is always a Tailwind separator (`:`, whitespace, a
 * quote) or nothing, never a word character or hyphen.
 */
const DANGEROUS_UTILITY =
  /(?<![\w-])-?(?:scale|translate-x|translate-y|translate|rotate|skew-x|skew-y|skew)-[\w.%[\]()-]+/;

const TRANSFORM_NONE_GUARD = "motion-reduce:transform-none";

/** Whether one class-like string pairs the guard with a dangerous utility. */
function pairsTransformNoneWithMotionUtility(classString: string): boolean {
  return (
    classString.includes(TRANSFORM_NONE_GUARD) &&
    DANGEROUS_UTILITY.test(classString)
  );
}

/**
 * Every file (relative to `root`) with at least one class-like string that
 * pairs `motion-reduce:transform-none` with a scale/translate/rotate/skew
 * utility. Exported so the fixture tests below drive the real function
 * against a real directory on disk, same shape as
 * analytics-host.grep.test.ts's `findAnalyticsMarkerOffenders` - a
 * mutation check against a reimplementation would not catch a regression
 * in this function itself.
 */
export function findTransformNoneScalePairings(
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
      if (pairsTransformNoneWithMotionUtility(literal)) {
        offending = true;
        break;
      }
    }
    if (offending) {
      offenders.push(path.relative(path.dirname(root), file));
    }
  }
  return offenders;
}

describe("K2: no motion-reduce:transform-none paired with a scale/translate/rotate/skew utility", () => {
  const files = walkSourceFiles(SRC_ROOT, isExcluded);

  it("finds files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("ships no such pairing anywhere under src/", () => {
    const offenders = findTransformNoneScalePairings(files, SRC_ROOT);

    expect(
      offenders,
      `"${TRANSFORM_NONE_GUARD}" paired with a scale-*/translate-*/rotate-*/skew-* ` +
        `utility in the same class string, found in: ${offenders.join(", ")}. ` +
        `Tailwind 4's scale/translate/rotate/skew utilities compile to their own ` +
        `standalone CSS properties, not to transform - use the matching ` +
        `motion-reduce:{scale,translate,rotate}-none override instead (see ` +
        `src/components/gallery/containment.ts's GALLERY_TILE_IMAGE_CLASS comment).`,
    ).toEqual([]);
  });
});

describe("findTransformNoneScalePairings (the real scanner, exercised over a real fixture on disk)", () => {
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

  it("MUTATION CHECK: reports a file reproducing the exact pre-fix containment.ts bug (scale, motion-reduce:transform-none)", () => {
    const root = fixture({
      "tile.ts": [
        "export const TILE_IMAGE_CLASS =",
        '  "h-full w-full object-cover transition-transform duration-300 ' +
          'ease-out group-hover:scale-[1.04] motion-reduce:transform-none ' +
          'motion-reduce:transition-none";',
      ].join("\n"),
    });

    const result = findTransformNoneScalePairings(
      walkSourceFiles(root, isTestFile),
      root,
    );

    expect(result).toEqual([path.join(path.basename(root), "tile.ts")]);
  });

  it("MUTATION: fixing the same fixture (motion-reduce:scale-none instead) makes the scan report nothing", () => {
    // Required mutation for the check above, kept as a standing assertion:
    // same fixture, the one-utility swap this bead actually ships, proving
    // the "found nothing" result is live rather than a scanner that
    // silently stopped looking.
    const root = fixture({
      "tile.ts": [
        "export const TILE_IMAGE_CLASS =",
        '  "h-full w-full object-cover transition-transform duration-300 ' +
          'ease-out group-hover:scale-[1.04] motion-reduce:scale-none ' +
          'motion-reduce:transition-none";',
      ].join("\n"),
    });

    const result = findTransformNoneScalePairings(
      walkSourceFiles(root, isTestFile),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not flag an unrelated transform-none guard and an unrelated scale utility that merely share one FILE", () => {
    // Two DIFFERENT class strings, each innocent on its own - the pairing
    // this gate hunts for is "on the same element" (the same class
    // string), not "anywhere in the same file". A file-level (rather than
    // string-level) check would wrongly flag this.
    const root = fixture({
      "two-elements.ts": [
        'export const A = "transition-transform motion-reduce:transform-none";',
        'export const B = "group-hover:scale-110";',
      ].join("\n"),
    });

    const result = findTransformNoneScalePairings(
      walkSourceFiles(root, isTestFile),
      root,
    );

    expect(result).toEqual([]);
  });

  it("ignores a comment that merely discusses the pairing, rather than shipping it", () => {
    const root = fixture({
      "documented.ts": [
        "/**",
        " * Do not write group-hover:scale-[1.04] motion-reduce:transform-none",
        " * here - it is a no-op, see ugcportal-ig4g.",
        " */",
        'export const CLASS = "h-full w-full object-cover";',
      ].join("\n"),
    });

    const result = findTransformNoneScalePairings(
      walkSourceFiles(root, isTestFile),
      root,
    );

    expect(result).toEqual([]);
  });

  it.each([
    ["translate", "group-hover:translate-x-4 motion-reduce:transform-none"],
    ["negative translate-y", "hover:-translate-y-0.5 motion-reduce:transform-none"],
    ["rotate", "group-hover:rotate-6 motion-reduce:transform-none"],
    ["skew", "hover:skew-x-3 motion-reduce:transform-none"],
  ])("also catches the same pairing for a %s utility", (_label, classString) => {
    const root = fixture({
      "other-utility.ts": `export const CLASS = "${classString}";`,
    });

    const result = findTransformNoneScalePairings(
      walkSourceFiles(root, isTestFile),
      root,
    );

    expect(result).toEqual([path.join(path.basename(root), "other-utility.ts")]);
  });
});
