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

  it("reads findings_pr<n>_r<N> keys too", () => {
    const stop = checkPassBudget(bead({ tokens_impl_passes: 3, findings_pr10_r1: DIRTY, findings_pr11_r1: DIRTY }));
    expect(stop.verdict).toBe("STOP");
    expect(stop.rounds.map((x) => x.key)).toEqual(["findings_pr10_r1", "findings_pr11_r1"]);
    const ok = checkPassBudget(bead({ tokens_impl_passes: 3, findings_pr10_r1: DIRTY, findings_pr11_r1: CLEAN_FINDINGS }));
    expect(ok.verdict).toBe("PROCEED");
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
    expect(formatVerdict(b, r)).toContain("Examined 3 metadata key(s), 1 of them findings keys.");
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

  it("main returns the exit code without exiting the process", () => {
    const lines = [];
    expect(main(["ugcportal-fix", "--beads", file], (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("STOP");
  });
});
