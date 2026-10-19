import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, RISK_PATHS, PROCESS_PROSE, beadIdFromTitle, riskMatch, main } from "./reviewer-model.mjs";
import { SENSITIVE_PATH_RES, isSensitivePath } from "./check-human-merge-labels.mjs";

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
    writeFileSync(bin, `#!/bin/sh\necho '{"title":"chore: synthetic, no bead id","files":[{"path":"a.md"}],"changedFiles":1}'\n`);
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
  it("each risk-list entry matches its own example (the pinned list is in the M3 block)", () => {
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

// ---- pinned list, name pattern, truncation, dotted ids, effort, step-2 coverage ----

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./reviewer-model.mjs", import.meta.url));

/** Run the script against a fake gh (and bd) printing the given JSON. */
function runWithFakes(view, metadata) {
  const dir = mkdtempSync(join(tmpdir(), "rm-"));
  const viewFile = join(dir, "view.json");
  writeFileSync(viewFile, JSON.stringify(view));
  writeFileSync(join(dir, "gh"), `#!/bin/sh\ncat '${viewFile}'\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const beadFile = join(dir, "bead.json");
  writeFileSync(beadFile, JSON.stringify([{ metadata }]));
  writeFileSync(join(dir, "bd"), `#!/bin/sh\ncat '${beadFile}'\n`);
  chmodSync(join(dir, "bd"), 0o755);
  return spawnSync(process.execPath, [SCRIPT, "1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

const opus = (path, tier = "sonnet") => decide({ title: t("ugcportal-abcd"), paths: ["docs/a.md", path], bead: { model: tier } });

describe("M3: the risk list is pinned, so deleting an entry fails", () => {
  it("RISK_PATHS is exactly this list (source and regex, in order)", () => {
    expect(RISK_PATHS.map((r) => `${r.source} ${r.re}`)).toEqual([
      "model-fit /^src\\/lib\\/attestation/",
      "model-fit /^src\\/lib\\/resale-rights/",
      "model-fit /^src\\/lib\\/origin/",
      "model-fit /^src\\/lib\\/test-support\\//",
      "model-fit /^src\\/app\\/api\\//",
      "model-fit /^prisma\\//",
      "model-fit /^scripts\\/check-[^/]*\\.mjs$/",
      "name-pattern /^src\\/(?:lib|app)\\/.*(?:session|sign-in|auth|role|admin|oauth|sellab|publish|rights|licen[cs]e|pricing|price|payment|crypto|encrypt|attest|origin|disclos|evidence)/i",
      "process-guard /^scripts\\/(?:reviewer-model|sweep-merged-branches|check-human-merge-labels|gh-app-token)(?:\\.test)?\\.mjs$/",
      "guard /^\\.claude\\/settings(\\.local)?\\.json$/",
      "guard /^src\\/lib\\/auth/",
      "guard /^src\\/app\\/api\\/auth\\//",
      "guard /^\\.github\\/workflows\\//",
      "guard /(^|\\/)docker-compose\\.yml$/",
      "guard /(^|\\/)[^/]*(secret|credential)[^/]*$/",
      "guard /(^|\\/)\\.env[^/]*$/",
      "guard /\\.(pem|key)$/",
    ]);
  });
  // Fixed paths written here, not read off RISK_PATHS, so a deleted entry
  // cannot take its own test case with it.
  const REQUIRED_OPUS = [
    "src/lib/attestation.ts", "src/lib/resale-rights.ts", "src/lib/origin.ts", "src/lib/test-support/db.ts",
    "src/app/api/media/route.ts", "src/lib/auth.ts", "src/app/api/auth/[...nextauth]/route.ts",
    "prisma/schema.prisma", "prisma/migrations/0001_init/migration.sql", ".github/workflows/ci.yml",
    "scripts/check-npm-audit.mjs", "docker-compose.yml", "src/lib/secret-store.ts", ".env", ".env.production",
    "hal9000.pem", "certs/tls.key", ".claude/settings.json", ".claude/settings.local.json",
    "scripts/reviewer-model.mjs", "scripts/reviewer-model.test.mjs", "scripts/sweep-merged-branches.mjs",
    "scripts/check-human-merge-labels.mjs", "scripts/gh-app-token.mjs",
    "src/lib/session.ts", "src/lib/sellable-media.ts", "src/app/admin/settings/rights/page.tsx",
  ];
  for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
    it(`every required path routes to opus (bead tier ${tier})`, () => {
      for (const p of REQUIRED_OPUS) {
        const d = opus(p, tier);
        expect(d.model, p).toBe("opus");
        expect(d.reason, p).toContain(`risk path ${p}`);
      }
    });
  }
});

describe("M1: session, sellability, rights, money and crypto code routes opus by name pattern", () => {
  const NAME_RE = /(session|sign-in|auth|role|admin|oauth|sellab|publish|rights|licen[cs]e|pricing|price|payment|crypto|encrypt|attest|origin|disclos|evidence)/i;
  it("the fourteen files round 1 named route opus", () => {
    for (const f of ["session", "session-or-anonymous", "sign-in-policy", "sign-in-providers", "roles", "admin",
      "instagram-oauth-state", "sellable-media", "publishability", "publish-gates", "rights-evidence", "pricing",
      "crypto", "evidence-encryption"]) {
      expect(opus(`src/lib/${f}.ts`).model, f).toBe("opus");
    }
  });
  it("every non-test src/lib/**/*.ts at HEAD whose basename matches the pattern routes opus (count printed, zero fails)", () => {
    const listed = spawnSync("git", ["ls-files", "src/lib/*.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const files = listed.stdout.split("\n").filter((p) => p && !p.endsWith(".test.ts"));
    const hits = files.filter((p) => NAME_RE.test(p.split("/").pop()));
    console.log(`reviewer-model M1: ${hits.length} of ${files.length} non-test src/lib .ts files match the name pattern`);
    expect(hits.length).toBeGreaterThanOrEqual(14);
    for (const p of hits) expect(opus(p).model, p).toBe("opus");
  }, 30_000); // spawns a real git ls-files over the tree
  it("non-API src/app paths carrying such a name route opus; unrelated src/app and src/lib paths do not", () => {
    const listed = spawnSync("git", ["ls-files", "src/app"], { cwd: ROOT, encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const files = listed.stdout.split("\n").filter((p) => p && !p.startsWith("src/app/api/"));
    const hits = files.filter((p) => NAME_RE.test(p.slice("src/app/".length)));
    console.log(`reviewer-model M1: ${hits.length} of ${files.length} non-API src/app files match the name pattern`);
    expect(hits.length).toBeGreaterThan(0);
    for (const p of hits) expect(opus(p).model, p).toBe("opus");
    for (const p of ["src/lib/utils.ts", "src/lib/media.ts", "src/app/page.tsx", "src/components/admin-nav.tsx", "docs/src/lib/session.ts"]) {
      expect(opus(p).model, p).toBe("sonnet");
    }
  }, 30_000); // spawns a real git ls-files over the tree
});

describe("M2: a truncated file list fails closed to opus", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `docs/f${i}.md` }));
  it("decide: 100 files read of 150 changed -> opus, reason names the truncation", () => {
    const d = decide({ title: t("ugcportal-abcd"), paths: files.map((f) => f.path), changedFiles: 150, bead: { model: "haiku" } });
    expect(d).toMatchObject({ ok: true, model: "opus" });
    expect(d.reason).toBe("file list truncated (100 of 150); routed opus");
  });
  it("main: gh returning files=100 and changedFiles=150 prints opus", () => {
    const r = runWithFakes({ title: t("ugcportal-abcd"), files, changedFiles: 150 }, { model: "sonnet", model_effort: "medium" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("model=opus effort=medium reason=file list truncated (100 of 150); routed opus");
  });
  it("main: a complete list of 100 is not truncated", () => {
    const r = runWithFakes({ title: t("ugcportal-abcd"), files, changedFiles: 100 }, { model: "sonnet" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^model=sonnet effort=high reason=bead ugcportal-abcd tier sonnet; 100 changed path/);
  });
  it("main: gh output without a numeric changedFiles exits 1 rather than trusting the list", () => {
    const r = runWithFakes({ title: t("ugcportal-abcd"), files }, { model: "sonnet" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("gh pr view gave no numeric changedFiles");
  });
});

describe("L1: dotted bead ids parse", () => {
  it("one and two dots", () => {
    expect(beadIdFromTitle("feat(x): y (ugcportal-74w.1)")).toBe("ugcportal-74w.1");
    expect(beadIdFromTitle("feat(x): y (ugcportal-qnq9.2.2)")).toBe("ugcportal-qnq9.2.2");
    const d = decide({ title: "feat(x): y (ugcportal-74w.1)", paths: ["a.md"], bead: { model: "sonnet" } });
    expect(d).toMatchObject({ ok: true, model: "sonnet" });
    expect(d.reason).toContain("bead ugcportal-74w.1 tier sonnet");
  });
  it("a trailing PR number and the release title still have no bead id (exit 2)", () => {
    expect(beadIdFromTitle("fix(x): y (#303)")).toBe(null);
    expect(beadIdFromTitle("chore(release): v0.9.0")).toBe(null);
    for (const title of ["fix(x): y (#303)", "chore(release): v0.9.0"]) {
      const r = runWithFakes({ title, files: [{ path: "a.md" }], changedFiles: 1 }, { model: "sonnet" });
      expect(r.status, title).toBe(2);
      expect(r.stdout).toBe("");
    }
  });
});

describe("L2: model_effort is validated", () => {
  it("legal values pass through", () => {
    for (const e of ["low", "medium", "high", "xhigh", "max"]) {
      const d = decide({ title: t("ugcportal-abcd"), paths: ["a.md"], bead: { model: "sonnet", model_effort: e } });
      expect(d.effort).toBe(e);
      expect(d.reason).not.toContain("model_effort");
    }
  });
  // Case is not folded: CLAUDE.md lists the values in lower case, so "HIGH"
  // is malformed metadata and is reported, even though the fallback is high.
  it("extreme, HIGH and 5 fall back to high with the reason naming the value", () => {
    for (const [e, shown] of [["extreme", '"extreme"'], ["HIGH", '"HIGH"'], [5, "5"]]) {
      const d = decide({ title: t("ugcportal-abcd"), paths: ["a.md"], bead: { model: "sonnet", model_effort: e } });
      expect(d.effort, String(e)).toBe("high");
      expect(d.reason).toContain(`model_effort ${shown} is not one of low|medium|high|xhigh|max; effort high`);
    }
  });
});

describe("L4: the process-guard scripts route their own PRs to opus", () => {
  it("this PR's own file list (#330) routes opus", () => {
    const d = decide({
      title: t("ugcportal-1mhn"),
      paths: [".claude/agents/worker-reviewer.md", ".claude/skills/harness-cost-controls/SKILL.md",
        ".claude/skills/pr-review-merge/SKILL.md", "scripts/reviewer-model.mjs", "scripts/reviewer-model.test.mjs"],
      bead: { model: "sonnet", model_effort: "medium" },
    });
    expect(d.model).toBe("opus");
    expect(d.reason).toBe("risk path scripts/reviewer-model.mjs (process-guard list)");
  });
});

describe("L5: every step-2 sensitive-path regex is classified here", () => {
  // One representative path per regex in check-human-merge-labels.mjs
  // SENSITIVE_PATH_RES, keyed by regex source. A regex added there with no
  // row here fails the first assertion.
  const REPRESENTATIVE = {
    "^\\.claude\\/settings(\\.local)?\\.json$": ".claude/settings.local.json",
    "^\\.claude\\/skills\\/": ".claude/skills/pr-review-merge/SKILL.md",
    "^\\.claude\\/agents\\/": ".claude/agents/worker-reviewer.md",
    "^CLAUDE\\.md$": "CLAUDE.md",
    "^\\.github\\/workflows\\/": ".github/workflows/ci.yml",
    "(^|\\/)docker-compose\\.yml$": "docker-compose.yml",
    "(^|\\/)[^/]*(secret|credential)[^/]*$": "config/credentials.json",
    "(^|\\/)\\.env[^/]*$": ".env.local",
    "\\.(pem|key)$": "hal9000.pem",
    "^src\\/lib\\/auth\\.ts$": "src/lib/auth.ts",
    "^src\\/app\\/api\\/auth\\/": "src/app/api/auth/[...nextauth]/route.ts",
  };
  it("each regex has a representative it matches, and each representative is a risk path or stated process prose", () => {
    expect(SENSITIVE_PATH_RES.length).toBeGreaterThan(0);
    for (const re of SENSITIVE_PATH_RES) {
      const p = REPRESENTATIVE[re.source];
      expect(p, `no representative for step-2 regex ${re}`).toBeDefined();
      expect(re.test(p), `${p} vs ${re}`).toBe(true);
      expect(isSensitivePath(p)).toBe(true);
      const risk = riskMatch(p);
      const prose = PROCESS_PROSE.find((x) => x.re.test(p));
      expect(Boolean(risk) || Boolean(prose), `${p} is neither a risk path nor process prose`).toBe(true);
      if (prose) {
        expect(risk, `${p} is both`).toBe(null);
        expect(prose.reason.length).toBeGreaterThan(20);
        expect(opus(p).model, p).toBe("sonnet");
      } else {
        expect(opus(p, "haiku").model, p).toBe("opus");
      }
    }
    expect(Object.keys(REPRESENTATIVE).length).toBe(SENSITIVE_PATH_RES.length);
  });
});
