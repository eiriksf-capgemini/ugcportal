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

import eslintConfig, {
  INTERPOLATED_CLASSNAME_SELECTORS,
} from "./eslint.config.mjs";

/**
 * ugcportal-wz8w. Tailwind v4's content scanner statically scans source
 * TEXT for class-name substrings and never evaluates code, so a class built
 * by interpolating a runtime value into a template literal —
 * `` `sm:h-[${N}px]` `` — ships the literal `${N}` characters into the DOM
 * with no matching generated CSS rule at all. ugcportal-a3hj shipped this in
 * src/components/home/hero.tsx, past every automated gate (lint, every unit
 * test — which only inspect the markup STRING, and the string WAS present —
 * build and typecheck); only a live, seeded e2e render measuring
 * getBoundingClientRect() in a real browser caught it.
 *
 * Its shape there was a MODULE-LEVEL CONSTANT, not an inline className:
 * `` const HERO_VISUAL_CONTAINER_SM_CLASS = `sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px] …`; ``
 * referenced by identifier at the `cn()` call site (PR #215's own body, and
 * hero.tsx's surviving comment on why the two numbers must stay two
 * independent literals). That is why there are THREE selectors and not one:
 * the declarator selector is the one that covers the historical bug, and
 * the first round of this PR shipped only the className one.
 *
 * This drives the REAL `INTERPOLATED_CLASSNAME_SELECTORS` constant exported
 * from eslint.config.mjs (not a hand-copied duplicate that could drift from
 * what actually ships) through ESLint's own RuleTester, then — the same
 * two-layer shape eslint-gated-script.test.ts uses, because a selector that
 * is right but wired to the wrong file set still ships broken — through
 * `Linter.verify` against the REAL merged, exported `eslintConfig`, at
 * realistic file paths.
 *
 * K1's negative fixtures are the load-bearing half of this file: a plain
 * string literal in the exact same positions must raise NOTHING, so the
 * guard is shown to fire on the real interpolation shape and not merely on
 * the word `className`, the suffix `_CLASS`, or every template literal
 * anywhere.
 *
 * These fixtures live only as CODE STRINGS passed to RuleTester/
 * Linter.verify — never as on-disk .tsx files under src/ — specifically so
 * the K1 positive fixtures (which are DESIGNED to fail lint) can never be
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
  it("exports exactly the three selectors this file asserts on", () => {
    expect(
      INTERPOLATED_CLASSNAME_SELECTORS.map((entry) => entry.selector),
    ).toEqual([
      'JSXAttribute[name.name="className"] TemplateLiteral[expressions.length>=1]',
      "VariableDeclarator[id.name=/CLASS(ES)?$/] TemplateLiteral[expressions.length>=1]",
      "CallExpression[callee.name=/^(cn|clsx|classNames|classnames|cva|twMerge|twJoin)$/] TemplateLiteral[expressions.length>=1]",
    ]);
  });

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
          code: 'const x = <div data-id={`item-${id}`} className="sm:h-[240px]" />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // A template literal with a substitution used for a totally
        // different attribute, with className a plain literal alongside
        // it — the selector is scoped to the className attribute only.
        {
          code: 'const x = <img alt={`Photo ${index}`} className="h-28 w-28" />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // A static-looking class picked at runtime via a ternary of whole
        // literal strings — the repo's own documented escape hatch for
        // "the class depends on a runtime value" — carries no template
        // literal at all, so it is unaffected.
        {
          code: 'const x = <div className={cond ? "sm:h-[160px]" : "sm:h-[240px]"} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // cn()/clsx()-style helper with only plain string arguments: the
        // documented FIX for every site this guard flags, so it must be
        // clean under all three selectors at once.
        {
          code: 'const x = <div className={cn("base", cond && "sm:h-[240px]")} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        {
          code: 'export const GALLERY_TILE_CLASS = cn("group", GALLERY_TILE_BASE_CLASS, "cursor-zoom-in");',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // The declarator selector is scoped by NAME SUFFIX, not by "any
        // constant": an ordinary interpolated string — a log line, a URL,
        // an SQL fragment — is none of this guard's business. Without
        // this, the repo-wide hit count went from 12 to 367 (measured via
        // `npx eslint src` with selector 2's name-suffix requirement
        // removed, against commit b592ba0 — this PR's merge-base; the
        // count moves as `src/` changes, so re-run it rather than trust a
        // bare number) and the guard would have been suppressed almost
        // everywhere rather than obeyed.
        {
          code: "const message = `failed for ${id} at ${when}`;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        {
          code: "const label = `[${name}] ${value}`;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
        // A `_CLASS` constant assigned a plain string is the shape this
        // bead's own fixes produce; it must stay clean.
        {
          code: 'const SECTION_WRAPPER_CLASS = "mt-10";',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
        },
      ],
      invalid: [
        // K1 positive fixture: the exact declaration ugcportal-a3hj
        // shipped — a module-level `_CLASS` constant built by
        // interpolating an exported numeric constant into a template
        // literal, then referenced by identifier at the `cn()` call site.
        // Only the SECOND selector sees this one; the className selector
        // that shipped in round 1 of this PR did not.
        {
          code: "const HERO_VISUAL_CONTAINER_SM_CLASS = `sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px] sm:w-[${HERO_VISUAL_CONTAINER_SM_PX}px]`;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // Plural suffix, and an array of them rather than a bare string.
        {
          code: "const HERO_SIZE_CLASSES = [`sm:h-[${n}px]`, `sm:h-[${m}px]`];",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 2,
        },
        // The inline form: `sm:h-[${N}px]` built directly in the
        // className value.
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
        // TWO errors, not one: the className selector and the
        // class-helper-call selector both match, which is exactly the
        // overlap that makes the set resilient to either one being wrong.
        {
          code: 'const x = <div className={cn("base", `sm:h-[${n}px]`)} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 2,
        },
        // Nested inside a conditional, still inside the className
        // attribute's own expression tree.
        {
          code: 'const x = <div className={cond ? `sm:h-[${n}px]` : "sm:h-[160px]"} />;',
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // Nested inside a clsx-style conditional object key.
        {
          code: "const x = <div className={cn({ [`sm:h-[${n}px]`]: active })} />;",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 2,
        },
        // A `cva()` variant value — src/components/ui/button.tsx's own
        // `size.sm`/`size["header-sm"]` shape before this bead. No
        // className attribute and no `_CLASS` declarator anywhere near it;
        // only the third selector sees this.
        {
          code: "const v = cva('base', { variants: { size: { sm: `${A} rounded-[${r}px]` } } });",
          options: INTERPOLATED_CLASSNAME_SELECTORS,
          errors: 1,
        },
        // `cn()` used to build a constant outside any JSX at all — the
        // shape a `.ts` class module uses.
        {
          code: "export const X_THING = cn('a', `sm:h-[${n}px]`);",
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
 * block: proves the selectors are actually ROUTED to real files by the
 * `files`/`ignores` wiring in eslint.config.mjs, not just correct in
 * isolation against the bare selector constant.
 *
 * This is also K2's own test: `npm run lint` is the existing, already-
 * gating script, and it runs through exactly this merged config — these
 * assertions are the same end-to-end path short of spawning the CLI.
 */
describe("eslintConfig (the real merged, exported config) wires INTERPOLATED_CLASSNAME_SELECTORS to the right files", () => {
  const linter = new Linter({ configType: "flat" });

  /**
   * FAIL CLOSED (round-1 review of this PR, finding 1 — family 3).
   *
   * `message.ruleId` is `null` for everything that is NOT a rule result,
   * and there are two such cases a fixture in this file can hit by
   * accident, both of which produce ZERO rule results:
   *
   *   - a fatal parse error — `Parsing error: '>' expected.`, which is
   *     what JSX at a `.ts` filename produces, since TypeScript does not
   *     parse JSX there;
   *   - `No matching configuration found for <path>.`, which is what a
   *     filename outside this config's own `files` globs produces.
   *
   * The previous version of this helper ended in
   * `.filter((ruleId) => ruleId !== null)`, which DISCARDED both and
   * returned `[]`. That turned every `not.toContain(...)` assertion in
   * this file into one that could not fail — and one of them was
   * exactly that: a JSX fixture handed the FIXTURE PATH
   * "src/lib/fine" + ".ts" (a string, never a file on disk), which stayed
   * green with the real defect substituted in. Throwing instead means a fixture
   * ESLint could not actually lint is a RED test rather than a passing
   * one. `ruleIdsFor`'s own throwing behaviour is asserted by the first test
   * below.
   */
  function ruleIdsFor(code: string, filename: string): string[] {
    const messages = linter.verify(code, eslintConfig, { filename });
    const unlintable = messages.filter((message) => message.ruleId === null);
    if (unlintable.length > 0) {
      throw new Error(
        "eslint-interpolated-classname.test.ts: ESLint returned no rule " +
          `result for the fixture at ${filename} — ` +
          unlintable
            .map(
              (message) =>
                `${message.fatal ? "fatal: " : ""}${message.message}`,
            )
            .join("; ") +
          ". The fixture was never linted, so any assertion over its " +
          "rule ids would be vacuous.",
      );
    }
    return messages.map((message) => message.ruleId as string);
  }

  it("ruleIdsFor throws rather than returning [] for a fixture ESLint could not lint", () => {
    // The precise trap this helper used to fall into: JSX at a `.ts`
    // filename. TypeScript will not parse it, so the ONLY message is a
    // fatal one with `ruleId: null`.
    expect(() =>
      ruleIdsFor(
        'export function X() { return <div className="sm:h-[240px]" />; }',
        "src/lib/fine.ts",
      ),
    ).toThrow(/never linted/);
    // And the second null-ruleId case: a path no config object matches.
    expect(() =>
      ruleIdsFor("const a = 1;", "somewhere/outside/the/globs.txt"),
    ).toThrow(/never linted/);
  });

  it("K1/K2: flags the exact ugcportal-a3hj declaration — a module-level _CLASS constant built from a template literal", () => {
    // Reproduced from PR #215's own body and from hero.tsx's surviving
    // comment: the class was NOT written inline at the className, it was
    // a module constant referenced by identifier. This is the assertion
    // round 1 of this PR did not have, and could not have passed.
    const ruleIds = ruleIdsFor(
      "const HERO_VISUAL_CONTAINER_SM_CLASS = `sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px] sm:w-[${HERO_VISUAL_CONTAINER_SM_PX}px]`;\n" +
        "export function X() { return <div className={cn('x', HERO_VISUAL_CONTAINER_SM_CLASS)} />; }",
      "src/components/home/hero.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("K1/K2: flags the same declaration in a plain .ts class module", () => {
    // src/components/gallery/containment.ts and
    // src/components/site/section-heading.ts are `.ts` files holding
    // nothing but class constants, so the declarator selector has to be
    // routed to the NON-JSX half of the config's file partition too.
    const ruleIds = ruleIdsFor(
      "export const GALLERY_TILE_BASE_CLASS = `relative ${GALLERY_RADIUS_CLASS}`;",
      "src/components/gallery/containment.ts",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("K1/K2: flags a cva() variant value built from a template literal", () => {
    const ruleIds = ruleIdsFor(
      "const v = cva('base', { variants: { size: { sm: `${SM_BOX_MODEL} rounded-[${r}px]` } } });",
      "src/components/ui/button.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("K1/K2: flags the inline form in an ordinary .tsx component", () => {
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

  it("K1: does NOT flag the cn() form every site in this repo was converted to", () => {
    const ruleIds = ruleIdsFor(
      'export const GALLERY_TILE_CLASS = cn("group", GALLERY_TILE_BASE_CLASS);',
      "src/components/gallery/containment.ts",
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
    //
    // Both fixtures are `.tsx` — the first of them was `.ts` before this
    // PR's round-1 review, which is what made it vacuous (see
    // `ruleIdsFor`'s own comment).
    expect(
      ruleIdsFor(
        'export function X() { return <div className="sm:h-[240px]" />; }',
        "src/lib/fine.tsx",
      ),
    ).not.toContain("no-restricted-syntax");
    expect(
      ruleIdsFor(
        'export function X() { return <div data-id={`item-${id}`} className="sm:h-[240px]" />; }',
        "src/lib/fine.tsx",
      ),
    ).not.toContain("no-restricted-syntax");
  });

  it("MUTATION CHECK: an ordinary interpolated string that is not a class raises nothing", () => {
    // The declarator and helper-call selectors are deliberately NARROW.
    // Dropping either scope turns this guard into a ban on template
    // literals: measured via `npx eslint src` against commit b592ba0 (this
    // PR's merge-base), a name-unscoped version of selector 2
    // (`VariableDeclarator TemplateLiteral[expressions.length>=1]`) fires
    // 367 times against `src/` (96 outside test files), almost all of it
    // log lines, URLs and SQL — the count moves as `src/` changes, so
    // re-run the command above against a named commit rather than trust a
    // bare number. These two fixtures are what that would cost.
    expect(
      ruleIdsFor(
        "export const message = `failed for ${id} at ${when}`;",
        "src/lib/thing.ts",
      ),
    ).not.toContain("no-restricted-syntax");
    expect(
      ruleIdsFor(
        "export const label = `[${name}] ${value}`;",
        "src/lib/thing.ts",
      ),
    ).not.toContain("no-restricted-syntax");
  });

  it("KNOWN LIMIT: a class built outside all three syntactic places is NOT caught", () => {
    // Asserted, not just commented, so that widening the guard later
    // breaks this test and forces eslint.config.mjs's KNOWN LIMIT
    // paragraph to be rewritten with it — rather than leaving a stale
    // disclosure behind. `no-restricted-syntax` cannot resolve an
    // identifier back to its binding, so neither of these is reachable
    // without scope analysis.
    expect(
      ruleIdsFor(
        "const heroSize = `sm:h-[${n}px]`;\n" +
          "export function X() { return <div className={heroSize} />; }",
        "src/components/home/hero.tsx",
      ),
    ).not.toContain("no-restricted-syntax");
    expect(
      ruleIdsFor(
        "function tile(n) { return `sm:h-[${n}px]`; }\n" +
          "export function X() { return <div className={tile(3)} />; }",
        "src/components/home/hero.tsx",
      ),
    ).not.toContain("no-restricted-syntax");
  });

  it("KNOWN LIMIT: a test asserting on the class STRING is not collateral damage", () => {
    // src/components/home/hero.test.tsx:304 does exactly this — builds
    // the expected class with the same template literal the production
    // bug used, on purpose, to pin the constant against the literal. A
    // guard that fired here would have to be suppressed in the one file
    // that proves a3hj stays fixed.
    expect(
      ruleIdsFor(
        "it('x', () => { expect(markup).toContain(`sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px]`); });",
        "src/components/home/hero.test.tsx",
      ),
    ).not.toContain("no-restricted-syntax");
  });
});
