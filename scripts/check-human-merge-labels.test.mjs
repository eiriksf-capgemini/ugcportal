/**
 * Tests for scripts/check-human-merge-labels.mjs (ugcportal-ub7y, K3).
 * Pure classification over injected fixtures; no network.
 */
import { describe, expect, it } from "vitest";

import { LABEL, VERDICT_MARKER, classifyPrs, formatReport } from "./check-human-merge-labels.mjs";

const verdict = { body: `${VERDICT_MARKER}\nReviewed clean; a human must merge: touches .claude/skills/` };
const chatter = { body: "LGTM" };

const fixture = [
  { number: 1, labels: [{ name: LABEL }], comments: [verdict] },
  { number: 2, labels: [{ name: "bug" }], comments: [verdict] },
  { number: 3, labels: [], comments: [chatter] },
];

describe("classifyPrs", () => {
  it("flags the verdict PR without the label and not the labelled one", () => {
    const r = classifyPrs(fixture.slice(0, 2));
    expect(r).toEqual({ examined: 2, withVerdict: 2, unlabelled: [2] });
  });

  it("does not count a PR with no verdict comment", () => {
    const r = classifyPrs(fixture);
    expect(r.examined).toBe(3);
    expect(r.withVerdict).toBe(2);
    expect(r.unlabelled).toEqual([2]);
  });

  it("reports zero unlabelled when every verdict PR is labelled, with the counts still non-zero", () => {
    const r = classifyPrs([fixture[0]]);
    expect(r).toEqual({ examined: 1, withVerdict: 1, unlabelled: [] });
  });

  it("tolerates missing labels/comments", () => {
    expect(classifyPrs([{ number: 9 }])).toEqual({ examined: 1, withVerdict: 0, unlabelled: [] });
  });
});

describe("formatReport", () => {
  it("prints the counts before any PR line", () => {
    const out = formatReport(classifyPrs(fixture)).split("\n");
    expect(out[0]).toContain("PRs examined: 3");
    expect(out[0]).toContain("with a verdict comment");
    expect(out[0]).toContain("unlabelled among those: 1");
    expect(out[1]).toContain("#2");
  });
});
