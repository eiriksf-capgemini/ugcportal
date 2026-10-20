/**
 * Tests for scripts/check-skill-split.mjs (ugcportal-j13u K2, K3).
 *
 * The synthetic cases drive each failure the checker exists to catch; the
 * "real tree" cases are the standing gate over .claude/skills/pr-review-merge,
 * including two mutations of a copy of it (a dropped rule sentence, an
 * unlinked reference file) that must turn the CLI red and name what broke.
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
    skillText: LINKED_SKILL("You must run the probe first. Then read its output.\n\n```bash\ngh api x || exit 1\n```"),
    references: {
      "reference/01.md": [
        "Never merge on a red row.",
        "- a list item that must stay",
        "- another item, which is only a note",
        "| 1 | Any finding, always |",
        // re-wrapped, and the link repointed at the checklist's anchor: still a match
        "See [step 2](../SKILL.md#2-step)\n  before stamping.",
      ].join("\n\n"),
    },
  };

  it("passes when every rule sentence moved, re-wrapped or relinked", () => {
    const r = checkSplit({ oldText: OLD, ...allMoved });
    expect(r.checked).toBe(7);
    expect(r.missing).toEqual([]);
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
    expect(lines.at(-1)).toBe("FAIL: 1 rule sentence(s) missing");
  });

  it("a reworded rule sentence is a miss, not a match", () => {
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

  it("zero rule sentences checked fails loud, as does an absent SKILL.md", () => {
    const none = checkSplit({ oldText: "Nothing to see here.\n", skillText: "x", references: {} });
    expect(none.checked).toBe(0);
    expect(fmt(none).lines.at(-1)).toMatch(/^FAIL: zero rule sentences checked/);
    const absent = checkSplit({ oldText: OLD, skillText: null, references: {} });
    expect(fmt(absent).ok).toBe(false);
    expect(fmt(absent).lines.at(-1)).toMatch(/SKILL\.md is absent/);
  });
});

describe("the real tree (standing gate)", () => {
  it("the pinned pre-split copy is the origin/main 8993bb4 file, byte for byte", () => {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(DEFAULT_OLD)).digest("hex");
    expect(sha).toBe("063c68a4d4b0b5e9c68a84e1cf31c96df2c3f4dfd92676c911e660fbb2f6f275");
  });

  it("checks several hundred rule sentences, finds all, and every reference file is linked", () => {
    const r = cli();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const checked = Number(r.stdout.match(/checked: (\d+) rule sentence/)?.[1]);
    expect(checked).toBeGreaterThan(300);
    expect(r.stdout).toContain("missing: 0");
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
    expect(r.stdout).toContain("missing: 1");
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
