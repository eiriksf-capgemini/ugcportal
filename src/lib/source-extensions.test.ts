import { describe, expect, it } from "vitest";

import eslintConfig, { GATED_LOADER_PATH } from "../../eslint.config.mjs";
import { SCRIPT_KIND_BY_EXTENSION } from "./design/scan-source";
import {
  JS_FAMILY_EXTENSIONS,
  JS_FAMILY_FILENAME_PATTERN,
  JSX_LINTED_EXTENSIONS,
  NON_JSX_LINTED_EXTENSIONS,
  globsFor,
} from "./source-extensions.mjs";

/**
 * ugcportal-ysub review round 3, finding 4. Four separate lists said which
 * file extensions this repo treats as executable source — the scanner's
 * dialect map, two ESLint `files` globs, and the K6 grep's walker pattern
 * — and each was widened in a different review round. The gaps between
 * them WERE the bypass, three times over: a `.js`/`.mjs` file the grep
 * could not see, a `.cjs` file neither the grep nor the lint rules looked
 * at.
 *
 * They now all derive from `source-extensions.mjs`. This file is what
 * makes "derive" true rather than claimed: each assertion below compares a
 * real consumer against the shared list, so restating the list by hand in
 * any of them turns this red.
 */
describe("every JS-family extension list derives from the one shared list", () => {
  it("partitions the full list into exactly the two ESLint halves, with no overlap", () => {
    expect([...JSX_LINTED_EXTENSIONS, ...NON_JSX_LINTED_EXTENSIONS].sort()).toEqual(
      [...JS_FAMILY_EXTENSIONS].sort(),
    );
    expect(
      JSX_LINTED_EXTENSIONS.filter((extension) =>
        NON_JSX_LINTED_EXTENSIONS.includes(extension),
      ),
    ).toEqual([]);
  });

  it("gives the scanner a parse dialect for every extension in the list", () => {
    // A missing entry is not loud: `scriptKindFor` falls back to TS, so a
    // new `.jsx`-like extension would silently parse in the wrong dialect
    // — which is exactly round 1's finding, one extension over.
    expect(Object.keys(SCRIPT_KIND_BY_EXTENSION).sort()).toEqual(
      [...JS_FAMILY_EXTENSIONS].sort(),
    );
  });

  it("gives the K6 grep a walker pattern that accepts every extension and nothing else", () => {
    for (const extension of JS_FAMILY_EXTENSIONS) {
      expect(JS_FAMILY_FILENAME_PATTERN.test(`evil.${extension}`)).toBe(true);
    }
    for (const extension of ["css", "json", "md", "txt", "tsxx", "coffee"]) {
      expect(JS_FAMILY_FILENAME_PATTERN.test(`evil.${extension}`)).toBe(false);
    }
  });

  /**
   * The ESLint half, checked against the REAL exported config rather than
   * against the constants it was built from — a `files` array that stopped
   * reading the shared list would pass every assertion above.
   *
   * Checked PER RULE, not as one union across both (caught by this file's
   * own fixture-mutation pass): the union is covered as long as SOME
   * object names an extension, so a `no-restricted-imports` block that
   * silently dropped `.cjs` would still look complete while the import ban
   * no longer applied to a single CommonJS file. Each rule has to cover
   * the whole list on its own.
   */
  it.each(["no-restricted-syntax", "no-restricted-imports"])(
    "wires %s to every extension in the list, through the real config",
    (rule) => {
      const covered = new Set(
        eslintConfig
          .filter((entry) => entry.rules?.[rule])
          .filter((entry) => !(entry.files as string[] | undefined)?.includes(GATED_LOADER_PATH))
          .flatMap((entry) => (entry.files ?? []) as string[]),
      );

      expect(covered.size).toBeGreaterThan(0);
      for (const glob of globsFor(JS_FAMILY_EXTENSIONS)) {
        expect(
          covered.has(glob),
          `no ${rule} config object covers ${glob}; the shared extension list and ` +
            "eslint.config.mjs have drifted",
        ).toBe(true);
      }
    },
  );

  it("MUTATION CHECK: a glob built from an extension NOT in the list is not covered", () => {
    // Fixture mutation for the assertion above: `.coffee` is a plausible
    // executable extension that this repo deliberately does not lint, so
    // the needle really can be absent. Without this, a `covered` set that
    // somehow contained everything would pass the check above silently.
    const covered = new Set(
      eslintConfig.flatMap((entry) => (entry.files ?? []) as string[]),
    );
    expect(covered.has("**/*.coffee")).toBe(false);
  });
});
