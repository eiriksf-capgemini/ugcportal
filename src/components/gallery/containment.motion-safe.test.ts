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
/** Matches globals.css's own `@source not` exclusion exactly - *.test.ts/*.test.tsx under src/, which legitimately ship these strings as fixtures. Deliberately NOT *.spec.ts: e2e/'s specs are NOT excluded from Tailwind's scan (see globals.css's own comment), so this test has to see them too. */
function isExcludedFromTailwindScan(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

/**
 * Each pattern requires the dangerous string to appear WITHOUT an
 * immediately-preceding `motion-safe:` - the real, shipped, correctly-gated
 * utility (`motion-safe:group-hover:scale-[1.04]`, `motion-safe:active:
 * not-aria-[haspopup]:translate-y-px`) must keep passing; only the bare,
 * ungated form is the regression this guards.
 */
const DANGEROUS_BARE_PATTERNS: readonly RegExp[] = [
  /(?<!motion-safe:)active:not-aria-\[haspopup\]:translate-y-px/,
  /(?<!motion-safe:)group-hover:scale-\[1\.04\]/,
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

describe("no file Tailwind's real build can scan ships either pre-fix string bare and unprefixed (ugcportal-ig4g, round-5 review)", () => {
  const REPO_ROOT = path.resolve(path.dirname(GLOBALS_CSS_PATH), "..", "..");

  it("finds no bare, unprefixed mention of either removed rule in any scanned file", () => {
    const files = walkSourceFiles(REPO_ROOT, isExcludedFromTailwindScan);
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
      walkSourceFiles(root, isExcludedFromTailwindScan),
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
      walkSourceFiles(root, isExcludedFromTailwindScan),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not flag a *.test.ts fixture file - globals.css's own @source not already excludes it", () => {
    const root = fixture({
      "something.test.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, isExcludedFromTailwindScan),
      root,
    );

    expect(result).toEqual([]);
  });

  it("STILL flags a *.spec.ts fixture file - e2e/ specs are not excluded from Tailwind's scan", () => {
    const root = fixture({
      "something.spec.ts": 'export const X = "group-hover:scale-[1.04]";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, isExcludedFromTailwindScan),
      root,
    );

    expect(result).toEqual(["something.spec.ts"]);
  });

  it("does not flag the correctly-gated active:not-aria-[haspopup] shape", () => {
    const root = fixture({
      "button-like.ts":
        'export const X = "motion-safe:active:not-aria-[haspopup]:translate-y-px";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, isExcludedFromTailwindScan),
      root,
    );

    expect(result).toEqual([]);
  });

  it("flags the bare, ungated active:not-aria-[haspopup] shape", () => {
    const root = fixture({
      "button-like.ts": 'export const X = "active:not-aria-[haspopup]:translate-y-px";',
    });

    const result = findBareUngatedMentions(
      walkSourceFiles(root, isExcludedFromTailwindScan),
      root,
    );

    expect(result).toEqual(["button-like.ts"]);
  });
});
