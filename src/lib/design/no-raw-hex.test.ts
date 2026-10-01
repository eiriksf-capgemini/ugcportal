/**
 * K2 (ugcportal-rw9j): "no raw hex values in components outside the tokens/
 * theme file". A grep-style CI check, run as a vitest test (so it is part of
 * `npm test`, already in CI's `quality` job) rather than a separate lint rule
 * - this repo's own ESLint config has no custom-rule mechanism set up, and a
 * plain source scan here does not need one.
 *
 * Scope: every .tsx and .css file under src/, which is where a component
 * could actually render a literal colour (in JSX, in a `style={}`, or in a
 * stylesheet) - EXCEPT:
 *
 *   - src/app/globals.css, the tokens/theme file itself. That is where every
 *     hex literal in this app's palette is meant to live (see its own
 *     "ONE THEME PER MODE" and petrol-palette comments).
 *   - src/lib/design/**, the colour-contrast engine (color.ts, contrast.ts,
 *     tokens.ts, usage.ts) and its tests. That code's whole job is parsing
 *     and reasoning about arbitrary hex/oklch strings as DATA - a hex literal
 *     there is a worked example or a test fixture, not a component choosing
 *     its own colour outside a token.
 *   - *.test.ts(x) elsewhere, for the same "fixture, not shipped UI" reason
 *     (confirmed empty today - this repo's components do not inline hex
 *     anywhere - but excluded on principle rather than happening to pass).
 *
 * .ts files outside src/lib/design are NOT excluded as a category: a future
 * hex literal smuggled into, say, an email template or OG-image generator
 * would still be a K2 violation and this still has to see it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SCANNED_EXTENSIONS = /\.(tsx|ts|css)$/;

/** Matches a CSS hex colour literal: #rgb, #rgba, #rrggbb or #rrggbbaa. */
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

const EXCLUDED_FILES = new Set([path.join(SRC_ROOT, "app", "globals.css")]);
const EXCLUDED_DIRS = [path.join(SRC_ROOT, "lib", "design")];

function isExcluded(file: string): boolean {
  if (EXCLUDED_FILES.has(file)) return true;
  if (EXCLUDED_DIRS.some((dir) => file.startsWith(dir + path.sep))) return true;
  if (/\.(test|spec)\.(tsx?|css)$/.test(file)) return true;
  return false;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.includes(`${path.sep}generated${path.sep}`)) continue;
    if (SCANNED_EXTENSIONS.test(entry) && !isExcluded(full)) out.push(full);
  }
}

/**
 * Strips `//`, `/* *\/` and the CSS/JS-comment-adjacent `{/* *\/}` wrapper
 * braces are irrelevant to a text scan, so only the comment bodies need
 * removing.
 *
 * The line-comment half uses a negative lookbehind for `:` (not usage.ts's
 * `(^|[^:\w])` boundary) specifically so it does NOT require whitespace
 * before `//` to strip it - review round 1: `(^|[^:\w])` also excludes any
 * `//` immediately after a word character (digit/letter) with no separating
 * space, so e.g. `5//#abc123` left the hex literal in a genuine comment
 * un-stripped and reported as a false-positive "raw hex" finding. The
 * lookbehind only has to avoid treating a URL's `://` as a comment opener;
 * it does not need usage.ts's broader class-name-boundary logic, which this
 * file has no class names to bound.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<!:)\/\/[^\n]*/g, " ");
}

describe("no raw hex colour literals outside the tokens file", () => {
  it("finds files to scan", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    expect(files.length).toBeGreaterThan(10);
  });

  it("ships no hex colour literal in a .tsx/.ts/.css file other than the tokens file", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);

    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      const matches = source.match(HEX_COLOR);
      if (matches) {
        const relative = path.relative(path.dirname(SRC_ROOT), file);
        offenders.push(`${relative}: ${matches.join(", ")}`);
      }
    }

    expect(
      offenders,
      "Raw hex colour literal(s) found outside src/app/globals.css. Every " +
        "colour in a component must resolve through a design token - add the " +
        "value to globals.css (or reuse an existing token) and reference it " +
        "via a Tailwind utility or var(), rather than writing the hex " +
        `directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
