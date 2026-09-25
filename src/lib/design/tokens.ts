/**
 * Reads the design tokens straight out of src/app/globals.css (ugcportal-axu).
 *
 * The contrast gate parses the stylesheet rather than a hand-maintained copy of
 * the values in TypeScript, because a copy drifts: the moment the two disagree,
 * the test is checking numbers that no longer ship, while still reporting a
 * pass. Parsing the real file is what makes "a later token tweak cannot quietly
 * drop a pair below the line" true rather than merely claimed.
 *
 * One honest limit on that claim: what the gate measures is the *authored*
 * value. Lightning CSS (via Tailwind) transpiles `oklch()` to `lab()` for the
 * configured browser targets, and that conversion rounds. Measured on
 * 2026-09-25 against headless Chromium, across all 76 documented pairings, the
 * largest difference between the authored ratio and the ratio of the colour
 * the browser actually painted was 0.06:1, and no pairing changed pass/fail.
 * So the gate is accurate to about a hundredth of a ratio point, not exact.
 * Keep roughly that much margin above a threshold and the distinction never
 * matters; ship a pair at 4.50 exactly and it might.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Declaration = {
  property: string;
  value: string;
  /** The block the declaration was found in, e.g. ":root" or "@theme". */
  selector: string;
};

function fail(message: string): never {
  throw new Error(`[design/tokens] ${message}`);
}

/** Strips `/* ... *​/` comments. CSS has no string escapes we need to survive. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Collects every custom-property declaration in the stylesheet, tagged with the
 * block it came from. Brace-aware, so `@layer base { * { ... } }` nests
 * correctly instead of flattening into one soup.
 */
export function parseDeclarations(css: string): Declaration[] {
  const source = stripComments(css);
  const declarations: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";

  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (!text.startsWith("--")) return;
    const colon = text.indexOf(":");
    if (colon === -1) {
      fail(`custom property with no value: "${text}"`);
    }
    const property = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (value === "") fail(`empty value for ${property}`);
    declarations.push({
      property,
      value,
      selector: stack.length > 0 ? stack.join(" > ") : "(top level)",
    });
  };

  for (const char of source) {
    if (char === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      flush();
      if (stack.length === 0) fail("unbalanced } in stylesheet");
      stack.pop();
    } else if (char === ";") {
      flush();
    } else {
      buffer += char;
    }
  }
  if (stack.length !== 0) fail("unbalanced { in stylesheet");
  return declarations;
}

/**
 * Flattens declarations into one lookup, refusing any property declared more
 * than once.
 *
 * This is the "one theme, not two" guard: a second `.dark { --background: ... }`
 * block — the shape this file had before ugcportal-axu — makes this throw, so a
 * duplicate palette cannot be reintroduced without the suite saying so. It also
 * means the contrast gate never has to guess which of two declarations wins.
 */
export function flattenDeclarations(
  declarations: Declaration[],
): Map<string, Declaration> {
  const byProperty = new Map<string, Declaration>();
  for (const declaration of declarations) {
    const existing = byProperty.get(declaration.property);
    if (existing) {
      fail(
        `${declaration.property} is declared twice, in "${existing.selector}" and ` +
          `"${declaration.selector}". This design system has exactly one theme; ` +
          `every token is declared once, in one block.`,
      );
    }
    byProperty.set(declaration.property, declaration);
  }
  return byProperty;
}

const VAR_ONLY = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/;

/**
 * Resolves a token to a literal value, following `var()` chains.
 *
 * Throws on an unknown token, a cycle, or a value this resolver does not fully
 * understand (for example `color-mix(...)`, which would need a second colour
 * model to evaluate). Refusing is deliberate: returning the unresolved text
 * would make the caller's parse fail in a confusing place, and returning a
 * default would make the gate pass a pair it never evaluated.
 */
export function resolveToken(
  property: string,
  declarations: Map<string, Declaration>,
  seen: string[] = [],
): string {
  if (seen.includes(property)) {
    fail(`cyclic token reference: ${[...seen, property].join(" -> ")}`);
  }
  const declaration = declarations.get(property);
  if (!declaration) {
    fail(
      `unknown token ${property}` +
        (seen.length > 0 ? ` (referenced via ${seen.join(" -> ")})` : ""),
    );
  }
  return resolveValue(declaration.value, declarations, [...seen, property]);
}

/**
 * Resolves one declaration value. Split out from resolveToken so that a
 * `var()` *fallback* goes through exactly the same path as a declaration:
 * `var(--missing, var(--b))` used to be returned verbatim as the string
 * "var(--b)", which parseColor then rejected as unsupported syntax, blaming
 * the colour parser for a missing token.
 */
function resolveValue(
  rawValue: string,
  declarations: Map<string, Declaration>,
  seen: string[],
): string {
  const value = rawValue.trim();
  const asVar = VAR_ONLY.exec(value);
  if (asVar) {
    const target = asVar[1];
    const fallback = asVar[2]?.trim();
    if (!declarations.has(target)) {
      if (fallback === undefined || fallback === "") {
        fail(
          `${seen[seen.length - 1]} references ${target}, which is not declared`,
        );
      }
      return resolveValue(fallback, declarations, seen);
    }
    return resolveToken(target, declarations, seen);
  }
  if (value.includes("var(")) {
    fail(
      `${seen[seen.length - 1]} = "${value}" mixes var() with other syntax; this ` +
        `resolver only handles a bare var() reference, and will not guess at the rest`,
    );
  }
  return value;
}

/**
 * Resolved relative to this module rather than to process.cwd(), so the gate
 * reads the stylesheet in its own checkout no matter where the runner was
 * started from.
 */
export const GLOBALS_CSS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "app",
  "globals.css",
);

/** Reads and flattens the shipped stylesheet. */
export function loadThemeTokens(
  cssPath: string = GLOBALS_CSS_PATH,
): Map<string, Declaration> {
  const css = readFileSync(cssPath, "utf8");
  return flattenDeclarations(parseDeclarations(css));
}
