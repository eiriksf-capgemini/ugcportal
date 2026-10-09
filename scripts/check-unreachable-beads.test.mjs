/**
 * Tests for the unreachable-bead gate check (ugcportal-z4nh).
 *
 * All graph-logic tests run against hand-built fixture objects, following
 * the scripts/sweep-merged-branches.mjs / scripts/sweep-candidates.mjs
 * convention of exercising the exported pure functions directly rather than
 * a real `bd` database -- this check must never mutate (or even touch) the
 * live beads database (constraint in ugcportal-z4nh), so its tests cannot
 * either. The CLI end-to-end block below still runs the real script, but
 * points it at a fixture file via `--beads`, never at live `bd`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildBeadIndex,
  canReach,
  directBlockers,
  explainStuckPaths,
  findUnreachableBeads,
  formatReport,
} from "./check-unreachable-beads.mjs";

const SCRIPT = fileURLToPath(new URL("./check-unreachable-beads.mjs", import.meta.url));

function bead(id, status, blockedBy = [], extra = {}) {
  return {
    id,
    title: `title of ${id}`,
    status,
    dependencies: blockedBy.map((target) => ({
      issue_id: id,
      depends_on_id: target,
      type: "blocks",
      created_at: "2026-01-01T00:00:00Z",
    })),
    ...extra,
  };
}

describe("directBlockers", () => {
  it("only counts hard `blocks` edges, not discovered-from/parent-child/related", () => {
    const b = {
      id: "x",
      dependencies: [
        { depends_on_id: "a", type: "blocks" },
        { depends_on_id: "b", type: "discovered-from" },
        { depends_on_id: "c", type: "parent-child" },
        { depends_on_id: "d", type: "related" },
        { depends_on_id: "e", type: "relates-to" },
        { depends_on_id: "f", type: "supersedes" },
      ],
    };
    expect(directBlockers(b)).toEqual(["a"]);
  });

  it("returns an empty array for a bead with no dependencies field", () => {
    expect(directBlockers({ id: "x" })).toEqual([]);
  });
});

describe("canReach", () => {
  it("a closed bead always resolves", () => {
    const beads = [bead("c1", "closed")];
    expect(canReach("c1", buildBeadIndex(beads))).toBe(true);
  });

  it("a deferred bead never resolves, regardless of its own blockers", () => {
    const beads = [bead("d1", "deferred")];
    expect(canReach("d1", buildBeadIndex(beads))).toBe(false);
  });

  it("a missing id never resolves", () => {
    expect(canReach("ghost", buildBeadIndex([]))).toBe(false);
  });

  it("an open bead with no blockers resolves (it is ready now)", () => {
    const beads = [bead("r1", "open")];
    expect(canReach("r1", buildBeadIndex(beads))).toBe(true);
  });

  it("an open bead blocked by a closed bead resolves", () => {
    const beads = [bead("a", "open", ["b"]), bead("b", "closed")];
    expect(canReach("a", buildBeadIndex(beads))).toBe(true);
  });

  it("an open bead blocked by a deferred bead does not resolve", () => {
    const beads = [bead("a", "open", ["b"]), bead("b", "deferred")];
    expect(canReach("a", buildBeadIndex(beads))).toBe(false);
  });

  it("one dead blocker dooms the bead even with other closed blockers (ugcportal-5x8 shape)", () => {
    const beads = [
      bead("a", "open", ["closed1", "closed2", "dead"]),
      bead("closed1", "closed"),
      bead("closed2", "closed"),
      bead("dead", "deferred"),
    ];
    expect(canReach("a", buildBeadIndex(beads))).toBe(false);
  });

  it("transitively unreachable through an open intermediate bead", () => {
    const beads = [bead("a", "open", ["b"]), bead("b", "open", ["c"]), bead("c", "deferred")];
    expect(canReach("a", buildBeadIndex(beads))).toBe(false);
  });

  it("a dependency cycle is treated as resolvable rather than flagged (cycle detection is bd's job)", () => {
    const beads = [bead("a", "open", ["b"]), bead("b", "open", ["a"])];
    expect(canReach("a", buildBeadIndex(beads))).toBe(true);
  });
});

describe("findUnreachableBeads (K1)", () => {
  // Given a bead blocked only by deferred beads, one normally-blocked bead,
  // and one ready bead, exactly the first is reported.
  const beads = [
    bead("stuck", "open", ["deferred-blocker"]),
    bead("deferred-blocker", "deferred"),
    bead("normal", "open", ["in-flight"]),
    bead("in-flight", "in_progress"),
    bead("ready", "open"),
  ];

  it("reports exactly the bead blocked only by deferred beads", () => {
    const result = findUnreachableBeads(beads);
    expect(result.flagged.map((f) => f.id)).toEqual(["stuck"]);
  });

  it("names the deferred blocker in the stuck path", () => {
    const result = findUnreachableBeads(beads);
    const [stuck] = result.flagged;
    expect(stuck.paths).toEqual([[{ id: "deferred-blocker", status: "deferred", title: "title of deferred-blocker", deferUntil: null }]]);
  });

  it("does not report the normally-blocked or ready beads", () => {
    const result = findUnreachableBeads(beads);
    const ids = result.flagged.map((f) => f.id);
    expect(ids).not.toContain("normal");
    expect(ids).not.toContain("ready");
  });
});

describe("findUnreachableBeads (K3): examined count guards an empty report", () => {
  it("reports examinedCount alongside flagged, so an empty flagged list is distinguishable from an unexamined graph", () => {
    const beads = [bead("ready", "open"), bead("done", "closed")];
    const result = findUnreachableBeads(beads);
    expect(result.examinedCount).toBe(1); // "done" is closed, excluded from examination
    expect(result.flagged).toEqual([]);
  });

  it("mutating the fixture to defer a blocker of a previously-ready bead raises the flagged count", () => {
    const before = [bead("a", "open", ["b"]), bead("b", "open")];
    const beforeResult = findUnreachableBeads(before);
    expect(beforeResult.examinedCount).toBe(2);
    expect(beforeResult.flagged).toEqual([]);

    const after = [bead("a", "open", ["b"]), bead("b", "deferred")];
    const afterResult = findUnreachableBeads(after);
    // "b" itself is now deferred, so it drops out of examination (deferred
    // beads are not themselves candidates -- see TERMINAL_STATUSES); only
    // "a" remains examined, and it is now flagged.
    expect(afterResult.examinedCount).toBe(1);
    expect(afterResult.flagged.map((f) => f.id)).toEqual(["a"]);
    expect(afterResult.flagged.length).toBeGreaterThan(beforeResult.flagged.length);
  });
});

describe("findUnreachableBeads: dangling reference vs deferred (two real audit shapes)", () => {
  it("flags a bead whose blocker id does not resolve via bd show, distinctly from a deferred one", () => {
    const beads = [bead("has-ghost-blocker", "open", ["ugcportal-ghost"])];
    const result = findUnreachableBeads(beads);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].paths).toEqual([[{ id: "ugcportal-ghost", status: "missing" }]]);
  });

  it("a bead with both a deferred and a missing blocker reports both stuck paths", () => {
    const beads = [bead("double-stuck", "open", ["ugcportal-ghost", "deferred-one"]), bead("deferred-one", "deferred")];
    const result = findUnreachableBeads(beads);
    expect(result.flagged).toHaveLength(1);
    const kinds = result.flagged[0].paths.map((p) => p[0].status).sort();
    expect(kinds).toEqual(["deferred", "missing"]);
  });
});

describe("findUnreachableBeads: multi-hop chain", () => {
  it("names the full chain down to the terminal, not just the direct blocker", () => {
    const beads = [bead("a", "in_progress", ["b"]), bead("b", "in_progress", ["c"]), bead("c", "deferred")];
    const result = findUnreachableBeads(beads);
    // "b" is itself examined (in_progress, not closed/deferred) and is also
    // unreachable, since its own direct blocker "c" is deferred -- both are
    // correctly flagged, each with its own chain down to "c".
    expect(result.flagged.map((f) => f.id).sort()).toEqual(["a", "b"]);
    const a = result.flagged.find((f) => f.id === "a");
    expect(a.paths[0].map((n) => n.id)).toEqual(["b", "c"]);
    const b = result.flagged.find((f) => f.id === "b");
    expect(b.paths[0].map((n) => n.id)).toEqual(["c"]);
  });
});

describe("buildChain cycle guard (distinct from canReach's own guard)", () => {
  // canReach's cycle guard is exercised above ("a dependency cycle is
  // treated as resolvable..."), but buildChain walks the SAME graph a
  // second time, with its own `seen` set, to render a human-readable
  // chain -- and has its own, separately-written guard (the
  // `seen.has(blockerId)` check). Deleting that line does not make
  // canReach's tests fail (nothing above exercises buildChain against a
  // cycle at all); it only blows the stack here, in buildChain itself, on a
  // bead that is unreachable via a genuine deferred dead-end AND sits in a
  // mutual-block cycle with its own direct blocker.
  it("terminates with a cycle marker instead of recursing forever, for a bead whose chain revisits a bead already on the path", () => {
    const beads = [
      bead("a", "open", ["b", "dead-a"]),
      bead("b", "open", ["a", "dead-b"]),
      bead("dead-a", "deferred"),
      bead("dead-b", "deferred"),
    ];
    const result = findUnreachableBeads(beads);
    expect(result.flagged.map((f) => f.id).sort()).toEqual(["a", "b"]);

    const a = result.flagged.find((f) => f.id === "a");
    // One path revisits "b" (the cycle) and is cut off with a cycle marker,
    // rather than recursing until the stack overflows; the other path is
    // the genuine, independent deferred dead end "dead-a".
    const cyclePath = a.paths.find((p) => p.some((n) => n.note === "cycle"));
    expect(cyclePath.map((n) => n.id)).toEqual(["b", "a", "b"]);
    expect(cyclePath[2].note).toBe("cycle");
    const deferredPath = a.paths.find((p) => p[0].id === "dead-a");
    expect(deferredPath).toEqual([{ id: "dead-a", status: "deferred", title: "title of dead-a", deferUntil: null }]);
  });
});

describe("explainStuckPaths", () => {
  it("returns one path per independently-stuck direct blocker", () => {
    const beads = [
      bead("a", "open", ["closed1", "dead1", "dead2"]),
      bead("closed1", "closed"),
      bead("dead1", "deferred"),
      bead("dead2", "deferred"),
    ];
    const index = buildBeadIndex(beads);
    const memo = new Map();
    canReach("a", index, memo);
    const paths = explainStuckPaths("a", index, memo);
    expect(paths.map((p) => p[0].id).sort()).toEqual(["dead1", "dead2"]);
  });
});

describe("formatReport", () => {
  it("names the examined and flagged counts and every flagged bead's chain", () => {
    const result = findUnreachableBeads([bead("stuck", "open", ["ugcportal-ghost"])]);
    const text = formatReport(result);
    expect(text).toContain("Examined 1 bead(s)");
    expect(text).toContain("Flagged 1 as unreachable");
    expect(text).toContain('stuck [open] "title of stuck"');
    expect(text).toContain("ugcportal-ghost (does not exist)");
  });

  it("prints (none) when nothing is flagged, instead of an empty body indistinguishable from not running", () => {
    const result = findUnreachableBeads([bead("ready", "open")]);
    const text = formatReport(result);
    expect(text).toContain("Flagged 0 as unreachable");
    expect(text).toContain("(none)");
  });

  it("does NOT print (none) when beads are flagged", () => {
    const result = findUnreachableBeads([bead("stuck", "open", ["ugcportal-ghost"])]);
    const text = formatReport(result);
    expect(text).not.toContain("(none)");
  });

  it("names the defer-until date on a deferred node that has one set", () => {
    const beads = [
      bead("stuck", "open", ["deferred-with-date"]),
      bead("deferred-with-date", "deferred", [], { defer_until: "2027-03-01T00:00:00Z" }),
    ];
    const text = formatReport(findUnreachableBeads(beads));
    expect(text).toContain('deferred-with-date [DEFERRED until 2027-03-01] "title of deferred-with-date"');
  });

  it("renders the cycle note on a chain node buildChain marked with note: \"cycle\" (sibling of the defer-until branch above)", () => {
    // Same mutual-block-plus-independent-deferred-dead-end shape as the
    // "buildChain cycle guard" describe block below, which asserts the raw
    // `note: "cycle"` data directly -- this test instead runs the actual
    // reporting path (findUnreachableBeads -> formatReport -> formatChain)
    // over that same cycle-marked path, so the RENDERING of the marker, not
    // just its presence in the data, is exercised.
    const beads = [
      bead("a", "open", ["b", "dead-a"]),
      bead("b", "open", ["a", "dead-b"]),
      bead("dead-a", "deferred"),
      bead("dead-b", "deferred"),
    ];
    const text = formatReport(findUnreachableBeads(beads));
    expect(text).toContain("(cycle, not followed further)");
  });

  // Round 3 review: three rounds of one-at-a-time sibling hunting in this
  // reporting layer were not converging, so this is the full enumeration of
  // every conditional branch and loop in formatChain/formatReport, each with
  // its own assertion (see the PR/bead notes for the mutation proving each
  // of the four new ones below actually goes red):
  //   formatChain  status === "missing"                      -- covered above
  //   formatChain  status === "deferred", deferUntil present  -- covered above
  //   formatChain  status === "deferred", deferUntil absent   -- NEW below
  //   formatChain  note === "cycle" (true)                    -- covered above
  //   formatChain  note === "cycle" (false/absent)             -- NEW below
  //   formatReport outer loop, >1 flagged bead                -- NEW below
  //   formatReport inner loop, >1 stuck path per bead          -- NEW below
  //   formatReport flagged.length === 0 (true: "(none)")       -- covered above
  //   formatReport flagged.length === 0 (false: no "(none)")   -- covered above

  it("renders a deferred node with no defer_until with the plain fallback, no until suffix", () => {
    const beads = [bead("stuck", "open", ["deferred-no-date"]), bead("deferred-no-date", "deferred")];
    const text = formatReport(findUnreachableBeads(beads));
    expect(text).toContain('deferred-no-date [DEFERRED] "title of deferred-no-date"');
  });

  it("does NOT render a cycle note on a node that was not marked with one", () => {
    // A plain two-hop chain with no cycle anywhere in it: neither node
    // should ever pick up "(cycle, not followed further)".
    const beads = [bead("stuck", "open", ["blocker"]), bead("blocker", "open", ["dead"]), bead("dead", "deferred")];
    const text = formatReport(findUnreachableBeads(beads));
    expect(text).not.toContain("(cycle, not followed further)");
  });

  it("renders every flagged bead, not just the first (outer loop)", () => {
    const beads = [
      bead("first-stuck", "open", ["dead1"]),
      bead("second-stuck", "open", ["dead2"]),
      bead("dead1", "deferred"),
      bead("dead2", "deferred"),
    ];
    const text = formatReport(findUnreachableBeads(beads));
    expect(text).toContain('first-stuck [open] "title of first-stuck"');
    expect(text).toContain('second-stuck [open] "title of second-stuck"');
  });

  it("renders every stuck path for a bead, not just the first (inner loop)", () => {
    const beads = [bead("multi-stuck", "open", ["dead1", "dead2"]), bead("dead1", "deferred"), bead("dead2", "deferred")];
    const text = formatReport(findUnreachableBeads(beads));
    expect(text).toContain("stuck via: dead1");
    expect(text).toContain("stuck via: dead2");
  });
});

describe("CLI end-to-end (--beads fixture file, never live bd)", () => {
  let tmpDir;

  it("reports the expected bead from a fixture file via --json", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unreachable-beads-"));
    const file = path.join(tmpDir, "beads.json");
    fs.writeFileSync(
      file,
      JSON.stringify([bead("stuck", "open", ["deferred-blocker"]), bead("deferred-blocker", "deferred"), bead("ready", "open")]),
    );
    try {
      const out = execFileSync("node", [SCRIPT, "--beads", file, "--json"], { encoding: "utf8" });
      const result = JSON.parse(out);
      expect(result.examinedCount).toBe(2);
      expect(result.flagged.map((f) => f.id)).toEqual(["stuck"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    expect(() => execFileSync("node", [SCRIPT, "--nonsense"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).toThrow();
  });
});
