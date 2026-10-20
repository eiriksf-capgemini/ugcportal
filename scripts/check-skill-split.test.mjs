/**
 * Tests for scripts/check-skill-split.mjs (ugcportal-j13u K2, K3).
 *
 * The synthetic cases drive each failure the checker exists to catch; the
 * "real tree" cases are the standing gate over .claude/skills/pr-review-merge,
 * including mutations of a copy of it (a dropped rule sentence, a dropped
 * sentence with no rule word, one dropped copy of a repeated line, an unlinked
 * reference file) that must turn the CLI red and name what broke, and the
 * repin path a deliberate rule change takes.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_OLD, DEFAULT_SKILL_DIR, checkSplit, formatResult, normalize, readSkillDir, splitUnits } from "./check-skill-split.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "check-skill-split.mjs");
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const fmt = (r) => formatResult(r, { oldLabel: "old", skillLabel: "skill", skillBytes: 1, refBytes: 1 });

const OLD = [
  "# Skill",
  "",
  "Intro with no rule word here.",
  "",
  "## 1. Step",
  "",
  "You must run the probe first. Then read its output. Never merge on a red row.",
  "",
  "- a list item that must stay",
  "- another item, which is only a note",
  "",
  "```bash",
  "gh api x || exit 1",
  "echo plain",
  "```",
  "",
  "| Round | Blocks |",
  "|---|---|",
  "| 1 | Any finding, always |",
  "",
  "See [step 2](#2-step) before stamping.",
].join("\n");

// The sha256 of scripts/fixtures/pr-review-merge-SKILL.pre-split.md. Until the
// first repin it is origin/main 8993bb4's pre-split SKILL.md. A PR that changes
// a rule runs `node scripts/check-skill-split.mjs --repin` and puts the sha256
// it prints here, in the same commit (the checker's header says why).
const PINNED_SHA256 = "063c68a4d4b0b5e9c68a84e1cf31c96df2c3f4dfd92676c911e660fbb2f6f275";

const LINKED_SKILL = (body) => `${body}\n\nOpen only when you need the why: [reference/01.md](reference/01.md).\n`;

describe("splitUnits / normalize", () => {
  it("splits sentences, list items, code lines and table rows, each with its line", () => {
    const units = splitUnits(OLD).map((u) => `${u.line}:${u.text}`);
    expect(units).toContain("7:You must run the probe first.");
    expect(units).toContain("7:Never merge on a red row.");
    expect(units).toContain("9:a list item that must stay");
    expect(units).toContain("13:gh api x || exit 1");
    expect(units).toContain("19:| 1 | Any finding, always |");
    expect(units).toContain("21:See [step 2] before stamping.");
  });
  it("collapses whitespace, drops link targets and a leading marker", () => {
    expect(normalize("  - You  must\n   run [it](a.md#x)  ")).toBe("You must run [it]");
  });
});

describe("checkSplit (synthetic)", () => {
  const allMoved = {
    skillText: LINKED_SKILL("# Skill\n\nIntro with no rule word here.\n\n## 1. Step\n\nYou must run the probe first. Then read its output.\n\n```bash\ngh api x || exit 1\necho plain\n```"),
    references: {
      "reference/01.md": [
        "Never merge on a red row.",
        "| Round | Blocks |\n|---|---|",
        "- a list item that must stay",
        "- another item, which is only a note",
        "| 1 | Any finding, always |",
        // re-wrapped, and the link repointed at the checklist's anchor: still a match
        "See [step 2](../SKILL.md#2-step)\n  before stamping.",
      ].join("\n\n"),
    },
  };

  it("passes when every unit moved, re-wrapped or relinked", () => {
    const r = checkSplit({ oldText: OLD, ...allMoved });
    expect(r.checked).toBe(splitUnits(OLD).length);
    expect(r.checked).toBe(15);
    expect(r.missing).toEqual([]);
    expect(r.fewer).toEqual([]);
    expect(r.unlinked).toEqual([]);
    expect(fmt(r).ok).toBe(true);
  });

  it("a dropped rule sentence fails, naming the sentence and its old line", () => {
    const refs = { "reference/01.md": allMoved.references["reference/01.md"].replace("Never merge on a red row.", "") };
    const r = checkSplit({ oldText: OLD, skillText: allMoved.skillText, references: refs });
    expect(r.missing.map((m) => m.text)).toEqual(["Never merge on a red row."]);
    const { ok, lines } = fmt(r);
    expect(ok).toBe(false);
    expect(lines).toContain("  MISSING (old line 7): Never merge on a red row.");
    expect(lines.at(-1)).toBe("FAIL: 1 unit(s) missing");
  });

  it("a dropped unit with no rule word fails too (round 1, L2(a))", () => {
    const skillText = allMoved.skillText.replace("Intro with no rule word here.", "");
    const r = checkSplit({ oldText: OLD, skillText, references: allMoved.references });
    expect(r.missing.map((m) => m.text)).toEqual(["Intro with no rule word here."]);
    expect(fmt(r).lines).toContain("  MISSING (old line 3): Intro with no rule word here.");
  });

  it("one dropped copy of a repeated unit fails as FEWER, with both counts and every old line (round 1, L2(b))", () => {
    const oldText = `${OLD}\n\n\`\`\`bash\ngh api x || exit 1\n\`\`\`\n`;
    const twice = checkSplit({ oldText, skillText: `${allMoved.skillText}\n\`\`\`bash\ngh api x || exit 1\n\`\`\`\n`, references: allMoved.references });
    expect(twice.fewer).toEqual([]);
    const once = checkSplit({ oldText, ...allMoved });
    expect(once.missing).toEqual([]);
    expect(once.fewer.map((m) => [m.text, m.old, m.now])).toEqual([["gh api x || exit 1", 2, 1]]);
    const { ok, lines } = fmt(once);
    expect(ok).toBe(false);
    expect(lines).toContain("  FEWER (old lines 13, 24; old 2, new 1): gh api x || exit 1");
    expect(lines.at(-1)).toBe("FAIL: 1 unit(s) with fewer copies");
  });

  it("a reworded sentence is a miss, not a match", () => {
    const refs = { "reference/01.md": allMoved.references["reference/01.md"].replace("Never merge", "Do not merge") };
    expect(checkSplit({ oldText: OLD, skillText: allMoved.skillText, references: refs }).missing).toHaveLength(1);
  });

  it("an unlinked reference file fails, naming it", () => {
    const refs = { ...allMoved.references, "reference/02.md": "orphan" };
    const r = checkSplit({ oldText: OLD, skillText: allMoved.skillText, references: refs });
    expect(r.unlinked).toEqual(["reference/02.md"]);
    const { ok, lines } = fmt(r);
    expect(ok).toBe(false);
    expect(lines).toContain("  UNLINKED: reference/02.md");
  });

  it("a link not on an 'open only when' line does not count as linked", () => {
    const skillText = allMoved.skillText.replace("Open only when you need the why:", "See");
    expect(checkSplit({ oldText: OLD, skillText, references: allMoved.references }).unlinked).toEqual(["reference/01.md"]);
  });

  it("a link to a reference file that does not exist fails as dangling", () => {
    const skillText = `${allMoved.skillText}Open only when lost: [gone](reference/99.md).\n`;
    const r = checkSplit({ oldText: OLD, skillText, references: allMoved.references });
    expect(r.dangling.map((d) => d.target)).toEqual(["reference/99.md"]);
    expect(fmt(r).ok).toBe(false);
  });

  it("zero units checked fails loud, as does an absent SKILL.md", () => {
    const none = checkSplit({ oldText: "\n\n", skillText: "x", references: {} });
    expect(none.checked).toBe(0);
    expect(fmt(none).lines.at(-1)).toMatch(/^FAIL: zero units checked/);
    const absent = checkSplit({ oldText: OLD, skillText: null, references: {} });
    expect(fmt(absent).ok).toBe(false);
    expect(fmt(absent).lines.at(-1)).toMatch(/SKILL\.md is absent/);
  });
});

describe("the real tree (standing gate)", () => {
  it("the pinned copy is byte for byte the file PINNED_SHA256 names", () => {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(DEFAULT_OLD)).digest("hex");
    expect(sha).toBe(PINNED_SHA256);
  });

  it("checks every unit of the pinned copy, finds each with every copy, and every reference file is linked", () => {
    const r = cli();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const checked = Number(r.stdout.match(/checked: (\d+) unit\(s\)/)?.[1]);
    expect(checked).toBeGreaterThan(1000);
    expect(r.stdout).toContain("missing: 0; fewer copies: 0\n");
    expect(r.stdout).toMatch(/unlinked: 0; dangling links: 0/);
    const { references } = readSkillDir(DEFAULT_SKILL_DIR);
    expect(Object.keys(references).length).toBeGreaterThan(0);
  });

  it("the checklist is under 35,000 bytes (ugcportal-j13u K1)", () => {
    expect(fs.statSync(path.join(DEFAULT_SKILL_DIR, "SKILL.md")).size).toBeLessThan(35000);
  });

  const copyTree = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-split-"));
    fs.cpSync(DEFAULT_SKILL_DIR, dir, { recursive: true });
    return dir;
  };

  it("mutation: deleting one rule sentence from a reference file prints it and exits 1", () => {
    const dir = copyTree();
    const sentence = "**Only a human clears it**, after backfilling every earlier agent id and correcting `tokens_qa`: `bd update <bead-id> --unset-metadata cost_coverage_qa --unset-metadata cost_note_qa`, then re-run.";
    const file = path.join(dir, "reference", "04a-record-qa-cost.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(sentence);
    fs.writeFileSync(file, text.replace(sentence, ""));
    const r = cli("--skill-dir", dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`MISSING (old line 436): ${sentence}`);
    expect(r.stdout).toContain("missing: 1; fewer copies: 0\n");
  });

  // ugcportal-j13u round 1, L2(a): a unit with no rule word is checked too.
  it("mutation: deleting the j3ns sentence (no rule word) from 05-decide prints it and exits 1", () => {
    const dir = copyTree();
    const sentence = "Until `ugcportal-j3ns` changes `.claude/agents/worker-reviewer.md`, a dispatched reviewer applies no inline fix of any kind, neither a commit nor a body or title edit; the orchestrator may.";
    const file = path.join(dir, "reference", "05-decide.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text.split(sentence)).toHaveLength(2);
    fs.writeFileSync(file, text.replace(sentence, ""));
    const r = cli("--skill-dir", dir);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`MISSING (old line 733): ${sentence}`);
  });

  // ugcportal-j13u round 1, L2(b): one copy of a unit that occurs three times is dropped.
  it("mutation: deleting one of three copies of the empty-identity guard reports the count deficit and exits 1", () => {
    const dir = copyTree();
    const guard = '[ -n "$me" ] || { echo "empty reviewer identity — fix auth first" >&2; exit 1; }';
    const file = path.join(dir, "SKILL.md");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const hits = lines.flatMap((l, i) => (l.trim() === guard ? [i] : []));
    expect(hits).toHaveLength(3);
    lines.splice(hits[1], 1);
    fs.writeFileSync(file, lines.join("\n"));
    const r = cli("--skill-dir", dir);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(`FEWER (old lines 501, 834, 890; old 3, new 2): ${guard}`);
  });

  // ugcportal-j13u round 1, L3: a deliberate rewording fails until the pin is regenerated from the new tree.
  it("repin: a reworded sentence fails, --repin rewrites the pin from the tree and prints its sha256, then it passes", () => {
    const dir = copyTree();
    const oldCopy = path.join(dir, "pinned.md");
    fs.copyFileSync(DEFAULT_OLD, oldCopy);
    const file = path.join(dir, "reference", "05-decide.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("a dispatched reviewer applies no inline fix of any kind");
    fs.writeFileSync(file, text.replace("a dispatched reviewer applies no inline fix of any kind", "a dispatched reviewer applies a text-only inline fix"));
    const before = cli("--old", oldCopy, "--skill-dir", dir);
    expect(before.status, before.stdout).toBe(1);
    expect(before.stdout).toContain("MISSING (old line 733): Until `ugcportal-j3ns`");
    const repin = cli("--repin", "--old", oldCopy, "--skill-dir", dir);
    expect(repin.status, repin.stdout + repin.stderr).toBe(0);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(oldCopy)).digest("hex");
    expect(repin.stdout).toContain(`sha256 ${sha}`);
    expect(fs.readFileSync(oldCopy, "utf8")).toContain("a dispatched reviewer applies a text-only inline fix");
    const after = cli("--old", oldCopy, "--skill-dir", dir);
    expect(after.status, after.stdout).toBe(0);
    expect(after.stdout).toMatch(/missing: 0; fewer copies: 0/);
  });

  it("repin: refuses, exits 1 and leaves the pin untouched when SKILL.md is absent", () => {
    const dir = copyTree();
    fs.rmSync(path.join(dir, "SKILL.md"));
    const oldCopy = path.join(dir, "pinned.md");
    fs.writeFileSync(oldCopy, "unchanged\n");
    const r = cli("--repin", "--old", oldCopy, "--skill-dir", dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^FAIL: --repin refused: .*SKILL\.md is absent/m);
    expect(fs.readFileSync(oldCopy, "utf8")).toBe("unchanged\n");
  });

  it("mutation: removing a reference file's links from SKILL.md reports it unlinked and exits 1", () => {
    const dir = copyTree();
    const file = path.join(dir, "SKILL.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("](reference/07-cleanup-sweep.md)");
    fs.writeFileSync(file, text.replaceAll("](reference/07-cleanup-sweep.md)", "]"));
    const r = cli("--skill-dir", dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("  UNLINKED: reference/07-cleanup-sweep.md");
  });
});
