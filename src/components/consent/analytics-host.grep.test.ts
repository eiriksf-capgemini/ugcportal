import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ANALYTICS_MARKER } from "@/lib/analytics-marker";
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
  // Round 5, finding 6: ANALYTICS_MARKER now lives in one shared module
  // (src/lib/analytics-marker.ts), imported here AND by
  // e2e/cookie-consent.spec.ts — it necessarily spells the vendor name
  // itself, same reason the loader and this file are both already allowed.
  // Its own direct unit test (analytics-marker.test.ts) needs the same
  // allowance, for the same reason this file's own tests do.
  "lib/analytics-marker.ts",
  "lib/analytics-marker.test.ts",
  // The privacy statement (ugcportal-qnq9.4) has to tell the visitor WHICH
  // tool loads after they accept — GDPR Art. 13 is not satisfied by "an
  // analytics script". Naming it in prose is not wiring it up: content.ts
  // is a data module with no script, and eslint.config.mjs's next/script
  // ban still applies to it. Its test names the vendor in the pattern that
  // keeps the vendor OUT of layout.tsx.
  "app/privacy/content.ts",
  "app/privacy/content.test.ts",
]);

// walkSourceFiles's own default (/\.(tsx|ts)$/) misses .jsx/.js/.mjs
// entirely (review round 4, finding 2 — CONFIRMED: a .js or .mjs file
// under src/ bypassed this scan silently). A tracking snippet doesn't
// require TypeScript to execute; next.config.ts, scripts/, and any future
// plain-JS file under src/ are just as real a bypass surface as a .ts one.
// `.cjs` added by ugcportal-ysub item 3: CommonJS is as executable as ESM,
// and a `.cjs` file under src/ was covered by neither this scan's extension
// list nor (before this bead) eslint.config.mjs's gated-script rules.
const K6_SCANNED_EXTENSIONS = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

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
    if (ANALYTICS_MARKER.test(stripComments(contents, absolutePath))) offenders.push(relative);
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

  it("reports a vendor reference in a CommonJS .cjs file", () => {
    // ugcportal-ysub item 3: `.cjs` was in neither this list nor the lint
    // rule's file globs, so a CommonJS tracking snippet under src/ was
    // invisible to both halves of the gate at once.
    const root = fixture({
      "offender.cjs": 'module.exports = { trackingSrc: "https://stats.example/x?umami" };',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.cjs"]);
  });

  /**
   * ugcportal-ysub item 1 (CONFIRMED medium, reproduced by execution): the
   * `)` that closes an `if`/`while` CONDITION looks exactly like the `)`
   * that closes a parenthesised VALUE to a character-based "is this `/`
   * division?" heuristic — so the regex literal in statement position
   * right after it was read as a division operator. With an ODD number of
   * quote characters in that regex's own pattern, the first of them then
   * opened a phantom string, and from there the scanner ran with inverted
   * string parity: the `//` of a perfectly ordinary `https://` URL later
   * in the file was read as a comment opener and the live analytics host
   * after it was erased before the grep ever saw it.
   *
   * This is K3's "following should never happen" fixture: a real file on
   * disk, walked by the real walker, read by the real reader, stripped by
   * the real scanner, matched by the real marker.
   */
  it("reports a live analytics host that follows a control-flow ) and an odd-quoted regex", () => {
    const root = fixture({
      "offender.ts":
        "export function hasCharset(header: string): void {\n" +
        '  if (header) /charset="/i.test(header);\n' +
        "}\n" +
        'const trackingSrc = "https://stats.example/x?umami";\n',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Review round 1 on this PR, finding 2, MEDIUM (CONFIRMED by execution):
   * a block comment with no closer runs to end of file, so stripping it
   * erased every line after it — and a live analytics host on one of those
   * lines was gone before this grep ever ran. The second K3 fixture, same
   * shape as the desync one above: real file, real walker, real reader,
   * real scanner, real marker. `stripComments` now returns such a file
   * whole rather than stripping it, so the host is still there to find.
   */
  it("reports a live analytics host that follows an unterminated block comment", () => {
    const root = fixture({
      "offender.ts":
        "const a = 1; /* this comment is never closed\n" +
        'const trackingSrc = "https://stats.example/x?umami";\n',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Review round 1 on this PR, finding 1, MEDIUM (CONFIRMED by execution):
   * parsing every file as TSX made a `.ts` file's generic arrow open a JSX
   * element that never closes, so no comment after it was stripped. That
   * direction is a FALSE POSITIVE for this gate rather than a bypass — a
   * comment merely discussing the vendor would trip it, which is precisely
   * the round-2 finding-9 regression this scan already pays to avoid.
   */
  it("does not report a .ts file whose only vendor mention is a comment after a generic arrow", () => {
    const root = fixture({
      "fine.ts":
        "export const identity = <T>(x: T) => x;\n" +
        "// umami lives in analytics-loader.tsx, not here\n" +
        "export const y = 2;\n",
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual([]);
  });

  it("MUTATION CHECK: the same file with the vendor in LIVE code after the generic arrow IS reported", () => {
    const root = fixture({
      "offender.ts":
        "export const identity = <T>(x: T) => x;\n" +
        'export const trackingSrc = "https://stats.example/x?umami";\n',
    });

    const result = findAnalyticsMarkerOffenders(
      walkSourceFiles(root, INCLUDE_EVERYTHING, K6_SCANNED_EXTENSIONS),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
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
