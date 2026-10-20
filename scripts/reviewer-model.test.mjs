import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide,
  classify,
  GUARD_PATHS,
  PROCESS_PROSE,
  PRESENTATION_ALLOWLIST,
  beadIdFromTitle,
  main,
} from "./reviewer-model.mjs";
import { SENSITIVE_PATH_RES, isSensitivePath } from "./check-human-merge-labels.mjs";

const t = (id) => `chore(x): something (${id})`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./reviewer-model.mjs", import.meta.url));

/** Every tracked file at HEAD, read live; fails loud rather than walking an empty list. */
function trackedFiles() {
  const listed = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  expect(listed.status, listed.stderr).toBe(0);
  const files = listed.stdout.split("\n").filter(Boolean);
  expect(files.length).toBeGreaterThan(500);
  return files;
}

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

/** decide() over a docs file plus `path`, so `path` alone decides whether it is opus. */
const route = (path, tier = "sonnet") => decide({ title: t("ugcportal-abcd"), paths: ["docs/a.md", path], bead: { model: tier } });

describe("K1 fixtures from PR #327 and #326", () => {
  it("#327: one docs file, bead tiered haiku -> sonnet, reason names the floor", () => {
    const d = decide({
      title: t("ugcportal-nexj"),
      paths: ["docs/process/dependency-deferral-register.md"],
      bead: { model: "haiku", model_effort: "low" },
    });
    expect(d).toMatchObject({ ok: true, model: "sonnet", effort: "low" });
    expect(d.reason).toMatch(/^floor:/);
    expect(d.reason).toContain("1 process prose");
  });
  it("#326: ci.yml and check-npm-audit.mjs, bead tiered sonnet -> opus, reason names the guard path", () => {
    const d = decide({
      title: t("ugcportal-1j4j"),
      paths: [".github/workflows/ci.yml", "scripts/check-npm-audit.mjs", "scripts/npm-audit-allowlist.json"],
      bead: { model: "sonnet", model_effort: "medium" },
    });
    expect(d).toMatchObject({ ok: true, model: "opus", effort: "medium" });
    expect(d.reason).toMatch(/^guard: \.github\/workflows\/ci\.yml /);
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
    const r = runWithFakes({ title: "chore: synthetic, no bead id", files: [{ path: "a.md" }], changedFiles: 1 }, { model: "sonnet" });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/no trailing \(ugcportal-xxxx\)/);
  });
  it("main rejects a non-numeric PR argument", () => {
    expect(main(["abc"], () => {}, () => {})).toBe(1);
  });
});

describe("the rule: process prose and allowlisted presentation take the bead's tier, everything else routes opus", () => {
  it("prose takes the bead's tier and effort defaults to high", () => {
    const d = decide({
      title: t("ugcportal-abcd"),
      paths: [".claude/skills/x/SKILL.md", ".claude/agents/worker-reviewer.md", "CLAUDE.md", "CHANGELOG.md", "docs/design/tokens.css", "AGENTS.md"],
      bead: { model: "sonnet" },
    });
    expect(d).toMatchObject({ model: "sonnet", effort: "high" });
    expect(d.reason).toBe("bead ugcportal-abcd tier sonnet; 6 changed path(s), none code by default: 6 process prose");
  });
  it("an allowlisted presentation file takes the bead's tier and the reason names the allowlist entry", () => {
    const d = decide({ title: t("ugcportal-abcd"), paths: ["src/lib/design/no-raw-hex.test.ts"], bead: { model: "sonnet" } });
    expect(d.model).toBe("sonnet");
    expect(d.reason).toContain("1 allowlist (allowlist: ");
  });
  it("a file nobody classified routes opus by the code default, naming the path", () => {
    for (const p of ["src/lib/brand-new-module.ts", "src/app/new-page/page.tsx", "scripts/new-tool.mjs", "public/new.svg",
      "e2e/new.spec.ts", "Dockerfile", "package.json", "package-lock.json", "next.config.ts", "vitest.config.ts",
      ".claude/skills/harness-cost-controls/scripts/usage_indicators.py", "unknown-file"]) {
      const d = route(p);
      expect(d.model, p).toBe("opus");
      expect(d.reason, p).toBe(`code default: ${p} is code or configuration on no allowlist; routed opus`);
    }
  });
  it("a guard path beats prose and the allowlist (a credential file under docs/ routes opus)", () => {
    for (const p of ["docs/credentials.md", "docs/hal9000.pem", ".env.md", "src/components/ui/secret-button.tsx"]) {
      const d = route(p, "haiku");
      expect(d.model, p).toBe("opus");
      expect(d.reason, p).toMatch(new RegExp(`^guard: ${p.replace(/[.]/g, "\\.")} `));
    }
  });
  it("model=haiku never routes to haiku; a fable bead keeps fable", () => {
    expect(decide({ title: t("ugcportal-abcd"), paths: ["docs/a.md"], bead: { model: "haiku" } }).model).toBe("sonnet");
    expect(decide({ title: t("ugcportal-abcd"), paths: ["a.md"], bead: { model: "fable" } }).model).toBe("fable");
  });
  it("a bead id is read only from the trailing parenthesis", () => {
    expect(beadIdFromTitle("fix (ugcportal-aaaa) and more (ugcportal-bbbb)")).toBe("ugcportal-bbbb");
    expect(beadIdFromTitle("fix (ugcportal-aaaa) and more")).toBe(null);
  });
});

describe("pinned lists: deleting or adding an entry fails", () => {
  it("PRESENTATION_ALLOWLIST is exactly this list", () => {
    expect(PRESENTATION_ALLOWLIST.map((r) => String(r.re))).toEqual([
      "/^src\\/app\\/favicon\\.ico$/",
      "/^src\\/lib\\/design\\/(?:tailwind-source-scan|terracotta-500-guard)(?:\\.test)?\\.ts$/",
      "/^src\\/lib\\/design\\/(?:color|contrast|dual-meaning-usage|ink-muted-usage|motion-reduce-pairing|no-raw-hex|terracotta-primary-control|tokens|usage)\\.test\\.ts$/",
      "/^src\\/lib\\/design\\/__snapshots__\\/contrast\\.test\\.ts\\.snap$/",
      "/^src\\/lib\\/utils\\.ts$/",
      "/^src\\/app\\/about\\/page(?:\\.test)?\\.tsx$/",
    ]);
    for (const r of PRESENTATION_ALLOWLIST) expect(r.reason.length, String(r.re)).toBeGreaterThan(25);
  });
  it("PROCESS_PROSE is exactly this list", () => {
    expect(PROCESS_PROSE.map((r) => String(r.re))).toEqual([
      "/^\\.claude\\/skills\\/.*\\.md$/",
      "/^\\.claude\\/agents\\/.*\\.md$/",
      "/^CLAUDE\\.md$/",
      "/^CHANGELOG\\.md$/",
      "/^docs\\//",
      "/^(?!docs\\/|\\.claude\\/(?:skills|agents)\\/|CLAUDE\\.md$|CHANGELOG\\.md$).*\\.md$/",
    ]);
    for (const r of PROCESS_PROSE) expect(r.reason.length, String(r.re)).toBeGreaterThan(20);
  });
  it("GUARD_PATHS is exactly this list", () => {
    expect(GUARD_PATHS.map((r) => String(r.re))).toEqual([
      "/^\\.claude\\/settings(\\.local)?\\.json$/",
      "/^src\\/lib\\/auth/",
      "/^src\\/app\\/api\\/auth\\//",
      "/^\\.github\\/workflows\\//",
      "/(^|\\/)docker-compose\\.yml$/",
      "/(^|\\/)[^/]*(secret|credential)[^/]*$/",
      "/(^|\\/)\\.env[^/]*$/",
      "/\\.(pem|key)$/",
    ]);
  });
});

// A risk name pattern (session, auth, sellability, rights, money, crypto,
// consent, access, media, curation, commerce, users, config ...), kept here
// ONLY as a negative check: no path it names may ever be allowlisted. It is
// not a routing rule; the script routes such paths opus by the code default.
const OLD_RISK_NAME_RE = /(session|sign-in|auth|role|admin|oauth|sellab|publish|rights|licen[cs]e|pricing|price|payment|crypto|encrypt|attest|origin|disclos|evidence|secret|credential|consent|access|media|curation|commerce|alcohol|privacy|users?\b|user-link|config)/i;

describe("the allowlist cannot reach risk", () => {
  it("no allowlist entry matches a path the old risk name pattern names, nor a step-2 sensitive path", () => {
    const probes = ["src/lib/session.ts", "src/lib/auth.ts", "src/config/users.ts", "src/lib/media-access.ts"];
    for (const r of PRESENTATION_ALLOWLIST) {
      for (const p of probes) expect(r.re.test(p), `${r.re} allowlists ${p}`).toBe(false);
    }
    const files = trackedFiles();
    let checked = 0;
    for (const p of files) {
      if (!PRESENTATION_ALLOWLIST.some((r) => r.re.test(p))) continue;
      checked += 1;
      expect(OLD_RISK_NAME_RE.test(p), `allowlisted ${p} carries a risk name`).toBe(false);
      expect(isSensitivePath(p), `allowlisted ${p} is a step-2 sensitive path`).toBe(false);
    }
    console.log(`reviewer-model allowlist guard: ${checked} allowlisted tracked file(s) checked against the risk name pattern`);
    expect(checked).toBeGreaterThan(0);
  }, 30_000); // spawns a real git ls-files over the tree
  it("every allowlist entry matches at least one tracked file (a stale entry fails)", () => {
    const files = trackedFiles();
    for (const r of PRESENTATION_ALLOWLIST) {
      expect(files.filter((p) => r.re.test(p)).length, `stale allowlist entry ${r.re}`).toBeGreaterThan(0);
    }
  }, 30_000); // spawns a real git ls-files over the tree
});

describe("walk: every tracked file is classified by exactly one rule", () => {
  it("prose and allowlist entries never overlap, no allowlisted file is a guard path, and every rule fires (counts printed)", () => {
    const files = trackedFiles();
    const counts = { guard: 0, "process prose": 0, allowlist: 0, "code default": 0 };
    for (const p of files) {
      const prose = PROCESS_PROSE.filter((r) => r.re.test(p)).length;
      const allow = PRESENTATION_ALLOWLIST.filter((r) => r.re.test(p)).length;
      const guard = GUARD_PATHS.some((r) => r.re.test(p));
      expect(prose + allow, `${p} matches ${prose} prose and ${allow} allowlist entries`).toBeLessThanOrEqual(1);
      expect(guard && allow > 0, `${p} is both a guard path and allowlisted`).toBe(false);
      const c = classify(p);
      const want = guard ? "guard" : prose ? "process prose" : allow ? "allowlist" : "code default";
      expect(c.rule, p).toBe(want);
      counts[c.rule] += 1;
      const d = route(p, "haiku");
      expect(d.model, p).toBe(c.rule === "guard" || c.rule === "code default" ? "opus" : "sonnet");
    }
    console.log(`reviewer-model walk: ${files.length} tracked files: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const [k, v] of Object.entries(counts)) expect(v, `rule ${k} classified nothing`).toBeGreaterThan(0);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(files.length);
  }, 30_000); // spawns a real git ls-files over the tree
});

// K2 of ugcportal-gvrf: an allowlisted module imported by a module the
// script routes opus is never presentation-only, whatever its file name says.
// The case it exists for is src/lib/design/scan-source.ts: a directory named
// design, no risk word in the name, and the scanning engine behind the privacy,
// attestation, sellability, licence, alcohol-commerce and consent guards.
// The graph is resolved from import specifiers, not guessed from names:
// every tracked .js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.css file is read (src/,
// scripts/, e2e/ and the root configs alike), and each relative or `@/`
// specifier in a from-clause, a side-effect or CSS @import, import(),
// require() or vi.mock()/vi.importActual() is resolved against the tracked
// file list the way tsconfig's bundler resolution and `@/*` -> `src/*` do.
const IMPORTER_EXT = /\.(?:[cm]?[jt]sx?|mts|css)$/;
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".css",
  "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

/** Resolve one specifier from `from` to a tracked path; null for a bare package, {unresolved} when no tracked file matches. */
function resolveSpecifier(from, spec, tracked) {
  let base;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) if (tracked.has(base + suffix)) return base + suffix;
  const noJs = base.replace(/\.[cm]?jsx?$/, "");
  if (noJs !== base) for (const suffix of [".ts", ".tsx", ".mts"]) if (tracked.has(noJs + suffix)) return noJs + suffix;
  return { unresolved: base };
}

let graphCache = null;
/** Every import edge between tracked files, plus the relative and alias specifiers no tracked file matched. */
function importGraph() {
  if (graphCache) return graphCache;
  const files = trackedFiles();
  const tracked = new Set(files);
  const importers = files.filter((p) => IMPORTER_EXT.test(p));
  const edges = [];
  const unresolved = [];
  for (const from of importers) {
    for (const m of readFileSync(join(ROOT, from), "utf8").matchAll(SPECIFIER_RE)) {
      const to = resolveSpecifier(from, m[2], tracked);
      if (to === null) continue;
      if (typeof to === "string") edges.push([from, to]);
      else unresolved.push([from, m[2], to.unresolved]);
    }
  }
  graphCache = { files, importers, edges, unresolved };
  return graphCache;
}

const stem = (p) => posix.basename(p).replace(/(?:\.test)?\.[^.]+$/, "");

/**
 * Every (allowlisted file, importer the script routes opus) pair under `allowlist`.
 * An unresolved relative or alias specifier whose last segment names an
 * allowlisted file's stem counts as such an import too, so a resolver gap
 * fails toward a violation rather than away from one.
 */
function importViolations(allowlist) {
  const { files, edges, unresolved } = importGraph();
  const routedOpus = (p) => ["guard", "code default"].includes(classify(p, allowlist).rule);
  const allowlisted = (p) => classify(p, allowlist).rule === "allowlist";
  const out = new Set();
  for (const [from, to] of edges) if (allowlisted(to) && routedOpus(from)) out.add(`${to} <- ${from}`);
  const allowStems = new Map(files.filter(allowlisted).map((p) => [stem(p), p]));
  for (const [from, spec] of unresolved) {
    const hit = allowStems.get(stem(spec));
    if (hit && routedOpus(from)) out.add(`${hit} <- ${from} (unresolved ${spec})`);
  }
  return [...out].sort();
}

describe("ugcportal-gvrf K1: a PR changing only the source-scanning engine routes opus", () => {
  for (const tier of ["haiku", "sonnet"]) {
    it(`src/lib/design/scan-source.ts alone, bead tier ${tier} -> opus by the code default`, () => {
      const d = decide({ title: t("ugcportal-abcd"), paths: ["src/lib/design/scan-source.ts"], bead: { model: tier, model_effort: "low" } });
      expect(d).toMatchObject({ ok: true, model: "opus", effort: "low" });
      expect(d.reason).toBe("code default: src/lib/design/scan-source.ts is code or configuration on no allowlist; routed opus");
    });
  }
});

describe("import graph (ugcportal-gvrf K2): no allowlisted module is imported by a module the script routes opus", () => {
  it("the resolver sees relative, alias and CSS imports (positive controls, counts printed)", () => {
    const { importers, edges, unresolved } = importGraph();
    const has = (from, to) => edges.some(([f, t]) => f === from && t === to);
    console.log(`reviewer-model import graph: ${importers.length} importer files read, ${edges.length} edges resolved, ${unresolved.length} relative or alias specifiers unresolved`);
    expect(importers.length).toBeGreaterThan(400);
    expect(edges.length).toBeGreaterThan(1000);
    expect(has("src/app/privacy/content.test.ts", "src/lib/design/scan-source.ts"), "alias import").toBe(true);
    expect(has("src/app/upload/upload-form.tsx", "src/app/upload/alt-text.ts"), "relative import").toBe(true);
    expect(has("src/app/admin/curation/price-form.tsx", "src/components/ui/button.tsx"), "alias .tsx import").toBe(true);
    expect(has("src/app/layout.tsx", "src/app/globals.css"), "side-effect CSS import").toBe(true);
    expect(has("src/app/globals.css", "src/app/vendor/shadcn-tailwind.css"), "CSS @import").toBe(true);
  }, 30_000); // spawns a real git ls-files and reads every tracked code file
  it("PRESENTATION_ALLOWLIST: every allowlisted tracked file's importers are allowlisted or prose (pairs named on failure)", () => {
    const { files } = importGraph();
    const checked = files.filter((p) => classify(p).rule === "allowlist").length;
    const v = importViolations(PRESENTATION_ALLOWLIST);
    console.log(`reviewer-model import graph: ${checked} allowlisted tracked file(s) checked, ${v.length} imported by an opus-routed module`);
    expect(checked).toBeGreaterThan(0);
    expect(v, `allowlisted module imported by a module routed opus:\n${v.join("\n")}`).toEqual([]);
  }, 30_000);
  it("mutation kept as a test: re-adding src/lib/design/** fails the check, naming scan-source.ts and the privacy guard", () => {
    const widened = [...PRESENTATION_ALLOWLIST, { re: /^src\/lib\/design\//, reason: "the 28781a3 entry" }];
    const v = importViolations(widened);
    expect(v).toContain("src/lib/design/scan-source.ts <- src/app/privacy/content.test.ts");
    expect(v).toContain("src/lib/design/scan-source.ts <- src/lib/test-support/prisma-write-scan.ts");
  }, 30_000);
});

describe("named files route opus whatever the bead tier", () => {
  // Fixed paths written here, not read off any list in the script, so a
  // widened allowlist cannot take its own test case with it.
  const RISK_NAMED = [
    "src/lib/attestation.ts", "src/lib/resale-rights.ts", "src/lib/origin.ts", "src/lib/test-support/db.ts",
    "src/app/api/media/route.ts", "src/lib/auth.ts", "src/app/api/auth/[...nextauth]/route.ts",
    "prisma/schema.prisma", "prisma/migrations/0001_init/migration.sql", ".github/workflows/ci.yml",
    "scripts/check-npm-audit.mjs", "docker-compose.yml", "src/lib/secret-store.ts", ".env", ".env.production",
    "hal9000.pem", "certs/tls.key", ".claude/settings.json", ".claude/settings.local.json",
    "scripts/reviewer-model.mjs", "scripts/reviewer-model.test.mjs", "scripts/sweep-merged-branches.mjs",
    "scripts/check-human-merge-labels.mjs", "scripts/gh-app-token.mjs",
    "src/lib/session.ts", "src/lib/session-or-anonymous.ts", "src/lib/sign-in-policy.ts", "src/lib/sign-in-providers.ts",
    "src/lib/roles.ts", "src/lib/admin.ts", "src/lib/instagram-oauth-state.ts", "src/lib/sellable-media.ts",
    "src/lib/publishability.ts", "src/lib/publish-gates.ts", "src/lib/rights-evidence.ts", "src/lib/pricing.ts",
    "src/lib/crypto.ts", "src/lib/evidence-encryption.ts", "src/app/admin/settings/rights/page.tsx",
  ];
  const RISK_UNNAMED = [
    "src/config/users.ts", "src/lib/configured-user-link.ts", "src/lib/curation-clearance-write.ts",
    "src/lib/curation-triage-write.ts", "src/lib/media-access.ts", "src/lib/public-media.ts",
    "src/lib/alcohol-commerce.ts", "src/lib/consent.ts", "src/app/privacy/content.ts", "src/app/licence/content.ts",
    // guard configuration: the npm-audit allowlist, the push hook, the bd PreToolUse guard
    "scripts/npm-audit-allowlist.json", ".beads/hooks/pre-push", "scripts/bd-guard.mjs",
    // the source-scanning engine behind the privacy, attestation, sellability,
    // licence and consent guards, its test and its support file (ugcportal-gvrf)
    "src/lib/design/scan-source.ts", "src/lib/design/scan-source.test.ts",
    "src/lib/design/scan-source-legacy.test-support.ts", "src/lib/test-support/prisma-write-scan.ts",
  ];
  for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
    it(`risk files with and without a risk word in their name route opus (bead tier ${tier})`, () => {
      for (const p of [...RISK_NAMED, ...RISK_UNNAMED]) {
        const d = route(p, tier);
        expect(d.model, p).toBe("opus");
        expect(d.reason, p).toMatch(new RegExp(`^(?:guard|code default): ${p.replace(/[.[\]]/g, "\\$&")} `));
        expect(["guard", "code default"]).toContain(classify(p).rule);
      }
    });
  }
  it("PR #330's own six files route opus, on the code default for its first script", () => {
    const d = decide({
      title: t("ugcportal-1mhn"),
      paths: [".claude/agents/worker-reviewer.md", ".claude/skills/harness-cost-controls/SKILL.md",
        ".claude/skills/pr-review-merge/SKILL.md", "scripts/check-human-merge-labels.mjs",
        "scripts/reviewer-model.mjs", "scripts/reviewer-model.test.mjs"],
      bead: { model: "sonnet", model_effort: "medium" },
    });
    expect(d.model).toBe("opus");
    expect(d.reason).toBe("code default: scripts/check-human-merge-labels.mjs is code or configuration on no allowlist; routed opus");
  });
});

describe("M2: a truncated file list fails closed to opus", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `docs/f${i}.md` }));
  it("decide: 100 files read of 150 changed -> opus, reason names the truncation", () => {
    const d = decide({ title: t("ugcportal-abcd"), paths: files.map((f) => f.path), changedFiles: 150, bead: { model: "haiku" } });
    expect(d).toMatchObject({ ok: true, model: "opus" });
    expect(d.reason).toBe("truncated: file list has 100 of 150 changed files; routed opus");
  });
  it("main: gh returning files=100 and changedFiles=150 prints opus", () => {
    const r = runWithFakes({ title: t("ugcportal-abcd"), files, changedFiles: 150 }, { model: "sonnet", model_effort: "medium" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("model=opus effort=medium reason=truncated: file list has 100 of 150 changed files; routed opus");
  });
  it("main: a complete list of 100 is not truncated", () => {
    const r = runWithFakes({ title: t("ugcportal-abcd"), files, changedFiles: 100 }, { model: "sonnet" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("model=sonnet effort=high reason=bead ugcportal-abcd tier sonnet; 100 changed path(s), none code by default: 100 process prose");
  });
  it("main: gh output without a numeric changedFiles exits 1 rather than trusting the list", () => {
    const r = runWithFakes({ title: t("ugcportal-abcd"), files }, { model: "sonnet" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("gh pr view gave no numeric changedFiles");
  });
});

describe("dotted bead ids parse", () => {
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

describe("model_effort is validated", () => {
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

describe("every step-2 sensitive-path regex is classified here", () => {
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
  it("each regex has a representative it matches; prose ones take the bead's tier, the rest route opus as guard paths", () => {
    expect(SENSITIVE_PATH_RES.length).toBeGreaterThan(0);
    for (const re of SENSITIVE_PATH_RES) {
      const p = REPRESENTATIVE[re.source];
      expect(p, `no representative for step-2 regex ${re}`).toBeDefined();
      expect(re.test(p), `${p} vs ${re}`).toBe(true);
      expect(isSensitivePath(p)).toBe(true);
      const c = classify(p);
      expect(["guard", "process prose"], p).toContain(c.rule);
      expect(route(p, "haiku").model, p).toBe(c.rule === "guard" ? "opus" : "sonnet");
    }
    expect(Object.keys(REPRESENTATIVE).length).toBe(SENSITIVE_PATH_RES.length);
  });
});
