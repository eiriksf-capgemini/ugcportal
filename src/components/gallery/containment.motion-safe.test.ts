/**
 * ugcportal-ig4g, round-1 review (PR #101): the removed Playwright test's
 * job - proving the hover-scale rule actually lives inside a
 * `prefers-reduced-motion: no-preference` gate, and that no competing
 * UNGATED version of the same rule exists - is cheaper and more precise to
 * check by compiling the real, vendored Tailwind than by driving a real
 * browser. Compiling is also IMMUNE to the problem that sank the Playwright
 * version of this check (round-1 review): no database, no dev server, no
 * SQLITE_BUSY from parallel workers, nothing for another e2e suite's
 * assumptions about what the shared dev database holds to collide with.
 *
 * Same technique as `src/components/site-header.height.test.ts` (itself
 * following `src/components/app-shell.test.tsx`'s own `compile()`): restrict
 * Tailwind's source scan to exactly the ONE class string this test cares
 * about via `@source inline(...)` over a `source(none)`-patched copy of the
 * real globals.css, so no unrelated utility shipped anywhere else in this
 * app can change what gets compiled here. Not consolidated into a shared
 * helper (same reasoning `no-raw-hex.test.ts`'s header gives for NOT
 * centralising scan-source.ts's sibling, `usage.ts`): this is the third
 * independent copy of the same few lines, and each of the three has already
 * drifted once in a small, deliberate way (this file resolves media-query
 * NESTING rather than cascade specificity, which is a different enough job
 * that sharing would mean a shared helper doing two things).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import tailwindPostcss from "@tailwindcss/postcss";
import postcss, { type AtRule, type Container, type Root } from "postcss";
import { afterEach, describe, expect, it } from "vitest";

import { GALLERY_TILE_IMAGE_CLASS } from "./containment";
import { walkSourceFiles } from "@/lib/design/scan-source";
import { GLOBALS_CSS_PATH } from "@/lib/design/tokens";

async function compile(classNames: string): Promise<Root> {
  const globalsCss = readFileSync(GLOBALS_CSS_PATH, "utf8");
  const restricted = globalsCss.replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  if (restricted === globalsCss) {
    throw new Error(
      'containment.motion-safe.test.ts: expected globals.css to start with exactly ' +
        '\'@import "tailwindcss";\' so this test can disable Tailwind\'s automatic ' +
        "whole-project source scan for it.",
    );
  }
  const input = `${restricted}\n@source inline(${JSON.stringify(classNames)});\n`;
  const result = await postcss([
    tailwindPostcss({ base: path.dirname(GLOBALS_CSS_PATH) }),
  ]).process(input, { from: GLOBALS_CSS_PATH });
  return result.root;
}

/**
 * Every rule compiled from `root` whose selector contains BOTH "group-hover"
 * and "scale" (so it matches regardless of whether a `motion-safe:` prefix
 * is present - the whole point is to tell gated and ungated versions of the
 * SAME utility apart), paired with the `@media` conditions (outermost
 * first) it sits inside. An un-nested rule (compiled directly under the
 * stylesheet root, no `@media` wrapper at all) reports an empty array, not
 * `null` or an exception - that shape is exactly what BUG 2's pre-fix
 * selector compiles to (see containment.ts's own comment) and this
 * function needs to describe it, not refuse to.
 */
function groupHoverScaleRules(root: Root): { selector: string; mediaConditions: string[] }[] {
  const found: { selector: string; mediaConditions: string[] }[] = [];
  root.walkRules((rule) => {
    if (!rule.selector.includes("group-hover") || !rule.selector.includes("scale")) return;

    const mediaConditions: string[] = [];
    let parent: Container | undefined = rule.parent as Container | undefined;
    while (parent && parent.type !== "root") {
      if (parent.type === "atrule" && (parent as AtRule).name === "media") {
        mediaConditions.unshift((parent as AtRule).params);
      }
      parent = parent.parent as Container | undefined;
    }
    found.push({ selector: rule.selector, mediaConditions });
  });
  return found;
}

const NO_PREFERENCE_MEDIA = "(prefers-reduced-motion: no-preference)";

describe("GALLERY_TILE_IMAGE_CLASS's hover-scale rule is actually gated by prefers-reduced-motion (ugcportal-ig4g K1)", () => {
  it("the real, shipped class string compiles its group-hover:scale rule nested inside @media (prefers-reduced-motion: no-preference), with no ungated sibling", async () => {
    const root = await compile(GALLERY_TILE_IMAGE_CLASS);
    const rules = groupHoverScaleRules(root);

    expect(
      rules.length,
      `expected exactly one compiled rule for the group-hover scale utility in ` +
        `GALLERY_TILE_IMAGE_CLASS, found ${rules.length}: ` +
        `${JSON.stringify(rules)}`,
    ).toBe(1);
    expect(
      rules[0].mediaConditions,
      `GALLERY_TILE_IMAGE_CLASS's hover-scale rule (${rules[0].selector}) must sit ` +
        `inside @media ${NO_PREFERENCE_MEDIA} - found media conditions ` +
        `${JSON.stringify(rules[0].mediaConditions)} instead. Without this gate the ` +
        `rule exists under prefers-reduced-motion: reduce too, where a bare ` +
        `motion-reduce:scale-none cannot reliably out-specificity it (see ` +
        `containment.ts's own BUG 2 comment).`,
    ).toContain(NO_PREFERENCE_MEDIA);
  });

  /**
   * MUTATION CHECK 1 (round-1 review's own finding): the shape this test
   * must NOT wrongly call clean - `motion-reduce:scale-none` swapped in for
   * `motion-reduce:transform-none`, but the triggering utility itself still
   * bare `group-hover:scale-[1.04]`, no `motion-safe:` anywhere. Proves this
   * test is not vacuously satisfied by any class string that merely
   * contains the word "scale-none" somewhere.
   */
  it("MUTATION CHECK: the pre-fix 'scale-none' shape (bare group-hover:scale, no motion-safe:) compiles its rule with NO prefers-reduced-motion gate", async () => {
    const buggyClass =
      "h-full w-full object-cover transition-transform duration-300 ease-out " +
      "group-hover:scale-[1.04] motion-reduce:scale-none motion-reduce:transition-none";

    const root = await compile(buggyClass);
    const rules = groupHoverScaleRules(root);

    expect(rules.length).toBe(1);
    expect(
      rules[0].mediaConditions,
      "the pre-fix shape must NOT be reported as gated by prefers-reduced-motion - " +
        "if it is, this test can never tell the broken shape from the real fix",
    ).not.toContain(NO_PREFERENCE_MEDIA);
  });

  /** MUTATION CHECK 2: the ORIGINAL bug (motion-reduce:transform-none), for completeness - same ungated shape, different (irrelevant) sibling guard. */
  it("MUTATION CHECK: the original pre-fix shape (motion-reduce:transform-none) also compiles its rule with NO prefers-reduced-motion gate", async () => {
    const buggyClass =
      "h-full w-full object-cover transition-transform duration-300 ease-out " +
      "group-hover:scale-[1.04] motion-reduce:transform-none motion-reduce:transition-none";

    const root = await compile(buggyClass);
    const rules = groupHoverScaleRules(root);

    expect(rules.length).toBe(1);
    expect(rules[0].mediaConditions).not.toContain(NO_PREFERENCE_MEDIA);
  });
});

/**
 * NO FILE TAILWIND'S REAL BUILD SCANS SHIPS EITHER PRE-FIX STRING BARE
 * (round-5 review, PR #101): everything above compiles a single class
 * string in ISOLATION (`source(none)` plus `@source inline(...)`), which
 * proves the RULE is correct but cannot catch a completely different
 * failure mode - Tailwind's real, automatic, whole-project source scan
 * reading an UNBROKEN mention of a dangerous bare class name somewhere
 * this isolated compile never looks (a test fixture string, a doc-comment
 * quoting the pre-fix shape for illustration) and compiling a SECOND,
 * UNGATED copy of the same rule into the actual production build. That is
 * exactly what happened: src/lib/design/motion-reduce-pairing.test.ts's
 * own fixtures, and explanatory comments in containment.ts, button.tsx,
 * portfolio-tile.tsx and e2e/gallery-tile-reduced-motion.spec.ts that
 * quoted the bare pre-fix strings for documentation, were all measured
 * compiling straight into the real built `next build` CSS - growing it by
 * roughly 147 dead rules and reintroducing the exact two now-fixed ungated
 * rules this describe block exists to pin shut.
 *
 * NOT implemented as a second `postcss`/`@tailwindcss/postcss` compile of
 * the whole project the way the block above compiles ONE class string
 * (round-5 review, caught the hard way): invoking the real plugin
 * STANDALONE, outside an actual Next.js/Turbopack build, was measured
 * NOT to reproduce automatic whole-project detection at all - a
 * deliberately reintroduced bare mention of either string, inside a
 * REAL production file, produced ZERO matching rules from that approach
 * where the real `next build` produces one. A test that cannot fail is
 * worse than no test, so this does not try to re-simulate Tailwind's own
 * scanner; it directly encodes the rule the scanner effectively applies -
 * "an unbroken, unprefixed mention of this string anywhere in a scanned
 * file's raw bytes becomes a candidate" - as a text search over every
 * file Tailwind's automatic detection can reach (walking the WHOLE repo,
 * not just src/, since e2e/ is reachable too - confirmed by this bead's
 * own investigation), deliberately WITHOUT stripping comments first
 * (`stripComments`, which every other source-scan test in this file's
 * sibling, motion-reduce-pairing.test.ts, uses) - Tailwind's own scanner
 * has no notion of a comment either, which is the entire bug this test
 * exists to catch.
 */
/**
 * Matches globals.css's own `@source not` exclusions exactly:
 * *.test.ts/*.test.tsx anywhere under src/, and (ugcportal-61pv)
 * e2e/**\/*.spec.ts/*.spec.tsx - the glob that previously could not be made
 * to exclude anything, now confirmed working against a real `next build`
 * (see globals.css's own comment for what was measured and for why earlier
 * attempts failed).
 *
 * A *.spec.ts(x) file OUTSIDE e2e/ is deliberately NOT covered - the real
 * `@source not` glob is anchored to e2e/ specifically, not to the extension
 * alone, and this predicate mirrors that scope exactly rather than widening
 * it to "any spec file anywhere" - see the fixture tests below for both
 * directions.
 *
 * `root` is REQUIRED, and the e2e check is anchored to exactly
 * `<root>/e2e/` (round 2 review, two findings against the previous,
 * root-less version): a bare `file.split(path.sep).includes("e2e")` matches
 * the literal segment "e2e" ANYWHERE in `file`'s full path, which is wrong
 * in both directions the glob itself does not share -
 *
 *   1. a checkout whose path happens to contain an "e2e" segment ABOVE the
 *      repo root (e.g. `/home/builder/e2e/ugcportal/src/components/
 *      foo.spec.ts`) would exclude every *.spec.ts(x) file in the real
 *      tree, src/ included - the real glob never sees anything above the
 *      repo root at all;
 *   2. a *.spec.ts(x) file nested under some OTHER directory that happens
 *      to be named e2e/ (e.g. `src/some-feature/e2e/foo.spec.ts`) would
 *      also be wrongly excluded - the real glob resolves to
 *      `ROOT/e2e/**\/*.spec.ts(x)` specifically, nothing else.
 *
 * Both fixtures below ("an e2e segment above the root" and "a nested e2e/
 * directory under src") exercise one direction each. Deliberately NOT
 * scan-source.ts's own `${path.sep}generated${path.sep}` substring idiom
 * (round 2 review): that check is intentionally UNANCHORED - a generated/
 * directory is meant to be excluded wherever it occurs in the tree - while
 * this exclusion must be anchored to exactly one location (the repo's own
 * e2e/, matching the glob), so reusing the unanchored idiom here would
 * silently reintroduce the same bug this round fixes.
 */
function isExcludedFromTailwindScan(root: string, file: string): boolean {
  if (/\.test\.tsx?$/.test(file)) return true;
  if (!/\.spec\.tsx?$/.test(file)) return false;
  const e2eRoot = path.join(root, "e2e") + path.sep;
  return file.startsWith(e2eRoot);
}

/**
 * Each pattern requires the dangerous string to appear WITHOUT an
 * immediately-preceding `motion-safe:` - the real, shipped, correctly-gated
 * utility (`motion-safe:group-hover:scale-[1.04]`, `motion-safe:active:
 * not-aria-[haspopup]:translate-y-px`) must keep passing; only the bare,
 * ungated form is the regression this guards.
 *
 * The `group-hover:scale-` pattern matches ANY bracketed value, not only
 * the literal `1.04` (ugcportal-61pv): containment.ts's own doc comment was
 * found shipping `group-hover:scale-[…]` - the real value elided to an
 * ellipsis for illustration - which this gate's previous, value-pinned
 * regex could not see, and which compiled a second, ungated `scale: …` rule
 * into the real production stylesheet exactly like the pinned `1.04` shape
 * does. Widened to close that gap rather than adding a second, equally
 * pinnable pattern for one more literal value.
 *
 * The lookbehind is `(?<!(?<!not-)motion-safe:)`, not the simpler
 * `(?<!motion-safe:)` this started as (ugcportal-61pv round 2 - PLAUSIBLE
 * finding, reproduced): Tailwind v4 compiles `not-*` as a real variant
 * modifier on `motion-safe:` the same as on any other boolean variant -
 * confirmed by compiling `not-motion-safe:group-hover:scale-[1.04]` through
 * this same file's own `compile()` helper, which produces
 * `@media not (prefers-reduced-motion: no-preference) { @media
 * (hover:hover) { ...scale:1.04 } }` - i.e. the rule fires exactly when
 * reduced motion IS requested, the inverse of safe. A bare
 * `(?<!motion-safe:)` lookbehind cannot tell that shape from the real gate,
 * because the 12 characters immediately before `group-hover:scale-[` are
 * `motion-safe:` either way - `not-motion-safe:` ends in that same
 * substring. The nested lookbehind only treats `motion-safe:` as the real
 * gate when it is not ITSELF preceded by `not-`.
 */
const DANGEROUS_BARE_PATTERNS: readonly RegExp[] = [
  /(?<!(?<!not-)motion-safe:)active:not-aria-\[haspopup\]:translate-y-px/,
  /(?<!(?<!not-)motion-safe:)group-hover:scale-\[[^\]]*\]/,
];

/**
 * Every file (relative to `root`) containing a bare, unprefixed mention of
 * either removed rule. Exported-shape (module-local here, no other file
 * needs it) so the fixture test below drives the SAME function the
 * real-tree test uses, rather than a reimplementation.
 */
function findBareUngatedMentions(files: readonly string[], root: string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (DANGEROUS_BARE_PATTERNS.some((pattern) => pattern.test(source))) {
      offenders.push(path.relative(root, file));
    }
  }
  return offenders;
}

// ugcportal-9faa: walks the whole repository tree (not just src/) looking
// for a bare pattern in raw file bytes — no TypeScript parse, so cheaper
// than this bead's other tree-walking fixes, but still a real tree-wide
// walk+read (606ms unloaded) a busy machine can push further. Explicit
// timeout, not a bigger global default.
describe("no file Tailwind's real build can scan ships either pre-fix string bare and unprefixed (ugcportal-ig4g, round-5 review)", { timeout: 15_000 }, () => {
  const REPO_ROOT = path.resolve(path.dirname(GLOBALS_CSS_PATH), "..", "..");

  it("finds no bare, unprefixed mention of either removed rule in any scanned file", () => {
    const files = walkSourceFiles(REPO_ROOT, (file) =>
      isExcludedFromTailwindScan(REPO_ROOT, file),
    );
    expect(files.length).toBeGreaterThan(10);

    const offenders = findBareUngatedMentions(files, REPO_ROOT);

    expect(
      offenders,
      `a bare, unprefixed mention of a pre-fix ungated rule this bead removed ` +
        `was found in: ${offenders.join(", ")}. Tailwind's automatic source ` +
        `scan reads raw file bytes with no notion of "this is a comment, not ` +
        `a real className" - an UNBROKEN mention compiles a second, ungated ` +
        `copy of the rule into the real production stylesheet even though no ` +
        `component ever renders it. Break the string the same way ` +
        `containment.ts's/button.tsx's/portfolio-tile.tsx's/the e2e spec's own ` +
        `"space inserted here" comments already do, or move the fixture into a ` +
        `*.test.ts(x) file under src/, which globals.css's @source not ` +
        `exclusion already covers.`,
    ).toEqual([]);
  });
});

describe("findBareUngatedMentions (the real scanner, exercised over a real fixture on disk)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "bare-ungated-mentions-"));
    created.push(root);
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return root;
  }

  /**
   * MUTATION CHECK (round-5 review): proves the check above is not
   * vacuous - the exact regression that actually shipped (a production
   * file's doc comment quoting the bare, pre-fix string unbroken) is
   * caught when it is a real file on disk, not merely a string in memory.
   */
  it("MUTATION CHECK: catches a real production-shaped file with the exact pre-fix bare string in a comment", () => {
    const root = fixture({
      "containment-like.ts": [
        "/**",
        " * Tailwind compiles group-hover:scale-[1.04] to this selector.",
        " */",
        'export const X = "motion-safe:group-hover:scale-[1.04]";',
      ].join("\n"),
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual(["containment-like.ts"]);
  });

  it("MUTATION: breaking the same string with a space makes the scan report nothing", () => {
    const root = fixture({
      "containment-like.ts": [
        "/**",
        " * Tailwind compiles group-hover: scale-[1.04] to this selector.",
        " */",
        'export const X = "motion-safe:group-hover:scale-[1.04]";',
      ].join("\n"),
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not flag a *.test.ts fixture file - globals.css's own @source not already excludes it", () => {
    const root = fixture({
      "something.test.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([]);
  });

  it("STILL flags a *.spec.ts fixture file OUTSIDE e2e/ - only e2e/'s own specs are excluded", () => {
    const root = fixture({
      "something.spec.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual(["something.spec.ts"]);
  });

  /**
   * ugcportal-61pv: the real fix. globals.css's `@source not
   * "../../e2e/**\/*.spec.ts"` now genuinely excludes e2e/ from the real
   * `next build` (confirmed by planting this exact string in a real e2e
   * spec, building, and measuring the output - see globals.css's own
   * comment for the before/after sizes) - so a fixture nested under an
   * `e2e/` directory must no longer be flagged, the same as a *.test.ts
   * fixture under src/ already isn't.
   */
  it("does not flag a *.spec.ts fixture file under e2e/ - globals.css's own @source not now excludes it for real", () => {
    const root = fixture({
      "e2e/something.spec.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([]);
  });

  /**
   * A *.spec.ts file nested under a DIFFERENT directory that merely
   * contains the four letters "e2e" as part of a longer name (not the
   * literal path segment) must not be caught by the exclusion either -
   * proves the check is a path-SEGMENT match, not a substring search.
   */
  it("STILL flags a *.spec.ts fixture under a directory whose name merely contains \"e2e\" as a substring", () => {
    const root = fixture({
      "not-e2e-really/something.spec.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([path.join("not-e2e-really", "something.spec.ts")]);
  });

  /**
   * MUTATION CHECK (ugcportal-61pv): the shape that actually shipped -
   * containment.ts's own doc comment elided the real arbitrary value to an
   * ellipsis rather than writing out `1.04`, which the pre-widening,
   * value-pinned pattern could not see at all.
   */
  it("MUTATION CHECK: catches the ellipsis-elided shape the previous, value-pinned pattern missed", () => {
    const root = fixture({
      "containment-like.ts": [
        "/**",
        " * `GALLERY_TILE_IMAGE_CLASS`'s `group-hover:scale-[…]` has an ancestor",
        " * to key off.",
        " */",
        'export const X = "motion-safe:group-hover:scale-[1.04]";',
      ].join("\n"),
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual(["containment-like.ts"]);
  });

  it("MUTATION: breaking the ellipsis-elided shape with a space makes the scan report nothing", () => {
    const root = fixture({
      "containment-like.ts": [
        "/**",
        " * `GALLERY_TILE_IMAGE_CLASS`'s `group-hover: scale-[…]` has an ancestor",
        " * to key off.",
        " */",
        'export const X = "motion-safe:group-hover:scale-[1.04]";',
      ].join("\n"),
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not flag the correctly-gated active:not-aria-[haspopup] shape", () => {
    const root = fixture({
      "button-like.ts":
        'export const X = "motion-safe:active:not-aria-[haspopup]:translate-y-px";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([]);
  });

  it("flags the bare, ungated active:not-aria-[haspopup] shape", () => {
    const root = fixture({
      "button-like.ts": 'export const X = "active:not-aria-[haspopup]:translate-y-px";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual(["button-like.ts"]);
  });

  /**
   * ugcportal-61pv round 2 (CONFIRMED, reproduced): a checkout whose path
   * happens to contain a REAL directory segment literally named "e2e"
   * somewhere ABOVE the repo root (e.g. `/home/builder/e2e/ugcportal/...`,
   * or CI's own `/home/runner/work/e2e/ugcportal/...` shape) must not
   * exclude every *.spec.ts(x) file in the real tree - the actual `@source
   * not` glob never resolves to anything above the repo root at all. The
   * PREVIOUS, root-less `file.split(path.sep).includes("e2e")` predicate
   * could not tell this from the real e2e/ directory; anchoring to
   * `<root>/e2e/` can.
   */
  it("STILL flags a *.spec.ts fixture OUTSIDE e2e/ even when the checkout path itself has an 'e2e' ancestor directory above the fixture root", () => {
    const outer = mkdtempSync(path.join(tmpdir(), "bare-ungated-mentions-outer-"));
    created.push(outer);
    const e2eAncestor = path.join(outer, "e2e");
    mkdirSync(e2eAncestor, { recursive: true });
    const root = mkdtempSync(path.join(e2eAncestor, "checkout-"));
    created.push(root);
    writeFileSync(
      path.join(root, "something.spec.ts"),
      'export const X = "group-hover:scale-[1.04]";',
    );

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual(["something.spec.ts"]);
  });

  /**
   * ugcportal-61pv round 2 (CONFIRMED, reproduced): the other direction of
   * the same anchoring bug - a *.spec.ts file nested under some OTHER
   * directory that happens to be named e2e/ (not the repo-root one) must
   * still be flagged. The real `@source not` glob resolves to exactly
   * `ROOT/e2e/**\/*.spec.ts(x)`; `src/some-feature/e2e/foo.spec.ts` is not
   * under that path at all, so Tailwind's build does NOT exclude it, and
   * this scan must not either.
   */
  it("STILL flags a *.spec.ts fixture nested under a NON-root directory named e2e/", () => {
    const root = fixture({
      "src/some-feature/e2e/foo.spec.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([path.join("src", "some-feature", "e2e", "foo.spec.ts")]);
  });

  /**
   * ugcportal-61pv round 2 (PLAUSIBLE finding, reproduced): Tailwind v4
   * compiles `not-motion-safe:` as a real variant (confirmed above
   * DANGEROUS_BARE_PATTERNS's own comment) whose rule fires exactly when
   * reduced motion IS requested - the inverse of safe, and at least as
   * dangerous as the fully bare shape. The OLD `(?<!motion-safe:)`
   * lookbehind could not tell it apart from the real gate, because
   * `not-motion-safe:` ends in the same 12-character `motion-safe:`
   * substring the lookbehind checked for.
   */
  it("flags the not-motion-safe: inverse-variant shape, which fires under reduced motion rather than being gated by it", () => {
    const root = fixture({
      "containment-like.ts": 'export const X = "not-motion-safe:group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual(["containment-like.ts"]);
  });

  it("MUTATION: the correctly-gated motion-safe: shape (no not- prefix) is still not flagged", () => {
    const root = fixture({
      "containment-like.ts": 'export const X = "motion-safe:group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, (file) => isExcludedFromTailwindScan(root, file)),
      root,
    );

    expect(result).toEqual([]);
  });
});

/**
 * ugcportal-61pv round 2 (MEDIUM finding, review round 1): everything
 * above proves `isExcludedFromTailwindScan` behaves correctly in
 * isolation, but nothing previously asserted that it agrees with what
 * globals.css's OWN `@source not` lines actually say - so a regression
 * that changes one without the other (the exact failure mode round 1's
 * review reproduced: reverting the two-level `e2e/` glob back to its old,
 * broken one-level form, with the predicate left widened) passed every
 * unit test while leaking an ungated rule into the real `next build`
 * output. Two checks close that gap:
 *
 *   1. an exact-value assertion on the four `@source not` strings
 *      globals.css declares, so the glob cannot silently regress to the
 *      one-level form without this file going red first;
 *   2. a fixture suite proving `isExcludedFromTailwindScan` and THOSE
 *      SAME globs (read from the real globals.css, not a hand-copied
 *      literal) agree on which files are excluded, at several depths and
 *      for both the src/ and e2e/ exclusions.
 */
const SOURCE_NOT_GLOB_PATTERN = /@source not "([^"]+)";/g;

/** Every `@source not "..."` glob string globals.css currently declares, in file order. */
function readSourceNotGlobs(): string[] {
  const globalsCss = readFileSync(GLOBALS_CSS_PATH, "utf8");
  return [...globalsCss.matchAll(SOURCE_NOT_GLOB_PATTERN)].map((match) => match[1]);
}

/**
 * A minimal interpreter for EXACTLY the two `@source not` glob shapes this
 * repo's globals.css uses - `../**\/*.EXT` and `../../DIR/**\/*.EXT` - not a
 * general globbing engine (deliberately: see scan-source.ts's own header
 * for why a general-purpose dependency was preferred over hand-rolled
 * logic elsewhere in this file's siblings, and why this is narrow enough
 * not to need that here).
 *
 * Tailwind resolves every `@source` path relative to the file that
 * declares it (globals.css's own comment: "`@source` globs resolve
 * relative to THIS file's own directory, src/app"), so a leading run of
 * `../` segments walks up that many REAL directories from src/app before
 * the glob's own remaining segments - zero or more literal directory
 * names, then exactly one `**`, then exactly one filename pattern - apply
 * from there. Throws on any other shape, deliberately: silently matching
 * nothing would make the agreement test below pass vacuously instead of
 * flagging a glob this interpreter was never taught to read.
 */
function globToFileMatcher(glob: string): (absoluteFile: string) => boolean {
  const segments = glob.split("/");
  let anchor = path.dirname(GLOBALS_CSS_PATH);
  let cursor = 0;
  while (segments[cursor] === "..") {
    anchor = path.dirname(anchor);
    cursor++;
  }

  const literalDirs: string[] = [];
  while (segments[cursor] !== "**") {
    if (cursor >= segments.length) {
      throw new Error(`globToFileMatcher: expected a "**" segment in ${glob}`);
    }
    literalDirs.push(segments[cursor]);
    cursor++;
  }
  cursor++; // skip "**"
  if (cursor !== segments.length - 1) {
    throw new Error(
      `globToFileMatcher: expected exactly one filename segment after "**" in ${glob}`,
    );
  }
  const filenameGlob = segments[cursor];
  const filenamePattern = new RegExp(
    "^" +
      filenameGlob
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*") +
      "$",
  );

  return (absoluteFile: string): boolean => {
    const relative = path.relative(anchor, absoluteFile);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }
    const relativeSegments = relative.split(path.sep);
    if (relativeSegments.length < literalDirs.length + 1) return false;
    for (let i = 0; i < literalDirs.length; i++) {
      if (relativeSegments[i] !== literalDirs[i]) return false;
    }
    const filename = relativeSegments[relativeSegments.length - 1];
    return filenamePattern.test(filename);
  };
}

describe("globals.css's @source not globs and isExcludedFromTailwindScan agree (ugcportal-61pv round 2)", () => {
  const REPO_ROOT = path.resolve(path.dirname(GLOBALS_CSS_PATH), "..", "..");

  it("globals.css declares exactly the four @source not globs this repo relies on", () => {
    expect(readSourceNotGlobs()).toEqual([
      "../**/*.test.ts",
      "../**/*.test.tsx",
      "../../e2e/**/*.spec.ts",
      "../../e2e/**/*.spec.tsx",
    ]);
  });

  const matchers = readSourceNotGlobs().map(globToFileMatcher);

  function matchesAnySourceNotGlob(absoluteFile: string): boolean {
    return matchers.some((matches) => matches(absoluteFile));
  }

  const cases: readonly string[] = [
    "src/components/foo.test.ts",
    "src/components/foo.test.tsx",
    "src/lib/deep/nested/bar.test.ts",
    "src/components/foo.ts",
    "src/foo.spec.ts",
    "src/some-feature/e2e/foo.spec.ts",
    "e2e/foo.spec.ts",
    "e2e/foo.spec.tsx",
    "e2e/production/bar.spec.ts",
    "e2e/a/b/c/deep.spec.ts",
    "e2e/foo.ts",
    "somewhere-else/foo.spec.ts",
  ];

  it.each(cases)(
    "isExcludedFromTailwindScan and globals.css's own globs agree for %s",
    (relativePath) => {
      const absoluteFile = path.join(REPO_ROOT, relativePath);
      expect(
        isExcludedFromTailwindScan(REPO_ROOT, absoluteFile),
        `isExcludedFromTailwindScan and globals.css's @source not globs must agree on ` +
          `${relativePath} - a mismatch here means either Tailwind's real build or this ` +
          `repo's own text scanner disagrees with the other about which files are excluded.`,
      ).toBe(matchesAnySourceNotGlob(absoluteFile));
    },
  );
});
