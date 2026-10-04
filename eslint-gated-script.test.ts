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
        // A bare-identifier createElement NOT called with "script".
        {
          code: 'import { createElement } from "react"; createElement("div");',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
        },
        // A different function that happens to be NAMED createElement
        // locally, called with "script" — the selector matches on the
        // callee's name and the literal argument only, same as every real
        // JS tokenizer would see it (no cross-file type information), so
        // this is a known, accepted false-positive surface, not something
        // this test claims to rule out.
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
        // Round 4, finding 3: bare-identifier callee — hand-written
        // React.createElement, the exact call JSX compiles `<script>` down
        // to, with no `.` and no JSX syntax for either of the shapes above
        // to see.
        {
          code: 'import { createElement } from "react"; createElement("script", { src: "https://evil.example/x.js" });',
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
        // ugcportal-ysub: DOM tag names are case-insensitive, so each of
        // these builds the same HTMLScriptElement as the lowercase
        // spelling while matching none of the old literal `"script"`
        // selectors.
        {
          code: 'document.createElement("SCRIPT");',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: 'document.createElement("Script");',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: 'document["createElement"]("SCRIPT");',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: 'import { createElement } from "react"; createElement("ScRiPt", {});',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // ugcportal-ysub, family-4 sibling of the two template-literal
        // module specifiers below: a backticked TAG NAME has no `.value`
        // either, in any of the three callee spellings.
        {
          code: "document.createElement(`script`);",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: 'document["createElement"](`SCRIPT`);',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: 'import { createElement } from "react"; createElement(`script`, {});',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // ugcportal-ysub: a no-substitution TEMPLATE literal specifier is
        // a TemplateLiteral node with no `.value` at all, so the
        // `[source.value=...]` selector could not see it.
        {
          code: "async function load() { await import(`next/script`); }",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        // ugcportal-ysub: CommonJS. no-restricted-imports only understands
        // ESM declarations, so before this selector `require("next/script")`
        // was caught by nothing at all.
        {
          code: 'const Script = require("next/script");',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
        {
          code: "const Script = require(`next/script`);",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
          errors: 1,
        },
      ],
    });
  });

  /**
   * ugcportal-ysub, review-standards family 3: the `invalid` cases above
   * prove the new selectors FIRE; these prove they still have a failing
   * case, i.e. that they are matching the tag name rather than anything
   * that merely contains it. Without these, widening `"script"` to
   * `/script/i` (no anchors) would pass every assertion above while
   * flagging `createElement("scripture")`.
   */
  it("does not widen past the tag name itself", () => {
    tester.run("GATED_SCRIPT_SYNTAX_SELECTORS (anchoring)", noRestrictedSyntax, {
      valid: [
        { code: 'document.createElement("scriptish");', options: GATED_SCRIPT_SYNTAX_SELECTORS },
        { code: 'document.createElement("noscript");', options: GATED_SCRIPT_SYNTAX_SELECTORS },
        { code: "document.createElement(`scriptish`);", options: GATED_SCRIPT_SYNTAX_SELECTORS },
        // A tag name only known at runtime — the documented residual the
        // K6 grep backstops, not something a selector can close.
        { code: "document.createElement(`${tag}script`);", options: GATED_SCRIPT_SYNTAX_SELECTORS },
        {
          code: 'async function load() { await import("next/script-helpers"); }',
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
        },
        {
          code: "async function load() { await import(`next/script-helpers`); }",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
        },
        { code: 'const x = require("next/image");', options: GATED_SCRIPT_SYNTAX_SELECTORS },
        // A template literal WITH a substitution: the specifier is not
        // statically present, which eslint.config.mjs documents as the
        // residual the K6 grep backstops rather than something a selector
        // can close.
        {
          code: "const x = require(`next/${name}`);",
          options: GATED_SCRIPT_SYNTAX_SELECTORS,
        },
      ],
      invalid: [],
    });
  });
});

describe("eslint.config.mjs: gated-script import/export ban (no-restricted-imports)", () => {
  it("passes ESLint's own RuleTester", () => {
    tester.run("GATED_SCRIPT_IMPORT_OPTIONS", noRestrictedImports, {
      valid: [
        { code: 'import Something from "other-module";', options: GATED_SCRIPT_IMPORT_OPTIONS },
        // react itself is not banned — only its `createElement` export is.
        {
          code: 'import { useState, useRef } from "react";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
        },
        // ...and only from react: a `createElement` of someone else's is
        // not React's, and the gate is about React's.
        {
          code: 'import { createElement } from "some-vdom-lib";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
        },
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
        // ugcportal-ysub, MEDIUM (CONFIRMED with Linter.verify on PR #92):
        // every call-site selector matches the callee's NAME, so an
        // ALIASED import defeated all of them — `h("script", ...)` spells
        // `h`. `importNames` matches the IMPORTED name, which the alias
        // cannot change, so the import site catches what the call site
        // structurally cannot.
        {
          code: 'import { createElement } from "react";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
          errors: 1,
        },
        {
          code: 'import { createElement as h } from "react";',
          options: GATED_SCRIPT_IMPORT_OPTIONS,
          errors: 1,
        },
        {
          code: 'export { createElement as h } from "react";',
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

  /**
   * Review round 4, MEDIUM (CONFIRMED): the lint config's `files` globs
   * covered .ts/.tsx/.jsx only — a plain .js or .mjs file under src/
   * bypassed both the import ban and the syntax ban, even though neither
   * needs TypeScript to execute.
   */
  it("flags a next/script import in a plain .js file", () => {
    const ruleIds = ruleIdsFor(
      'import Script from "next/script";\nexport const x = Script;',
      "src/lib/evil.js",
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("flags a next/script import in a plain .mjs file", () => {
    const ruleIds = ruleIdsFor(
      'import Script from "next/script";\nexport const x = Script;',
      "src/lib/evil.mjs",
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("flags document.createElement(\"script\") in a plain .js file", () => {
    const ruleIds = ruleIdsFor('document.createElement("script");', "src/lib/evil.js");
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("flags a bare-identifier createElement(\"script\") call (round 4, finding 3)", () => {
    const ruleIds = ruleIdsFor(
      'import { createElement } from "react";\n' +
        'export function evil() { return createElement("script", { src: "https://evil.example/x.js" }); }',
      "src/components/evil.tsx",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  /**
   * K2 (ugcportal-ysub): the four shapes the bead names, each driven
   * through the REAL merged config at a realistic path — not against the
   * bare selector constants, because a selector that is right but wired to
   * the wrong file set ships broken all the same.
   */
  it("K2: flags an ALIASED createElement import from react and the h(\"script\") call it enables", () => {
    const ruleIds = ruleIdsFor(
      'import { createElement as h } from "react";\n' +
        'export function evil() { return h("script", { src: "https://evil.example/x.js" }); }',
      "src/components/evil.tsx",
    );
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("K2: flags createElement(\"SCRIPT\") — DOM tag names are case-insensitive", () => {
    const ruleIds = ruleIdsFor('document.createElement("SCRIPT");', "src/lib/evil.ts");
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("K2: flags a template-literal dynamic import of next/script", () => {
    const ruleIds = ruleIdsFor(
      "export async function load() { return import(`next/script`); }",
      "src/lib/evil.ts",
    );
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("K2: flags a CommonJS require(\"next/script\"), including in a .cjs file", () => {
    expect(ruleIdsFor('const S = require("next/script");', "src/lib/evil.ts")).toContain(
      "no-restricted-syntax",
    );
    expect(ruleIdsFor('const S = require("next/script");', "src/lib/evil.cjs")).toContain(
      "no-restricted-syntax",
    );
  });

  it("does NOT flag any of those four inside the gated loader itself", () => {
    // The single allowed loader path stays the only exception — a new
    // selector that fired even there would make the one legitimate caller
    // unlintable, which is the failure mode opposite to a bypass and just
    // as real.
    expect(
      ruleIdsFor(
        'import { createElement as h } from "react";\nexport const x = h;',
        GATED_LOADER_PATH,
      ),
    ).not.toContain("no-restricted-imports");
    expect(
      ruleIdsFor('export const x = () => document.createElement("SCRIPT");', GATED_LOADER_PATH),
    ).not.toContain("no-restricted-syntax");
  });

  it("MUTATION CHECK: the same four shapes spelled just off-target raise neither rule", () => {
    // Fixture mutation for the four assertions above: one character off
    // the thing being banned in each case, so each needle really can be
    // absent (review-standards family 3). If any of these started
    // failing, the selectors would have widened past "this IS the gated
    // module / the script tag" into "this mentions it".
    expect(
      ruleIdsFor('import { useMemo as h } from "react";\nexport const x = h;', "src/lib/fine.ts"),
    ).not.toContain("no-restricted-imports");
    expect(ruleIdsFor('document.createElement("scripture");', "src/lib/fine.ts")).not.toContain(
      "no-restricted-syntax",
    );
    expect(
      ruleIdsFor(
        "export async function load() { return import(`next/script-helpers`); }",
        "src/lib/fine.ts",
      ),
    ).not.toContain("no-restricted-syntax");
    expect(ruleIdsFor('const S = require("next/image");', "src/lib/fine.cjs")).not.toContain(
      "no-restricted-syntax",
    );
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
