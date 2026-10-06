#!/usr/bin/env node
/**
 * A rerunnable stand-in for the manual verification PR #129's round-1
 * review did by hand ("next build + compiled CSS inspection: exactly one
 * group-hover: scale-[1.04] rule... properly gated", space inserted here
 * only, same reason globals.css's own comment and every other file that
 * quotes this shape for illustration already gives - Tailwind's real
 * build scans THIS file's raw bytes too, `scripts/` is not excluded by
 * any `@source not` glob, and an unbroken mention here would compile a
 * second, ungated copy of the rule straight into the shipped CSS,
 * reproduced while writing this very script) and for the one-time byte
 * measurements src/app/globals.css's own comment used to carry in prose
 * before this bead's round 2 (ugcportal-61pv): a number in a comment is a
 * measurement nobody re-runs, per review-standards section 5. This script
 * re-runs it.
 *
 * Deliberately does NOT invoke `next build` itself (the review comment
 * that asked for this: "do not add a full build to vitest" - the same
 * reasoning extends to this script, which is meant to be run AFTER the
 * build gate that pre-review step 1 and CI's build job already run once
 * per pass, not to duplicate it). If `.next/static/chunks` does not exist
 * yet, this exits 0 and says so rather than failing - "no build to check"
 * is not the failure this script exists to catch.
 *
 * What IS re-run: every compiled CSS chunk is parsed with postcss (a real
 * parser, not a text grep - a grep can't tell a selector from a comment or
 * a string literal inside the compiled output) and every rule whose
 * selector mentions both "group-hover" and "scale" is checked for the
 * SAME gate containment.motion-safe.test.ts's own `compile()` helper
 * checks for a single isolated class string: a `motion-safe:`-prefixed
 * selector, nested inside `@media (prefers-reduced-motion: no-preference)`.
 * A rule missing either half is the exact shape ugcportal-ig4g's gallery
 * bug, and every regression this bead's lineage has found since, took.
 *
 * Usage: `node scripts/check-reduced-motion-css-exclusions.mjs` after
 * `npm run build`. Exits 1 and lists every offending rule if any ungated
 * group-hover+scale rule is found in the compiled output; exits 0
 * otherwise (including "no build present").
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";

import { isMainModule } from "./lib/is-main.mjs";

const PREFIX = "[check-reduced-motion-css-exclusions]";

/** Every `.css` file under `dir`, recursively. */
export function walkCssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkCssFiles(full));
    } else if (entry.name.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The `@media` conditions (outermost first) `rule` sits inside, same
 * technique as containment.motion-safe.test.ts's own `groupHoverScaleRules`
 * (not shared - that one walks a freshly `postcss().process()`-ed `Root`
 * from an in-memory compile, this one walks `postcss.parse()`-ed real
 * build output; the two call sites differ enough, and are small enough,
 * that importing across a test/script boundary was judged not worth it).
 *
 * @param {import("postcss").Rule} rule
 * @returns {string[]}
 */
function mediaConditionsOf(rule) {
  const conditions = [];
  let parent = rule.parent;
  while (parent && parent.type !== "root") {
    if (parent.type === "atrule" && parent.name === "media") {
      conditions.unshift(parent.params);
    }
    parent = parent.parent;
  }
  return conditions;
}

/**
 * Every group-hover+scale rule in `cssText` that is NOT gated - missing a
 * `motion-safe:`-prefixed selector, or not nested inside
 * `@media (prefers-reduced-motion: no-preference)`, or both.
 *
 * @param {string} cssText
 * @returns {string[]} the offending selectors, each already describing
 *   which half of the gate it is missing.
 */
export function findUngatedGroupHoverScaleRules(cssText) {
  const root = postcss.parse(cssText);
  const offenders = [];
  root.walkRules((rule) => {
    if (!rule.selector.includes("group-hover") || !rule.selector.includes("scale")) return;

    // NOT a bare `.includes("motion-safe")` (same trap
    // containment.motion-safe.test.ts's own DANGEROUS_BARE_PATTERNS was
    // found in, round 2): Tailwind v4 compiles `not-motion-safe:` as a real
    // variant whose rule fires exactly when reduced motion IS requested -
    // the inverse of safe - and "not-motion-safe" contains "motion-safe" as
    // a substring, so a plain `.includes` would wrongly call that shape
    // gated. The lookbehind only counts a "motion-safe" occurrence that is
    // not itself preceded by "not-".
    const motionSafePrefixed = /(?<!not-)motion-safe/.test(rule.selector);
    const conditions = mediaConditionsOf(rule);
    const reducedMotionGated = conditions.some((condition) =>
      condition.includes("prefers-reduced-motion"),
    );
    if (motionSafePrefixed && reducedMotionGated) return;

    const missing = [
      !motionSafePrefixed && "no motion-safe: prefix",
      !reducedMotionGated && "not nested inside @media (prefers-reduced-motion: ...)",
    ]
      .filter(Boolean)
      .join(", ");
    offenders.push(`${rule.selector} (${missing})`);
  });
  return offenders;
}

/* c8 ignore start -- process wiring, exercised by running the script itself */
function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chunksDir = path.join(repoRoot, ".next", "static", "chunks");

  if (!existsSync(chunksDir)) {
    console.log(
      `${PREFIX} ${chunksDir} does not exist - run \`npm run build\` first ` +
        "(pre-review step 1 and CI's build job both already do). Skipping.",
    );
    process.exit(0);
  }

  const files = walkCssFiles(chunksDir);
  const offenders = [];
  for (const file of files) {
    const cssText = readFileSync(file, "utf8");
    for (const offender of findUngatedGroupHoverScaleRules(cssText)) {
      offenders.push(`${path.relative(repoRoot, file)}: ${offender}`);
    }
  }

  if (offenders.length > 0) {
    console.error(
      `${PREFIX} found a group-hover+scale rule in the compiled production CSS ` +
        "that is not gated by motion-safe: nested inside " +
        "@media (prefers-reduced-motion: no-preference):\n" +
        offenders.map((offender) => `  ${offender}`).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `${PREFIX} every compiled group-hover+scale rule across ${files.length} CSS ` +
      "file(s) is motion-safe:-gated.",
  );
}

if (isMainModule(import.meta.url)) main();
/* c8 ignore stop */
