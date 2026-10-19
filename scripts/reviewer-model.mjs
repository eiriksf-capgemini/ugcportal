#!/usr/bin/env node
/**
 * Which model tier and effort a review round should run on (ugcportal-1mhn).
 *
 *   node scripts/reviewer-model.mjs <pr-number>
 *   prints one line: model=<tier> effort=<e> reason=<...>
 *   exit 2, nothing on stdout, a message on stderr naming what is missing,
 *   when the PR title has no trailing (ugcportal-xxxx) or the bead has no
 *   legal `model`: the orchestrator then decides by hand and records why.
 *   exit 1 when `gh` or `bd` itself fails.
 *
 * Rule:
 *   - opus when any changed path matches RISK_PATHS;
 *   - otherwise the bead's `model` tier, floored at sonnet (haiku is never a
 *     review tier);
 *   - `.claude/**` and CLAUDE.md are process prose, not risk: they take the
 *     bead's tier (floored). They route to a human merge anyway (pr-review-merge
 *     step 2); this script only picks the model that reviews them;
 *   - effort is the bead's `model_effort`, or `high` when absent.
 *
 * The risk list has two sources, named per entry in RISK_PATHS:
 *   guard  = the sensitive-path list in .claude/skills/pr-review-merge/SKILL.md
 *            step 2 (mirrored in scripts/check-human-merge-labels.mjs
 *            SENSITIVE_PATH_RES). .claude/settings.json carries only edit-deny
 *            rules, no path list, so that skill list is the guard read here.
 *            Its .claude/** and CLAUDE.md entries are process prose and are
 *            deliberately not risk (see above).
 *   model-fit = CLAUDE.md's model-fit table, "opus: security/money
 *            correctness, ... wide blast radius": attestation, resale rights,
 *            origin, test-support, API route handlers, prisma, check scripts.
 *
 * The decision is pure (decide); gh and bd run only in main(), so the tests
 * need no network. Same shape as scripts/check-npm-audit.mjs.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {{re: RegExp, example: string, source: "guard"|"model-fit"}[]} */
export const RISK_PATHS = [
  { re: /^src\/lib\/attestation/, example: "src/lib/attestation.ts", source: "model-fit" },
  { re: /^src\/lib\/resale-rights/, example: "src/lib/resale-rights.ts", source: "model-fit" },
  { re: /^src\/lib\/origin/, example: "src/lib/origin.ts", source: "model-fit" },
  { re: /^src\/lib\/test-support\//, example: "src/lib/test-support/db.ts", source: "model-fit" },
  { re: /^src\/app\/api\//, example: "src/app/api/media/route.ts", source: "model-fit" },
  { re: /^src\/lib\/auth/, example: "src/lib/auth.ts", source: "guard" },
  { re: /^src\/app\/api\/auth\//, example: "src/app/api/auth/[...nextauth]/route.ts", source: "guard" },
  { re: /^prisma\//, example: "prisma/schema.prisma", source: "model-fit" },
  { re: /^\.github\/workflows\//, example: ".github/workflows/ci.yml", source: "guard" },
  { re: /^scripts\/check-[^/]*\.mjs$/, example: "scripts/check-npm-audit.mjs", source: "model-fit" },
  { re: /(^|\/)docker-compose\.yml$/, example: "docker-compose.yml", source: "guard" },
  { re: /(^|\/)[^/]*(secret|credential)[^/]*$/, example: "src/lib/secret-store.ts", source: "guard" },
  { re: /(^|\/)\.env[^/]*$/, example: ".env.production", source: "guard" },
  { re: /\.(pem|key)$/, example: "hal9000.pem", source: "guard" },
];

const PROCESS_RE = /^(\.claude\/|CLAUDE\.md$)/;
const TIERS = ["haiku", "sonnet", "opus", "fable"];

/** @param {string} title @returns {string|null} */
export function beadIdFromTitle(title) {
  const m = /\((ugcportal-[a-z0-9]+)\)\s*$/.exec(String(title ?? "").trim());
  return m ? m[1] : null;
}

/** @param {string} path */
export function riskMatch(path) {
  return RISK_PATHS.find((r) => r.re.test(path)) ?? null;
}

/**
 * @param {{title: string, paths: string[], bead: {model?: string, model_effort?: string}|null}} input
 * @returns {{ok: false, missing: string} | {ok: true, model: string, effort: string, reason: string}}
 */
export function decide({ title, paths, bead }) {
  const id = beadIdFromTitle(title);
  if (!id) return { ok: false, missing: `PR title has no trailing (ugcportal-xxxx) bead id: ${JSON.stringify(title)}` };
  const tier = bead?.model;
  if (!tier || !TIERS.includes(tier)) {
    return { ok: false, missing: `bead ${id} has no legal metadata.model (got ${JSON.stringify(tier ?? null)}; want one of ${TIERS.join("|")})` };
  }
  const effort = bead.model_effort || "high";
  for (const p of paths) {
    const hit = riskMatch(p);
    if (hit) return { ok: true, model: "opus", effort, reason: `risk path ${p} (${hit.source} list)` };
  }
  const process = paths.filter((p) => PROCESS_RE.test(p)).length;
  const note = `${paths.length} changed path(s) checked, none on the risk list${process ? `, ${process} process-prose path(s) take the bead's tier` : ""}`;
  if (tier === "haiku") {
    return { ok: true, model: "sonnet", effort, reason: `floor: bead ${id} is tiered haiku, never haiku for review; ${note}` };
  }
  return { ok: true, model: tier, effort, reason: `bead ${id} tier ${tier}; ${note}` };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

export function main(argv = process.argv.slice(2), out = console.log, err = console.error) {
  const pr = argv[0];
  if (!/^[0-9]+$/.test(pr ?? "")) {
    err("usage: node scripts/reviewer-model.mjs <pr-number>");
    return 1;
  }
  try {
    const view = JSON.parse(run("gh", ["pr", "view", pr, "--json", "title,files"]));
    const paths = (view.files ?? []).map((f) => f.path);
    const id = beadIdFromTitle(view.title);
    let bead = null;
    if (id) {
      const shown = JSON.parse(run("bd", ["show", id, "--json"]));
      const issue = Array.isArray(shown) ? shown[0] : shown;
      bead = issue?.metadata ?? {};
    }
    const d = decide({ title: view.title, paths, bead });
    if (!d.ok) {
      err(`reviewer-model: cannot route PR #${pr}: ${d.missing}. Decide the model by hand and record why.`);
      return 2;
    }
    out(`model=${d.model} effort=${d.effort} reason=${d.reason}`);
    return 0;
  } catch (e) {
    err(`reviewer-model: ${e.message}`);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main());
