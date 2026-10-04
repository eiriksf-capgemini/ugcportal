import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Matches 3/4/6/8-digit hex color literals (e.g. #fff, #ffff, #ffffff, #ffffffff).
const HEX_COLOR_REGEX =
  "#(?:[0-9a-fA-F]{3,4}\\b|[0-9a-fA-F]{6}\\b|[0-9a-fA-F]{8}\\b)";
const hexColorMessage =
  "Hardcoded hex colors are not allowed in components. Use a theme color token (e.g. bg-primary, text-petrol-600) defined in src/app/globals.css instead.";

export const HEX_COLOR_SELECTORS = [
  {
    selector: `Literal[value=/${HEX_COLOR_REGEX}/]`,
    message: hexColorMessage,
  },
  {
    selector: `TemplateElement[value.raw=/${HEX_COLOR_REGEX}/]`,
    message: hexColorMessage,
  },
];

/**
 * Cookie-consent gate (ugcportal-3wgp). The K6 repo-grep test
 * (analytics-host.grep.test.ts) only catches a bypass that names the
 * vendor's host string in plain text — it cannot see a bypass that never
 * spells the vendor out at all. These two rulesets catch the MECHANISM
 * instead, everywhere under src/ except the one gated loader
 * (src/components/consent/analytics-loader.tsx):
 *
 * - GATED_SCRIPT_IMPORT_OPTIONS (`no-restricted-imports`, a built-in rule
 *   chosen specifically because it already understands every form of
 *   "this file depends on next/script" — a direct `import`, a dynamic
 *   `import()`, AND a `.ts` barrel re-export (`export { default as X } from
 *   "next/script"` / `export * from "next/script"`) — without hand-written
 *   selectors for each. Round 1 only banned `ImportDeclaration`, which a
 *   re-export dodges entirely (it's an `ExportNamedDeclaration`/
 *   `ExportAllDeclaration` node, not an `ImportDeclaration`), and an
 *   imported alias was never actually a gap — `source.value` is checked on
 *   the declaration itself, so any local name bound to it was always
 *   caught; the real gap `no-restricted-imports` closes is the barrel.
 *   Scoped to .ts, .js and .mjs too (not just .tsx/.jsx — round 1's gap for
 *   .ts; round 4's finding 2 for .js/.mjs, since a tracking snippet does not
 *   need TypeScript to execute), as that is exactly where such a barrel
 *   would live.
 *
 * - GATED_SCRIPT_SYNTAX_SELECTORS (`no-restricted-syntax`, same mechanism
 *   as the hex-colour guardrail below) bans the JSX `<script>` element
 *   OUTRIGHT — not just one carrying a `src` attribute (round 1's
 *   narrower selector), because a `<script dangerouslySetInnerHTML={{
 *   __html: snippet }}>` inline-bootstrap tag (the standard way GA4/GTM/
 *   Meta Pixel snippets are usually dropped into a page) carries no `src`
 *   at all and dodged it. Also bans `document.createElement("script")`
 *   (and `anything.createElement("script")` generally — there is no
 *   legitimate non-`document` receiver for this in a browser DOM context),
 *   the programmatic-DOM-construction bypass that uses no JSX and no
 *   import at all, in both its dot-notation and computed/bracket forms
 *   (`x["createElement"]("script")`).
 *
 *   KNOWN LIMIT (review round 3, finding 2), inherent to static AST
 *   selectors rather than fixable by adding another one: every selector
 *   here matches a LITERAL AST shape. `document.createElement(someVar)`
 *   where `someVar` happens to hold the string `"script"` at runtime, or
 *   `import(someVar)` where `someVar` holds `"next/script"`, cannot be
 *   caught — the value isn't present in the source text for a selector to
 *   match at all, only computable at runtime. The computed-property
 *   *shape* (`x["createElement"]`, a literal string key via bracket
 *   notation rather than dot notation) IS caught, since the literal string
 *   is still present in the AST; a fully dynamic key or argument is not,
 *   and no selector-based rule can close that — it would need real
 *   data-flow analysis. The K6 grep test (analytics-host.grep.test.ts) is
 *   the backstop for exactly this residual gap: it does not care how a
 *   vendor's host string reached the page, only that the string itself
 *   appears somewhere in the source.
 */
const GATED_SCRIPT_MESSAGE =
  "next/script (or a raw <script> element, however constructed) may only " +
  "be used inside src/components/consent/analytics-loader.tsx — " +
  "ugcportal-3wgp's consent gate. Route any tracking/affiliate script " +
  "mount through that module instead, so it is gated on visitor consent " +
  "rather than bypassing it.";

/**
 * ugcportal-ysub item 3 (MEDIUM, CONFIRMED with Linter.verify): every
 * `createElement` selector below matches the callee's NAME, so
 * `import { createElement as h } from "react"; h("script", ...)` passed all
 * of them — the call site spells `h`, not `createElement`. `no-restricted-
 * syntax` is esquery over one file's AST with no scope analysis, so no
 * selector can follow the alias back to its binding.
 *
 * Closed at the IMPORT instead, which is where the name is still
 * `createElement` whatever it is bound to locally: `no-restricted-imports`
 * matches `importNames` against the IMPORTED name, not the local one, so
 * the alias is irrelevant. That is the bead's own stated alternative
 * ("resolve the import binding ... or lint on the imported name").
 *
 * Deliberately bans `createElement` from react outright rather than only
 * when called with "script": a rule that has to see the call site is
 * exactly the rule the alias defeats. Nothing in this repo imports it
 * today (JSX compiles to `jsx()` from react/jsx-runtime, not to a
 * hand-written `createElement`), and the one module with a legitimate
 * reason to construct a script element — the gated loader — is already
 * exempt from this whole ruleset via `ignores`.
 */
const GATED_CREATE_ELEMENT_MESSAGE =
  "React's createElement may not be imported outside " +
  "src/components/consent/analytics-loader.tsx — a hand-written " +
  "createElement(\"script\", ...) is exactly what JSX compiles a raw " +
  "<script> down to, and an aliased import of it (createElement as h) is " +
  "invisible to the call-site lint selectors. Write JSX instead, and route " +
  "any tracking/affiliate script mount through the consent gate.";

export const GATED_SCRIPT_IMPORT_OPTIONS = [
  {
    paths: [
      { name: "next/script", message: GATED_SCRIPT_MESSAGE },
      {
        name: "react",
        importNames: ["createElement"],
        message: GATED_CREATE_ELEMENT_MESSAGE,
      },
    ],
  },
];

/**
 * DOM tag names are case-INSENSITIVE: `document.createElement("SCRIPT")`
 * and `createElement("Script", ...)` build exactly the same
 * HTMLScriptElement as the lowercase spelling (ugcportal-ysub, MEDIUM —
 * the selectors below matched the literal string `"script"` and nothing
 * else). An esquery attribute value written as `/.../i` is a real regex
 * with real flags — verified against this repo's installed esquery 1.7.0,
 * and against the merged config by Linter.verify in
 * eslint-gated-script.test.ts.
 *
 * Anchored (`^...$`), so this is still "the tag name IS script", not "the
 * argument CONTAINS script" — `createElement("scriptish")` is not a
 * script element and must not be flagged as one.
 *
 * Note this does NOT apply to the JSX selector: in JSX a capitalised tag
 * (`<Script />`) is a reference to a component VARIABLE, not the HTML
 * element, so `<script>` really is the only spelling that produces a raw
 * script tag there.
 */
const SCRIPT_TAG_NAME = "/^script$/i";

/** `next/script`, as a plain Literal argument and as a no-substitution template literal. */
const NEXT_SCRIPT_MODULE = "next/script";

export const GATED_SCRIPT_SYNTAX_SELECTORS = [
  {
    // Any <script> JSX element at all — not qualified by `src` or any
    // other attribute, so a dangerouslySetInnerHTML-only inline-snippet
    // bootstrap (no `src`) is caught the same as a src-bearing one.
    selector: 'JSXOpeningElement[name.name="script"]',
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // Dot notation: document.createElement("script").
    selector: `CallExpression[callee.property.name="createElement"][arguments.0.value=${SCRIPT_TAG_NAME}]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // Computed/bracket notation: document["createElement"]("script") —
    // the property is a string Literal (`.value`), not an Identifier
    // (`.name`), so this needs its own selector rather than reusing the
    // one above (review round 3, finding 2).
    selector: `CallExpression[callee.computed=true][callee.property.value="createElement"][arguments.0.value=${SCRIPT_TAG_NAME}]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // Bare-identifier callee: `import { createElement } from "react";
    // createElement("script", ...)` — hand-written React.createElement,
    // the exact call JSX itself compiles `<script ...>` down to, with no
    // `.` at all (the callee is a plain Identifier, not a MemberExpression,
    // so neither selector above matches it) and no JSX syntax for the
    // JSXOpeningElement selector above to see either (review round 4,
    // finding 3). An ALIASED import of the same function
    // (`createElement as h`) is caught at its import instead — see
    // GATED_CREATE_ELEMENT_MESSAGE above for why it cannot be caught here.
    selector: `CallExpression[callee.name="createElement"][arguments.0.value=${SCRIPT_TAG_NAME}]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // A BACKTICKED tag name: ``document.createElement(`script`)``, and the
    // computed and bare-identifier spellings of the same thing. Found by
    // the family-4 sibling sweep while adding the backticked `import()`
    // and `require()` selectors below — a template literal has no
    // `.value`, so all three `[arguments.0.value=...]` selectors above
    // were blind to it. One `:matches()` rather than three near-identical
    // selectors, since the only part that differs is how the callee is
    // spelled. Same "no substitutions" restriction, for the same reason.
    selector: `CallExpression:matches([callee.property.name="createElement"], [callee.property.value="createElement"], [callee.name="createElement"]) > TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=${SCRIPT_TAG_NAME}]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // A dynamic `import("next/script")`. `no-restricted-imports` below
    // handles every static import/export-from form but — confirmed
    // directly against this repo's installed ESLint 9.39.5 via its own
    // RuleTester (eslint-gated-script.test.ts) — does NOT flag a dynamic
    // `ImportExpression` the way it flags a static `ImportDeclaration`, so
    // this shape needs its own selector here instead.
    selector: `ImportExpression[source.value="${NEXT_SCRIPT_MODULE}"]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // The same dynamic import written with BACKTICKS:
    // ``import(`next/script`)`` (ugcportal-ysub, MEDIUM). A template
    // literal is a TemplateLiteral node, not a Literal, so it has no
    // `.value` for the selector above to read at all — the specifier
    // lives in `quasis[0].value.cooked`. Only a template with NO
    // substitutions is matched, because that is the only case where the
    // whole specifier is statically present in the source; a
    // ``import(`${base}/script`)`` is the documented residual that no
    // selector-based rule can see (see KNOWN LIMIT above).
    selector: `ImportExpression > TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked="${NEXT_SCRIPT_MODULE}"]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // CommonJS: `require("next/script")` (ugcportal-ysub, MEDIUM).
    // `no-restricted-imports` understands ESM declarations only, and the
    // ImportExpression selectors above are a different node kind, so this
    // was caught by nothing — in a `.cjs` file it was not even reached,
    // since neither this ruleset's file globs nor the K6 grep's extension
    // list included `.cjs` before this bead.
    selector: `CallExpression[callee.name="require"][arguments.0.value="${NEXT_SCRIPT_MODULE}"]`,
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // ``require(`next/script`)`` — same template-literal shape as the
    // dynamic import above, same reason it needs its own selector.
    selector: `CallExpression[callee.name="require"] > TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked="${NEXT_SCRIPT_MODULE}"]`,
    message: GATED_SCRIPT_MESSAGE,
  },
];

// Exported (review round 3, finding 5 — reuse) so analytics-host.grep.test.ts
// doesn't carry its own independent copy of this path; repo-root-relative,
// matching how ESLint's own `files`/`ignores` glob matching works here.
export const GATED_LOADER_PATH = "src/components/consent/analytics-loader.tsx";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees (gitignored, but not excluded from lint by default,
    // which makes local `npm run lint` scan stale checkouts under here).
    ".claude/worktrees/**",
  ]),
  /*
   * Three non-overlapping `no-restricted-syntax` config objects below,
   * deliberately partitioned by file set rather than combined with
   * `ignores` on a single pair — ESLint's flat config does not MERGE two
   * `no-restricted-syntax` arrays that both match the same file; the
   * later-listed config object silently replaces the earlier one's
   * selectors for that rule key instead of adding to them. Giving each
   * object a file set that never overlaps another `no-restricted-syntax`
   * object's set avoids that collision entirely, rather than relying on
   * array-combining discipline every time one of these rulesets changes.
   */
  {
    // The gate itself: hex-colour-checked like every other component, but
    // exempt from the script-shape ban (it IS the gate).
    files: [GATED_LOADER_PATH],
    rules: {
      "no-restricted-syntax": ["error", ...HEX_COLOR_SELECTORS],
    },
  },
  {
    // Design-system guardrail (ugcportal-eh5) PLUS the script-shape ban,
    // for every other *.tsx/*.jsx file.
    files: ["**/*.tsx", "**/*.jsx"],
    ignores: [GATED_LOADER_PATH],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...HEX_COLOR_SELECTORS,
        ...GATED_SCRIPT_SYNTAX_SELECTORS,
      ],
    },
  },
  {
    // Plain .ts/.js/.mjs files never carry JSX, so no hex-colour/JSX-
    // selector concern here — but the script-shape ban
    // (document.createElement) still applies, and no-restricted-imports
    // (next config object) needs this file set covered too for the
    // barrel-re-export shape. .js/.mjs added (review round 4, finding 2 —
    // CONFIRMED: a tracking snippet doesn't need TypeScript to execute, so
    // a plain .js/.mjs file was just as real a bypass surface as a .ts
    // one, and this object's old `files: ["**/*.ts"]` silently missed it).
    // .cjs added by ugcportal-ysub, alongside the `require("next/script")`
    // selector: CommonJS executes just as happily as ESM, and `.cjs` was
    // the one real source extension neither this ruleset nor the K6 grep
    // looked at.
    files: ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      "no-restricted-syntax": ["error", ...GATED_SCRIPT_SYNTAX_SELECTORS],
    },
  },
  {
    // A different rule key (no-restricted-imports), so this can freely
    // span every extension together without colliding with any object
    // above. .js/.mjs (and now .cjs) added for the same reason as the
    // object above.
    files: ["**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
    ignores: [GATED_LOADER_PATH],
    rules: {
      "no-restricted-imports": ["error", ...GATED_SCRIPT_IMPORT_OPTIONS],
    },
  },
]);

export default eslintConfig;
