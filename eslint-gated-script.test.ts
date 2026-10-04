import { Linter, RuleTester } from "eslint";
// eslint/use-at-your-own-risk is exactly what it says: an internal API this
// test deliberately opts into to get at the built-in rule modules
// (no-restricted-syntax/no-restricted-imports) directly, the only way to
// unit-test a *configuration* of a built-in rule without shelling out to
// the CLI.
import { builtinRules } from "eslint/use-at-your-own-risk";
import parser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";

import eslintConfig, {
  GATED_LOADER_PATH,
  GATED_SCRIPT_IMPORT_OPTIONS,
  GATED_SCRIPT_SYNTAX_SELECTORS,
} from "./eslint.config.mjs";

/**
 * Review round 2, MEDIUM finding 1: round 1's gated-script ESLint ban only
 * matched a `next/script` `ImportDeclaration` or a JSX `<script src>` in
 * `.tsx`/`.jsx` — `dangerouslySetInnerHTML` script-tag bootstraps,
 * `document.createElement("script")`, and a `.ts` barrel re-export of
 * `next/script` all passed both that rule and the K6 grep test silently.
 *
 * This drives the REAL configuration objects exported from
 * eslint.config.mjs (not a hand-copied duplicate that could drift from
 * what actually ships) through ESLint's own `RuleTester`, against
 * `eslint/use-at-your-own-risk`'s `builtinRules` map — the supported way to
 * unit-test a *configuration* of a built-in rule (`no-restricted-syntax`/
 * `no-restricted-imports`) without invoking the CLI. Each `invalid` case
 * below is the fixture the review asked for, one per bypass shape it
 * named. Before writing this file, each shape was also planted as a real
 * throwaway file under src/ and checked against `npm run lint` directly
 * (not just this RuleTester harness), confirmed to fail with this round's
 * selectors, then removed — this file is what keeps that proof standing
 * rather than a one-off manual check nobody re-runs.
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
const noRestrictedImports = builtinRules.get("no-restricted-imports");
if (!noRestrictedSyntax || !noRestrictedImports) {
  throw new Error(
    "eslint.config.test.ts: expected ESLint's builtinRules map to contain " +
      "'no-restricted-syntax' and 'no-restricted-imports' — ESLint's " +
      "internal API may have changed shape.",
  );
}

describe("eslint.config.mjs: gated-script syntax selectors (JSX/createElement)", () => {
  it("passes ESLint's own RuleTester", () => {
    tester.run("GATED_SCRIPT_SYNTAX_SELECTORS", noRestrictedSyntax, {
      valid: [
        // An ordinary element is untouched.
        { code: "const x = <div src=\"a\" />;", options: GATED_SCRIPT_SYNTAX_SELECTORS },
        // The gated <Script> COMPONENT (capital S) is a different rule's
        // job (no-restricted-imports, tested below) — this selector only
        // targets the literal lowercase `<script>` HTML element, so it
        // must NOT fire here. If it did, the one legitimate caller
        // (analytics-loader.tsx) would be unusable even where this
        // ruleset is scoped out.
        { code: "const x = <Script src=\"https://example.com/a.js\" />;", options: GATED_SCRIPT_SYNTAX_SELECTORS },
        // An unrelated createElement call.
        { code: "document.createElement(\"div\");", options: GATED_SCRIPT_SYNTAX_SELECTORS },
      ],
      invalid: [
        // Round 1's own shape, still caught.
        {
          code: "const x = <script src=\"https://stats.example/u.js\" />;",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // Round 2 finding 1, shape A: inline-snippet bootstrap via
        // dangerouslySetInnerHTML, no `src` attribute at all.
        {
          code: "const x = <script dangerouslySetInnerHTML={{ __html: snippet }} />;",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // A bare <script> with no attributes at all must also be caught —
        // round 1's selector required a `src` attribute and would have
        // missed this.
        {
          code: "const x = <script>{inertSnippet}</script>;",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // Round 2 finding 1, shape B: programmatic DOM construction, no
        // JSX and no import at all.
        {
          code: "document.createElement(\"script\");",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: "window.document.createElement(\"script\");",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // A dynamic `import("next/script")` — confirmed directly against
        // this repo's installed ESLint (see eslint.config.mjs's own
        // comment on this selector) that no-restricted-imports does NOT
        // flag an ImportExpression the way it flags a static
        // ImportDeclaration, so this is enforced here instead of in the
        // import/export describe block below.
        {
          code: 'async function load() { await import("next/script"); }',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
      ],
    });
  });
});

describe("eslint.config.mjs: gated-script import/export ban (no-restricted-imports)", () => {
  it("passes ESLint's own RuleTester", () => {
    tester.run("GATED_SCRIPT_IMPORT_OPTIONS", noRestrictedImports, {
      valid: [
        { code: 'import Something from "other-module";', options: GATED_SCRIPT_IMPORT_OPTIONS },
      ],
      invalid: [
        // A direct import, under any local binding name — round 1 already
        // caught this (the declaration's `source.value` is what's
        // checked, not the local name), re-asserted here as a baseline.
        {
          code: 'import Script from "next/script";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
          errors: 1,
        },
        {
          code: 'import TotallyNotScript from "next/script";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
          errors: 1,
        },
        // Round 2 finding 1, shape C: a .ts barrel re-export — an
        // ExportNamedDeclaration/ExportAllDeclaration with a `source`,
        // not an ImportDeclaration at all. Round 1's
        // `ImportDeclaration`-only selector could not have caught these;
        // no-restricted-imports does, by design.
        {
          code: 'export { default as SneakyScript } from "next/script";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
          errors: 1,
        },
        {
          code: 'export * from "next/script";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
          errors: 1,
        },
      ],
    });
  });
});

/**
 * Review round 3, LOW (family 3): everything above drives the bare selector
 * CONSTANTS against the bare rule MODULE via RuleTester — it proves the
 * selectors are correct, but not that `eslint.config.mjs`'s own `files`/
 * `ignores` WIRING actually routes them to the right files once merged into
 * the full exported config (`eslint-config-next`'s presets, the three
 * non-overlapping `no-restricted-syntax` objects, the separate
 * `no-restricted-imports` object). A wiring bug — a typo'd glob, an
 * `ignores` on the wrong object, a swapped rule key — would pass every test
 * above and still ship broken.
 *
 * This drives the same shapes through ESLint's own `Linter.verify`,
 * against the REAL default-exported `eslintConfig`, at realistic file
 * paths — the actual end-to-end path `npm run lint` takes, short of
 * spawning the CLI.
 */
describe("eslintConfig (the real merged, exported config) wires the gated-script rules to the right files", () => {
  const linter = new Linter({ configType: "flat" });

  function ruleIdsFor(code: string, filename: string): string[] {
    return linter
      .verify(code, eslintConfig, { filename })
      .map((message) => message.ruleId)
      .filter((ruleId): ruleId is string => ruleId !== null);
  }

  it("flags a next/script import in an ordinary component", () => {
    const ruleIds = ruleIdsFor(
      'import Script from "next/script";\nexport const x = Script;',
      "src/components/evil.tsx",
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("does NOT flag a next/script import inside the gated loader itself", () => {
    const ruleIds = ruleIdsFor(
      'import Script from "next/script";\nexport const x = Script;',
      GATED_LOADER_PATH,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("flags a raw <script src> in an ordinary component", () => {
    const ruleIds = ruleIdsFor(
      'export function X() { return <script src="https://evil.example/x.js" />; }',
      "src/components/evil.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("does NOT flag a raw <script src> inside the gated loader itself", () => {
    const ruleIds = ruleIdsFor(
      'export function X() { return <script src="https://ok.example/x.js" />; }',
      GATED_LOADER_PATH,
    );
    expect(ruleIds).not.toContain("no-restricted-syntax");
  });

  it("flags document.createElement(\"script\") in a plain .ts file (not just .tsx/.jsx)", () => {
    const ruleIds = ruleIdsFor('document.createElement("script");', "src/lib/evil.ts");
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("flags a .ts barrel re-export of next/script", () => {
    const ruleIds = ruleIdsFor(
      'export { default as X } from "next/script";',
      "src/lib/barrel.ts",
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("MUTATION CHECK: an unrelated file/shape raises neither gated-script rule", () => {
    const ruleIds = ruleIdsFor(
      'export const greeting = "hello";',
      "src/components/fine.tsx",
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
    expect(ruleIds).not.toContain("no-restricted-syntax");
  });
});
