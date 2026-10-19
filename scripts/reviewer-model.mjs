#!/usr/bin/env node
/**
 * Which model tier and effort a review round should run on (ugcportal-1mhn).
 *
 *   node scripts/reviewer-model.mjs <pr-number>
 *   prints one line: model=<tier> effort=<e> reason=<...>
 *   exit 2, nothing on stdout, a message on stderr naming what is missing,
 *   when the PR title has no trailing (ugcportal-xxxx) or the bead has no
 *   legal `model`: the orchestrator then decides by hand and records why.
 *   exit 1 when `gh` or `bd` itself fails, or gh's output has no numeric
 *   `changedFiles` to check the file list against.
 *
 * Rule:
 *   - opus when gh's file list is truncated: `gh pr view --json files` stops
 *     at 100 files (gh 2.102.0 on cli/cli#14354 prints files=100 against
 *     changedFiles=150; the same window as FILE_WINDOW in
 *     scripts/check-human-merge-labels.mjs), so when files.length is below
 *     the PR's `changedFiles` a risk path past the window would go unseen;
 *     this fails closed rather than routing on the part it read;
 *   - opus when any changed path matches RISK_PATHS;
 *   - otherwise the bead's `model` tier, floored at sonnet (haiku is never a
 *     review tier);
 *   - PROCESS_PROSE paths (.claude/skills/**, .claude/agents/**, CLAUDE.md)
 *     take the bead's tier (floored). They route to a human merge anyway
 *     (pr-review-merge step 2); this script only picks the model that
 *     reviews them;
 *   - effort is the bead's `model_effort` when it is one of EFFORTS
 *     (CLAUDE.md "Model-fit metadata", lower case, not case-folded), else
 *     `high`, and the reason names an illegal value.
 *
 * The risk list has four sources, named per entry in RISK_PATHS:
 *   guard  = the sensitive-path list in .claude/skills/pr-review-merge/SKILL.md
 *            step 2 (line 104 names it the authority; mirrored in
 *            scripts/check-human-merge-labels.mjs SENSITIVE_PATH_RES).
 *            .claude/settings.json has no path list (it carries permission
 *            allow/deny rules and a SessionStart hook), so that skill list is
 *            the guard read here. Every step-2 regex is either a guard entry
 *            here or a PROCESS_PROSE entry with its reason; the test fails on
 *            a step-2 regex that is neither. .claude/settings*.json are
 *            permission config, not prose, so they are guard entries.
 *   model-fit = CLAUDE.md's model-fit table, "opus: security/money
 *            correctness, ... wide blast radius": attestation, resale rights,
 *            origin, test-support, API route handlers, prisma, check scripts.
 *   name-pattern = the same model-fit row made enumerable for src/lib/** and
 *            src/app/**: any path there whose part below src/lib/ or src/app/
 *            names session, sign-in, auth, roles, admin, oauth, sellability,
 *            publishing, rights, licences, pricing, payment, crypto,
 *            encryption, attestation, origin, disclosure or evidence. It
 *            matches by name, so it errs towards opus (src/app/admin/** all
 *            matches).
 *   process-guard = scripts whose defect reaches every review or every merge:
 *            this script (it picks every review's model),
 *            sweep-merged-branches.mjs (deletes branches and worktrees),
 *            check-human-merge-labels.mjs and gh-app-token.mjs (the PR
 *            author identity the review chain reads), with their tests.
 *
 * The decision is pure (decide); gh and bd run only in main(), so the tests
 * need no network. Same shape as scripts/check-npm-audit.mjs.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {{re: RegExp, example: string, source: "guard"|"model-fit"|"name-pattern"|"process-guard"}[]} */
export const RISK_PATHS = [
  { re: /^src\/lib\/attestation/, example: "src/lib/attestation.ts", source: "model-fit" },
  { re: /^src\/lib\/resale-rights/, example: "src/lib/resale-rights.ts", source: "model-fit" },
  { re: /^src\/lib\/origin/, example: "src/lib/origin.ts", source: "model-fit" },
  { re: /^src\/lib\/test-support\//, example: "src/lib/test-support/db.ts", source: "model-fit" },
  { re: /^src\/app\/api\//, example: "src/app/api/media/route.ts", source: "model-fit" },
  { re: /^prisma\//, example: "prisma/schema.prisma", source: "model-fit" },
  { re: /^scripts\/check-[^/]*\.mjs$/, example: "scripts/check-npm-audit.mjs", source: "model-fit" },
  {
    re: /^src\/(?:lib|app)\/.*(?:session|sign-in|auth|role|admin|oauth|sellab|publish|rights|licen[cs]e|pricing|price|payment|crypto|encrypt|attest|origin|disclos|evidence)/i,
    example: "src/lib/sellable-media.ts",
    source: "name-pattern",
  },
  {
    re: /^scripts\/(?:reviewer-model|sweep-merged-branches|check-human-merge-labels|gh-app-token)(?:\.test)?\.mjs$/,
    example: "scripts/sweep-merged-branches.mjs",
    source: "process-guard",
  },
  { re: /^\.claude\/settings(\.local)?\.json$/, example: ".claude/settings.json", source: "guard" },
  { re: /^src\/lib\/auth/, example: "src/lib/auth.ts", source: "guard" },
  { re: /^src\/app\/api\/auth\//, example: "src/app/api/auth/[...nextauth]/route.ts", source: "guard" },
  { re: /^\.github\/workflows\//, example: ".github/workflows/ci.yml", source: "guard" },
  { re: /(^|\/)docker-compose\.yml$/, example: "docker-compose.yml", source: "guard" },
  { re: /(^|\/)[^/]*(secret|credential)[^/]*$/, example: "src/lib/secret-store.ts", source: "guard" },
  { re: /(^|\/)\.env[^/]*$/, example: ".env.production", source: "guard" },
  { re: /\.(pem|key)$/, example: "hal9000.pem", source: "guard" },
];

/** Step-2 sensitive paths that are deliberately not risk, each with its reason. */
export const PROCESS_PROSE = [
  { re: /^\.claude\/skills\//, reason: "skill prose: review and process rules, routed to a human merge by step 2" },
  { re: /^\.claude\/agents\//, reason: "agent system prompts: process prose, routed to a human merge by step 2" },
  { re: /^CLAUDE\.md$/, reason: "project instructions: process prose, routed to a human merge by step 2" },
];

const TIERS = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The id regex is release-cost-report.mjs line 267's `ugcportal-[a-z0-9.]+`,
 * which takes dotted child ids at any depth (ugcportal-74w.1,
 * ugcportal-qnq9.2.2); agent-pass-cost.mjs line 211's `(?:\.\d+)?` takes one
 * level only.
 * @param {string} title @returns {string|null}
 */
export function beadIdFromTitle(title) {
  const m = /\((ugcportal-[a-z0-9.]+)\)\s*$/.exec(String(title ?? "").trim());
  return m ? m[1] : null;
}

/** @param {string} path */
export function riskMatch(path) {
  return RISK_PATHS.find((r) => r.re.test(path)) ?? null;
}

/**
 * @param {{title: string, paths: string[], changedFiles?: number, bead: {model?: string, model_effort?: unknown}|null}} input
 *   changedFiles: the PR's changed-file count; omitted means paths is complete.
 * @returns {{ok: false, missing: string} | {ok: true, model: string, effort: string, reason: string}}
 */
export function decide({ title, paths, changedFiles = paths.length, bead }) {
  const id = beadIdFromTitle(title);
  if (!id) return { ok: false, missing: `PR title has no trailing (ugcportal-xxxx) bead id: ${JSON.stringify(title)}` };
  const tier = bead?.model;
  if (!tier || !TIERS.includes(tier)) {
    return { ok: false, missing: `bead ${id} has no legal metadata.model (got ${JSON.stringify(tier ?? null)}; want one of ${TIERS.join("|")})` };
  }
  const raw = bead.model_effort;
  const legal = EFFORTS.includes(/** @type {string} */ (raw));
  const effort = legal ? /** @type {string} */ (raw) : "high";
  const effortNote = legal || raw == null || raw === "" ? "" : `; model_effort ${JSON.stringify(raw)} is not one of ${EFFORTS.join("|")}; effort high`;
  if (paths.length < changedFiles) {
    return { ok: true, model: "opus", effort, reason: `file list truncated (${paths.length} of ${changedFiles}); routed opus${effortNote}` };
  }
  for (const p of paths) {
    const hit = riskMatch(p);
    if (hit) return { ok: true, model: "opus", effort, reason: `risk path ${p} (${hit.source} list)${effortNote}` };
  }
  const process = paths.filter((p) => PROCESS_PROSE.some((x) => x.re.test(p))).length;
  const note = `${paths.length} changed path(s) checked, none on the risk list${process ? `, ${process} process-prose path(s) take the bead's tier` : ""}${effortNote}`;
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
    const view = JSON.parse(run("gh", ["pr", "view", pr, "--json", "title,files,changedFiles"]));
    const paths = (view.files ?? []).map((f) => f.path);
    if (!Number.isInteger(view.changedFiles) || view.changedFiles < 0) {
      throw new Error(`gh pr view gave no numeric changedFiles (got ${JSON.stringify(view.changedFiles ?? null)}), so a truncated file list cannot be detected`);
    }
    const id = beadIdFromTitle(view.title);
    let bead = null;
    if (id) {
      const shown = JSON.parse(run("bd", ["show", id, "--json"]));
      const issue = Array.isArray(shown) ? shown[0] : shown;
      bead = issue?.metadata ?? {};
    }
    const d = decide({ title: view.title, paths, changedFiles: view.changedFiles, bead });
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
