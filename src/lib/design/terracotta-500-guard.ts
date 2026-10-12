/**
 * K3 guard (ugcportal-dmne): "terracotta-500 used behind body-sized text"
 * must never happen.
 *
 * Why this needs its own guard rather than relying on the ordinary contrast
 * gate (src/lib/design/contrast.ts): PAIRINGS only checks pairings this file
 * was TOLD about. `--terracotta-500` measures 3.3:1 against white and 4.4:1
 * against `--petrol-900` (src/app/globals.css's own terracotta-step
 * comment) — both short of body's 4.5:1, and BOTH the usable inks this
 * palette has. There is no safe body-text pairing for this step to add to
 * PAIRINGS in the first place; the gate can only prove a pairing that
 * exists is safe, never that an absent one was never written. This module
 * is the second half: it reads real component source (and a caller-supplied
 * fixture, for the dedicated mutation test) looking for the one shape that
 * is never safe — `bg-terracotta-500` co-occurring, in the same class list,
 * with a non-large text-size utility and no large-text utility alongside it
 * — regardless of which ink the caller chose, because K3 is true of EITHER
 * usable ink, not just one.
 *
 * Scope, stated rather than solved (same discipline this repo's other
 * source-text scanners disclose, see scan-source.ts's own header): this
 * looks at one quoted/template string literal at a time, the unit
 * `className`/`cva` variant strings are written in throughout this repo
 * (and the one this repo's own Tailwind-v4-static-scan rule already
 * requires every class name to be, per ugcportal-a3hj). A background and a
 * text-size utility split across two SEPARATE `cn()` arguments, or applied
 * to two different DOM elements (a parent fill, a child's inherited text
 * size), is invisible to it — the same static-text limit
 * src/components/ui/button.test.ts's z1nh guard discloses for the
 * analogous "does this name compile" question, not a gap unique to this
 * file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { isTestFile, stripComments, walkSourceFiles } from "./scan-source";

/**
 * WCAG 1.4.3's large-text threshold (>=18.66px bold or >=24px any weight) is
 * a continuous boundary Tailwind's own discrete size scale does not map
 * onto exactly — `text-lg` (18px) sits just under the bold threshold.
 * Deliberately conservative in the direction that matters here: every size
 * at or above `text-lg` counts as "large enough to exempt", which is the
 * generous reading, not the strict one. That is intentional — this guard's
 * job is to catch `--terracotta-500` behind ordinary BODY copy
 * (`text-xs`/`text-sm`/`text-base`, what every real control in this repo
 * actually uses), not to adjudicate the exact bold/18.66px boundary no
 * production call site here is anywhere near.
 */
export const LARGE_TEXT_SIZE_CLASSES: ReadonlySet<string> = new Set([
  "text-lg",
  "text-xl",
  "text-2xl",
  "text-3xl",
  "text-4xl",
  "text-5xl",
  "text-6xl",
  "text-7xl",
  "text-8xl",
  "text-9xl",
]);

/** The explicit non-large text-size utilities this repo's components actually use. */
export const BODY_TEXT_SIZE_CLASSES: ReadonlySet<string> = new Set([
  "text-xs",
  "text-sm",
  "text-base",
]);

const TERRACOTTA_500_FILL = "bg-terracotta-500";

/** Strips a Tailwind variant prefix (`hover:`, `dark:focus:`, ...), keeping only the bare utility name. */
function bareUtility(token: string): string {
  const lastColon = token.lastIndexOf(":");
  return lastColon === -1 ? token : token.slice(lastColon + 1);
}

/**
 * True when ONE class-list string (one element's worth of classes) pairs
 * `bg-terracotta-500` with a non-large text-size utility and no large-text
 * utility to exempt it — K3's exact "never happen" shape.
 *
 * Only `bg-terracotta-500` is checked as the fill, not `text-terracotta-500`
 * (a terracotta-500 LABEL on some other background is a different claim —
 * K3 is specifically about text sitting ON this fill, "used behind
 * body-sized text") — and only an EXPLICIT body-size marker counts as the
 * unsafe half: a class list naming no text-size utility at all inherits an
 * ambient size this scanner cannot see, so it is not flagged (a false
 * negative this module accepts rather than guesses past, same "exclude,
 * don't guess" precedent src/lib/design/usage.ts's own header states).
 */
export function hasUnsafeTerracotta500Pairing(classList: string): boolean {
  let hasFill = false;
  let hasBodyMarker = false;
  let hasLargeMarker = false;
  for (const rawToken of classList.split(/\s+/)) {
    if (rawToken === "") continue;
    const bare = bareUtility(rawToken);
    if (bare === TERRACOTTA_500_FILL) hasFill = true;
    if (BODY_TEXT_SIZE_CLASSES.has(bare)) hasBodyMarker = true;
    if (LARGE_TEXT_SIZE_CLASSES.has(bare)) hasLargeMarker = true;
  }
  return hasFill && hasBodyMarker && !hasLargeMarker;
}

/** One quoted ("...", '...') or backtick-delimited string literal, same three JS/TSX forms button.tsx's own z1nh guard matches. */
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

export type Terracotta500Violation = {
  /** Path relative to `root`. */
  file: string;
  /** The exact class-list literal the violation was found in. */
  classList: string;
};

/**
 * Every real `bg-terracotta-500` + non-large-text-size co-occurrence under
 * `root`, excluding test/spec files (fixtures, not shipped UI — same
 * exclusion no-raw-hex.test.ts and the z1nh guard both draw) and this
 * module's own directory (src/lib/design/**, which describes Tailwind
 * classes as DATA in prose/fixtures, not as UI — the identical exclusion
 * findBareColorUtilities and the z1nh guard already draw, for the same
 * reason).
 */
export function scanForUnsafeTerracotta500Pairings(root: string): Terracotta500Violation[] {
  const designLibDir = path.join(root, "lib", "design") + path.sep;
  const violations: Terracotta500Violation[] = [];
  const files = walkSourceFiles(
    root,
    (file) => isTestFile(file) || file.startsWith(designLibDir),
  );
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, "utf8"), file);
    STRING_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STRING_LITERAL.exec(stripped)) !== null) {
      const literal = match[1] ?? match[2] ?? match[3] ?? "";
      if (hasUnsafeTerracotta500Pairing(literal)) {
        violations.push({ file: path.relative(root, file), classList: literal });
      }
    }
  }
  return violations;
}
