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

/**
 * Strips `/* ... *​/` comments. CSS has no string escapes we need to survive.
 *
 * The same regex also lives in `stripCssComments` in scan-source.ts
 * (ugcportal-ysub review round 2). Kept separate on purpose: that one
 * replaces a comment with a SPACE so two tokens cannot fuse, this one
 * erases it, and this module's callers (`parseDeclarations` below) are
 * tuned to the erasing form. Importing it would also pull `node:fs` and
 * the `typescript` devDependency into this module's graph for one regex.
 * Change one, look at the other.
 */
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

export type ThemeMode = "light" | "dark";

/**
 * Matches the selector `parseDeclarations` records for anything nested inside
 * `@media (prefers-color-scheme: dark) { ... }` — the one, deliberate way
 * this stylesheet varies by mode (ugcportal-rw9j). Whitespace is normalised
 * by nothing here, so the media query in globals.css must be written exactly
 * `@media (prefers-color-scheme: dark)` for this to recognise it; a test in
 * contrast.test.ts pins that the block exists and is found by this pattern,
 * so a reformatted query is a loud failure rather than a silently-ignored
 * light theme in disguise.
 */
/**
 * Exported (round 5, code-review): contrast.test.ts's own "declares a
 * dark-mode override for exactly the tokens this phase touches" test used
 * to carry an independent, hand-copied literal of this same pattern. If this
 * one were ever widened (e.g. to tolerate no space after the colon), that
 * copy would silently stop recognising the real dark override and either
 * validate against an empty set or fail a change loadThemeTokens itself
 * handles correctly - importing the one pattern removes the divergence.
 */
export const DARK_MEDIA_SELECTOR = /(?:^|>\s*)@media \(prefers-color-scheme:\s*dark\)/;

/**
 * Matches a bare class-selector block — `.pswp { ... }`, or ugcportal-rw9j's
 * `.bg-surface-0,\n.bg-surface-1, ... { --ring: ...; }` - a CLASS-SCOPED
 * override, conditional on which element a component puts that class on,
 * not a theme declaration. resolveToken has no notion of "which class is
 * actually on this element" (that is a DOM fact, not a stylesheet fact), so
 * these are excluded from the theme map entirely in both modes rather than
 * folded into either one: `flattenDeclarations`'s "declared twice" guard
 * would otherwise see `--ring` declared once in :root and once more here and
 * read it as the exact second-theme drift ugcportal-axu's rule exists to
 * catch, when it is actually a third, legitimate kind of override alongside
 * the dark-media one above. A pairing that needs to verify a class-scoped
 * override's effect (contrast.ts's focus-ring-on-old-surface) checks the
 * literal token the override points at directly instead - the same way it
 * already does for primary-hover-fill and friends.
 *
 * round 5 (code-review): matches a `.` at the very start of the joined
 * selector string, OR right after a `>` nesting boundary - not just at the
 * start - for the same reason DARK_MEDIA_SELECTOR above already does this.
 * A class selector wrapped in an at-rule (`@layer base { .bg-surface-0 {
 * --ring: ...; } }`, an otherwise ordinary refactor nobody would expect to
 * change meaning) joins to "@layer base > .bg-surface-0, ...", which the
 * old `/^\./` never matched; `flattenDeclarations` then saw --ring declared
 * twice (once in :root, once "undetected-class-scoped") and threw. Fails
 * loudly today (not silently wrong) precisely because this guard didn't
 * fire - reproduced directly against loadThemeTokens before this fix.
 */
const CLASS_SCOPED_SELECTOR = /(?:^|>\s*)\./;

/**
 * Reads and flattens the shipped stylesheet for one theme mode.
 *
 * "Light" (the default) is every :root/@theme declaration not nested inside
 * the dark media query and not inside a class-scoped block (see
 * CLASS_SCOPED_SELECTOR) - exactly what this function returned before
 * dual-mode theming existed, so every caller that does not pass `mode` keeps
 * working unchanged. "Dark" is that same light map with whatever the dark
 * media query re-declares layered on top, the same way a browser's own
 * cascade resolves it: the light value is the fallback, the dark one wins
 * once the media feature matches.
 *
 * `flattenDeclarations` still refuses a property declared twice *within the
 * same mode* (ugcportal-axu's "one theme" guarantee, preserved per mode
 * rather than globally) — it just no longer considers a property declared
 * once in :root and once more inside the dark media query (or inside a
 * class-scoped block) to be that same violation, because those are the two
 * deliberate, single places that pattern is allowed.
 */
export function loadThemeTokens(
  cssPath: string = GLOBALS_CSS_PATH,
  mode: ThemeMode = "light",
): Map<string, Declaration> {
  const css = readFileSync(cssPath, "utf8");
  const declarations = parseDeclarations(css).filter(
    (declaration) => !CLASS_SCOPED_SELECTOR.test(declaration.selector),
  );
  const lightDeclarations = declarations.filter(
    (declaration) => !DARK_MEDIA_SELECTOR.test(declaration.selector),
  );
  const lightTokens = flattenDeclarations(lightDeclarations);
  if (mode === "light") return lightTokens;

  const darkDeclarations = declarations.filter((declaration) =>
    DARK_MEDIA_SELECTOR.test(declaration.selector),
  );
  const darkOverrides = flattenDeclarations(darkDeclarations);
  const merged = new Map(lightTokens);
  for (const [property, declaration] of darkOverrides) {
    merged.set(property, declaration);
  }
  return merged;
}
