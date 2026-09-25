import { describe, expect, it } from "vitest";

import { resolveRightsHolders } from "@/app/admin/settings/instagram/rights-holders";

function users(count: number, prefix = "user") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `User ${index}`,
    email: `${prefix}-${index}@example.com`,
  }));
}

const OUTSIDER = {
  id: "outsider",
  name: "Outside The Slice",
  email: "outsider@example.com",
};

describe("the recorded holder is always an option", () => {
  it("is added when the capped slice does not contain them", () => {
    const { options } = resolveRightsHolders({
      holders: users(3),
      recorded: OUTSIDER,
      cap: 3,
    });

    expect(options.map((holder) => holder.id)).toContain("outsider");
  });

  it("is not duplicated when the slice already has them", () => {
    const holders = users(3);
    const { options } = resolveRightsHolders({
      holders,
      recorded: holders[1],
      cap: 3,
    });

    expect(options).toHaveLength(3);
    expect(options.filter((holder) => holder.id === "user-1")).toHaveLength(1);
  });

  it("changes nothing when no holder is recorded", () => {
    const holders = users(2);
    expect(
      resolveRightsHolders({ holders, recorded: null, cap: 10 }).options,
    ).toEqual(holders);
  });
});

describe("the truncation notice", () => {
  /**
   * The regression. `truncated` is a fact about the *query*, and reading it
   * off the final length after the recorded holder was prepended made it
   * false at exactly the size it was written for — so the admin whose
   * holder fell outside the slice got a silently truncated select and no
   * warning.
   */
  it("survives the recorded holder being prepended", () => {
    const { options, truncated } = resolveRightsHolders({
      holders: users(200),
      recorded: OUTSIDER,
      cap: 200,
    });

    expect(truncated).toBe(true);
    // And the list really is longer than the cap now, which is what broke
    // the old length test.
    expect(options).toHaveLength(201);
  });

  it("is set when the query came back exactly at the cap", () => {
    expect(
      resolveRightsHolders({ holders: users(200), recorded: null, cap: 200 })
        .truncated,
    ).toBe(true);
  });

  it("is not set for a list shorter than the cap", () => {
    expect(
      resolveRightsHolders({ holders: users(199), recorded: OUTSIDER, cap: 200 })
        .truncated,
    ).toBe(false);
  });

  it("is not set when nothing was loaded at all", () => {
    // No form open, so no query and nothing to warn about.
    expect(
      resolveRightsHolders({ holders: [], recorded: null, cap: 200 }).truncated,
    ).toBe(false);
  });
});
