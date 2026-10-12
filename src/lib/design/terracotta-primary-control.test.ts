import { describe, expect, it } from "vitest";

import { countTerracottaPrimaryControls } from "./terracotta-primary-control";

describe("countTerracottaPrimaryControls", () => {
  it("counts zero in markup with no terracotta-filled control at all", () => {
    expect(countTerracottaPrimaryControls("<main>nothing here</main>")).toBe(0);
  });

  it("counts exactly one real occurrence", () => {
    const markup = '<a class="inline-flex bg-terracotta-600 text-terracotta-ink">CTA</a>';
    expect(countTerracottaPrimaryControls(markup)).toBe(1);
  });

  it("does not miscount a for-sale badge or highlighted price (terracotta-100/-900, a different fill entirely)", () => {
    const markup =
      '<span class="bg-terracotta-100 text-terracotta-900">For sale</span>' +
      '<span class="bg-terracotta-100 text-terracotta-900">kr 500</span>';
    expect(countTerracottaPrimaryControls(markup)).toBe(0);
  });

  /*
   * K4's own required mutation, kept as a permanent regression test rather
   * than a one-off check performed by hand and reverted: "a test asserting
   * at most one terracotta-filled primary control per page" has to be able
   * to fail when a page genuinely renders two, or the assertion proves
   * nothing. This markup is the mutation (two real, distinct CTAs, not one
   * duplicated DOM node) — and the inner `expect(...).toThrow()` is what
   * "confirm it fails" means here: the at-most-one assertion a real page
   * test makes (`expect(count).toBeLessThanOrEqual(1)`) genuinely throws
   * against this fixture.
   */
  it("K4 FIXTURE MUTATION: two terracotta-filled primary controls count as two, and an at-most-one assertion against them throws", () => {
    const markup =
      '<a class="bg-terracotta-600 text-terracotta-ink">See the portfolio</a>' +
      '<a class="bg-terracotta-600 text-terracotta-ink">Upload</a>';
    const count = countTerracottaPrimaryControls(markup);
    expect(count).toBe(2);
    expect(() => expect(count).toBeLessThanOrEqual(1)).toThrow();
  });
});
