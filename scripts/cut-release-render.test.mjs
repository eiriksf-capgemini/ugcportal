import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, classify, format, computeBump, exitCode, WITHOUT_CHANGE } from "./cut-release-render.mjs";

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

  it("M1: only shipped beads contribute to the version bump", () => {
    const wontFixFeat = bead("ugcportal-9pic", { cc_type: "feat", resolution: "wont-fix" });
    const shippedFeat = bead("ugcportal-ship", { cc_type: "feat", prs: "gh-9001" });
    const wontFixBreaking = bead("ugcportal-brk", { cc_type: "fix", resolution: "wont-fix", breaking: "true" });
    expect(render([wontFixFeat], changelog, states).bump).toBe("patch");
    expect(render([wontFixFeat, wontFixBreaking], changelog, states).bump).toBe("patch");
    expect(render([wontFixFeat, shippedFeat], changelog, states).bump).toBe("minor");
    expect(render([shippedFeat, bead("ugcportal-b", { prs: "gh-9001", breaking: "true" })], changelog, states).bump).toBe("major");
    expect(computeBump([]).bump).toBe("patch");
    expect(r.bump).toBe("minor"); // the shared fixture's only feat that shipped is ugcportal-ship
  });

  it("L2: a malformed prs token is excluded from C and reported, never classified shipped", () => {
    for (const prs of ["GH-12", "12", "gh-12a", "gh-9001,12", "gh-9001,"]) {
      const x = render([bead("ugcportal-bad", { prs })], changelog, states);
      expect(x.C).toBe(0);
      expect(x.rendered).toBe(0);
      expect(x.malformed).toEqual([expect.objectContaining({ id: "ugcportal-bad" })]);
      expect(x.report.join("\n")).toMatch(/ugcportal-bad: malformed prs ".*" -- excluded from this release; fix the bead, then re-run/);
    }
    // blank prs is absent, not malformed
    expect(render([bead("ugcportal-blank", { prs: "  " })], changelog, states).malformed).toEqual([]);
  });

  it("L4: resolution is trimmed, blank is absent, and matching is case-sensitive", () => {
    expect(classify(bead("a", { resolution: " wont-fix " })).resolution).toBe("wont-fix");
    expect(classify(bead("a", { resolution: "  ", prs: "gh-1" })).section).toBe("shipped");
    expect(classify(bead("a", { resolution: 7 })).resolution).toBe("none");
    expect(classify(bead("a", { resolution: "Shipped", prs: "gh-1" })).unrecognised).toBe(true);
  });

  it("L5: K2 matches the exact PR number only", () => {
    const log = "# Changelog\n\n## v1.0.0 - x\n\n- a — https://github.com/o/r/pull/1550\n- b — [#15](https://github.com/o/r/pull/15)\n";
    const st = { 155: "MERGED", 1550: "MERGED", 15: "MERGED" };
    expect(render([bead("a", { prs: "gh-155" })], log, st).repeatedPrs).toEqual([]);
    expect(render([bead("a", { prs: "gh-15" })], log, st).repeatedPrs).toHaveLength(1);
    const log2 = log + "- c — https://github.com/o/r/pull/155\n";
    expect(render([bead("a", { prs: "gh-155" })], log2, st).repeatedPrs).toHaveLength(1);
    expect(render([bead("a", { prs: "gh-1550" })], log2, st).repeatedPrs).toHaveLength(1);
  });

  it("N1: a malformed-prs bead makes the run exit non-zero, a clean run exits 0", () => {
    expect(exitCode(r)).toBe(0);
    expect(exitCode(render([...fixture, bead("ugcportal-bad", { cc_type: "feat", prs: "GH-12" })], changelog, states))).toBe(3);
    const dir = mkdtempSync(join(tmpdir(), "xb68-"));
    const run = (beads) => {
      writeFileSync(join(dir, "b.json"), JSON.stringify(beads));
      writeFileSync(join(dir, "s.json"), JSON.stringify(states));
      return spawnSync("node", [new URL("./cut-release-render.mjs", import.meta.url).pathname, join(dir, "b.json"), new URL("../CHANGELOG.md", import.meta.url).pathname, join(dir, "s.json")], { encoding: "utf8" });
    };
    expect(run(fixture).status).toBe(0);
    const bad = run([...fixture, bead("ugcportal-bad", { cc_type: "feat", prs: "GH-12" })]);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toMatch(/INCOMPLETE: 1 bead.*ugcportal-bad/);
  });

  it("format prints the figures and the report", () => {
    const out = format(r);
    expect(out).toContain("rendered entries: 5");
    expect(out).toContain(`### ${WITHOUT_CHANGE}`);
  });
});
