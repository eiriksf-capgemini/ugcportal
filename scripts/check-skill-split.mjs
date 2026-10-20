#!/usr/bin/env node
/**
 * Proves that splitting a skill into a checklist (`SKILL.md`) and reference
 * files (`reference/*.md`) dropped no text (ugcportal-j13u), and keeps proving
 * it for every later PR that edits the skill.
 *
 * Input: a pinned copy of the skill's text (the fixture below; until the first
 * repin, the pre-split `SKILL.md` of origin/main 8993bb4) and the skill
 * directory as it stands now.
 *
 * A "unit" is the same thing on both sides: each non-empty line of a fenced
 * code block, each table row, and otherwise each sentence of a heading,
 * paragraph or list item, split after `.`, `!` or `?` followed by whitespace
 * (so `## 2. Sensitive-path gate` is two units). Before comparing, two normalisations apply to both sides alike,
 * and nothing else:
 *
 *   - runs of whitespace collapse to one space, so a sentence re-wrapped or
 *     re-indented by the move still matches, and a leading list or quote
 *     marker (`- `, `1. `, `> `) is dropped from the start of a unit;
 *   - a markdown link's target is dropped (`[text](target)` reads as
 *     `[text]`), so a link the move had to repoint (an in-page anchor that now
 *     lives in another file) still matches on its text.
 *
 * What is compared is counts, not presence: every unit of the pinned copy is
 * checked, rule word or not, and for each distinct unit the number of units
 * of the new tree (`SKILL.md` plus every `reference/*.md`, split the same way)
 * with exactly that text must be at least its number in the pinned copy. A
 * unit that no longer occurs is reported MISSING; one that occurs fewer times
 * is reported FEWER, with both counts and its pinned lines. So a reworded or
 * deleted unit is reported, and so is one dropped copy of a line that also
 * stands elsewhere. Not reported: a unit that moved (to any file, any step,
 * any order), a copy added elsewhere that offsets one dropped (a checklist
 * line repeating a reference sentence verbatim covers for that sentence), and
 * any new text.
 *
 * It also checks the other direction the split could fail in (K3): every
 * `reference/*.md` file is linked from `SKILL.md` at least once, by a markdown
 * link on a line carrying the words "open only when", and no link in
 * `SKILL.md` points at a reference file that does not exist.
 *
 * Changing a rule. A PR that deliberately rewords, removes or adds rule text
 * edits the live text in `SKILL.md` or `reference/*.md`, then runs
 * `node scripts/check-skill-split.mjs --repin`. That writes `SKILL.md` and
 * every `reference/*.md` (sorted by name), concatenated, over the pinned copy,
 * re-runs the check against what it wrote, and prints its sha256, which the
 * same commit puts into PINNED_SHA256 in `scripts/check-skill-split.test.mjs`.
 * Each PR is then compared against the text it started from, and the pin's
 * diff shows the rule change to its reviewer. Never leave the superseded
 * sentence standing in a reference file to keep the check green: the
 * reference text is the rule, so a sentence left there stays in force.
 *
 * Fail-loud: exits 1 when any unit is missing or short of copies, when a
 * reference file is unlinked or a link dangles, when `SKILL.md` is absent,
 * and when zero units were checked -- a check that examined nothing must not
 * read as a pass (review-standards section 6). It prints the counts before
 * any verdict. `--repin` exits 1, after writing, if the tree does not pass
 * against the pin it wrote, and refuses to write when `SKILL.md` is absent.
 *
 * What it does not prove: that a unit still sits in the step where a reader
 * will look for it, or that a new checklist line restates its rule correctly
 * (the reference text is the rule; SKILL.md says so).
 *
 * Usage: node scripts/check-skill-split.mjs [--repin] [--old <file>] [--skill-dir <dir>]
 * Defaults: the pinned pr-review-merge copy and .claude/skills/pr-review-merge.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OLD = path.join(ROOT, "scripts", "fixtures", "pr-review-merge-SKILL.pre-split.md");
export const DEFAULT_SKILL_DIR = path.join(ROOT, ".claude", "skills", "pr-review-merge");

const FENCE = /^\s*```/;
const ITEM_START = /^\s*(?:[-*]\s|\d+\.\s|>\s?)/;

/** Collapse whitespace, drop markdown link targets, drop a leading list/quote marker. */
export function normalize(text) {
  let t = text.replace(/\]\([^)\s]*\)/g, "]").replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/^(?:[-*]|\d+\.|>)\s+/, "");
  }
  return t;
}

/** Split normalised paragraph text into sentences. */
function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The units of a markdown text, each with the 1-based line it starts on.
 * @param {string} md
 * @returns {{text: string, line: number}[]}
 */
export function splitUnits(md) {
  const out = [];
  const lines = md.split("\n");
  let inFence = false;
  let chunk = null;
  const flush = () => {
    if (!chunk) return;
    for (const s of sentences(chunk.parts.join(" ").replace(/\s+/g, " "))) {
      const text = normalize(s);
      if (text) out.push({ text, line: chunk.line });
    }
    chunk = null;
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (FENCE.test(raw)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) {
      const text = normalize(raw);
      if (text) out.push({ text, line });
      return;
    }
    if (raw.trim() === "") return flush();
    if (/^\s*\|/.test(raw)) {
      flush();
      out.push({ text: normalize(raw), line });
      return;
    }
    if (ITEM_START.test(raw) || /^\s*#/.test(raw)) flush();
    if (!chunk) chunk = { line, parts: [] };
    chunk.parts.push(raw);
    if (/^\s*#/.test(raw)) flush();
  });
  flush();
  return out;
}

/** Markdown link targets under reference/ in a text, without any #anchor. */
function referenceLinks(text) {
  const links = [];
  for (const [i, raw] of text.split("\n").entries()) {
    for (const m of raw.matchAll(/\]\((?:\.\/)?(reference\/[^)#\s]+)(?:#[^)\s]*)?\)/g)) {
      links.push({ target: m[1], line: i + 1, openOnlyWhen: /open only when/i.test(raw) });
    }
  }
  return links;
}

/** Each distinct unit text with how often it occurs and the lines it starts on, in first-seen order. */
export function tallyUnits(units) {
  const tally = new Map();
  for (const u of units) {
    const t = tally.get(u.text) ?? { count: 0, lines: [] };
    t.count += 1;
    t.lines.push(u.line);
    tally.set(u.text, t);
  }
  return tally;
}

/** The text a repin writes: SKILL.md, then every reference file sorted by name, each ending in one newline. */
export function buildPin({ skillText, references }) {
  return [skillText, ...Object.keys(references).sort().map((n) => references[n])]
    .map((t) => `${t.replace(/\n+$/, "")}\n`)
    .join("\n");
}

/**
 * @param {{oldText: string, skillText: string|null, references: Record<string, string>}} input
 *   references is keyed by path relative to the skill directory, e.g. "reference/<name>.md".
 */
export function checkSplit({ oldText, skillText, references }) {
  const units = splitUnits(oldText);
  const old = tallyUnits(units);
  const refNames = Object.keys(references).sort();
  const now = tallyUnits(skillText === null ? [] : [skillText, ...refNames.map((n) => references[n])].flatMap(splitUnits));
  const short = [];
  if (skillText !== null) {
    for (const [text, { count, lines }] of old) {
      const have = now.get(text)?.count ?? 0;
      if (have < count) short.push({ text, line: lines[0], lines, old: count, now: have });
    }
  }
  const links = skillText === null ? [] : referenceLinks(skillText);
  const unlinked = refNames.filter((n) => !links.some((l) => l.target === n && l.openOnlyWhen));
  const dangling = links.filter((l) => !(l.target in references));
  return {
    units: units.length,
    distinct: old.size,
    checked: skillText === null ? 0 : units.length,
    missing: short.filter((m) => m.now === 0),
    fewer: short.filter((m) => m.now > 0),
    references: refNames,
    unlinked,
    dangling,
    skillMissing: skillText === null,
  };
}

const where = (m) => (m.lines.length === 1 ? `old line ${m.line}` : `old lines ${m.lines.join(", ")}`);

export function formatResult(r, { oldLabel, skillLabel, skillBytes, refBytes }) {
  const lines = [
    `check-skill-split: old ${oldLabel}: ${r.units} unit(s), ${r.distinct} distinct`,
    `new: ${skillLabel}/SKILL.md (${r.skillMissing ? "ABSENT" : `${skillBytes} bytes`}) + ${r.references.length} reference file(s) (${refBytes} bytes)`,
    `checked: ${r.checked} unit(s), ${r.skillMissing ? 0 : r.distinct} distinct; found with every copy: ${r.skillMissing ? 0 : r.distinct - r.missing.length - r.fewer.length}; missing: ${r.missing.length}; fewer copies: ${r.fewer.length}`,
  ];
  for (const m of r.missing) lines.push(`  MISSING (${m.lines.length === 1 ? where(m) : `${where(m)}; old ${m.old}, new 0`}): ${m.text}`);
  for (const m of r.fewer) lines.push(`  FEWER (${where(m)}; old ${m.old}, new ${m.now}): ${m.text}`);
  const linked = r.references.length - r.unlinked.length;
  lines.push(`reference files: ${r.references.length}; linked from SKILL.md on an "open only when" line: ${linked}; unlinked: ${r.unlinked.length}; dangling links: ${r.dangling.length}`);
  for (const u of r.unlinked) lines.push(`  UNLINKED: ${u}`);
  for (const d of r.dangling) lines.push(`  DANGLING (SKILL.md line ${d.line}): ${d.target}`);
  const reasons = [];
  if (r.skillMissing) reasons.push("SKILL.md is absent");
  if (r.checked === 0) reasons.push("zero units checked -- a check that examined nothing is not a pass");
  if (r.missing.length) reasons.push(`${r.missing.length} unit(s) missing`);
  if (r.fewer.length) reasons.push(`${r.fewer.length} unit(s) with fewer copies`);
  if (r.unlinked.length) reasons.push(`${r.unlinked.length} reference file(s) unlinked`);
  if (r.dangling.length) reasons.push(`${r.dangling.length} dangling link(s)`);
  lines.push(reasons.length ? `FAIL: ${reasons.join("; ")}` : "OK: every unit found with every copy, every reference file linked");
  return { ok: reasons.length === 0, lines };
}

/** Read a skill directory: SKILL.md (or null) and every reference/*.md. */
export function readSkillDir(dir) {
  const skillPath = path.join(dir, "SKILL.md");
  const skillText = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : null;
  const references = {};
  const refDir = path.join(dir, "reference");
  if (fs.existsSync(refDir)) {
    for (const name of fs.readdirSync(refDir).sort()) {
      if (name.endsWith(".md")) references[`reference/${name}`] = fs.readFileSync(path.join(refDir, name), "utf8");
    }
  }
  return { skillText, references };
}

export function main(argv = process.argv.slice(2), log = console.log) {
  let oldPath = DEFAULT_OLD;
  let skillDir = DEFAULT_SKILL_DIR;
  let repin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repin") repin = true;
    else if (argv[i] === "--old") oldPath = path.resolve(argv[++i] ?? "");
    else if (argv[i] === "--skill-dir") skillDir = path.resolve(argv[++i] ?? "");
    else {
      log(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }
  const { skillText, references } = readSkillDir(skillDir);
  if (repin) {
    if (skillText === null) {
      log(`FAIL: --repin refused: ${path.join(skillDir, "SKILL.md")} is absent`);
      return 1;
    }
    const pin = buildPin({ skillText, references });
    fs.writeFileSync(oldPath, pin);
    const sha = crypto.createHash("sha256").update(pin).digest("hex");
    log(`repinned ${path.relative(ROOT, oldPath) || oldPath} from SKILL.md + ${Object.keys(references).length} reference file(s): sha256 ${sha}`);
    log("put that sha256 into PINNED_SHA256 in scripts/check-skill-split.test.mjs in the same commit");
  }
  if (!fs.existsSync(oldPath)) {
    log(`FAIL: pinned copy not found: ${oldPath}`);
    return 1;
  }
  const oldText = fs.readFileSync(oldPath, "utf8");
  const r = checkSplit({ oldText, skillText, references });
  const { ok, lines } = formatResult(r, {
    oldLabel: path.relative(ROOT, oldPath) || oldPath,
    skillLabel: path.relative(ROOT, skillDir) || skillDir,
    skillBytes: skillText === null ? 0 : Buffer.byteLength(skillText),
    refBytes: Object.values(references).reduce((n, t) => n + Buffer.byteLength(t), 0),
  });
  for (const l of lines) log(l);
  return ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
