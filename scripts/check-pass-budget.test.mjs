import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkPassBudget, CLEAN_FINDINGS, formatVerdict, main } from "./check-pass-budget.mjs";

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

  it("reads findings_pr<n>_r<N> keys: a clean round on the latest PR exempts", () => {
    const stop = checkPassBudget(bead({ tokens_impl_passes: 4, tokens_impl_passes_pr11: 3, findings_pr10_r1: DIRTY, findings_pr11_r1: DIRTY }));
    expect([stop.verdict, stop.passesKey]).toEqual(["STOP", "tokens_impl_passes_pr11"]);
    expect(stop.rounds.map((x) => [x.key, x.counted])).toEqual([
      ["findings_pr10_r1", false],
      ["findings_pr11_r1", true],
    ]);
    const ok = checkPassBudget(
      bead({ tokens_impl_passes: 4, tokens_impl_passes_pr11: 3, prs: "gh-10,gh-11", findings_pr10_r1: DIRTY, findings_pr11_r1: CLEAN_FINDINGS }),
    );
    expect([ok.verdict, ok.exit]).toEqual(["PROCEED", 0]);
    expect(ok.message).toContain("(findings_pr11_r1)");
  });

  it("M1 r1: a clean round on an earlier PR does not exempt the latest (the cii0 shape)", () => {
    const cii0 = {
      tokens_impl_passes: 6,
      tokens_impl_passes_pr262: 4,
      prs: "gh-261,gh-262",
      findings_pr261_r1: DIRTY,
      findings_pr261_r2: CLEAN_FINDINGS,
      findings_pr262_r1: DIRTY,
      findings_pr262_r2: DIRTY,
      findings_pr262_r3: DIRTY,
      findings_pr262_r4: DIRTY,
    };
    const r = checkPassBudget(bead(cii0));
    expect([r.verdict, r.exit, r.passes]).toEqual(["STOP", 1, 4]);
    expect(r.message).toContain("findings_pr262_r4=");
    expect(r.message).not.toContain("findings_pr261_r2");
    // the latest PR comes from the PR numbers, not key order or prs order alone:
    // an in-review PR not yet in prs is still the latest
    const inFlight = { ...cii0, prs: "gh-261" };
    expect(checkPassBudget(bead(inFlight)).verdict).toBe("STOP");
    // a prs entry newer than every findings key means that PR has no round yet
    const newer = { tokens_impl_passes: 5, tokens_impl_passes_pr270: 3, prs: "gh-261,gh-270", findings_pr261_r1: DIRTY, findings_pr261_r2: CLEAN_FINDINGS };
    const n = checkPassBudget(bead(newer));
    expect(n.verdict).toBe("STOP");
    expect(n.message).toContain("no findings_pr270_r<N> key");
    expect(checkPassBudget(bead({ ...newer, tokens_impl_passes_pr270: 1 })).verdict).toBe("PROCEED");
  });

  it("M1 r2: a multi-PR bead without the latest PR's own count is UNKNOWN, never PROCEED or STOP", () => {
    const cases = [
      // the cii0 shape with only the bead-wide count
      { tokens_impl_passes: 6, prs: "gh-261,gh-262", findings_pr261_r2: CLEAN_FINDINGS, findings_pr262_r1: DIRTY },
      // the latest PR is in prs only, and the keys name an earlier one
      { tokens_impl_passes: 4, prs: "gh-261,gh-270", findings_pr261_r1: DIRTY },
      // two PRs in prs and no findings keys at all (the dabx shape)
      { tokens_impl_passes: 3, prs: "gh-227,gh-267" },
      // two PRs named only by their keys
      { tokens_impl_passes: 3, findings_pr10_r1: DIRTY, findings_pr11_r1: DIRTY },
    ];
    for (const metadata of cases) {
      const r = checkPassBudget(bead(metadata));
      expect([r.verdict, r.exit, r.passes]).toEqual(["UNKNOWN", 2, null]);
      expect(r.message).toContain("The bead spans PRs #");
      expect(r.message).toContain("cannot be attributed to the latest PR");
      expect(r.message).toMatch(/--set-metadata tokens_impl_passes_pr\d+=<n>/);
    }
    // a per-PR count that is not a whole number is no better than none
    expect(checkPassBudget(bead({ ...cases[0], tokens_impl_passes_pr262: "two" })).verdict).toBe("UNKNOWN");
  });

  it("M1 r2(a): the false-STOP shape is UNKNOWN without the per-PR count and PROCEED with it", () => {
    const shape = {
      tokens_impl_passes: "3",
      prs: "gh-261,gh-262",
      findings_pr261_r1: DIRTY,
      findings_pr261_r2: CLEAN_FINDINGS,
      findings_pr262_r1: DIRTY,
    };
    const without = checkPassBudget(bead(shape));
    expect([without.verdict, without.exit]).toEqual(["UNKNOWN", 2]);
    expect(without.message).toContain("#261, #262");
    const withCount = checkPassBudget(bead({ ...shape, tokens_impl_passes_pr262: "1" }));
    expect([withCount.verdict, withCount.exit, withCount.passes, withCount.passesKey]).toEqual(["PROCEED", 0, 1, "tokens_impl_passes_pr262"]);
  });

  it("M1 r2(b): the stale-count shape is UNKNOWN, never PROCEED", () => {
    const stale = {
      tokens_impl_passes: "2",
      prs: "gh-1,gh-2",
      findings_pr1_r1: DIRTY,
      findings_pr1_r2: DIRTY,
      findings_pr1_r3: CLEAN_FINDINGS,
      findings_pr2_r1: DIRTY,
      findings_pr2_r2: DIRTY,
    };
    expect(checkPassBudget(bead(stale)).verdict).toBe("UNKNOWN");
    // a per-PR count above the bead-wide one says one of them is wrong
    const above = checkPassBudget(bead({ ...stale, tokens_impl_passes_pr2: "3" }));
    expect([above.verdict, above.exit]).toEqual(["UNKNOWN", 2]);
    expect(above.message).toContain("above the bead-wide tokens_impl_passes of 2");
    // a per-PR count below the latest PR's own rounds is the single-PR cross-check
    const lag = checkPassBudget(bead({ ...stale, tokens_impl_passes: "5", tokens_impl_passes_pr2: "1" }));
    expect([lag.verdict, lag.roundsRecorded]).toEqual(["UNKNOWN", 2]);
    expect(lag.message).toContain("tokens_impl_passes_pr2 is 1 but 2 review round(s) are recorded");
    // and with honest counts the latest PR's rounds decide
    expect(checkPassBudget(bead({ ...stale, tokens_impl_passes: "5", tokens_impl_passes_pr2: "2" })).verdict).toBe("PROCEED");
    expect(checkPassBudget(bead({ ...stale, tokens_impl_passes: "6", tokens_impl_passes_pr2: "3" })).verdict).toBe("STOP");
  });

  it("M1: a clean earlier round of the same PR still exempts", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 4, findings_pr5_r1: DIRTY, findings_pr5_r2: CLEAN_FINDINGS, findings_pr5_r3: DIRTY }));
    expect(r.verdict).toBe("PROCEED");
  });

  it("M1: bare and findings_pr keys together are a recording error, and nothing counts as clean", () => {
    const r = checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: CLEAN_FINDINGS, findings_pr7_r1: CLEAN_FINDINGS }));
    expect([r.verdict, r.exit]).toEqual(["STOP", 1]);
    expect(r.message).toContain("recording error");
    expect(r.message).toContain("findings_r1");
  });

  it("M1: bare keys on a bead whose prs lists two PRs are refused, even with a per-PR count", () => {
    const multi = { tokens_impl_passes: 3, prs: "gh-1,gh-2", findings_r1: DIRTY, findings_r2: CLEAN_FINDINGS };
    for (const metadata of [multi, { ...multi, tokens_impl_passes_pr2: 1 }]) {
      const r = checkPassBudget(bead(metadata));
      expect([r.verdict, r.exit]).toEqual(["UNKNOWN", 2]);
      expect(r.message).toContain("bare findings_r1, findings_r2 cannot be tied to a PR");
    }
    // the same keys on a one-PR bead do exempt
    expect(checkPassBudget(bead({ tokens_impl_passes: 3, prs: "gh-2", findings_r1: DIRTY, findings_r2: CLEAN_FINDINGS })).verdict).toBe("PROCEED");
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
    // on a multi-PR bead the bead-wide count is not cross-checked against one
    // PR's rounds at all: without the latest PR's own count it is UNKNOWN
    // (M1 of round 2; this case read PROCEED before)
    expect(checkPassBudget(bead({ tokens_impl_passes: 2, findings_pr1_r5: DIRTY, findings_pr2_r1: DIRTY })).verdict).toBe("UNKNOWN");
    expect(checkPassBudget(bead({ tokens_impl_passes: 6, tokens_impl_passes_pr2: 1, findings_pr1_r5: DIRTY, findings_pr2_r1: DIRTY })).verdict).toBe(
      "PROCEED",
    );
  });

  it("does not count an unparseable or near-miss findings value as clean", () => {
    for (const v of ["clean", "f1:0 f2:0 f3:0 f4:0 med:0 low:00", "f1:0 f2:0 f3:0 f4:0 med:0", ""]) {
      expect(checkPassBudget(bead({ tokens_impl_passes: 3, findings_r1: v })).verdict).toBe("STOP");
    }
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
