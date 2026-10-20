#!/usr/bin/env node
/**
 * Proves that splitting a skill into a checklist (`SKILL.md`) and reference
 * files (`reference/*.md`) dropped no rule (ugcportal-j13u).
 *
 * Input: the skill's pre-split text, pinned as a fixture, and the skill
 * directory as it stands now. Every sentence of the pinned text that carries
 * a rule word (RULE_WORD below) must appear verbatim in the new `SKILL.md` or
 * in one of its `reference/*.md` files. "Verbatim" is after two
 * normalisations, applied to both sides alike, and nothing else:
 *
 *   - runs of whitespace collapse to one space, so a sentence re-wrapped or
 *     re-indented by the move still matches, and a leading list or quote
 *     marker (`- `, `1. `, `> `) is dropped from the start of a unit;
 *   - a markdown link's target is dropped (`[text](target)` reads as
 *     `[text]`), so a link the move had to repoint (an in-page anchor that now
 *     lives in another file) still matches on its text.
 *
 * A "sentence" is a unit of the pinned text: each non-empty line of a fenced
 * code block, each table row, and otherwise each sentence of a paragraph or
 * list item, split after `.`, `!` or `?` followed by whitespace. Splitting
 * finer than a grammarian would only makes the check stricter in coverage
 * (more, shorter units checked); it cannot make a dropped sentence pass.
 *
 * It also checks the other direction the split could fail in (K3): every
 * `reference/*.md` file is linked from `SKILL.md` at least once, by a markdown
 * link on a line carrying the words "open only when", and no link in
 * `SKILL.md` points at a reference file that does not exist.
 *
 * Fail-loud: exits 1 when any rule sentence is missing, when a reference file
 * is unlinked or a link dangles, when `SKILL.md` is absent, and when zero
 * sentences were checked -- a check that examined nothing must not read as a
 * pass (review-standards section 6). It prints the counts before any verdict.
 *
 * What it does not prove: that a sentence still sits in the step where a
 * reader will look for it, that a new checklist line restates its rule
 * correctly (the reference text is the rule; SKILL.md says so), or anything
 * about sentences with no rule word.
 *
 * Usage: node scripts/check-skill-split.mjs [--old <file>] [--skill-dir <dir>]
 * Defaults: the pinned pr-review-merge copy and .claude/skills/pr-review-merge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OLD = path.join(ROOT, "scripts", "fixtures", "pr-review-merge-SKILL.pre-split.md");
export const DEFAULT_SKILL_DIR = path.join(ROOT, ".claude", "skills", "pr-review-merge");

/** The rule words of ugcportal-j13u's In scope (c), matched as word prefixes ("stops", "recorded"). */
export const RULE_WORD = /\b(never|always|must|only|stop|fail|exit|before|after|exactly|record)/i;

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

/**
 * @param {{oldText: string, skillText: string|null, references: Record<string, string>}} input
 *   references is keyed by path relative to the skill directory ("reference/x.md").
 */
export function checkSplit({ oldText, skillText, references }) {
  const units = splitUnits(oldText);
  const ruled = units.filter((u) => RULE_WORD.test(u.text));
  const refNames = Object.keys(references).sort();
  const corpus = normalize([skillText ?? "", ...refNames.map((n) => references[n])].join("\n\n"));
  const missing = skillText === null ? [] : ruled.filter((u) => !corpus.includes(u.text));
  const links = skillText === null ? [] : referenceLinks(skillText);
  const unlinked = refNames.filter((n) => !links.some((l) => l.target === n && l.openOnlyWhen));
  const dangling = links.filter((l) => !(l.target in references));
  return {
    units: units.length,
    checked: skillText === null ? 0 : ruled.length,
    missing,
    references: refNames,
    unlinked,
    dangling,
    skillMissing: skillText === null,
  };
}

export function formatResult(r, { oldLabel, skillLabel, skillBytes, refBytes }) {
  const lines = [
    `check-skill-split: old ${oldLabel}: ${r.units} sentence(s), of which ${r.checked} carry a rule word`,
    `new: ${skillLabel}/SKILL.md (${r.skillMissing ? "ABSENT" : `${skillBytes} bytes`}) + ${r.references.length} reference file(s) (${refBytes} bytes)`,
    `checked: ${r.checked} rule sentence(s); found: ${r.checked - r.missing.length}; missing: ${r.missing.length}`,
  ];
  for (const m of r.missing) lines.push(`  MISSING (old line ${m.line}): ${m.text}`);
  const linked = r.references.length - r.unlinked.length;
  lines.push(`reference files: ${r.references.length}; linked from SKILL.md on an "open only when" line: ${linked}; unlinked: ${r.unlinked.length}; dangling links: ${r.dangling.length}`);
  for (const u of r.unlinked) lines.push(`  UNLINKED: ${u}`);
  for (const d of r.dangling) lines.push(`  DANGLING (SKILL.md line ${d.line}): ${d.target}`);
  const reasons = [];
  if (r.skillMissing) reasons.push("SKILL.md is absent");
  if (r.checked === 0) reasons.push("zero rule sentences checked -- a check that examined nothing is not a pass");
  if (r.missing.length) reasons.push(`${r.missing.length} rule sentence(s) missing`);
  if (r.unlinked.length) reasons.push(`${r.unlinked.length} reference file(s) unlinked`);
  if (r.dangling.length) reasons.push(`${r.dangling.length} dangling link(s)`);
  lines.push(reasons.length ? `FAIL: ${reasons.join("; ")}` : "OK: every rule sentence found, every reference file linked");
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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--old") oldPath = path.resolve(argv[++i] ?? "");
    else if (argv[i] === "--skill-dir") skillDir = path.resolve(argv[++i] ?? "");
    else {
      log(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }
  if (!fs.existsSync(oldPath)) {
    log(`FAIL: pinned pre-split copy not found: ${oldPath}`);
    return 1;
  }
  const oldText = fs.readFileSync(oldPath, "utf8");
  const { skillText, references } = readSkillDir(skillDir);
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
