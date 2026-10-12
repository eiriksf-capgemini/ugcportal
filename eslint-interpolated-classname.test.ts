import { Linter, RuleTester } from "eslint";
// eslint/use-at-your-own-risk is exactly what it says: an internal API this
// test deliberately opts into to get at the built-in rule module
// (no-restricted-syntax) directly, the only way to unit-test a
// *configuration* of a built-in rule without shelling out to the CLI — the
// same technique eslint-gated-script.test.ts already uses for
// GATED_SCRIPT_SYNTAX_SELECTORS.
import { builtinRules } from "eslint/use-at-your-own-risk";
import parser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";

import eslintConfig, { INTERPOLATED_CLASSNAME_SELECTORS } from "./eslint.config.mjs";

/**
 * ugcportal-wz8w. Tailwind v4's content scanner statically scans source
 * TEXT for class-name substrings and never evaluates code, so a `className`
 * built by interpolating a runtime value into a template literal —
 * `` `sm:h-[${N}px]` `` — ships the literal `${N}` characters into the DOM
 * with no matching generated CSS rule at all. ugcportal-a3hj shipped exactly
 * this in src/components/home/hero.tsx, past every automated gate (lint,
 * every unit test — which only inspect the markup STRING, and the string
 * WAS present — build and typecheck); only a live, seeded e2e render
 * measuring getBoundingClientRect() in a real browser caught it.
 *
 * This drives the REAL `INTERPOLATED_CLASSNAME_SELECTORS` constant exported
 * from eslint.config.mjs (not a hand-copied duplicate that could drift from
 * what actually ships) through ESLint's own RuleTester, then — the same
 * two-layer shape eslint-gated-script.test.ts uses, because a selector that
 * is right but wired to the wrong file set still ships broken — through
 * `Linter.verify` against the REAL merged, exported `eslintConfig`, at
 * realistic file paths.
 *
 * K1's negative fixture is the load-bearing half of this file: a plain
 * string literal in the exact same className position must raise NOTHING,
 * so the guard is shown to fire on the real interpolation shape and not
 * merely on the word `className` or on every template literal anywhere.
 *
 * These fixtures live only as CODE STRINGS passed to RuleTester/
 * Linter.verify — never as on-disk .tsx files under src/ — specifically so
 * the K1 positive fixture (which is DESIGNED to fail lint) can never be
 * picked up by `npm run lint`'s own normal file-glob scan of the repo.
 */

const tester = new RuleTester({
  languageOptions: {
    parser,
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const noRestrictedSyntax = builtinRules.get("no-restricted-syntax");
if (!noRestrictedSyntax) {
  throw new Error(
    "eslint-interpolated-classname.test.ts: expected ESLint's builtinRules " +
      "map to contain 'no-restricted-syntax' — ESLint's internal API may " +
      "have changed shape.",
  );
}

describe("eslint.config.mjs: INTERPOLATED_CLASSNAME_SELECTORS", () => {
  it("passes ESLint's own RuleTester", () => {
    tester.run("INTERPOLATED_CLASSNAME_SELECTORS", noRestrictedSyntax, {
      valid: [
        // K1 negative fixture: a plain string literal in the exact same
        // className position as the positive fixture below, no
        // interpolation at all. This is the shape that must NOT be
        // flagged — proving the selector fires on the interpolation, not
        // on the mere presence of `className`.
        {
          code: 'const x = <div className="sm:h-[240px]" />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // A template literal with NO substitutions is fully static source
        // text — Tailwind's scanner reads it exactly like a plain string,
        // so it must not be flagged either.
        {
          code: "const x = <div className={`sm:h-[240px]`} />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // Interpolation elsewhere in the element (not in className) is
        // unrelated to this guard.
        {
          code: "const x = <div data-id={`item-${id}`} className=\"sm:h-[240px]\" />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // A template literal with a substitution used for a totally
        // different attribute, with className a plain literal alongside
        // it — the selector is scoped to the className attribute only.
        {
          code:
            'const x = <img alt={`Photo ${index}`} className="h-28 w-28" />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // A static-looking class picked at runtime via a ternary of whole
        // literal strings — the repo's own documented escape hatch for
        // "the class depends on a runtime value" — carries no template
        // literal at all, so it is unaffected.
        {
          code:
            'const x = <div className={cond ? "sm:h-[160px]" : "sm:h-[240px]"} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // cn()/clsx()-style helper with only plain string arguments.
        {
          code: 'const x = <div className={cn("base", cond && "sm:h-[240px]")} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
      ],
      invalid: [
        // K1 positive fixture: the exact shape ugcportal-a3hj shipped —
        // `sm:h-[${N}px]` built by interpolating a runtime value directly
        // into a template literal used as the className value.
        {
          code: "const x = <div className={`sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px]`} />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // The same shape with a different (shorter) runtime expression, so
        // the assertion isn't reading a needle tied to one identifier name.
        {
          code: "const x = <div className={`sm:h-[${n}px]`} />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // Passed into a helper rather than used directly — the bead's own
        // wording is "used as (or passed into) a JSX className value".
        {
          code: 'const x = <div className={cn("base", `sm:h-[${n}px]`)} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // Nested inside a conditional, still inside the className
        // attribute's own expression tree.
        {
          code: "const x = <div className={cond ? `sm:h-[${n}px]` : \"sm:h-[160px]\"} />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // Nested inside a clsx-style conditional object key.
        {
          code: "const x = <div className={cn({ [`sm:h-[${n}px]`]: active })} />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
      ],
    });
  });
});

/**
 * Same two-layer shape as eslint-gated-script.test.ts's own
 * "eslintConfig (the real merged, exported config) wires..." describe
 * block: proves the selector is actually ROUTED to real files by the
 * `files`/`ignores` wiring in eslint.config.mjs, not just correct in
 * isolation against the bare selector constant.
 *
 * This is also K2's own test: `npm run lint` is the existing, already-
 * gating script, and it runs through exactly this merged config — these
 * assertions are the same end-to-end path short of spawning the CLI.
 */
describe("eslintConfig (the real merged, exported config) wires INTERPOLATED_CLASSNAME_SELECTORS to the right files", () => {
  const linter = new Linter({ configType: "flat" });

  function ruleIdsFor(code: string, filename: string): string[] {
    return linter
      .verify(code, eslintConfig, { filename })
      .map((message) => message.ruleId)
      .filter((ruleId): ruleId is string => ruleId !== null);
  }

  it("K1/K2: flags the exact ugcportal-a3hj shape in an ordinary .tsx component", () => {
    const ruleIds = ruleIdsFor(
      "export function X() { return <div className={`sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px]`} />; }",
      "src/components/home/hero.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("K1: does NOT flag a plain string literal in the same position", () => {
    const ruleIds = ruleIdsFor(
      'export function X() { return <div className="sm:h-[240px]" />; }',
      "src/components/home/hero.tsx",
    );
    expect(ruleIds).not.toContain("no-restricted-syntax");
  });

  it("flags the interpolated shape passed into cn() in an ordinary .tsx component", () => {
    const ruleIds = ruleIdsFor(
      'export function X() { return <div className={cn("base", `sm:h-[${n}px]`)} />; }',
      "src/components/home/hero.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("flags the interpolated shape in a .jsx file", () => {
    const ruleIds = ruleIdsFor(
      "export function X() { return <div className={`sm:h-[${n}px]`} />; }",
      "src/components/evil.jsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("flags the interpolated shape in a plain .js file (Next compiles JSX there too)", () => {
    const ruleIds = ruleIdsFor(
      "export function X() { return <div className={`sm:h-[${n}px]`} />; }",
      "src/lib/evil.js",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("still flags the interpolated shape inside the gated consent loader itself", () => {
    // The loader is exempt from the SCRIPT-tag ban (it IS the gate) but
    // nothing about that exemption has anything to do with how it authors
    // Tailwind classes — it still gets the hex-colour guardrail (see
    // eslint.config.mjs's own loader config object), and must still get
    // this one.
    const ruleIds = ruleIdsFor(
      "export function X() { return <div className={`sm:h-[${n}px]`} />; }",
      "src/components/consent/analytics-loader.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("MUTATION CHECK: an unrelated className and an unrelated interpolated attribute raise nothing", () => {
    // Fixture mutation for the assertions above: swap the interpolated
    // template literal for (a) a plain literal className and (b) an
    // interpolated template literal on a DIFFERENT attribute, in the same
    // file/component shape. If the selector had widened to "any template
    // literal with a substitution anywhere in the file" or to "any
    // className at all", these would fire and the assertions above would
    // be reading a needle that can never be absent.
    expect(
      ruleIdsFor(
        'export function X() { return <div className="sm:h-[240px]" />; }',
        "src/lib/fine.ts",
      ),
    ).not.toContain("no-restricted-syntax");
    expect(
      ruleIdsFor(
        "export function X() { return <div data-id={`item-${id}`} className=\"sm:h-[240px]\" />; }",
        "src/lib/fine.tsx",
      ),
    ).not.toContain("no-restricted-syntax");
  });
});
