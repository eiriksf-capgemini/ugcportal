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
import { readFileSync } from "node:fs";
import path from "node:path";

import tailwindPostcss from "@tailwindcss/postcss";
import postcss, { type AtRule, type Container, type Root } from "postcss";
import { describe, expect, it } from "vitest";

import { GALLERY_TILE_IMAGE_CLASS } from "./containment";
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
