#!/usr/bin/env node
/**
 * A rerunnable stand-in for the manual verification PR #129's round-1
 * review did by hand ("next build + compiled CSS inspection: exactly one
 * group-hover: scale- [1.04] rule... properly gated", spaces inserted here
 * only - the one after the hyphen is what stops extraction (ugcportal-rj7y) -
 * same reason globals.css's own comment and every other file that
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
 * It also runs the repo-wide check (ugcportal-rj7y K2): every rule in the
 * compiled output that declares `scale`, `translate`, `rotate`, `transform`,
 * `animation` or `animation-name` with a value other than `none` is reported
 * unless it is gated, whichever file's text it came from. `transform` is in
 * the list because Tailwind v4 compiles `skew-*`, `rotate-x-*` and
 * `rotate-y-*` to it (round-1 F1: planted skews compiled to bare
 * `transform` rules this check used to pass). Gated means nested inside
 * `@media (prefers-reduced-motion: no-preference)` (what `motion-safe:`
 * compiles to), or inside `@media (prefers-reduced-motion: reduce)` with a
 * selector whose utility removes or neutralises motion (NEUTRALISING_UTILITY;
 * `motion-reduce:` on a utility that adds motion is not a gate, orchestrator
 * decision on round-1 F6). Transitions are not checked here: a transition
 * moves nothing unless one of the properties above changes. That is the
 * compiled-output half of src/lib/design/tailwind-source-scan.test.ts: that
 * test rejects the source string, this one proves nothing from a file that
 * ships no UI reached the stylesheet anyway (a glob or a scanner difference
 * the text scan cannot see). The deliberate ungated rules are named in
 * UNGATED_MOTION_ALLOWLIST, each with the exact number of compiled rules it
 * must match; any other count (0 when stale, more when widened) fails, so
 * an entry cannot go stale silently (`allowlistDrift`).
 *
 * Usage: `node scripts/check-reduced-motion-css-exclusions.mjs` after
 * `npm run build`. Exits 1 and lists every offender if any ungated
 * group-hover+scale rule or any ungated motion rule is found in the compiled
 * output, or if an allowlist entry's match count drifted; exits 0 otherwise
 * (including "no build present").
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
      isReducedMotionQuery(condition, "no-preference"),
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

/**
 * Compiled rules allowed to apply motion with no reduced-motion gate. Each
 * key is a selector exactly as postcss reads it; `count` is how many compiled
 * rules with a motion declaration it must match across every CSS file of one
 * build (checked by `allowlistDrift`). The video badge key is written in two
 * pieces on purpose: Tailwind reads this file's bytes, and the whole class
 * name here would compile a second rule.
 */
export const UNGATED_MOTION_ALLOWLIST = new Map([
  [
    ".translate-x-" + "0\\.5",
    { count: 1, reason: "video badge icon: a static optical nudge applied unconditionally" },
  ],
  [
    ".pswp__preloader .pswp__icn",
    {
      count: 1,
      reason:
        "PhotoSwipe's own vendored loading spinner, imported whole from its stylesheet; it ships " +
        "ungated today and is not this script's to fix (tracked in ugcportal-o5yj, remove this entry when that lands)",
    },
  ],
  [
    ".pswp,.pswp__bg",
    { count: 1, reason: "PhotoSwipe's vendored translateZ(0) compositing hint: a static layer promotion, no visible movement" },
  ],
  [
    ".pswp__button--arrow--next .pswp__icn",
    { count: 1, reason: "PhotoSwipe's vendored scaleX(-1): mirrors the next-arrow icon statically" },
  ],
  [
    ".transform",
    {
      count: 1,
      reason:
        "the bare `transform` utility, compiled from the English word in prose across the repo; its value " +
        "is built only from the unset --tw-rotate-*/--tw-skew-* variables, so it is the identity transform " +
        "unless a skew or rotate utility sets them, and those are checked themselves",
    },
  ],
]);

const MOTION_PROPERTY = /^(?:scale|translate|rotate|transform|animation|animation-name)$/;

/**
 * A copy of tailwind-source-scan.ts's NEUTRALISING_SEGMENT (that file's test
 * fails if the two differ): a utility that removes or neutralises motion,
 * the only kind a `motion-reduce:` prefix gates. Assembled from parts so
 * these bytes compile no rule.
 */
export const NEUTRALISING_UTILITY = new RegExp(
  "^(?:" +
    "(?:animate|transition|transform|scale|translate|rotate|skew)-none" +
    "|scale-(?:[xyz]-)?1" + "00" +
    "|(?:translate|rotate)-(?:[xyz]-)?0" +
    "|skew-(?:[xy]-)?0" +
    ")$",
);

/**
 * The utility (final variant segment) of a compiled selector's first class,
 * unescaped: `.motion-reduce\:hover\:scale-100:hover` gives the utility
 * after the last top-level `:`. Empty when the selector does not start with
 * a class.
 *
 * @param {string} selector
 * @returns {string}
 */
export function utilityOfSelector(selector) {
  const match = /^\.((?:\\.|[\w-])+)/.exec(selector.trim());
  if (!match) return "";
  const className = match[1].replace(/\\(.)/g, "$1");
  let depth = 0;
  let start = 0;
  for (let i = 0; i < className.length; i++) {
    if (className[i] === "[") depth++;
    if (className[i] === "]") depth--;
    if (className[i] === ":" && depth === 0) start = i + 1;
  }
  return className.slice(start);
}

/** @param {string} condition @param {string} value */
function isReducedMotionQuery(condition, value) {
  return !/^not\b/.test(condition.trim()) && new RegExp(`prefers-reduced-motion\\s*:\\s*${value}`).test(condition);
}

/**
 * Every rule in `cssText` that declares scale, translate, rotate, transform
 * or an animation (a value other than `none`) while not gated, except the
 * allowlisted selectors. Gated: nested inside
 * `@media (prefers-reduced-motion: no-preference)`, or inside
 * `@media (prefers-reduced-motion: reduce)` with a NEUTRALISING_UTILITY
 * selector. A `not (...)` condition is never a gate. Keyframe step rules
 * are skipped: a `from`/`to` step is only reachable through an animation
 * declaration, which this check sees itself.
 *
 * @param {string} cssText
 * @param {Map<string, number>} [allowlistHits] incremented once per
 *   allowlisted rule that carried a motion declaration, for `allowlistDrift`.
 * @returns {string[]} `selector { property } (reason)` descriptions.
 */
export function findUngatedMotionRules(cssText, allowlistHits = new Map()) {
  const root = postcss.parse(cssText);
  const offenders = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    const conditions = mediaConditionsOf(rule);
    if (conditions.some((condition) => isReducedMotionQuery(condition, "no-preference"))) return;
    const underReduce = conditions.some((condition) => isReducedMotionQuery(condition, "reduce"));
    if (underReduce && NEUTRALISING_UTILITY.test(utilityOfSelector(rule.selector))) return;

    const moving = rule.nodes.filter(
      (node) => node.type === "decl" && MOTION_PROPERTY.test(node.prop) && !/^none$/i.test(node.value.trim()),
    );
    if (moving.length === 0) return;
    if (UNGATED_MOTION_ALLOWLIST.has(rule.selector)) {
      allowlistHits.set(rule.selector, (allowlistHits.get(rule.selector) ?? 0) + 1);
      return;
    }
    const reason = underReduce
      ? "under @media (prefers-reduced-motion: reduce) but adds motion: motion-reduce: gates only a utility that removes it"
      : "not nested inside @media (prefers-reduced-motion: no-preference)";
    for (const decl of moving) offenders.push(`${rule.selector} { ${decl.prop} } (${reason})`);
  });
  return offenders;
}

/**
 * Every allowlist entry whose match count across one build differs from its
 * stated `count`: 0 means the entry is stale, more means it is now hiding a
 * second rule.
 *
 * @param {Map<string, number>} allowlistHits
 * @returns {string[]}
 */
export function allowlistDrift(allowlistHits) {
  const drift = [];
  for (const [selector, { count }] of UNGATED_MOTION_ALLOWLIST) {
    const actual = allowlistHits.get(selector) ?? 0;
    if (actual !== count) {
      drift.push(`UNGATED_MOTION_ALLOWLIST ${selector}: expected ${count} matching rule(s), found ${actual}`);
    }
  }
  return drift;
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
  const allowlistHits = new Map();
  for (const file of files) {
    const cssText = readFileSync(file, "utf8");
    for (const offender of [
      ...findUngatedGroupHoverScaleRules(cssText),
      ...findUngatedMotionRules(cssText, allowlistHits),
    ]) {
      offenders.push(`${path.relative(repoRoot, file)}: ${offender}`);
    }
  }
  const drift = allowlistDrift(allowlistHits);

  if (offenders.length > 0 || drift.length > 0) {
    console.error(
      `${PREFIX} found a motion rule in the compiled production CSS that is not gated ` +
        "(motion-safe: compiles inside @media (prefers-reduced-motion: no-preference); " +
        "motion-reduce: inside (prefers-reduced-motion: reduce) gates only a utility that removes motion), " +
        "or an allowlist entry whose match count drifted (a bare mention in a comment, doc or script " +
        "compiles like a real class):\n" +
        [...offenders, ...drift].map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `${PREFIX} every compiled group-hover+scale rule and every scale/translate/` +
      `rotate/transform/animation rule across ${files.length} CSS file(s) is reduced-motion-gated ` +
      `(${UNGATED_MOTION_ALLOWLIST.size} allowlist entries, each matching its stated count).`,
  );
}

if (isMainModule(import.meta.url)) main();
/* c8 ignore stop */
