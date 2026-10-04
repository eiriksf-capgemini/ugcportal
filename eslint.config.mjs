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
 *   Scoped to .ts too (not just .tsx/.jsx — round 1's gap), since a plain
 *   `.ts` file is exactly where such a barrel would live.
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

export const GATED_SCRIPT_IMPORT_OPTIONS = [
  {
    paths: [{ name: "next/script", message: GATED_SCRIPT_MESSAGE }],
  },
];

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
    selector: 'CallExpression[callee.property.name="createElement"][arguments.0.value="script"]',
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // Computed/bracket notation: document["createElement"]("script") —
    // the property is a string Literal (`.value`), not an Identifier
    // (`.name`), so this needs its own selector rather than reusing the
    // one above (review round 3, finding 2).
    selector:
      'CallExpression[callee.computed=true][callee.property.value="createElement"][arguments.0.value="script"]',
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    // A dynamic `import("next/script")`. `no-restricted-imports` below
    // handles every static import/export-from form but — confirmed
    // directly against this repo's installed ESLint 9.39.5 via its own
    // RuleTester (eslint-gated-script.test.ts) — does NOT flag a dynamic
    // `ImportExpression` the way it flags a static `ImportDeclaration`, so
    // this shape needs its own selector here instead.
    selector: 'ImportExpression[source.value="next/script"]',
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
    // Plain .ts files never carry JSX, so no hex-colour/JSX-selector
    // concern here — but the script-shape ban (document.createElement)
    // still applies, and no-restricted-imports (next config object) needs
    // this file set covered too for the barrel-re-export shape.
    files: ["**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...GATED_SCRIPT_SYNTAX_SELECTORS],
    },
  },
  {
    // A different rule key (no-restricted-imports), so this can freely
    // span .ts/.tsx/.jsx together without colliding with any object above.
    files: ["**/*.ts", "**/*.tsx", "**/*.jsx"],
    ignores: [GATED_LOADER_PATH],
    rules: {
      "no-restricted-imports": ["error", ...GATED_SCRIPT_IMPORT_OPTIONS],
    },
  },
]);

export default eslintConfig;
