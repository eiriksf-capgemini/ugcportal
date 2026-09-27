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
 * Pulls the skip link's className out of component source, so this test
 * always exercises what ships rather than a copy that can drift out of step
 * with it. Exported from `skipLinkClassName` as a pure function taking the
 * source text, so a test can mutate the *fixture* (a synthetic source
 * string) rather than only the production file, to prove the parser is
 * actually robust rather than merely happening to work on today's comments.
 *
 * ugcportal-j4j round 4 finding 4: matching against raw, unstripped source
 * means any comment between `href="#main-content"` and the real
 * `className="..."` that itself quotes a `className="..."` - and this file's
 * own comments do that constantly, including the one two fixes up in this
 * same file - would be matched instead, silently asserting against a string
 * that never renders. Comments are stripped first for the same reason
 * usage.ts strips them before scanning for utility classes.
 */
function extractSkipLinkClassName(source: string): string {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const match = /href="#main-content"[\s\S]*?className="([^"]+)"/.exec(stripped);
  if (!match) {
    throw new Error(
      "app-shell.test.tsx: could not find the skip link's className",
    );
  }
  return match[1];
}

function skipLinkClassName(): string {
  return extractSkipLinkClassName(readFileSync(APP_SHELL_PATH, "utf8"));
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
 * escaped classes, zero or more trailing *simple* pseudo-classes, no
 * combinators, no IDs, no element selectors. A general CSS selector parser
 * is out of scope; this is not one.
 *
 * That scope excludes functional pseudo-classes (`:is()`, `:where()`,
 * `:not()`) on purpose: their specificity is that of their most specific
 * argument per the Selectors spec, not "one pseudo-class", and computing
 * that correctly means parsing an arbitrary selector list recursively - the
 * general parser this function deliberately is not. ugcportal-j4j round 4
 * finding 3: the docstring said so, but nothing enforced it - `specificityOf`
 * would silently miscount one anyway. This repo's own globals.css defines
 * `@custom-variant dark (&:is(.dark *));`, so `dark:px-4` compiles to
 * `.dark\:px-4:is(.dark *)`, which the old unguarded version counted as
 * (0,3,0) (one class for the literal `.dark\:px-4`, one point for the `.dark`
 * *inside* the parens on top of that, one point for `:is` itself) when the
 * real answer, `:is(.dark *)` contributing the specificity of its single
 * most-specific argument (`.dark`, since `*` contributes nothing), is
 * (0,2,0) - a resolver silently picking the winner the browser would not.
 * Refusing is what usage.ts does for everything genuinely out of its scope;
 * this function does the same rather than guess.
 */
type Specificity = readonly [number, number, number];

function specificityOf(selector: string): Specificity {
  const functionalPseudoClass = /(?<!\\):[a-zA-Z-]+\(/.exec(selector);
  if (functionalPseudoClass) {
    throw new Error(
      `specificityOf: "${selector}" contains a functional pseudo-class ` +
        `(${functionalPseudoClass[0]}...) - out of scope for this hand-rolled ` +
        `calculator, whose specificity depends on its argument list per the ` +
        `Selectors spec rather than counting as a single pseudo-class. If the ` +
        `skip link starts using a variant that compiles to one (this repo's ` +
        `\`dark:\` is exactly such a case, via \`@custom-variant dark ` +
        `(&:is(.dark *))\`), this resolver needs teaching how to evaluate it, ` +
        `not a guess.`,
    );
  }
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
 * `padding`, the logical `padding-inline`/`padding-block` shorthands, and the
 * directional `padding-inline-start`/`padding-inline-end` (Tailwind's
 * `ps-*`/`pe-*`) all expand to some subset of these four; two rules setting
 * different Tailwind property *names* can still be competing for the same
 * physical property. LTR-only, which matches this app (no `dir="rtl"`
 * support exists yet) - under LTR, inline-start is left and inline-end is
 * right; an RTL-aware switch to `ps-*`/`pe-*` would need this updated, not
 * just expandPaddingDeclaration, since the mapping itself would flip.
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
  // ugcportal-j4j round 3 finding 5: the logical ps-/pe- (padding-inline-
  // start/-end) properties were missing entirely, so an RTL-aware component
  // switching px-3 to ps-3/pe-3 would have resolved to "no padding was ever
  // set" here - a false failure, not the true positive this resolver exists
  // to report.
  if (property === "padding-inline-start") {
    return { "padding-left": value };
  }
  if (property === "padding-inline-end") {
    return { "padding-right": value };
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

describe("extractSkipLinkClassName", () => {
  /**
   * ugcportal-j4j round 4 finding 4 (nit, harness family). A fixture
   * mutation, not a production-code change: constructs a synthetic source
   * string shaped exactly like the failure mode - a comment between `href`
   * and the real `className` that itself quotes a `className="..."` - and
   * confirms the parser still finds the real one. This is the harness's own
   * comments doing that (this file's docstrings quote `className="..."`
   * constantly), reproduced deliberately rather than trusted not to recur.
   */
  it("ignores a className mentioned inside a comment between href and the real one", () => {
    const source = `
      <a
        href="#main-content"
        /*
          Some prose about why this exists that happens to quote
          className="totally-wrong-classes-from-the-comment" as an example
          of what NOT to do.
        */
        className="sr-only real-classes-here"
      >
        Skip to content
      </a>
    `;
    expect(extractSkipLinkClassName(source)).toBe("sr-only real-classes-here");
  });

  it("ignores a className mentioned inside a line comment between href and the real one", () => {
    const source = `
      href="#main-content"
      // old value was className="stale-classes", now it is:
      className="sr-only real-classes-here"
    `;
    expect(extractSkipLinkClassName(source)).toBe("sr-only real-classes-here");
  });

  it("throws with an actionable message when it truly cannot find a skip link", () => {
    expect(() => extractSkipLinkClassName("no skip link here")).toThrow(
      /could not find the skip link/,
    );
  });
});

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

  /**
   * ugcportal-j4j round 3 finding 5 (nit). Without handling for the
   * logical `ps-`/`pe-` (padding-inline-start/-end) utilities,
   * resolvePaddingCascade could not see the padding an RTL-aware component
   * had actually set, so it would report "no padding at all" - a false
   * failure of this exact test, on a component that never shipped the bug
   * K4 guards against.
   */
  it("resolves the logical ps-/pe- utilities (padding-inline-start/-end), not just px-/py-", async () => {
    const css = await compile("sr-only focus-visible:not-sr-only focus-visible:ps-3 focus-visible:pe-3 focus-visible:py-2");
    const padding = resolvePaddingCascade(css);

    expect(padding["padding-left"], "padding-inline-start (ps-3)").not.toBe("0");
    expect(padding["padding-right"], "padding-inline-end (pe-3)").not.toBe("0");
  });

  /**
   * ugcportal-j4j round 4 finding 3 (nit, harness family). Fixture mutation,
   * not a production-code change: this repo's own `@custom-variant dark
   * (&:is(.dark *));` means `dark:` is a real, reachable variant, and the
   * unguarded specificityOf silently miscounted its compiled selector's
   * specificity (0,3,0) instead of the real (0,2,0). Rather than trust the
   * docstring's stated scope, this mutates the compiled input to actually
   * contain the shape the docstring says is out of scope, and confirms the
   * function notices rather than silently computing a wrong answer.
   */
  it("refuses to guess the specificity of a functional pseudo-class like dark's :is(.dark *)", async () => {
    const css = await compile("dark:px-4");
    expect(css).toContain(":is(.dark *)"); // sanity: the mutation actually reached this shape
    expect(() => resolvePaddingCascade(css)).toThrow(/functional pseudo-class/);
  });
});
