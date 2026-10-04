import { afterAll, describe, expect, it } from "vitest";

import { pinEnvironment } from "@/lib/test-support/env";

/**
 * The shared env helper has its own test because five suites now trust it
 * (PR #91 review, round 1, finding 6), and both of its claims are the kind
 * that fail silently: a variable it forgets to restore changes the answer of
 * some later, unrelated suite in the same process, and an `undefined` it
 * writes as the string `"undefined"` turns "not configured" into
 * "configured, with nonsense in it" — which the sign-in policy treats as a
 * malformed entry rather than as absence.
 *
 * Deliberately on invented variable names: this file must not depend on, or
 * disturb, any variable the application reads.
 */

const PRESENT = "UGCPORTAL_TEST_ENV_PRESENT";
const CLEARED = "UGCPORTAL_TEST_ENV_CLEARED";

// The "host" environment, established before `pinEnvironment` snapshots it.
process.env[PRESENT] = "host value";
process.env[CLEARED] = "host value too";

pinEnvironment({
  [PRESENT]: "pinned value",
  // The case the helper exists to get right.
  [CLEARED]: undefined,
});

afterAll(() => {
  // Runs after the helper's own afterEach, so this is what the next suite in
  // the process would inherit.
  expect(process.env[PRESENT]).toBe("host value");
  expect(process.env[CLEARED]).toBe("host value too");
  delete process.env[PRESENT];
  delete process.env[CLEARED];
});

describe("pinEnvironment", () => {
  it("applies the stated values before each test", () => {
    expect(process.env[PRESENT]).toBe("pinned value");
  });

  it("unsets a variable given as undefined, rather than writing a string", () => {
    expect(CLEARED in process.env).toBe(false);
    expect(process.env[CLEARED]).toBeUndefined();
  });

  it("re-applies them after a test has changed them", () => {
    // This test's own mutation is visible to it...
    process.env[PRESENT] = "changed by a test";
    process.env[CLEARED] = "also changed";
    expect(process.env[PRESENT]).toBe("changed by a test");
  });

  it("...and the next test starts from the pinned state again", () => {
    expect(process.env[PRESENT]).toBe("pinned value");
    expect(CLEARED in process.env).toBe(false);
  });
});
