import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { render, classify, format, WITHOUT_CHANGE } from "./cut-release-render.mjs";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const bead = (id, metadata) => ({ id, title: `title of ${id}`, metadata: { cc_type: "fix", cc_scope: "x", ...metadata } });
const fixture = [
  bead("ugcportal-ytai", {}), // closed, no prs, no resolution
  bead("ugcportal-0dh5", {}), // same shape
  bead("ugcportal-9pic", { cc_type: "feat", resolution: "wont-fix" }),
  bead("ugcportal-dupe", { resolution: "duplicate", prs: "gh-155" }),
  bead("ugcportal-ship", { cc_type: "feat", prs: "gh-9001" }),
  bead("ugcportal-old", { prs: "gh-1", released_in: "v0.1.0" }), // already released
  bead("ugcportal-open", { prs: "gh-9002" }), // PR not merged
];
const states = { 155: "MERGED", 9001: "MERGED", 9002: "OPEN" };

const names = (r, section) => (r.sections.get(section) ?? []).map((e) => e.id).sort();

describe("cut-release render (ugcportal-xb68)", () => {
  const r = render(fixture, changelog, states);

  it("K1: section membership", () => {
    expect(names(r, WITHOUT_CHANGE)).toEqual(
      ["ugcportal-0dh5", "ugcportal-9pic", "ugcportal-dupe", "ugcportal-ytai"],
    );
    expect(names(r, "Features")).toEqual(["ugcportal-ship"]);
    expect(names(r, "Fixes")).toEqual([]);
  });

  it("K1: shipped resolution and absent-with-prs render as shipped", () => {
    expect(classify(bead("a", { resolution: "shipped" })).section).toBe("shipped");
    expect(classify(bead("a", { resolution: "shipped", prs: "gh-1" })).section).toBe("shipped");
    expect(classify(bead("a", { prs: "gh-1" })).section).toBe("shipped");
  });

  it("K2: reports the repeated PR by number and still renders the bead", () => {
    expect(r.repeatedPrs).toEqual([{ pr: 155, bead: "ugcportal-dupe", sections: expect.arrayContaining(["v0.6.0"]) }]);
    expect(r.report.some((l) => /PR #155 \(ugcportal-dupe\).*earlier release section.*v0\.6\.0/.test(l))).toBe(true);
    expect(r.tagged).toContain("ugcportal-dupe");
  });

  it("K3: rendered count equals C, every candidate is tagged, narrowing is A/B/C", () => {
    expect([r.A, r.B, r.C]).toEqual([7, 6, 5]);
    expect(r.rendered).toBe(r.C);
    expect(r.tagged.sort()).toEqual(
      ["ugcportal-0dh5", "ugcportal-9pic", "ugcportal-dupe", "ugcportal-ship", "ugcportal-ytai"],
    );
    expect(r.dropped).toEqual([{ id: "ugcportal-open", unmerged: [9002] }]);
  });

  it("K3: an unrecognised resolution is rendered and warned, never dropped", () => {
    const x = render([bead("ugcportal-typo", { resolution: "shiped", prs: "gh-9001" })], changelog, states);
    expect(names(x, WITHOUT_CHANGE)).toEqual(["ugcportal-typo"]);
    expect(x.rendered).toBe(x.C);
    expect(x.report.join("\n")).toMatch(/unrecognised resolution "shiped"/);
  });

  it("a PR with no entry in the state map is not treated as merged", () => {
    const x = render([bead("ugcportal-q", { prs: "gh-424242" })], changelog, {});
    expect(x.C).toBe(0);
    expect(x.dropped).toHaveLength(1);
  });

  it("format prints the figures and the report", () => {
    const out = format(r);
    expect(out).toContain("rendered entries: 5");
    expect(out).toContain(`### ${WITHOUT_CHANGE}`);
  });
});
