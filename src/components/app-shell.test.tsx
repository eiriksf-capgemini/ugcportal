import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindPostcss from "@tailwindcss/postcss";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * K4 (ugcportal-j4j): the skip link must not render with zero padding at the
 * moment it becomes visible.
 *
 * Asserting the classes are present in the markup does not prove this - the
 * bug this guards against (finding 4) shipped with exactly the right classes
 * present. `focus-visible:not-sr-only` resets padding to 0 in the same rule
 * that un-hides the link, at specificity (0,2,0) (a class plus a
 * pseudo-class), which beats a plain `px-3`/`py-2` at (0,1,0) regardless of
 * source order. So this compiles the real component's classes against the
 * real vendored Tailwind and the real stylesheet, then resolves the CSS
 * cascade - specificity, then source order - for the padding properties by
 * hand, the same way contrast.ts resolves colour by hand rather than asking
 * a browser: this repo has no browser test runner yet (ugcportal-2al), and a
 * hand-rolled resolver that is provably right about specificity and order is
 * a stronger guarantee than eyeballing class names.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SHELL_PATH = path.join(HERE, "app-shell.tsx");
const GLOBALS_CSS_PATH = path.resolve(HERE, "..", "app", "globals.css");

/**
 * Pulls the skip link's className directly out of the shipped component, so
 * this test always exercises what ships rather than a copy that can drift
 * out of step with it.
 */
function skipLinkClassName(): string {
  const source = readFileSync(APP_SHELL_PATH, "utf8");
  const match = /href="#main-content"[\s\S]*?className="([^"]+)"/.exec(
    source,
  );
  if (!match) {
    throw new Error(
      "app-shell.test.tsx: could not find the skip link's className in app-shell.tsx",
    );
  }
  return match[1];
}

/**
 * Compiles `classNames` against the real globals.css with the real (vendored)
 * Tailwind - restricted to exactly those classes, and nothing else the app
 * happens to use elsewhere.
 *
 * ugcportal-j4j round 2 finding 5: `@import GLOBALS_CSS_PATH` alone pulls in
 * globals.css's own unrestricted `@import "tailwindcss";`, which by default
 * scans this entire repo for candidate class names - not just the
 * `@source inline(...)` this function adds. The compiled output ends up
 * containing every utility any page uses (`.p-4`, `.py-24`, `.container`,
 * even a `.sm:px-6` from inside an unrelated `@media` block, treated by
 * resolvePaddingCascade as unconditional), so an unrelated padding utility
 * added to some other component could silently change which rule wins here.
 * Rewriting that one line to add `source(none)` disables the automatic scan
 * for this compile while leaving the theme and every other import intact, so
 * only the classes this function explicitly asks for are compiled.
 */
async function compile(classNames: string): Promise<string> {
  const globalsCss = readFileSync(GLOBALS_CSS_PATH, "utf8");
  const restricted = globalsCss.replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  if (restricted === globalsCss) {
    throw new Error(
      'app-shell.test.tsx: expected globals.css to start with exactly \'@import "tailwindcss";\' ' +
        "so this test can disable Tailwind's automatic whole-project source scan for it. " +
        "If that import line changed shape, update this replacement to match.",
    );
  }
  const input = `${restricted}\n@source inline(${JSON.stringify(classNames)});\n`;
  const result = await postcss([
    tailwindPostcss({ base: path.dirname(GLOBALS_CSS_PATH) }),
  ]).process(input, { from: GLOBALS_CSS_PATH });
  return result.css;
}

/**
 * A minimal CSS specificity tuple (id, class-or-attr-or-pseudo-class,
 * type-or-pseudo-element). Scoped deliberately to what Tailwind actually
 * emits for a single utility-with-variants selector - one compound selector,
 * escaped classes, zero or more trailing pseudo-classes, no combinators, no
 * IDs, no element selectors. A general CSS selector parser is out of scope;
 * this is not one.
 */
type Specificity = readonly [number, number, number];

function specificityOf(selector: string): Specificity {
  const ids = (selector.match(/(?<!\\)#/g) ?? []).length;
  const classes = (selector.match(/(?<!\\)\./g) ?? []).length;
  const pseudoClasses = (selector.match(/(?<!\\):[a-zA-Z-]+/g) ?? []).length;
  return [ids, classes + pseudoClasses, 0];
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Physical padding longhands, the level the cascade actually resolves at.
 * `padding` and the logical `padding-inline`/`padding-block` shorthands all
 * expand to some subset of these four; two rules setting different Tailwind
 * property *names* can still be competing for the same physical property.
 * LTR-only, which matches this app (no `dir="rtl"` support exists yet).
 */
const PHYSICAL_PADDING = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;
type PhysicalPadding = (typeof PHYSICAL_PADDING)[number];

function expandPaddingDeclaration(
  property: string,
  value: string,
): Partial<Record<PhysicalPadding, string>> {
  if (property === "padding") {
    // Tailwind only ever emits the all-sides shorthand form here (`padding: 0`
    // in `not-sr-only`), never the 2- or 4-value form, so a single value
    // applying to all four sides is the only case this needs to handle.
    return Object.fromEntries(PHYSICAL_PADDING.map((p) => [p, value]));
  }
  if (property === "padding-inline") {
    return { "padding-left": value, "padding-right": value };
  }
  if (property === "padding-block") {
    return { "padding-top": value, "padding-bottom": value };
  }
  if ((PHYSICAL_PADDING as readonly string[]).includes(property)) {
    return { [property]: value };
  }
  return {};
}

/**
 * Resolves the winning value for each physical padding property across every
 * rule in `@layer utilities`, using the real CSS cascade algorithm:
 * specificity first, then source (document) order. Rules outside
 * `@layer utilities` (Preflight's own `@layer base` reset, notably) are
 * excluded on purpose - Tailwind's layer order already puts `base` before
 * `utilities`, so a base-layer rule can never win against a utilities-layer
 * one no matter its specificity, and folding that into a general
 * layer-precedence resolver would be solving a problem this component does
 * not have.
 */
function resolvePaddingCascade(
  css: string,
): Record<PhysicalPadding, string | undefined> {
  const root = postcss.parse(css);
  const winners: Partial<
    Record<PhysicalPadding, { value: string; specificity: Specificity; order: number }>
  > = {};
  let order = 0;

  root.walkAtRules("layer", (atRule) => {
    if (atRule.params !== "utilities") return;
    atRule.walkRules((rule: Rule) => {
      const currentOrder = order;
      order += 1;
      const specificity = specificityOf(rule.selector);
      rule.walkDecls((decl) => {
        const expanded = expandPaddingDeclaration(decl.prop, decl.value);
        for (const [prop, value] of Object.entries(expanded)) {
          const key = prop as PhysicalPadding;
          const existing = winners[key];
          const specificityCompare = existing
            ? compareSpecificity(specificity, existing.specificity)
            : 1;
          if (
            !existing ||
            specificityCompare > 0 ||
            (specificityCompare === 0 && currentOrder >= existing.order)
          ) {
            winners[key] = { value, specificity, order: currentOrder };
          }
        }
      });
    });
  });

  return {
    "padding-top": winners["padding-top"]?.value,
    "padding-right": winners["padding-right"]?.value,
    "padding-bottom": winners["padding-bottom"]?.value,
    "padding-left": winners["padding-left"]?.value,
  };
}

describe("the skip link's focus-visible padding", () => {
  it("resolves the classes it actually ships to something (sanity check on the test itself)", () => {
    const className = skipLinkClassName();
    expect(className).toContain("sr-only");
    expect(className).toContain("focus-visible:not-sr-only");
  });

  it("survives not-sr-only's padding reset when it becomes visible, in the real compiled cascade", async () => {
    const className = skipLinkClassName();
    const css = await compile(className);
    const padding = resolvePaddingCascade(css);

    for (const side of PHYSICAL_PADDING) {
      expect(padding[side], `${side} was never set by any rule`).toBeDefined();
      expect(
        padding[side],
        `${side} resolved to "0" - not-sr-only's reset won the cascade, so the ` +
          `skip link has no padding at the exact moment focus-visible makes it visible`,
      ).not.toBe("0");
    }
  });

  it("proves the test can fail: the un-patched class list loses the specificity tie", async () => {
    // Same classes, minus the focus-visible:px-3/py-2 the fix adds. This is
    // finding 4 exactly as it shipped: not-sr-only's `padding: 0` at (0,2,0)
    // beats the bare `px-3`/`py-2` at (0,1,0).
    const buggyClassName = skipLinkClassName()
      .replace(/\s*focus-visible:px-3\b/, "")
      .replace(/\s*focus-visible:py-2\b/, "");
    expect(buggyClassName).not.toContain("focus-visible:px-3");

    const css = await compile(buggyClassName);
    const padding = resolvePaddingCascade(css);

    expect(padding["padding-left"]).toBe("0");
    expect(padding["padding-top"]).toBe("0");
  });

  /**
   * ugcportal-j4j round 2 finding 5. Without `source(none)`, `compile()`
   * pulled in every utility this repo's other pages and components happen to
   * use, so this suite's outcome depended on padding classes added somewhere
   * else entirely - not just the skip link's own classes.
   */
  it("compiles only the skip link's own classes, not every utility the app happens to use elsewhere", async () => {
    const css = await compile(skipLinkClassName());
    // .p-4, .py-24 and .container are real utilities used elsewhere in this
    // app (page padding, page shells) but never on the skip link; a
    // media-gated utility like .sm:px-6 is a sharper check still, since an
    // unscoped compile would include it as if it were unconditional.
    for (const unrelated of [".p-4 ", ".py-24 ", ".container ", "sm\\:px-6"]) {
      expect(css, `unrelated utility "${unrelated}" leaked into the compile`).not.toContain(
        unrelated,
      );
    }
    // The skip link's own classes must still be there - this is a scoping
    // check, not a "compile nothing" check.
    expect(css).toContain("not-sr-only");
    expect(css).toContain("px-3");
  });
});
