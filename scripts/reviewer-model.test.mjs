import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, RISK_PATHS, beadIdFromTitle, main } from "./reviewer-model.mjs";

const t = (id) => `chore(x): something (${id})`;

describe("K1 fixtures from PR #327 and #326", () => {
  it("#327: one docs file, bead tiered haiku -> sonnet, reason names the floor", () => {
    const d = decide({
      title: t("ugcportal-nexj"),
      paths: ["docs/process/dependency-deferral-register.md"],
      bead: { model: "haiku", model_effort: "low" },
    });
    expect(d).toMatchObject({ ok: true, model: "sonnet", effort: "low" });
    expect(d.reason).toMatch(/^floor:/);
  });
  it("#326: ci.yml and check-npm-audit.mjs, bead tiered sonnet -> opus, reason names the path", () => {
    const d = decide({
      title: t("ugcportal-1j4j"),
      paths: [".github/workflows/ci.yml", "scripts/check-npm-audit.mjs", "scripts/npm-audit-allowlist.json"],
      bead: { model: "sonnet", model_effort: "medium" },
    });
    expect(d).toMatchObject({ ok: true, model: "opus", effort: "medium" });
    expect(d.reason).toContain("risk path .github/workflows/ci.yml");
  });
});

describe("K2 missing inputs", () => {
  it("no bead id in the title", () => {
    const d = decide({ title: "chore: no id", paths: ["a.md"], bead: { model: "sonnet" } });
    expect(d.ok).toBe(false);
    expect(d.missing).toMatch(/no trailing \(ugcportal-xxxx\)/);
  });
  it("bead has no model, or an illegal one", () => {
    for (const bead of [{}, null, { model: "gpt" }]) {
      const d = decide({ title: t("ugcportal-abcd"), paths: ["a.md"], bead });
      expect(d.ok).toBe(false);
      expect(d.missing).toContain("ugcportal-abcd has no legal metadata.model");
    }
  });
  it("main exits 2, prints nothing on stdout and names the problem on stderr (synthetic title)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-"));
    const bin = join(dir, "gh");
    writeFileSync(bin, `#!/bin/sh\necho '{"title":"chore: synthetic, no bead id","files":[{"path":"a.md"}]}'\n`);
    chmodSync(bin, 0o755);
    const r = spawnSync(process.execPath, [new URL("./reviewer-model.mjs", import.meta.url).pathname, "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/no trailing \(ugcportal-xxxx\)/);
  });
  it("main rejects a non-numeric PR argument", () => {
    expect(main(["abc"], () => {}, () => {})).toBe(1);
  });
});

describe("K3 guardrail", () => {
  it("risk list has the required entries", () => {
    expect(RISK_PATHS.length).toBeGreaterThanOrEqual(10);
    for (const r of RISK_PATHS) expect(r.re.test(r.example), r.example).toBe(true);
  });
  for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
    it(`every risk-list path routes to opus whatever the bead tier (${tier})`, () => {
      for (const r of RISK_PATHS) {
        const d = decide({ title: t("ugcportal-abcd"), paths: ["docs/a.md", r.example], bead: { model: tier } });
        expect(d.model, r.example).toBe("opus");
        expect(d.reason).toContain(r.example);
      }
    });
  }
  it("model=haiku never routes to haiku", () => {
    const d = decide({ title: t("ugcportal-abcd"), paths: ["docs/a.md"], bead: { model: "haiku" } });
    expect(d.model).toBe("sonnet");
  });
  it("process paths take the bead's tier, not opus; effort defaults to high", () => {
    const d = decide({
      title: t("ugcportal-abcd"),
      paths: [".claude/skills/x/SKILL.md", ".claude/agents/worker-reviewer.md", "CLAUDE.md"],
      bead: { model: "sonnet" },
    });
    expect(d).toMatchObject({ model: "sonnet", effort: "high" });
    expect(d.reason).toContain("3 process-prose");
  });
  it("a fable bead keeps fable; a bead id is read only from the trailing parenthesis", () => {
    expect(decide({ title: t("ugcportal-abcd"), paths: ["a.md"], bead: { model: "fable" } }).model).toBe("fable");
    expect(beadIdFromTitle("fix (ugcportal-aaaa) and more (ugcportal-bbbb)")).toBe("ugcportal-bbbb");
    expect(beadIdFromTitle("fix (ugcportal-aaaa) and more")).toBe(null);
  });
});
