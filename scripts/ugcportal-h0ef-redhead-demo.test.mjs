import { describe, expect, it } from "vitest";

// Throwaway fixture for ugcportal-h0ef's K2 reproduction: a deliberately red
// head, used only to demonstrate that the new CI-gate command in
// .claude/skills/pr-review-merge/SKILL.md still reports FAIL even after a
// later title/body-edit run skips the quality job on the same head. This
// file and its branch are discarded after the reproduction is captured.
describe("ugcportal-h0ef red-head demo", () => {
  it("is deliberately false", () => {
    expect(true).toBe(false);
  });
});
