/**
 * Tests for scripts/check-npm-audit.mjs (ugcportal-1j4j, K1/K3/K4).
 * Fixtures only; no network and no real `npm audit`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: Object.keys(vulnerabilities).length, critical: 0, total: Object.keys(vulnerabilities).length },
    dependencies: { prod: 224, dev: 467, optional: 127, peer: 0, peerOptional: 0, total: 734 },
  },
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

  // the verdict over a cycle must not depend on the order of the
  // `vulnerabilities` keys. `a` carries the advisory, `b` reaches it through `a`.
  const cyclic = (aFirst) => {
    const a = node("a", ["b", advisory("a", BRACES)]);
    const b = node("b", ["a"]);
    return report(aFirst ? { a, b } : { b, a });
  };
  it.each([
    ["a listed first", true],
    ["b listed first", false],
  ])("a cycle through an advisory-carrying package gives the same verdict with %s", (_label, aFirst) => {
    const r = cyclic(aFirst);
    const { advisories, unattributed } = collectAdvisories(r);
    expect(unattributed).toEqual([]);
    expect(advisories.get(BRACES).package).toBe("a");
    expect(advisories.get(BRACES).affected.sort()).toEqual(["a", "b"]);
    const v = evaluate(r, allow({ [BRACES]: entry({ package: "a" }) }), NOW);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
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
    [
      "a report with no metadata.dependencies",
      JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }),
      /metadata\.dependencies\.total/,
    ],
    [
      "a report over zero dependencies",
      JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 }, dependencies: { total: 0 } } }),
      /zero dependencies|0 dependencies/,
    ],
    [
      "a report whose dependency total is not an integer",
      JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 }, dependencies: { total: "734" } } }),
      /metadata\.dependencies\.total/,
    ],
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

  it("rejects a date that matches YYYY-MM-DD but is not a calendar date, and accepts a leap day", () => {
    const errs = (recheck) => validateAllowlist(allow({ [BRACES]: entry({ recheck }) }), NOW);
    expect(errs("2027-02-30")).toEqual([`allowlist entry ${BRACES}: missing or malformed recheck date (want YYYY-MM-DD)`]);
    expect(errs("2027-13-40")).toEqual([`allowlist entry ${BRACES}: missing or malformed recheck date (want YYYY-MM-DD)`]);
    expect(errs("2028-02-29")).toEqual([]);
    expect(validateAllowlist(allow({ [BRACES]: entry({ recorded: "2026-02-29" }) }), NOW)).toEqual([
      `allowlist entry ${BRACES}: missing or malformed recorded date (want YYYY-MM-DD)`,
    ]);
  });

  it("prints the dependency count examined and the advisory counts on a pass and on a verdict failure", () => {
    const pass = run(() => JSON.stringify(chain()));
    expect(pass.code).toBe(0);
    expect(pass.out).toContain("examined 734 dependencies");
    expect(pass.out).toContain('"high":5');
    const fail = run(() => JSON.stringify(report({})));
    expect(fail.code).toBe(1);
    expect(fail.out).toContain("examined 734 dependencies");
    expect(fail.out).toContain('"total":0');
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

describe("entry guard: the script runs when invoked by a symlinked path", () => {
  it("runs main when invoked through a symlinked directory", { timeout: 30_000 }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "check-npm-audit-"));
    const link = join(mkdtempSync(join(tmpdir(), "check-npm-audit-link-")), "scripts");
    symlinkSync(dirname(fileURLToPath(import.meta.url)), link);
    const jsonFile = join(tmp, "error.json");
    writeFileSync(jsonFile, JSON.stringify({ error: { code: "ENOLOCK", summary: "no lockfile" } }));
    const allowlist = join(tmp, "empty-allowlist.json");
    writeFileSync(allowlist, JSON.stringify({ advisories: {} }));
    const res = spawnSync(process.execPath, [join(link, "check-npm-audit.mjs"), "--json-file", jsonFile, "--allowlist", allowlist], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(res.stderr).toContain("::error::npm audit gate FAILED: npm audit reported an error: ENOLOCK");
    expect(res.status).toBe(1);
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

describe("each advisory is printed with its own severity (ugcportal-1aw4 L4)", () => {
  // micromatch is critical because of GHSA-dddd; braces carries only the high GHSA-aaaa
  const DDDD = "GHSA-dddd-eeee-ffff";
  const mixed = () =>
    report({
      micromatch: node("micromatch", ["braces", advisory("micromatch", DDDD, "critical")], "critical"),
      braces: node("braces", [advisory("braces", SECOND, "high")], "high"),
    });

  it("K1: a high advisory is not printed as critical because an affected package also carries a critical one", () => {
    const v = evaluate(mixed(), allow({ [SECOND]: entry(), [DDDD]: entry({ package: "micromatch" }) }), NOW);
    expect(v.ok).toBe(true);
    const line = (id) => v.lines.find((l) => l.includes(id));
    expect(line(SECOND)).toContain(`(braces, high)`);
    expect(line(DDDD)).toContain(`(micromatch, critical)`);
  });

  it("K1: the not-in-the-allowlist error carries the advisory's own severity too", () => {
    const v = evaluate(mixed(), allow({ [DDDD]: entry({ package: "micromatch" }) }), NOW);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain(`${SECOND} (braces, high) is not in the allowlist`);
  });

  it("K3: in a three-package chain with three severities, every printed (pkg, severity) token equals its via object's", () => {
    const own = { a: ["GHSA-aaaa-aaaa-aaaa", "high"], b: ["GHSA-bbbb-bbbb-bbbb", "critical"], c: ["GHSA-cccc-cccc-cccc", "high"] };
    const r = report({
      a: node("a", [advisory("a", own.a[0], own.a[1])], "high"),
      b: node("b", ["a", advisory("b", own.b[0], own.b[1])], "critical"),
      c: node("c", ["b", advisory("c", own.c[0], own.c[1])], "critical"),
    });
    const v = evaluate(r, allow({}), NOW);
    const text = v.errors.join("\n");
    const tokens = [...text.matchAll(/(GHSA-[a-z0-9-]+) \(([^,]+), (\w+)\)/g)];
    expect(tokens).toHaveLength(3);
    for (const [, id, pkg, sev] of tokens) {
      expect(own[pkg][0]).toBe(id);
      expect(sev).toBe(own[pkg][1]);
    }
    const ok = evaluate(r, allow(Object.fromEntries(Object.values(own).map(([id], i) => [id, entry({ package: "abc"[i] })]))), NOW);
    const printed = [...ok.lines.join("\n").matchAll(/allowlisted (GHSA-[a-z0-9-]+) \(([^,]+), (\w+)\)/g)];
    expect(printed).toHaveLength(3);
    for (const [, id, pkg, sev] of printed) expect([id, sev]).toEqual(own[pkg]);
  });
});

describe("an allowlisted id the gate does not collect (ugcportal-1aw4 L5, K2)", () => {
  it("K2: an id still in the report at moderate fails and says it is present, naming the severity", () => {
    const r = report({ braces: node("braces", [advisory("braces", BRACES, "moderate")], "moderate") });
    const v = evaluate(r, allow(), NOW);
    expect(v.ok).toBe(false);
    const msg = v.errors.join("\n");
    expect(msg).toContain(`allowlist entry ${BRACES} (braces) is present in npm audit at moderate`);
    expect(msg).not.toContain("no longer appears");
  });

  it("K2: an id that is nowhere in the report still says it no longer appears", () => {
    const r = report({ other: node("other", [advisory("other", SECOND, "high")]) });
    const v = evaluate(r, allow({ [BRACES]: entry(), [SECOND]: entry({ package: "other" }) }), NOW);
    expect(v.ok).toBe(false);
    const msg = v.errors.join("\n");
    expect(msg).toContain(`allowlist entry ${BRACES} (braces) no longer appears in npm audit`);
    expect(msg).not.toContain("present in npm audit");
  });

  it("which severities block is unchanged: a moderate advisory with no entry still passes", () => {
    const r = report({ braces: node("braces", [advisory("braces", BRACES, "moderate")], "moderate") });
    expect(evaluate(r, allow({}), NOW).ok).toBe(true);
  });
});

describe("one advisory at two severities prints one report-wide severity, whatever the key order (ugcportal-eylm)", () => {
  const G = "GHSA-gggg-gggg-gggg";
  const NODES = {
    x: () => node("x", [advisory("x", G, "high")], "high"),
    y: () => node("y", [advisory("y", G, "critical")], "critical"),
    z: () => node("z", [advisory("z", G, "high")], "high"),
  };
  const build = (order) => report(Object.fromEntries(order.map((n) => [n, NODES[n]()])));
  const output = (order, entries = {}) => {
    const v = evaluate(build(order), allow(entries), NOW);
    return [...v.errors, ...v.lines].join("\n");
  };
  const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((h, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [h, ...p])));

  it("K1/K2: both key orders print byte-identical output naming critical and the package that carries it", () => {
    const xy = output(["x", "y"]);
    const yx = output(["y", "x"]);
    expect(yx).toBe(xy);
    expect(xy).toContain(`${G} (y, critical) is not in the allowlist`);
  });

  it("K1/K2: the same holds for an allowlisted advisory (the allowlist entry names the carrying package)", () => {
    const entries = { [G]: entry({ package: "y" }) };
    const xy = output(["x", "y"], entries);
    expect(output(["y", "x"], entries)).toBe(xy);
    expect(xy).toContain(`allowlisted ${G} (y, critical)`);
  });

  it("K3: three packages in all six key orders give exactly one distinct output", () => {
    const orders = permutations(["x", "y", "z"]);
    expect(orders).toHaveLength(6);
    const outputs = new Set(orders.map((o) => output(o)));
    expect([...outputs]).toHaveLength(1);
    expect([...outputs][0]).toContain(`${G} (y, critical)`);
  });

  it("K2: when two packages carry the worst severity both are listed, in every order", () => {
    const both = (order) => {
      const nodes = { x: NODES.x, y: NODES.y, z: () => node("z", [advisory("z", G, "critical")], "critical") };
      const v = evaluate(report(Object.fromEntries(order.map((n) => [n, nodes[n]()]))), allow({}), NOW);
      return v.errors.join("\n");
    };
    const outputs = new Set(permutations(["x", "y", "z"]).map(both));
    expect([...outputs]).toHaveLength(1);
    expect([...outputs][0]).toContain(`${G} (y, z, critical) is not in the allowlist; affects: x, y, z`);
  });
});
