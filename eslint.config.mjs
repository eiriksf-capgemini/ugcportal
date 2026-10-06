import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import {
  JSX_LINTED_EXTENSIONS,
  NON_JSX_LINTED_EXTENSIONS,
  globsFor,
  JS_FAMILY_EXTENSIONS,
} from "./src/lib/source-extensions.mjs";

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
 *   match at all, only computable at runtime.
 *
 *   What IS caught is the computed-property *shape*: a literal string or
 *   backticked key via bracket notation rather than dot notation
 *   (`x["createElement"]`, ``module[`require`]``), because the literal is
 *   still there in the AST. That claim used to be written here while
 *   being true of `createElement` only — the `require` selectors read a
 *   single callee spelling until review round 3's second pass, so
 *   `module["require"]("next/script")` passed. Every method this ruleset
 *   names now goes through `calleeNamed`, which is what makes the
 *   sentence true rather than aspirational.
 *
 *   Genuinely residual, needing real data-flow analysis rather than
 *   another selector:
 *
 *     - a fully dynamic key or argument (`createElement(tag)`,
 *       `import(specifier)`, `` require(`next/${name}`) ``);
 *     - `createRequire(import.meta.url)("next/script")` — the callee is
 *       the RETURN VALUE of a call, so there is no `require` identifier
 *       or property anywhere in the expression to match on, under any
 *       spelling;
 *     - an aliased method reference (`const e = document.createElement;
 *       e("script")`).
 *
 *   STATICALLY MATCHABLE, DELIBERATELY NOT ENUMERATED (review round 5):
 *   the `Function.prototype` indirections — `require.call(null,
 *   "next/script")`, `require.apply(null, ["next/script"])`,
 *   `Reflect.apply(require, null, ["next/script"])`,
 *   `document.createElement.call(document, "script")`. These are NOT
 *   data-flow residuals: both the function's name and the literal
 *   specifier are right there in the source, and selectors for them are
 *   writable. They are left out because enumerating them means a fresh
 *   selector per (method x indirection x argument position x literal
 *   form), and that matrix is where this ruleset has already shipped
 *   confirmed holes, each pinned by a case in eslint-gated-script.test.ts
 *   — the cost of the next one is higher than the cost of not reaching for
 *   `.call` to mount a tracking script. If one ever appears, add it.
 *
 *   The K6 grep test (analytics-host.grep.test.ts) is the backstop for
 *   both lists: it does not care how a vendor's host string reached the
 *   page, only that the string itself appears somewhere in the source.
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
 *
 * KNOWN LIMIT (review round 1, LOW — stated, not closed). Banning the
 * import closes the ALIAS, not every route to a script element. These
 * shapes are known to pass both this ban and the call-site selectors, and
 * the K6 host-name grep (analytics-host.grep.test.ts) is the backstop for
 * all of them — it does not care how a vendor's host reached the page,
 * only that the string appears in the source:
 *
 *   - `jsx()`/`jsxs()`/`jsxDEV()` from `react/jsx-runtime`, which is what
 *     the modern JSX transform actually compiles to. Not banned here
 *     because every `.tsx` file in this repo imports it implicitly —
 *     banning the module would ban JSX itself. The lowercase JSX
 *     `<script>` selector covers the authored form; a HAND-WRITTEN
 *     `jsx("script", ...)` is not covered.
 *   - An aliased METHOD reference rather than an import: `const e =
 *     document.createElement; e("script")`. The call site's callee is a
 *     plain identifier bound by assignment, which no selector and no
 *     import rule can follow.
 *   - String-to-DOM routes that never name `createElement` at all:
 *     `el.innerHTML = "<script…"`, `insertAdjacentHTML`,
 *     `document.write`, `new DOMParser().parseFromString`. (Worth noting
 *     `innerHTML` alone does not execute an injected script, but
 *     `insertAdjacentHTML` and `document.write` reach the same end by
 *     other means.)
 *   - Any specifier or tag name assembled at runtime — a concatenation
 *     (`"next/" + "script"`), a substituted template, or a variable. The
 *     value is simply not in the source for a selector to match, which is
 *     the same residual the KNOWN LIMIT above already names.
 */
const GATED_CREATE_ELEMENT_MESSAGE =
  "React's createElement may not be imported outside " +
  "src/components/consent/analytics-loader.tsx — a hand-written " +
  "createElement(\"script\", ...) is exactly what JSX compiles a raw " +
  "<script> down to, and an aliased import of it (createElement as h) is " +
  "invisible to the call-site lint selectors. Write JSX instead, and route " +
  "any tracking/affiliate script mount through the consent gate.";

/**
 * The gated module specifier, in one place: it is spelled in the import
 * ban, in both dynamic-`import()` selectors and in both `require()`
 * selectors, and a rename that reached four of those five would leave a
 * live hole (review round 1, LOW).
 */
const NEXT_SCRIPT_MODULE = "next/script";

export const GATED_SCRIPT_IMPORT_OPTIONS = [
  {
    paths: [
      { name: NEXT_SCRIPT_MODULE, message: GATED_SCRIPT_MESSAGE },
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

/**
 * "The callee is createElement", in all four spellings JavaScript gives you
 * for naming the same function. Factored into one `:matches()` so the two
 * selectors below each state the TAG-NAME question once, instead of the
 * matrix of (callee spelling x tag spelling) that review round 2 found a
 * hole in: four hand-written selectors covered seven of the eight cells,
 * and the missing one — ``document[`createElement`]("script")`` — passed
 * the lint cleanly (CONFIRMED with Linter.verify).
 *
 *   - `document.createElement(...)`     — Identifier property
 *   - `document["createElement"](...)`  — computed, string Literal property
 *   - ``document[`createElement`](...)``— computed, TemplateLiteral property
 *   - `createElement(...)`              — bare Identifier callee, the
 *     hand-written React.createElement JSX itself compiles `<script>` down
 *     to. An ALIASED import of it (`createElement as h`) is caught at its
 *     import instead — see GATED_CREATE_ELEMENT_MESSAGE above for why no
 *     selector can catch it here.
 *
 * The template-literal spellings are restricted to NO substitutions, in
 * the property and in the argument alike: a substituted template is not
 * statically present in the source, which is the documented residual the
 * K6 grep backstops (see KNOWN LIMIT above), not something a selector can
 * close.
 */
function calleeNamed(method) {
  return (
    ":matches(" +
    `[callee.property.name="${method}"], ` +
    `[callee.computed=true][callee.property.value="${method}"], ` +
    `[callee.computed=true][callee.property.expressions.length=0][callee.property.quasis.0.value.cooked="${method}"], ` +
    `[callee.name="${method}"])`
  );
}

/**
 * "Argument N is the string `script`", as a plain string literal and as a
 * no-substitution template literal. Written as attribute paths rather than
 * a `> TemplateLiteral` child combinator so it can say WHICH argument:
 * `createElement` takes the tag name first, `createElementNS` takes it
 * SECOND, after the namespace (review round 3, finding 1).
 */
function scriptTagArgument(index) {
  return [
    `[arguments.${index}.value=${SCRIPT_TAG_NAME}]`,
    `[arguments.${index}.expressions.length=0][arguments.${index}.quasis.0.value.cooked=${SCRIPT_TAG_NAME}]`,
  ];
}

/**
 * "Argument N is the gated module specifier", as a plain string literal
 * and as a no-substitution template literal — the same pair as
 * `scriptTagArgument`, for a module path rather than a tag name.
 */
function scriptModuleArgument(index) {
  return [
    `[arguments.${index}.value="${NEXT_SCRIPT_MODULE}"]`,
    `[arguments.${index}.expressions.length=0][arguments.${index}.quasis.0.value.cooked="${NEXT_SCRIPT_MODULE}"]`,
  ];
}

const CREATE_ELEMENT_CALLEE = calleeNamed("createElement");

/**
 * `document.createElementNS(ns, "script")` (review round 3, finding 1,
 * CONFIRMED): a different method, with the tag name as its SECOND
 * argument, so every `arguments.0` selector was blind to it.
 *
 * Deliberately NOT filtered by namespace. The SVG namespace yields an
 * `SVGScriptElement`, which executes exactly like an HTML one; the XHTML
 * namespace yields the HTML one. There is no namespace for which
 * constructing a `script` element outside the consent gate is fine, so
 * asking about the namespace at all would only add a way to get it wrong.
 */
const CREATE_ELEMENT_NS_CALLEE = calleeNamed("createElementNS");

export const GATED_SCRIPT_SYNTAX_SELECTORS = [
  {
    // Any <script> JSX element at all — not qualified by `src` or any
    // other attribute, so a dangerouslySetInnerHTML-only inline-snippet
    // bootstrap (no `src`) is caught the same as a src-bearing one.
    selector: 'JSXOpeningElement[name.name="script"]',
    message: GATED_SCRIPT_MESSAGE,
  },
  // createElement: tag name first. createElementNS: namespace first, tag
  // name SECOND. Each in both the string-literal and backticked spelling,
  // across all four callee spellings — four selectors for what is one
  // question asked of two methods at two argument positions.
  ...scriptTagArgument(0).map((argument) => ({
    selector: `CallExpression${CREATE_ELEMENT_CALLEE}${argument}`,
    message: GATED_SCRIPT_MESSAGE,
  })),
  ...scriptTagArgument(1).map((argument) => ({
    selector: `CallExpression${CREATE_ELEMENT_NS_CALLEE}${argument}`,
    message: GATED_SCRIPT_MESSAGE,
  })),
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
  // CommonJS: `require("next/script")` (ugcportal-ysub, MEDIUM).
  // `no-restricted-imports` understands ESM declarations only, and the
  // ImportExpression selectors above are a different node kind, so this
  // was caught by nothing — in a `.cjs` file it was not even reached,
  // since neither this ruleset's file globs nor the K6 grep's extension
  // list included `.cjs` before this bead.
  //
  // Review round 3, second pass (CONFIRMED with Linter.verify on the
  // merged config): these two read `[callee.name="require"]` — ONE
  // spelling — while `calleeNamed` was already giving `createElement` and
  // `createElementNS` four. `module.require("next/script")`,
  // `module["require"](...)`, ``module[`require`](...)``,
  // `globalThis.require(...)` and `process.mainModule.require(...)` all
  // passed. `require` is a function like any other: reached through a
  // member expression it is the same function, so it gets the same
  // four-spelling treatment.
  ...scriptModuleArgument(0).map((argument) => ({
    selector: `CallExpression${calleeNamed("require")}${argument}`,
    message: GATED_SCRIPT_MESSAGE,
  })),
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
    files: globsFor(JSX_LINTED_EXTENSIONS),
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
    // .ts/.mts/.cts/.js/.mjs/.cjs. This half gets the SAME
    // GATED_SCRIPT_SYNTAX_SELECTORS as the JSX half above, raw-`<script>`
    // selector included: a `.js` file can carry JSX (Next compiles it),
    // and a selector that cannot match costs nothing. What the two halves
    // actually differ by is the hex-colour guardrail, which only the JSX
    // half gets — see src/lib/source-extensions.mjs for why they have to
    // be partitioned at all. no-restricted-imports (next config object)
    // needs this file set covered too, for the barrel-re-export shape.
    // .js/.mjs added (review round 4, finding 2 —
    // CONFIRMED: a tracking snippet doesn't need TypeScript to execute, so
    // a plain .js/.mjs file was just as real a bypass surface as a .ts
    // one, and this object's old `files: ["**/*.ts"]` silently missed it).
    // .cjs added by ugcportal-ysub, alongside the `require("next/script")`
    // selector: CommonJS executes just as happily as ESM, and `.cjs` was
    // the one real source extension neither this ruleset nor the K6 grep
    // looked at. Both halves of the partition now come from
    // src/lib/source-extensions.mjs, so widening one cannot leave the
    // other behind (review round 3, finding 4).
    files: globsFor(NON_JSX_LINTED_EXTENSIONS),
    // Review round 3, finding 8: this was the one gated-script block with
    // no loader exemption, purely because the loader happens to be a
    // `.tsx` today and so never matched here. Renaming it to `.ts` would
    // have started flagging the single legitimate caller. Stated, not
    // relied on.
    ignores: [GATED_LOADER_PATH],
    rules: {
      "no-restricted-syntax": ["error", ...GATED_SCRIPT_SYNTAX_SELECTORS],
    },
  },
  {
    // A different rule key (no-restricted-imports), so this can freely
    // span every extension together without colliding with any object
    // above. Spans every JS-family extension at once, from the same
    // shared list the partition above is derived from.
    files: globsFor(JS_FAMILY_EXTENSIONS),
    ignores: [GATED_LOADER_PATH],
    rules: {
      "no-restricted-imports": ["error", ...GATED_SCRIPT_IMPORT_OPTIONS],
    },
  },
]);

export default eslintConfig;
