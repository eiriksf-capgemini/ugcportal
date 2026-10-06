import { describe, expect, it } from "vitest";

import {
  PORTFOLIO_TAG_SLUG,
  isCurationTagSlug,
  stripCurationTags,
} from "@/lib/curation-tags";

describe("stripCurationTags", () => {
  it("drops the curation tag, keeping real subjects", () => {
    const result = stripCurationTags([
      { slug: "food", name: "Food" },
      { slug: PORTFOLIO_TAG_SLUG, name: "Portfolio" },
      { slug: "wine-drink", name: "Wine & drink" },
    ]);
    expect(result.map((tag) => tag.slug)).toEqual(["food", "wine-drink"]);
  });

  it("returns an empty list unchanged", () => {
    expect(stripCurationTags([])).toEqual([]);
  });

  /**
   * K3 (ugcportal-qnq9.16): this used to tolerate a non-array `tags` value
   * by returning it unchanged, solely to accommodate
   * src/app/api/public/media/route.test.ts's hand-rolled Prisma mock, whose
   * `Row` fixture predated the `tags` relation and never set one. That mock
   * now seeds `tags: []` like every other fixture in this codebase, so
   * there is nothing left to tolerate: a non-array value is a genuine
   * contract violation and must fail loudly rather than pass through
   * silently. This assertion fails against the pre-fix implementation,
   * which returned `undefined` here rather than throwing.
   */
  it("fails loudly on a non-array value rather than passing it through", () => {
    expect(() =>
      stripCurationTags(undefined as unknown as { slug: string }[]),
    ).toThrow();
  });
});

describe("isCurationTagSlug", () => {
  it("is true only for a curation-only slug", () => {
    expect(isCurationTagSlug(PORTFOLIO_TAG_SLUG)).toBe(true);
    expect(isCurationTagSlug("food")).toBe(false);
  });
});
