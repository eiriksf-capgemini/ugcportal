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
 * Rule (fails closed; each path takes the first of these that matches):
 *   1. GUARD_PATHS -> opus. The non-prose entries of the sensitive-path
 *      list in .claude/skills/pr-review-merge/SKILL.md step 2 (line 104
 *      names it the authority; mirrored in scripts/check-human-merge-labels.mjs
 *      SENSITIVE_PATH_RES): the .claude/settings*.json permission files,
 *      auth, workflows, docker-compose.yml and the secret, credential, .env,
 *      .pem and .key paths. They come first so that no prose or allowlist
 *      entry can cover them (a credential file under docs/ routes opus; the
 *      test "a guard path beats prose and the allowlist" pins it).
 *   2. PROCESS_PROSE -> the bead's tier: markdown anywhere (skills, agent
 *      prompts, CLAUDE.md, CHANGELOG.md, READMEs) and everything under docs/.
 *      The skill and agent prose routes to a human merge anyway (step 2);
 *      this script only picks the model that reviews it. A non-markdown file
 *      under .claude/skills/ (a script) is code, not prose.
 *   3. PRESENTATION_ALLOWLIST -> the bead's tier: exact paths and narrow
 *      globs, each with the reason a defect in it cannot reach sellability,
 *      rights, auth, money, data or the review and merge process. No file an
 *      entry covers is imported by a module routed opus (rule 1 or 4); the
 *      import-graph test fails naming the pair when one is (ugcportal-gvrf).
 *   4. Code default -> opus: every other path, which is code or
 *      configuration (src/**, prisma/**, scripts/**, .github/**, .beads/**,
 *      e2e/**, public/**, package*.json, Dockerfile, *.config.*, vitest*,
 *      and any file nobody has classified yet).
 * A PR routes opus when any one changed path does (rule 1 or 4), and also
 * when gh's file list is truncated: `gh pr view --json files` stops at 100
 * files (gh 2.102.0 on cli/cli#14354 prints files=100 against
 * changedFiles=150; the same window as FILE_WINDOW in
 * scripts/check-human-merge-labels.mjs), so when files.length is below the
 * PR's `changedFiles` this routes opus rather than on the part it read.
 * Otherwise it takes the bead's `model` tier floored at sonnet (haiku is
 * never a review tier). Effort is the bead's `model_effort` when it is one
 * of EFFORTS (CLAUDE.md "Model-fit metadata", lower case, not case-folded),
 * else `high`, and the reason names an illegal value.
 *
 * Why the default is opus rather than a list of risky names: auth,
 * sellability, rights and legal code often carries a file name no pattern
 * lists (src/config/users.ts, curation-clearance-write.ts, media-access.ts,
 * consent.ts, ...), and a list of names lets every new file fall open the
 * same way. CLAUDE.md's model-fit table puts "security/money correctness, ...
 * wide blast radius" on opus, and most of src/ is one of those. The cost
 * consequence: most code PRs review on opus; docs, process prose and
 * allowlisted presentation files review at the bead's tier. A later
 * measurement decides whether the allowlist should widen.
 *
 * The reason names the rule that fired: `truncated:`, `guard:`,
 * `code default:`, `floor:`, or `bead <id> tier <t>;` followed by the
 * process-prose and allowlist counts with each allowlist reason.
 *
 * The decision is pure (decide, classify); gh and bd run only in main(), so
 * the tests need no network. Same shape as scripts/check-npm-audit.mjs.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Step-2 sensitive paths that are not prose: always opus, ahead of prose and the allowlist. */
export const GUARD_PATHS = [
  { re: /^\.claude\/settings(\.local)?\.json$/, reason: "permission config (step 2)" },
  { re: /^src\/lib\/auth/, reason: "sign-in configuration (step 2)" },
  { re: /^src\/app\/api\/auth\//, reason: "auth route handlers (step 2)" },
  { re: /^\.github\/workflows\//, reason: "CI workflows (step 2)" },
  { re: /(^|\/)docker-compose\.yml$/, reason: "deployment config (step 2)" },
  { re: /(^|\/)[^/]*(secret|credential)[^/]*$/, reason: "secret or credential path (step 2)" },
  { re: /(^|\/)\.env[^/]*$/, reason: "environment file (step 2)" },
  { re: /\.(pem|key)$/, reason: "key material (step 2)" },
];

/** Prose: takes the bead's tier. Disjoint, so a path matches at most one entry. */
export const PROCESS_PROSE = [
  { re: /^\.claude\/skills\/.*\.md$/, reason: "skill prose: review and process rules, routed to a human merge by step 2" },
  { re: /^\.claude\/agents\/.*\.md$/, reason: "agent system prompts: process prose, routed to a human merge by step 2" },
  { re: /^CLAUDE\.md$/, reason: "project instructions: process prose, routed to a human merge by step 2" },
  { re: /^CHANGELOG\.md$/, reason: "release notes: prose cut-release writes from bead metadata" },
  { re: /^docs\//, reason: "documentation tree: process records, design mockups and screenshots no build reads" },
  {
    re: /^(?!docs\/|\.claude\/(?:skills|agents)\/|CLAUDE\.md$|CHANGELOG\.md$).*\.md$/,
    reason: "markdown elsewhere (AGENTS.md, READMEs, vendored skill prose): read by people and agents, not executed",
  },
];

/**
 * Presentation files that take the bead's tier. Each entry says why a defect
 * in it cannot reach sellability, rights, auth, money, data or the review and
 * merge process, and a test backs the part of that a name cannot: no module
 * the script routes opus (guard or code default) imports any file an entry
 * covers (the import-graph test in reviewer-model.test.mjs, ugcportal-gvrf).
 * A module code imports shapes that code's behaviour, so it is not
 * presentation-only whatever its directory is called: src/lib/design/
 * scan-source.ts, the scanning engine behind the privacy, attestation,
 * sellability and consent guards, routes opus for that reason, as do the
 * UI primitives, type scale, stylesheets and upload form helpers the pages
 * import.
 * When in doubt a file stays off this list and routes opus. The tests also
 * fail on an entry that matches no tracked file, on one that covers a step-2
 * sensitive path or a risk-named path, and on any edit to the list.
 */
export const PRESENTATION_ALLOWLIST = [
  { re: /^src\/app\/favicon\.ico$/, reason: "favicon: a static icon, no logic, imported by nothing" },
  {
    re: /^src\/lib\/design\/(?:tailwind-source-scan|terracotta-500-guard)(?:\.test)?\.ts$/,
    reason: "the motion-utility and terracotta-500 contrast scanners and their tests: imported only by their own tests, so a defect weakens a visual-design check only",
  },
  {
    re: /^src\/lib\/design\/(?:color|contrast|dual-meaning-usage|ink-muted-usage|motion-reduce-pairing|no-raw-hex|terracotta-primary-control|tokens|usage)\.test\.ts$/,
    reason: "tests of the design tokens, colour maths and visual-design rules: imported by nothing, so a defect weakens a visual-design check only",
  },
  { re: /^src\/lib\/design\/__snapshots__\/contrast\.test\.ts\.snap$/, reason: "the contrast test's snapshot of measured colour pairings: read by that test only" },
  { re: /^src\/lib\/utils\.ts$/, reason: "re-exports the cn class-name joiner: styling only, imported by no module the script routes opus" },
  { re: /^src\/app\/about\/page(?:\.test)?\.tsx$/, reason: "about page: composes static site sections, reads no data, gates nothing and is imported only by its own test" },
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

/**
 * Which rule classifies one path. `allowlist` exists for the import-graph
 * test, which checks a widened list without editing this one; main() and
 * decide() always use PRESENTATION_ALLOWLIST.
 * @param {string} path
 * @param {{re: RegExp, reason: string}[]} [allowlist]
 * @returns {{rule: "guard"|"process prose"|"allowlist"|"code default", reason: string}}
 */
export function classify(path, allowlist = PRESENTATION_ALLOWLIST) {
  const guard = GUARD_PATHS.find((r) => r.re.test(path));
  if (guard) return { rule: "guard", reason: guard.reason };
  const prose = PROCESS_PROSE.find((r) => r.re.test(path));
  if (prose) return { rule: "process prose", reason: prose.reason };
  const allow = allowlist.find((r) => r.re.test(path));
  if (allow) return { rule: "allowlist", reason: allow.reason };
  return { rule: "code default", reason: "code or configuration on no allowlist" };
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
    return { ok: true, model: "opus", effort, reason: `truncated: file list has ${paths.length} of ${changedFiles} changed files; routed opus${effortNote}` };
  }
  let prose = 0;
  const allowed = new Map();
  for (const p of paths) {
    const c = classify(p);
    if (c.rule === "guard") return { ok: true, model: "opus", effort, reason: `guard: ${p} (${c.reason}); routed opus${effortNote}` };
    if (c.rule === "code default") return { ok: true, model: "opus", effort, reason: `code default: ${p} is ${c.reason}; routed opus${effortNote}` };
    if (c.rule === "process prose") prose += 1;
    else allowed.set(c.reason, (allowed.get(c.reason) ?? 0) + 1);
  }
  const parts = [];
  if (prose) parts.push(`${prose} process prose`);
  const nAllowed = [...allowed.values()].reduce((a, b) => a + b, 0);
  if (nAllowed) parts.push(`${nAllowed} allowlist (${[...allowed.keys()].map((r) => `allowlist: ${r}`).join("; ")})`);
  const note = `${paths.length} changed path(s), none code by default${parts.length ? `: ${parts.join(", ")}` : ""}${effortNote}`;
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
