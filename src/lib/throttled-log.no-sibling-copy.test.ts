import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "@/lib/design/scan-source";

/**
 * K4 (ugcportal-z3lo): "a third hand-rolled copy of this throttle appearing
 * in the repo" must never happen. `watermark.ts`'s `logShedUpload` and
 * `public-media.ts`'s `logFailedPublicListing` each used to declare their
 * own module-level `lastAt`/`suppressed` pair (`shedLogLastAt` +
 * `shedLogSuppressed`, `listingFailureLogLastAt` +
 * `listingFailureLogSuppressed`) before this bead migrated both onto
 * `createThrottledLog`. This greps for that exact shape — a `let` whose
 * name suggests a suppressed counter alongside a `let` whose name suggests
 * a last-logged timestamp, declared in the same file — so the next caller
 * that needs a throttled log is pushed toward this module instead of
 * copying the pattern a third time.
 *
 * Pins two literal name fragments — a `let`-declared identifier containing
 * `suppressed` and another containing `lastAt` — not a structural match: a
 * renamed pair (`lastLoggedAt`/`suppressedSince`, a `const`, an object
 * literal, a class field) is not caught. See the fixtures below for cases
 * this pattern does and does not match.
 *
 * This does not distinguish a module-level `let` from one declared inside
 * a function body — `throttled-log.ts` itself has exactly this pair inside
 * `createThrottledLog`'s closure, so the pattern flags it too. The
 * real-tree check below allowlists TWO files by name rather than relying
 * on the pattern to exclude either: `throttled-log.ts` (the real pair in
 * its closure) and this file itself, whose own fixture string literals
 * below contain the same two name fragments and are not comments, so
 * `stripComments` does not remove them. Erring toward a false positive
 * that has to be allowlisted is the safe direction for a guard whose job
 * is to not miss a real new copy.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THROTTLED_LOG_RELATIVE = "lib/throttled-log.ts";
const THIS_FILE_RELATIVE = "lib/throttled-log.no-sibling-copy.test.ts";

const SUPPRESSED_LET_PATTERN = /\blet\s+\w*[Ss]uppressed\w*\s*[:=]/;
const LAST_AT_LET_PATTERN = /\blet\s+\w*[Ll]ast[Aa]t\w*\s*[:=]/;

/**
 * The real scanner, exported so the mutation-check fixtures below can
 * drive it directly against synthetic files on disk rather than
 * re-implementing the match logic inline.
 */
export function findThrottleSiblingCopies(
  files: readonly string[],
  root: string,
  allowedRelativePaths: ReadonlySet<string>,
): string[] {
  const offenders: string[] = [];
  for (const absolutePath of files) {
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    if (allowedRelativePaths.has(relative)) continue;
    const contents = stripComments(readFileSync(absolutePath, "utf8"), absolutePath);
    if (SUPPRESSED_LET_PATTERN.test(contents) && LAST_AT_LET_PATTERN.test(contents)) {
      offenders.push(relative);
    }
  }
  return offenders;
}

describe("K4: no module outside throttled-log.ts hand-rolls a suppressed-count/last-at throttle pair", () => {
  const files = walkSourceFiles(SRC_ROOT, () => false);

  it("finds files to scan (sanity check on the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("greps every .ts/.tsx file under src/ and allows the pair only in throttled-log.ts and this file's own fixtures", () => {
    const offenders = findThrottleSiblingCopies(
      files,
      SRC_ROOT,
      new Set([THROTTLED_LOG_RELATIVE, THIS_FILE_RELATIVE]),
    );

    expect(
      offenders,
      `a module-level suppressed-count/last-at throttle pair found outside throttled-log.ts and ` +
        `this file's own fixtures in: ${offenders.join(", ")}. Use createThrottledLog ` +
        `(src/lib/throttled-log.ts) instead of hand-rolling another copy.`,
    ).toEqual([]);
  });
});

describe("findThrottleSiblingCopies (the real scanner, exercised over fixtures on disk)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "throttle-sibling-guard-"));
    created.push(root);
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return root;
  }

  it("reports a file that declares both a suppressed counter and a last-at timestamp", () => {
    const root = fixture({
      "offender.ts":
        "let barSuppressed = 0;\n" +
        "let barLastAt = 0;\n" +
        "export function logBar() { barSuppressed += 1; barLastAt = Date.now(); }\n",
    });

    const result = findThrottleSiblingCopies(
      walkSourceFiles(root, () => false),
      root,
      new Set(),
    );

    expect(result).toEqual(["offender.ts"]);
  });

  it("MUTATION: removing the last-at timestamp from the same fixture makes the scan report nothing", () => {
    // Required mutation for the test above, kept as a standing assertion:
    // same shape, minus the second half of the pair — proving a lone
    // suppressed counter (plenty of non-throttle code has one) does not
    // alone trip the guard.
    const root = fixture({
      "offender.ts": "let barSuppressed = 0;\nexport function logBar() { barSuppressed += 1; }\n",
    });

    const result = findThrottleSiblingCopies(
      walkSourceFiles(root, () => false),
      root,
      new Set(),
    );

    expect(result).toEqual([]);
  });

  it("does not report a file where the pair appears only inside comments", () => {
    const root = fixture({
      "commented.ts":
        "// let fooSuppressed = 0;\n// let fooLastAt = 0;\nexport const x = 1;\n",
    });

    const result = findThrottleSiblingCopies(
      walkSourceFiles(root, () => false),
      root,
      new Set(),
    );

    expect(result).toEqual([]);
  });

  it("an allowed path inside the fixture is not reported even though it contains the pair", () => {
    const root = fixture({
      "allowed.ts":
        "let xSuppressed = 0;\nlet xLastAt = 0;\nexport function log() { xSuppressed += 1; xLastAt = Date.now(); }\n",
    });

    const result = findThrottleSiblingCopies(
      walkSourceFiles(root, () => false),
      root,
      new Set(["allowed.ts"]),
    );

    expect(result).toEqual([]);
  });
});
