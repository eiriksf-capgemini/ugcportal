import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Matches 3/4/6/8-digit hex color literals (e.g. #fff, #ffff, #ffffff, #ffffffff).
const HEX_COLOR_REGEX =
  "#(?:[0-9a-fA-F]{3,4}\\b|[0-9a-fA-F]{6}\\b|[0-9a-fA-F]{8}\\b)";
const hexColorMessage =
  "Hardcoded hex colors are not allowed in components. Use a theme color token (e.g. bg-primary, text-petrol-600) defined in src/app/globals.css instead.";

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
  ]),
  {
    // Design-system guardrail (ugcportal-eh5): components must consume the
    // petrol blue theme tokens defined in src/app/globals.css rather than
    // bypassing them with hardcoded hex colors. Scoped to component files;
    // the theme definition itself lives in CSS and is unaffected.
    files: ["**/*.tsx", "**/*.jsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${HEX_COLOR_REGEX}/]`,
          message: hexColorMessage,
        },
        {
          selector: `TemplateElement[value.raw=/${HEX_COLOR_REGEX}/]`,
          message: hexColorMessage,
        },
      ],
    },
  },
]);

export default eslintConfig;
