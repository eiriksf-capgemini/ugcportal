/**
 * Tests for scripts/check-npm-audit.mjs (ugcportal-1j4j, K1/K3/K4).
 * Fixtures only; no network and no real `npm audit`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { collectAdvisories, evaluate, main, parseAudit, runNpmAudit, validateAllowlist } from "./check-npm-audit.mjs";

const NOW = new Date("2026-10-18T12:00:00Z");
const BRACES = "GHSA-vfj7-8cjw-p6xm";
const SECOND = "GHSA-aaaa-bbbb-cccc";

const advisory = (name, ghsa, severity = "high") => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} advisory`,
  url: `https://github.com/advisories/${ghsa}`,
  severity,
  range: "<=1.0.0",
});
const node = (name, via, severity = "high") => ({ name, severity, isDirect: false, via, effects: [], range: "*", nodes: [] });
const report = (vulnerabilities) => ({
  vulnerabilities,
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: Object.keys(vulnerabilities).length, critical: 0, total: Object.keys(vulnerabilities).length } },
});
// the shape npm prints for the real braces chain: only braces carries the advisory object
const chain = () =>
  report({
    braces: node("braces", [advisory("braces", BRACES)]),
    micromatch: node("micromatch", ["braces"]),
    "fast-glob": node("fast-glob", ["micromatch"]),
    "eslint-config-next": node("eslint-config-next", ["@next/eslint-plugin-next"]),
    "@next/eslint-plugin-next": node("@next/eslint-plugin-next", ["fast-glob"]),
  });
const entry = (over = {}) => ({ package: "braces", ownerBead: "ugcportal-pg85", recorded: "2026-10-18", recheck: "2027-01-18", reason: "deferred", ...over });
const allow = (entries = { [BRACES]: entry() }) => ({ advisories: entries });

describe("attribution of `via package` entries", () => {
  it("attributes the whole chain to the one GHSA id and names every package", () => {
    const { advisories, unattributed } = collectAdvisories(chain());
    expect(unattributed).toEqual([]);
    expect([...advisories.keys()]).toEqual([BRACES]);
    expect(advisories.get(BRACES).package).toBe("braces");
    expect(advisories.get(BRACES).affected.sort()).toEqual(["@next/eslint-plugin-next", "braces", "eslint-config-next", "fast-glob", "micromatch"]);
  });

  it("K1: passes and prints the allowlisted id with its chain", () => {
    const v = evaluate(chain(), allow(), NOW);
    expect(v.ok).toBe(true);
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toContain(BRACES);
    expect(v.lines[0]).toContain("micromatch");
    expect(v.lines[0]).toContain("ugcportal-pg85");
  });

  it("a high package whose via chain reaches no high/critical GHSA id fails as unattributed", () => {
    const r = report({ orphan: node("orphan", ["missing-pkg"]), mod: node("mod", [advisory("mod", "GHSA-xxxx-yyyy-zzzz", "moderate")]) });
    const v = evaluate(r, allow({}), NOW);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("orphan");
  });

  it("terminates on a cyclic via graph", () => {
    const r = report({ a: node("a", ["b"]), b: node("b", ["a", advisory("b", SECOND)]) });
    expect(collectAdvisories(r).advisories.has(SECOND)).toBe(true);
  });
});

describe("K2 shape: an unlisted high or critical advisory fails naming id and package", () => {
  it("names the GHSA id, package and severity", () => {
    const r = report({ lodash: node("lodash", [advisory("lodash", SECOND, "critical")], "critical") });
    const v = evaluate(r, allow({}), NOW);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/GHSA-aaaa-bbbb-cccc \(lodash, critical\) is not in the allowlist/);
  });
});

describe("K3: the gate never passes because it found nothing to audit", () => {
  const allowlistPath = new URL("./npm-audit-allowlist.json", import.meta.url).pathname;
  const run = (audit, args = []) => {
    const out = [];
    const err = [];
    const code = main(["--allowlist", allowlistPath, ...args], { audit, now: NOW, out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it.each([
    ["empty output", "", /no output/],
    ["whitespace output", "  \n", /no output/],
    ["malformed JSON", "{not json", /not valid JSON/],
    ["a registry error", JSON.stringify({ error: { code: "ENOTFOUND", summary: "audit endpoint unreachable" } }), /ENOTFOUND/],
    ["JSON that is not an audit report", JSON.stringify({ hello: "world" }), /not an audit report/],
    ["JSON with no metadata", JSON.stringify({ vulnerabilities: {} }), /metadata/],
    ["JSON array", "[]", /not an object/],
  ])("fails on %s", (_label, text, why) => {
    // the message is asserted so a guard removed in favour of a downstream throw is still seen
    expect(() => parseAudit(text)).toThrow(why);
    const r = run(() => text);
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED");
  });

  it("fails when the report is valid but the allowlist entry has no owner bead", () => {
    const v = evaluate(chain(), allow({ [BRACES]: entry({ ownerBead: undefined }) }), NOW);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("ownerBead");
  });

  it("fails when an allowlist entry has no re-check date, a malformed one, or an overdue one", () => {
    expect(validateAllowlist(allow({ [BRACES]: entry({ recheck: undefined }) }), NOW).join()).toContain("recheck");
    expect(validateAllowlist(allow({ [BRACES]: entry({ recheck: "next spring" }) }), NOW).join()).toContain("recheck");
    expect(validateAllowlist(allow({ [BRACES]: entry({ recheck: "2026-10-17" }) }), NOW).join()).toContain("has passed");
    expect(validateAllowlist(allow({ [BRACES]: entry({ recheck: "2026-10-18" }) }), NOW)).toEqual([]);
  });

  it("fails on an entry with no reason, a malformed bead id, or a non-canonical key", () => {
    expect(validateAllowlist(allow({ [BRACES]: entry({ reason: " " }) }), NOW).join()).toContain("reason");
    expect(validateAllowlist(allow({ [BRACES]: entry({ ownerBead: "someone" }) }), NOW).join()).toContain("ownerBead");
    expect(validateAllowlist(allow({ "GHSA-VFJ7-8CJW-P6XM": entry() }), NOW).join()).toContain("canonical");
  });

  it("fails on a stale allowlisted id that no longer appears", () => {
    const v = evaluate(report({}), allow(), NOW);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain(`allowlist entry ${BRACES}`);
    expect(v.errors.join("\n")).toContain("no longer appears");
  });

  it("fails when the allowlist names a different package than npm audit does", () => {
    const v = evaluate(chain(), allow({ [BRACES]: entry({ package: "micromatch" }) }), NOW);
    expect(v.ok).toBe(false);
  });

  it("runNpmAudit returns stdout even when npm audit exits 1, and main then judges the JSON", () => {
    const stdout = JSON.stringify(chain());
    const text = runNpmAudit(() => ({ status: 1, stdout, stderr: "" }));
    expect(text).toBe(stdout);
    expect(run(() => text).code).toBe(0);
  });

  it("a non-zero exit with unparseable stdout still fails (exit status is not the verdict, the JSON is)", () => {
    const text = runNpmAudit(() => ({ status: 1, stdout: "npm ERR! network", stderr: "" }));
    expect(run(() => text).code).toBe(1);
  });

  it("a spawn failure throws instead of returning empty output", () => {
    expect(() => runNpmAudit(() => ({ error: new Error("ENOENT"), stdout: null }))).toThrow(/could not run npm audit/);
  });

  it("the committed allowlist is itself sound", () => {
    const list = JSON.parse(readFileSync(allowlistPath, "utf8"));
    expect(validateAllowlist(list, NOW)).toEqual([]);
    expect(Object.keys(list.advisories)).toEqual([BRACES]);
  });

  it("the ci.yml step invokes the script directly, with no pipe", () => {
    const yml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const lines = yml.split("\n").filter((l) => l.includes("check-npm-audit.mjs"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.trim()).toMatch(/^run: node scripts\/check-npm-audit\.mjs$/);
    }
  });
});

describe("K4: the allowlist accepts by GHSA id, never by package name", () => {
  it("an allowlisted package carrying a second, unlisted GHSA id fails", () => {
    const r = report({
      braces: node("braces", [advisory("braces", BRACES), advisory("braces", SECOND)]),
    });
    const v = evaluate(r, allow(), NOW);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain(SECOND);
    expect(v.lines.join("\n")).toContain(BRACES);
  });
});
