import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Matches 3/4/6/8-digit hex color literals (e.g. #fff, #ffff, #ffffff, #ffffffff).
const HEX_COLOR_REGEX =
  "#(?:[0-9a-fA-F]{3,4}\\b|[0-9a-fA-F]{6}\\b|[0-9a-fA-F]{8}\\b)";
const hexColorMessage =
  "Hardcoded hex colors are not allowed in components. Use a theme color token (e.g. bg-primary, text-petrol-600) defined in src/app/globals.css instead.";

const HEX_COLOR_SELECTORS = [
  {
    selector: `Literal[value=/${HEX_COLOR_REGEX}/]`,
    message: hexColorMessage,
  },
  {
    selector: `TemplateElement[value.raw=/${HEX_COLOR_REGEX}/]`,
    message: hexColorMessage,
  },
];

// Cookie-consent gate (ugcportal-3wgp review round 1, finding 2): the K6
// repo-grep test (analytics-host.grep.test.ts) only catches a bypass that
// names the vendor's host string — a `<Script src="https://plausible.io/...">`
// or a raw `<script src>` dropped into any page, naming no vendor at all,
// would pass it silently. This catches the MECHANISM instead, the same
// `no-restricted-syntax` pattern the hex-colour guardrail above already
// uses: ban importing `next/script` and any JSX `<script src>` everywhere
// under src/ except the one gated loader.
const GATED_SCRIPT_MESSAGE =
  "next/script (or a raw <script src>) may only be used inside " +
  "src/components/consent/analytics-loader.tsx — ugcportal-3wgp's consent " +
  "gate. Route any tracking/affiliate script mount through that module " +
  "instead, so it is gated on visitor consent rather than bypassing it.";

const GATED_SCRIPT_SELECTORS = [
  {
    selector: 'ImportDeclaration[source.value="next/script"]',
    message: GATED_SCRIPT_MESSAGE,
  },
  {
    selector: 'JSXOpeningElement[name.name="script"] > JSXAttribute[name.name="src"]',
    message: GATED_SCRIPT_MESSAGE,
  },
];

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
  {
    // Design-system guardrail (ugcportal-eh5): components must consume the
    // petrol blue theme tokens defined in src/app/globals.css rather than
    // bypassing them with hardcoded hex colors. Scoped to component files;
    // the theme definition itself lives in CSS and is unaffected.
    //
    // Also carries the gated-script ban (above): every *.tsx/*.jsx file
    // EXCEPT analytics-loader.tsx itself, which is the one file allowed to
    // import next/script. Both rulesets live in the same config object
    // (rather than two separate ones) because ESLint's flat config does
    // not merge two `no-restricted-syntax` arrays for the same matched
    // file — the later config object would silently replace the earlier
    // one's selectors instead of adding to them.
    files: ["**/*.tsx", "**/*.jsx"],
    ignores: ["src/components/consent/analytics-loader.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...HEX_COLOR_SELECTORS,
        ...GATED_SCRIPT_SELECTORS,
      ],
    },
  },
  {
    // The one exception: still checked for hex colours, exempt from the
    // gated-script ban (it IS the gate).
    files: ["src/components/consent/analytics-loader.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...HEX_COLOR_SELECTORS],
    },
  },
]);

export default eslintConfig;
