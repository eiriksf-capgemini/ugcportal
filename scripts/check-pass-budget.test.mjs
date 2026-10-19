import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkPassBudget, CLEAN_FINDINGS, formatVerdict, main, MULTI_PR_OWNER, parsePrs } from "./check-pass-budget.mjs";
import { parseFindingsKey } from "./release-cost-report.mjs";

const DIRTY = "f1:1 f2:0 f3:0 f4:0 med:0 low:1";
const bead = (metadata) => ({ id: "ugcportal-fix", metadata });

describe("checkPassBudget", () => {
  it("proceeds under the limit", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 2, findings_r1: DIRTY }));
    expect([r.verdict, r.exit, r.passes]).toEqual(["PROCEED", 0, 2]);
  });

  it("stops at three passes with no clean round, naming passes and rounds", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: DIRTY, findings_r2: DIRTY }));
    expect([r.verdict, r.exit, r.passes]).toEqual(["STOP", 1, 3]);
    expect(r.message).toContain("3 implementation passes");
    expect(r.message).toContain(`findings_r1=${DIRTY}`);
    expect(r.message).toContain("findings_r2=");
  });

  it("stops at three passes with no findings recorded at all", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 3 }));
    expect(r.verdict).toBe("STOP");
    expect(r.message).toContain("none recorded");
  });

  it("proceeds with a note at three or more passes when a round was clean", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 4, findings_r1: DIRTY, findings_r2: CLEAN_FINDINGS }));
    expect([r.verdict, r.exit]).toEqual(["PROCEED", 0]);
    expect(r.message).toContain("clean round was recorded (findings_r2)");
  });

  it("names ugcportal-8zcj as the owner of the multi-PR case", () => {
    expect(MULTI_PR_OWNER).toBe("ugcportal-8zcj");
  });

  // Narrowed at PR #296 round 3: every multi-PR signal is UNKNOWN naming the
  // owner bead, whatever the bead-wide count and rounds would have said. Each
  // fixture below gives STOP (dirty rounds) or PROCEED (a clean round) on the
  // single-PR path, so a signal that fell through to it would change the verdict.
  const signalCases = [
    ["two prs entries", { prs: "gh-261,gh-262" }, "prs lists 2 PRs (#261, #262)"],
    ["a findings_pr key", { findings_pr262_r1: DIRTY }, "per-PR findings key(s) findings_pr262_r1"],
    ["a tokens_impl_passes_pr key", { tokens_impl_passes_pr262: 1 }, "per-PR pass count key(s) tokens_impl_passes_pr262"],
    ["an unparseable prs entry (semicolon)", { prs: "gh-261;gh-262" }, 'entry that do not parse ("gh-261;gh-262")'],
    ["an unparseable prs entry (space)", { prs: "gh-261 gh-262" }, 'entry that do not parse ("gh-261 gh-262")'],
    ["one parsed and one unparseable prs entry", { prs: "gh-261, pr262" }, '"pr262"'],
  ];
  for (const [name, signal, needle] of signalCases) {
    it(`multi-PR signal, ${name}: UNKNOWN naming the signal and the owner bead`, () => {
      for (const rounds of [
        { findings_r1: DIRTY, findings_r2: DIRTY, findings_r3: DIRTY },
        { findings_r1: DIRTY, findings_r2: CLEAN_FINDINGS },
      ]) {
        const single = checkPassBudget(bead({ tokens_impl_passes: 4, ...rounds }));
        expect(single.verdict).not.toBe("UNKNOWN");
        const r = checkPassBudget(bead({ tokens_impl_passes: 4, ...rounds, ...signal }));
        expect([r.verdict, r.exit, r.passes]).toEqual(["UNKNOWN", 2, null]);
        expect(r.message).toContain("applies to single-PR beads only");
        expect(r.message).toContain(needle);
        expect(r.message).toContain(MULTI_PR_OWNER);
        expect(r.rounds.every((x) => !x.counted)).toBe(true);
      }
    });
  }

  it("multi-PR: every signal present is named, and an absent count does not hide them", () => {
    const r = checkPassBudget(bead({ prs: "gh-1,gh-2;x", findings_pr2_r1: DIRTY, tokens_impl_passes_pr2: 1 }));
    expect([r.verdict, r.exit]).toEqual(["UNKNOWN", 2]);
    expect(r.message).toContain('"gh-2;x"');
    expect(r.message).toContain("findings_pr2_r1");
    expect(r.message).toContain("tokens_impl_passes_pr2");
    expect(r.message).not.toContain("prs lists");
  });

  it("a single-PR bead with prs set, or the same PR listed twice, is not multi-PR", () => {
    expect(checkPassBudget(bead({ tokens_impl_passes: 3, prs: "gh-2", findings_r1: DIRTY, findings_r2: CLEAN_FINDINGS })).verdict).toBe("PROCEED");
    expect(checkPassBudget(bead({ tokens_impl_passes: 3, prs: "gh-2,#2,", findings_r1: DIRTY })).verdict).toBe("STOP");
  });

  it("parsePrs lists the gh-<n>, #<n> and <n> forms and reports the rest", () => {
    expect(parsePrs("gh-261,#262, 263,")).toEqual({ listed: [261, 262, 263], unparsed: [] });
    expect(parsePrs("gh-261;gh-262")).toEqual({ listed: [], unparsed: ["gh-261;gh-262"] });
    expect(parsePrs(undefined)).toEqual({ listed: [], unparsed: [] });
  });

  it("M2: a count below the recorded rounds is UNKNOWN, naming both figures", () => {
    const three = { findings_r1: DIRTY, findings_r2: DIRTY, findings_r3: DIRTY };
    for (const passes of ["0", "1"]) {
      const r = checkPassBudget(bead({ tokens_impl_passes: passes, ...three }));
      expect([r.verdict, r.exit, r.passes]).toEqual(["UNKNOWN", 2, Number(passes)]);
      expect(r.message).toContain(`tokens_impl_passes is ${passes} but 3 review round(s) are recorded`);
      expect(r.message).toContain("lags");
      // L1 of round 2: a round with no pass behind it is possible, so the
      // message asks for a check, never for the count to be raised to match
      expect(r.message).toContain("Confirm the count or record the update round");
      expect(r.message).toContain("BEHIND update-branch round");
      expect(r.message).toContain("Never raise the count above the passes made");
    }
    expect(checkPassBudget(bead({ tokens_impl_passes: "4", ...three })).verdict).toBe("STOP");
    expect(checkPassBudget(bead({ tokens_impl_passes: "4", ...three, findings_r4: CLEAN_FINDINGS })).verdict).toBe("PROCEED");
    // a clean round does not rescue a stale count
    expect(checkPassBudget(bead({ tokens_impl_passes: "2", ...three, findings_r3: CLEAN_FINDINGS })).verdict).toBe("UNKNOWN");
  });

  it("M2: the cross-check uses the highest round number, and findings_unstamped adds one", () => {
    expect(checkPassBudget(bead({ tokens_impl_passes: 2, findings_r3: DIRTY })).verdict).toBe("UNKNOWN");
    const u = checkPassBudget(bead({ tokens_impl_passes: 2, findings_r1: DIRTY, findings_r2: DIRTY, findings_unstamped: DIRTY }));
    expect([u.verdict, u.roundsRecorded]).toEqual(["UNKNOWN", 3]);
    expect(u.message).toContain("plus 1 for findings_unstamped");
    // findings_unstamped is never a clean round
    expect(checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: DIRTY, findings_unstamped: CLEAN_FINDINGS })).verdict).toBe("STOP");
  });

  it("does not count an unparseable or near-miss findings value as clean", () => {
    for (const v of ["clean", "f1:0 f2:0 f3:0 f4:0 med:0 low:00", "f1:0 f2:0 f3:0 f4:0 med:0", ""]) {
      expect(checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: v })).verdict).toBe("STOP");
    }
  });

  // ugcportal-kwxh: from round 2 a round whose only findings are lows merges with the lows
  // filed as beads; pr-review-merge step 4a item 5 records it with a trailing ` merged:lows-filed`.
  const MERGED_LOWS = "f1:1 f2:0 f3:0 f4:0 med:0 low:1 merged:lows-filed";

  it("K3 (kwxh): three passes and a round that merged with its lows filed print PROCEED, naming that round clean", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: DIRTY, findings_r2: MERGED_LOWS }));
    expect([r.verdict, r.exit]).toEqual(["PROCEED", 0]);
    expect(r.message).toContain("clean round was recorded (findings_r2)");
  });

  it("K3 (kwxh): three passes and only low-only rounds that did not merge still print STOP", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: DIRTY, findings_r2: DIRTY, findings_r3: "f1:2 f2:0 f3:0 f4:0 med:0 low:2" }));
    expect([r.verdict, r.exit]).toEqual(["STOP", 1]);
  });

  it("K3 (kwxh): a merged:lows-filed tag on a round with a medium, an unstated finding or no low is not clean", () => {
    for (const v of [
      "f1:1 f2:0 f3:0 f4:0 med:1 low:1 merged:lows-filed",
      "f1:1 f2:0 f3:0 f4:0 med:0 low:1 unstated:1 merged:lows-filed",
      "f1:0 f2:0 f3:0 f4:0 med:0 low:0 merged:lows-filed",
      "f1:1 f2:0 f3:0 f4:0 med:0 low:1 merged:lows",
      "f1:1 f2:0 f3:0 f4:0 med:0 low:1 merged:lows-filed extra",
    ]) {
      expect(checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: v })).verdict, v).toBe("STOP");
    }
  });

  it("K3 (kwxh): every value the budget reads as a merged round parses in release-cost-report", () => {
    const k = parseFindingsKey(MERGED_LOWS);
    expect(k).toMatchObject({ med: 0, low: 1, unstated: 0, mergedLowsFiled: true });
  });

  it("tolerates extra whitespace in a clean string", () => {
    expect(checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: `  ${CLEAN_FINDINGS.replace(/ /g, "  ")} ` })).verdict).toBe("PROCEED");
  });

  it("K3: an absent tokens_impl_passes is UNKNOWN, exit 2, never PROCEED", () => {
    const withField = { tokens_impl_passes: 5, findings_r1: DIRTY };
    expect(checkPassBudget(bead(withField)).verdict).toBe("STOP");
    const mutated = { ...withField };
    delete mutated.tokens_impl_passes;
    const r = checkPassBudget(bead(mutated));
    expect([r.verdict, r.exit, r.passes]).toEqual(["UNKNOWN", 2, null]);
    expect(r.message).toContain("absent");
    expect(r.message).toContain("--set-metadata tokens_impl_passes=<n>");
  });

  it("K3: empty, whitespace, null and non-numeric values are UNKNOWN", () => {
    for (const v of ["", "  ", null, "three", "3x", "-1", "2.5", "NaN", {}, []]) {
      const r = checkPassBudget(bead({ tokens_impl_passes: v }));
      expect([r.verdict, r.exit]).toEqual(["UNKNOWN", 2]);
    }
  });

  it("K3: a bead with no metadata at all is UNKNOWN", () => {
    expect(checkPassBudget({ id: "x" }).exit).toBe(2);
    expect(checkPassBudget({ id: "x", metadata: null }).exit).toBe(2);
  });

  it("accepts a numeric string, which is how bd may return it", () => {
    expect(checkPassBudget(bead({ tokens_impl_passes: "3" })).verdict).toBe("STOP");
  });

  it("reports how many keys it examined", () => {
    const b = bead({ tokens_impl_passes: 3, model: "opus", findings_r1: DIRTY });
    const r = checkPassBudget(b);
    expect(r.keysExamined).toBe(3);
    expect(formatVerdict(b, r)).toContain("Examined 3 metadata key(s), 1 of them findings keys, 1 counted toward the budget.");
  });
});

describe("CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pass-budget-"));
  const file = path.join(dir, "beads.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      bead({ tokens_impl_passes: 3, findings_r1: DIRTY }),
      { id: "ugcportal-nofield", metadata: { findings_r1: DIRTY } },
    ]),
  );
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "check-pass-budget.mjs");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("exits 1 on STOP and prints the verdict", () => {
    const r = run("ugcportal-fix", "--beads", file);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("STOP ugcportal-fix");
  });

  it("exits 2 when the field is removed from the fixture", () => {
    const r = run("ugcportal-nofield", "--beads", file);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("UNKNOWN");
  });

  it("exits 2 on an unreadable file, a missing id and no arguments", () => {
    expect(run("ugcportal-fix", "--beads", path.join(dir, "missing.json")).status).toBe(2);
    expect(run("ugcportal-absent", "--beads", file).status).toBe(2);
    expect(run().status).toBe(2);
    expect(run("ugcportal-fix", "--beads").status).toBe(2);
  });

  it("prints bd's stderr once when bd show fails", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pass-budget-bin-"));
    fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\necho 'no issue found: ugcportal-nosuch' >&2\nexit 1\n", { mode: 0o755 });
    const r = spawnSync(process.execPath, [script, "ugcportal-nosuch"], { encoding: "utf8", env: { ...process.env, PATH: bin } });
    expect(r.status).toBe(2);
    expect(r.stderr.split("no issue found: ugcportal-nosuch").length - 1).toBe(1);
    expect(r.stderr).toContain("bd show ugcportal-nosuch exited 1");
  });

  it("exits 2 with the spawn error when bd is not on PATH", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pass-budget-nobd-"));
    const r = spawnSync(process.execPath, [script, "ugcportal-any"], { encoding: "utf8", env: { ...process.env, PATH: empty } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot read bead ugcportal-any");
    expect(r.stderr).toContain("ENOENT");
  });

  it("exits 2 when bd show succeeds but returns no bead", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pass-budget-bin-"));
    fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\necho '[]'\nexit 0\n", { mode: 0o755 });
    const r = spawnSync(process.execPath, [script, "ugcportal-empty"], { encoding: "utf8", env: { ...process.env, PATH: bin } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("bd show ugcportal-empty returned no bead");
  });

  it("main returns the exit code without exiting the process", () => {
    const lines = [];
    expect(main(["ugcportal-fix", "--beads", file], (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("STOP");
  });
});
