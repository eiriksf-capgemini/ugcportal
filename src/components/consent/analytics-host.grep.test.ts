import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "@/lib/design/scan-source";

/**
 * K6 (ugcportal-3wgp): "the gate being bypassed by a script placed outside
 * it" must never happen. Verified by greping src/ for the analytics host
 * (Umami) or its env var names and failing if either appears anywhere
 * outside the one gated loader module.
 *
 * Reuses src/lib/design's own `walkSourceFiles` (the same file walker
 * no-raw-hex.test.ts and dual-meaning-usage.test.ts use) rather than a new
 * hand-rolled directory walk, for the same "don't re-litigate what counts
 * as a source file" reason those two share it.
 *
 * This file's own path, and analytics-loader.tsx/analytics-loader.test.ts,
 * are the only allowed matches — the loader module and its test cannot
 * avoid mentioning "umami" and still be useful, and this grep test cannot
 * describe what it is checking for without mentioning it either. Every
 * other file under src/ is in scope.
 */

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ALLOWED_RELATIVE_PATHS = new Set([
  "src/components/consent/analytics-loader.tsx",
  "src/components/consent/analytics-loader.test.tsx",
  "src/components/consent/analytics-host.grep.test.ts",
]);

// Matches "umami" case-insensitively, which also catches the two env var
// names (NEXT_PUBLIC_UMAMI_SRC, NEXT_PUBLIC_UMAMI_WEBSITE_ID) and any actual
// host/URL containing the word, without needing three separate patterns.
const ANALYTICS_MARKER = /umami/i;

function toRepoRelative(absolutePath: string): string {
  return path.relative(path.resolve(SRC_ROOT, ".."), absolutePath).split(path.sep).join("/");
}

// No exclusions at all: unlike dual-meaning-usage.test.ts (which uses
// isTestFile to skip test files because it only cares about shipped UI),
// this scan deliberately covers test files too — the allowlist above is
// the only exemption, so a future test file that hardcodes the analytics
// host still trips this rather than being silently out of scope.
const INCLUDE_EVERYTHING = () => false;

describe("K6: the analytics host/script name appears nowhere outside the gated loader", () => {
  it("finds files to scan (sanity check on the walker itself)", () => {
    const files = walkSourceFiles(SRC_ROOT, INCLUDE_EVERYTHING);
    expect(files.length).toBeGreaterThan(50);
  });

  it("greps every file under src/ for 'umami' and allows it only in the gated loader and its own tests", () => {
    const offenders: string[] = [];
    for (const absolutePath of walkSourceFiles(SRC_ROOT, INCLUDE_EVERYTHING)) {
      const relative = toRepoRelative(absolutePath);
      if (ALLOWED_RELATIVE_PATHS.has(relative)) continue;
      const contents = readFileSync(absolutePath, "utf8");
      if (ANALYTICS_MARKER.test(contents)) {
        offenders.push(relative);
      }
    }

    expect(
      offenders,
      `"umami" (or an env var naming it) found outside the gated loader in: ${offenders.join(", ")}. ` +
        `Umami may only be referenced in ${[...ALLOWED_RELATIVE_PATHS].join(", ")} — ` +
        `a tracking script must plug into AnalyticsLoader, not be wired up directly elsewhere.`,
    ).toEqual([]);
  });

  it("MUTATION CHECK: the scan actually notices a planted violation (proves the test can fail)", () => {
    // Fixture mutation, not a production-code change: builds the exact file
    // list the real test would see, but with a synthetic extra file
    // containing the marker outside the allowlist, and confirms the same
    // detection logic used above flags it. This is the harness-can-fail
    // proof for a test whose happy path is "found nothing" — the one shape
    // that needs this, since a scanner that always finds zero matches would
    // pass this suite even if it silently stopped scanning anything.
    const planted = "src/components/some-other-component.tsx";
    const syntheticFiles = new Map<string, string>([
      [planted, 'const trackingSrc = "https://stats.example/umami.js";'],
      ["src/components/consent/analytics-loader.tsx", "umami lives here, allowed"],
    ]);

    const offenders = [...syntheticFiles.entries()]
      .filter(([relative]) => !ALLOWED_RELATIVE_PATHS.has(relative))
      .filter(([, contents]) => ANALYTICS_MARKER.test(contents))
      .map(([relative]) => relative);

    expect(offenders).toEqual([planted]);
  });
});
