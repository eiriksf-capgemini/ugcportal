import { describe, expect, it } from "vitest";

import { ABOUT_CONTACT_PATH, pathFragment } from "@/lib/routes";

describe("pathFragment (ugcportal-akv6, round-3/round-4 review)", () => {
  it("extracts the fragment half of a real route constant", () => {
    expect(pathFragment(ABOUT_CONTACT_PATH)).toBe("contact");
  });

  it("throws when the path has no '#' at all", () => {
    expect(() => pathFragment("/about")).toThrow();
  });

  it("round-4 review: throws on an EMPTY fragment too, not just a missing '#'", () => {
    // "/about#" has a "#" but nothing after it. The doc comment says this
    // function exists to keep a caller from ever rendering `id=""`; before
    // round 4 this case slipped through (hashIndex !== -1, so it skipped
    // the old "no fragment at all" check) and returned "" silently.
    expect(() => pathFragment("/about#")).toThrow();
  });

  it("MUTATION CHECK: a non-empty fragment after an empty one in the same string is still extracted correctly", () => {
    // Control for the two throwing cases above: a "#" that DOES have
    // something after it must still work, including when the fragment
    // text itself happens to contain another "#" — `indexOf` finds the
    // FIRST "#", so everything after it (another literal "#") stays part
    // of the fragment rather than being split on again.
    expect(pathFragment("/about#a#b")).toBe("a#b");
  });
});
