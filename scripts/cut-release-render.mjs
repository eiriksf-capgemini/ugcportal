#!/usr/bin/env node
/**
 * Reference implementation of cut-release steps 1 (candidate filter and
 * classification), 5 (grouping) and the K2 repeated-PR check
 * (.claude/skills/cut-release/SKILL.md), so the rendering rule is testable
 * rather than prose only (ugcportal-xb68, review-standards section 6).
 *
 * It does NOT touch bd, gh, CHANGELOG.md, package.json or any bead. It reads
 * a JSON array of beads (the shape `bd list --status=closed --json` returns),
 * the text of CHANGELOG.md, and a map of PR number -> state, and prints the
 * section membership, the A/B/C narrowing figures and the K2 report lines.
 *
 * Usage:
 *   node scripts/cut-release-render.mjs <beads.json> <CHANGELOG.md> <pr-states.json>
 * pr-states.json is {"155":"MERGED", ...}, e.g. built from `gh pr view N
 * --json state`. A PR absent from the map is NOT treated as merged: a lookup
 * that was never made must not read as a pass.
 */
import { readFileSync } from "node:fs";
import { isMainModule } from "./lib/is-main.mjs";

export const RESOLUTIONS = ["shipped", "not-reproducible", "wont-fix", "duplicate", "superseded"];

export const TYPE_SECTIONS = [
  ["Features", ["feat"]],
  ["Fixes", ["fix"]],
  ["Performance", ["perf"]],
  ["Documentation", ["docs"]],
  ["Refactoring", ["refactor"]],
  ["Tests", ["test"]],
  ["Build & CI", ["build", "ci"]],
  ["Chores", ["chore", "style", "revert"]],
];
export const OTHER = "Other";
export const WITHOUT_CHANGE = "Closed without a change";

/**
 * Split `metadata.prs` (`gh-N,gh-M`) into PR numbers and malformed tokens.
 * A blank or non-string value is absent: no numbers, nothing malformed. Any
 * other token not matching /^gh-\d+$/ after trimming (`GH-12`, `12`,
 * `gh-12a`, an empty token from a trailing comma) is malformed.
 */
export function splitPrs(prs) {
  if (typeof prs !== "string" || prs.trim() === "") return { numbers: [], malformed: [] };
  const numbers = [];
  const malformed = [];
  for (const raw of prs.split(",")) {
    const t = raw.trim();
    const m = /^gh-(\d+)$/.exec(t);
    if (m) numbers.push(Number(m[1]));
    else malformed.push(t);
  }
  return { numbers, malformed };
}

export function parsePrs(prs) {
  return splitPrs(prs).numbers;
}

/**
 * Version bump from the beads classified as shipped only (SKILL.md step 3).
 * breaking=true -> major; else any feat -> minor; else patch.
 */
export function computeBump(shippedBeads) {
  const breaking = shippedBeads.filter((b) => b.metadata?.breaking === "true").map((b) => b.id);
  if (breaking.length) return { bump: "major", triggers: breaking };
  const feats = shippedBeads.filter((b) => b.metadata?.cc_type === "feat").map((b) => b.id);
  if (feats.length) return { bump: "minor", triggers: feats };
  return { bump: "patch", triggers: [] };
}

/**
 * Classify one candidate. Returns { section: "shipped"|"without-change",
 * resolution, reason }. Value set, default and fallback live in SKILL.md
 * step 1; this is the same rule.
 */
export function classify(bead) {
  const md = bead.metadata ?? {};
  const raw = typeof md.resolution === "string" ? md.resolution.trim() : "";
  const hasPrs = typeof md.prs === "string" && md.prs.trim() !== "";
  if (raw === "") {
    return hasPrs
      ? { section: "shipped", resolution: "shipped", reason: "default: resolution absent, prs non-empty" }
      : { section: "without-change", resolution: "none", reason: "fallback: no prs and no resolution" };
  }
  if (raw === "shipped") return { section: "shipped", resolution: "shipped", reason: "resolution=shipped" };
  if (RESOLUTIONS.includes(raw)) return { section: "without-change", resolution: raw, reason: `resolution=${raw}` };
  // Never drop: an unrecognised value is rendered, in the section that makes it visible.
  return { section: "without-change", resolution: raw, reason: `unrecognised resolution "${raw}"`, unrecognised: true };
}

/** { "v0.6.0": Set<number> } over every "## v..." section of the changelog text. */
export function prsBySection(changelog) {
  const out = new Map();
  let current = null;
  for (const line of changelog.split("\n")) {
    const h = /^## (v\S+)/.exec(line);
    if (h) {
      current = h[1];
      out.set(current, new Set());
      continue;
    }
    if (current === null) continue;
    for (const m of line.matchAll(/pull\/(\d+)/g)) out.get(current).add(Number(m[1]));
  }
  return out;
}

function typeSection(bead) {
  const t = bead.metadata?.cc_type;
  for (const [name, types] of TYPE_SECTIONS) if (types.includes(t)) return name;
  return OTHER;
}

export function render(beads, changelog, prStates) {
  const A = beads.length;
  const unreleased = beads.filter((b) => !b.metadata?.released_in);
  const B = unreleased.length;
  const dropped = [];
  const malformed = [];
  const candidates = [];
  for (const b of unreleased) {
    const bad = splitPrs(b.metadata?.prs).malformed;
    if (bad.length > 0) {
      malformed.push({ id: b.id, tokens: bad, raw: b.metadata.prs });
      continue;
    }
    const unmerged = parsePrs(b.metadata?.prs).filter((n) => prStates[String(n)] !== "MERGED");
    if (unmerged.length > 0) dropped.push({ id: b.id, unmerged });
    else candidates.push(b);
  }
  const C = candidates.length;

  const earlier = prsBySection(changelog);
  const sections = new Map();
  const add = (name, entry) => sections.set(name, [...(sections.get(name) ?? []), entry]);
  const repeatedPrs = [];
  const warnings = [];
  const tagged = [];
  const shippedBeads = [];
  for (const b of candidates) {
    const c = classify(b);
    if (c.section === "shipped") shippedBeads.push(b);
    const entry = { id: b.id, title: b.title, resolution: c.resolution, reason: c.reason };
    add(c.section === "without-change" ? WITHOUT_CHANGE : typeSection(b), entry);
    tagged.push(b.id);
    if (c.unrecognised) warnings.push(`${b.id}: ${c.reason}`);
    for (const n of parsePrs(b.metadata?.prs)) {
      const where = [...earlier].filter(([, set]) => set.has(n)).map(([v]) => v);
      if (where.length > 0) repeatedPrs.push({ pr: n, bead: b.id, sections: where });
    }
  }
  const rendered = [...sections.values()].reduce((s, e) => s + e.length, 0);
  const report = [
    ...repeatedPrs.map((r) => `PR #${r.pr} (${r.bead}) is already linked in an earlier release section: ${r.sections.join(", ")}`),
    ...warnings,
    ...malformed.map((m) => `${m.id}: malformed prs "${m.raw}" -- excluded from this release; fix the bead, then re-run`),
    ...dropped.map((d) => `${d.id} dropped from this release: PR(s) not MERGED: ${d.unmerged.join(", ")}`),
  ];
  const { bump, triggers } = computeBump(shippedBeads);
  return { A, B, C, rendered, tagged, sections, repeatedPrs, dropped, malformed, bump, bumpTriggers: triggers, report };
}

export function format(result) {
  const lines = [
    `closed beads returned: ${result.A}`,
    `of those, without released_in: ${result.B}`,
    `of those, verified (every gh-N MERGED, or no prs): ${result.C}`,
    `rendered entries: ${result.rendered}`,
    `version bump (shipped beads only): ${result.bump}`,
  ];
  for (const [name, entries] of result.sections) {
    lines.push("", `### ${name}`);
    for (const e of entries) lines.push(`- ${e.id} [${e.reason}]`);
  }
  lines.push("", "report:", ...(result.report.length ? result.report.map((r) => `- ${r}`) : ["- (none)"]));
  return lines.join("\n");
}

/**
 * 1: never-drop violated (rendered != C). 3: the run is incomplete because a
 * bead with a malformed prs token was excluded. 0 otherwise.
 */
export function exitCode(result) {
  if (result.rendered !== result.C) return 1;
  if (result.malformed.length > 0) return 3;
  return 0;
}

if (isMainModule(import.meta.url)) {
  const [beadsPath, changelogPath, statesPath] = process.argv.slice(2);
  if (!beadsPath || !changelogPath || !statesPath) {
    console.error("usage: cut-release-render.mjs <beads.json> <CHANGELOG.md> <pr-states.json>");
    process.exit(2);
  }
  const result = render(
    JSON.parse(readFileSync(beadsPath, "utf8")),
    readFileSync(changelogPath, "utf8"),
    JSON.parse(readFileSync(statesPath, "utf8")),
  );
  console.log(format(result));
  if (result.rendered !== result.C) {
    console.error(`never-drop violated: rendered ${result.rendered} != C ${result.C}`);
  }
  if (result.malformed.length > 0) {
    console.error(`INCOMPLETE: ${result.malformed.length} bead(s) with malformed prs excluded (${result.malformed.map((m) => m.id).join(", ")}); fix them before steps 6-8`);
  }
  process.exit(exitCode(result));
}
