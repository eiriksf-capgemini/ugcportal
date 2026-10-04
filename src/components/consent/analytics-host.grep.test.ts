import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "@/lib/design/scan-source";

import { GATED_LOADER_PATH } from "../../../eslint.config.mjs";

/**
 * K6 (ugcportal-3wgp): "the gate being bypassed by a script placed outside
 * it" must never happen. This is belt-and-braces alongside
 * eslint.config.mjs's `no-restricted-syntax` ban on importing `next/script`
 * or using a raw `<script src>` anywhere outside analytics-loader.tsx
 * (review round 1, finding 2) — that rule catches the MECHANISM regardless
 * of vendor name; this test catches the host-name string regardless of
 * mechanism (e.g. a raw `fetch()` beacon naming the vendor, which no
 * next/script-focused lint rule would see).
 *
 * `findAnalyticsMarkerOffenders` below is exported and exercised directly,
 * against a real temp-directory fixture, by its own describe block further
 * down (review round 1, finding 3) — the first version of this test's
 * mutation check re-implemented the filter inline against an in-memory Map
 * and never called this function, `walkSourceFiles`, or `readFileSync`, so a
 * regression in any of those (inverted exclusion, a changed extension regex,
 * a broken relative-path join) could have shipped with every test in this
 * file still green.
 *
 * This file's own path, and analytics-loader.tsx/analytics-loader.test.ts,
 * are the only allowed matches — the loader module and its test cannot
 * avoid mentioning "umami" and still be useful, and this grep test cannot
 * describe what it is checking for without mentioning it either. Every
 * other file under src/ is in scope, including other test files (no
 * isTestFile exclusion, unlike dual-meaning-usage.test.ts — see
 * INCLUDE_EVERYTHING below) and every real source extension, not just
 * `.ts`/`.tsx` — see K6_SCANNED_EXTENSIONS below (review round 4,
 * finding 2: walkSourceFiles's own default, `/\.(tsx|ts)$/`, silently
 * missed `.jsx`/`.js`/`.mjs`, a bypass surface just as real as a `.ts`
 * one since none of those need TypeScript to execute).
 *
 * Comments are stripped before matching (review round 2, finding 9) using
 * the same `stripComments` its sibling repo-wide scanners
 * (dual-meaning-usage.test.ts, no-raw-hex.test.ts, both via scan-source.ts)
 * already use — before this fix, an innocent comment merely discussing the
 * vendor name (a code-review note, a docblock explaining why some other
 * file is the gate) tripped this test with no live code anywhere
 * referencing it, a false positive its siblings don't have.
 */

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Relative to SRC_ROOT itself (not the repo root) — see
// findAnalyticsMarkerOffenders's own doc comment for why. The loader's own
// path comes from eslint.config.mjs's exported GATED_LOADER_PATH (review
// round 3, finding 5 — reuse) rather than a second hardcoded copy here;
// GATED_LOADER_PATH is repo-root-relative (ESLint's own convention), so the
// leading "src/" is stripped to match this file's SRC_ROOT-relative one.
const ALLOWED_RELATIVE_PATHS = new Set([
  GATED_LOADER_PATH.replace(/^src\//, ""),
  "components/consent/analytics-loader.test.tsx",
  "components/consent/analytics-host.grep.test.ts",
]);

// Matches "umami" case-insensitively, which also catches the two env var
// names (NEXT_PUBLIC_UMAMI_SRC, NEXT_PUBLIC_UMAMI_WEBSITE_ID) and any actual
// host/URL containing the word, without needing three separate patterns.
const ANALYTICS_MARKER = /umami/i;

// walkSourceFiles's own default (/\.(tsx|ts)$/) misses .jsx/.js/.mjs
// entirely (review round 4, finding 2 — CONFIRMED: a .js or .mjs file
// under src/ bypassed this scan silently). A tracking snippet doesn't
// require TypeScript to execute; next.config.ts, scripts/, and any future
// plain-JS file under src/ are just as real a bypass surface as a .ts one.
const K6_SCANNED_EXTENSIONS = /\.(tsx|ts|jsx|js|mjs)$/;

// No exclusions at all: unlike dual-meaning-usage.test.ts (which uses
// isTestFile to skip test files because it only cares about shipped UI),
// this scan deliberately covers test files too — the allowlist above is
// the only exemption, so a future test file that hardcodes the analytics
// host still trips this rather than being silently out of scope.
const INCLUDE_EVERYTHING = () => false;

/**
 * The real scanner (K6), exported so the mutation-check describe block
 * below can drive it against a synthetic directory on disk rather than
 * re-implementing its filter inline (review round 1, finding 3).
 *
 * Takes `files` (an already-walked list) rather than walking `root` itself,
 * so the real-tree test below can walk SRC_ROOT exactly once and have both
 * the sanity check and the real assertion share that one result (review
 * round 1, finding 10 — `walkSourceFiles` previously ran twice per test run
 * for ~200 files).
 *
 * `allowedRelativePaths` are relative to `root` itself, not to `root`'s
 * parent: a temp-directory fixture has no "src" ancestor to anchor a
 * repo-relative convention to, and computing paths relative to `root`
 * directly works identically for the real tree (passing SRC_ROOT) and for
 * a fixture (passing the fixture's own temp root).
 */
export function findAnalyticsMarkerOffenders(
  files: readonly string[],
  root: string,
  allowedRelativePaths: ReadonlySet<string>,
): string[] {
  const offenders: string[] = [];
  for (const absolutePath of files) {
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    if (allowedRelativePaths.has(relative)) continue;
    const contents = readFileSync(absolutePath, "utf8");
    if (ANALYTICS_MARKER.test(stripComments(contents))) offenders.push(relative);
  }
  return offenders;
}

describe("K6: the analytics host/script name appears nowhere outside the gated loader", () => {
  const files = walkSourceFiles(SRC_ROOT, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS);

  it("finds files to scan (sanity check on the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("greps every file under src/ for 'umami' and allows it only in the gated loader and its own tests", () => {
    const offenders = findAnalyticsMarkerOffenders(files, SRC_ROOT, ALLOWED_RELATIVE_PATHS);

    expect(
      offenders,
      `"umami" (or an env var naming it) found outside the gated loader in: ${offenders.join(", ")}. ` +
        `Umami may only be referenced in ${[...ALLOWED_RELATIVE_PATHS].join(", ")} — ` +
        `a tracking script must plug into AnalyticsLoader, not be wired up directly elsewhere.`,
    ).toEqual([]);
  });
});

describe("findAnalyticsMarkerOffenders (the real scanner, exercised over a real fixture on disk)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "analytics-host-grep-"));
    created.push(root);
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return root;
  }

  it("reports a real offending file, found by actually walking and reading the fixture directory", () => {
    const root = fixture({
      "allowed.ts": "// nothing to see here",
      "offender.ts": 'const trackingSrc = "https://stats.example/umami.js";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(["allowed.ts"]),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  it("MUTATION: removing the offending file from the same fixture makes the scan report nothing", () => {
    // This is the required mutation for the test above, kept as its own
    // standing assertion rather than a one-off manual check: same shape,
    // minus the offending file, over the real scan path — proving the
    // "found nothing" result above is live and not a scanner that silently
    // stopped looking.
    const root = fixture({
      "allowed.ts": "// nothing to see here",
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(["allowed.ts"]),
    );

    expect(result).toEqual([]);
  });

  it("an allowed path inside the fixture is not reported even though it contains the marker", () => {
    const root = fixture({
      "allowed.ts": 'const note = "umami lives here, allowed";',
      "offender.ts": 'const note = "umami, not allowed here";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(["allowed.ts"]),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Review round 2, finding 9: a comment merely discussing the vendor name
   * must not trip this test — only LIVE code referencing it should.
   */
  it("does not report a file where the marker appears only inside a comment", () => {
    const root = fixture({
      "block-comment.ts": "/* do not wire up umami tracking here directly */\nexport const x = 1;",
      "line-comment.ts": "// umami lives in analytics-loader.tsx, not here\nexport const y = 2;",
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual([]);
  });

  it("MUTATION CHECK: still reports a file where the marker appears in live code alongside an unrelated comment", () => {
    // Confirms the fix above is "strip comments", not "stop matching
    // altogether" — a regression that did the latter would also pass the
    // comment-only test above.
    const root = fixture({
      "offender.ts": '// unrelated comment\nconst trackingSrc = "https://stats.example/umami.js";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Review round 3, MEDIUM (CONFIRMED, reproduced by the reviewer): the old
   * stripComments erased everything from an unprefixed `//` to end of
   * line, so a PROTOCOL-RELATIVE URL (no scheme, so nothing precedes its
   * `//`) inside a live string literal was mistaken for a comment opener —
   * the rest of the line, including "umami", vanished before this scan
   * ever ran. See scan-source.test.ts for the unit-level fixture on
   * stripComments itself; this is the end-to-end version, through the
   * real K6 scanner.
   */
  it("reports a vendor reference reached only via a protocol-relative URL in a string", () => {
    const root = fixture({
      "offender.ts": 'const trackingSrc = "//stats.example/collect?x=umami";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Review round 4, MEDIUM (CONFIRMED, reproduced by the reviewer): a
   * quote character inside a regex literal's own pattern (not string
   * syntax) — the exact shape of the real `DISPOSITION_NAME` constant in
   * src/lib/request-body.ts — desynced the round-3 string tracker, which
   * had no concept of a regex literal at all. See scan-source.test.ts for
   * the unit-level fixture; this is the end-to-end version, through the
   * real K6 scanner, proving a live vendor reference AFTER such a regex in
   * the same file is still found rather than blinded by the desync.
   */
  it("reports a vendor reference that appears after a regex literal containing a quote character", () => {
    const root = fixture({
      "offender.ts":
        'const DISPOSITION_NAME = /;\\s*name\\s*=\\s*"([^"]*)"/i;\n' +
        'const trackingSrc = "https://stats.example/x?umami";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Review round 4, MEDIUM (CONFIRMED): walkSourceFiles's own default
   * extensions regex (`/\.(tsx|ts)$/`) silently skipped `.js`/`.mjs`
   * (and `.jsx`) entirely — a tracking snippet doesn't need TypeScript
   * to execute, so a plain `.js` file under src/ was just as real a
   * bypass as a `.ts` one, and this scan never looked at it at all.
   */
  it("reports a vendor reference in a plain .js file", () => {
    const root = fixture({
      "offender.js": 'const trackingSrc = "https://stats.example/x?umami";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.js"]);
  });

  it("reports a vendor reference in a plain .mjs file", () => {
    const root = fixture({
      "offender.mjs": 'export const trackingSrc = "https://stats.example/x?umami";',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.mjs"]);
  });

  it("MUTATION CHECK: reverting to the default (tsx|ts-only) extensions misses the .js/.mjs offenders", () => {
    const root = fixture({
      "offender.js": 'const trackingSrc = "https://stats.example/x?umami";',
      "offender.mjs": 'export const trackingSrc = "https://stats.example/x?umami";',
    });

    // No third argument: falls back to walkSourceFiles's own default,
    // /\.(tsx|ts)$/ — the exact shape this finding is about.
    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING),
      root,
      new Set(),
    );

    expect(result).toEqual([]);
  });
});
