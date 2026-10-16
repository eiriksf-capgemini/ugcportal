/**
 * Tests for the pure parts of scripts/agent-pass-cost.mjs (ugcportal-l6t5):
 * pass segmentation, per-message-id dedupe of streamed usage records, the
 * input-token-equivalent weighting, the task-notification reader and the
 * tool-call pricer. Fixtures are shaped like the real Claude Code transcript
 * lines the script reads (a subagent's `agent-<id>.jsonl` and its parent
 * session's task-notification text). The filesystem walk (scan, scanTool) is
 * exercised on small fixture trees written to a temp directory, for the
 * skip-and-count behaviour of unreadable files, malformed lines and usage
 * blocks that are missing or not numeric.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ctxOf, iteOf, notificationTotals, parsePasses, reportScan, reportTool, roleOf, scan, scanTool, toolCallCost, validUsage } from "./agent-pass-cost.mjs";

const usage = (o) => ({ input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10, ...o });
const asst = (id, ts, u, content = []) => ({ type: "assistant", timestamp: ts, message: { id, usage: u, content } });
const prompt = (ts, text) => ({ type: "user", timestamp: ts, message: { content: text } });

describe("parsePasses", () => {
  const entries = [
    prompt("2026-10-15T09:00:00Z", "Implement bead ugcportal-x"),
    asst("m1", "2026-10-15T09:00:05Z", usage({ cache_creation_input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 30000, ephemeral_1h_input_tokens: 0 } })),
    // a reminder injected mid-run, after a call, must not open a pass
    prompt("2026-10-15T09:00:06Z", "<system-reminder> report through SubagentHandback </system-reminder>"),
    // a streamed message repeats its id; only the last record per id counts
    asst("m2", "2026-10-15T09:00:09Z", usage({ cache_read_input_tokens: 30000, output_tokens: 5 })),
    asst("m2", "2026-10-15T09:00:10Z", usage({ cache_read_input_tokens: 30000, output_tokens: 400 })),
    prompt("2026-10-15T09:20:10Z", "The coordinator sent a message while you were working: round 1 blocked"),
    asst("m3", "2026-10-15T09:20:15Z", usage({ cache_creation_input_tokens: 31000, cache_creation: { ephemeral_5m_input_tokens: 31000, ephemeral_1h_input_tokens: 0 } })),
  ];
  const passes = parsePasses(entries);

  it("opens a pass per real prompt and ignores a bare system-reminder", () => {
    expect(passes.map((p) => p.calls)).toEqual([2, 1]);
  });

  it("counts a streamed message id once, with its last usage record", () => {
    expect(passes[0].output).toBe(10 + 400);
    expect(passes[0].cacheRead).toBe(30000);
  });

  it("records the context at the first and last call, the idle gap and the first call's cache write", () => {
    expect(passes[0].ctxStart).toBe(2 + 30000 + 10);
    expect(passes[0].ctxEnd).toBe(2 + 30000 + 400);
    expect(passes[1].idleSeconds).toBe(1200);
    expect(passes[1].firstCallCacheWrite).toBe(31000);
  });

  it("weights usage by the published price ratios", () => {
    // pass 2: 2 input + 31000 * 1.25 + 10 * 5
    expect(passes[1].ite).toBe(Math.round(2 + 31000 * 1.25 + 50));
    expect(iteOf(usage({ cache_read_input_tokens: 1000, output_tokens: 0, input_tokens: 0 }))).toBe(100);
    expect(iteOf(usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 } }))).toBe(20);
  });

  it("ctxOf sums every input bucket and the output", () => {
    expect(ctxOf({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 })).toBe(10);
  });
});

describe("notificationTotals", () => {
  const n = (id, body) => `<task-notification>\\n<task-id>${id}</task-id>\\n${body}\\n</task-notification>`;
  it("reads subagent_tokens per task id, in order, collapsing an echoed repeat", () => {
    const text = [
      n("a1", "<usage><subagent_tokens>158995</subagent_tokens><tool_uses>3</tool_uses></usage>"),
      n("a1", "<usage><subagent_tokens>158995</subagent_tokens><tool_uses>3</tool_uses></usage>"),
      n("a1", "<usage><subagent_tokens>201126</subagent_tokens></usage>"),
      n("b2", "<usage>total_tokens: 47105\\ntool_uses: 4</usage>"),
      n("c3", "no usage block at all"),
    ].join("\n");
    const out = notificationTotals(text);
    expect(out.get("a1")).toEqual([158995, 201126]);
    expect(out.get("b2")).toEqual([47105]);
    expect(out.has("c3")).toBe(false);
  });
});

describe("toolCallCost", () => {
  it("prices the issuing turn of each matching call once and times it to its result", () => {
    const entries = [
      asst("t1", "2026-10-14T11:00:00Z", usage({ cache_read_input_tokens: 100000, output_tokens: 0, input_tokens: 0 }), [
        { type: "tool_use", id: "u1", input: { command: "node scripts/check-bead-dispatch.mjs ugcportal-x" } },
        { type: "tool_use", id: "u2", input: { command: "node scripts/check-bead-dispatch.mjs ugcportal-y" } },
      ]),
      { type: "user", timestamp: "2026-10-14T11:00:04Z", message: { content: [{ type: "tool_result", tool_use_id: "u1" }, { type: "tool_result", tool_use_id: "u2" }] } },
      asst("t2", "2026-10-14T11:00:05Z", usage({ cache_read_input_tokens: 100000 }), [{ type: "tool_use", id: "u3", input: { command: "ls" } }]),
    ];
    expect(toolCallCost(entries, /check-bead-dispatch/)).toEqual({ calls: 2, turns: 1, ite: 10000, seconds: 8, unpriced: 0, badUsage: 0 });
    expect(toolCallCost(entries, /no-such-command/)).toEqual({ calls: 0, turns: 0, ite: 0, seconds: 0, unpriced: 0, badUsage: 0 });
    // --before drops calls issued at or after the cutoff
    expect(toolCallCost(entries, /check-bead-dispatch/, "2026-10-14T11:00:00Z").calls).toBe(0);
    expect(toolCallCost(entries, /check-bead-dispatch/, "2026-10-14T11:00:01Z").calls).toBe(2);
  });
});

describe("notificationTotals, a long notification", () => {
  it("reads the figure of a notification longer than 20,000 characters", () => {
    const body = `<usage><subagent_tokens>151604</subagent_tokens></usage>${"x".repeat(30000)}`;
    const text = `<task-notification>\\n<task-id>a47e</task-id>\\n${body}\\n</task-notification>`;
    expect(notificationTotals(text).get("a47e")).toEqual([151604]);
  });
});

describe("notificationTotals, an unterminated notification", () => {
  it("reads a notification without a closing tag up to the next one, not through it", () => {
    const text = [
      "<task-notification>\\n<task-id>aa11</task-id>\\n<usage><subagent_tokens>111</subagent_tokens></usage>",
      "<task-notification>\\n<task-id>bb22</task-id>\\n<usage><subagent_tokens>222</subagent_tokens></usage>\\n</task-notification>",
    ].join("\n");
    const out = notificationTotals(text);
    expect(out.get("bb22")).toEqual([222]);
    expect(out.get("aa11")).toEqual([111]); // read to the next opening tag, not credited with 222
  });
});

describe("missing or non-numeric usage is counted, not zero-filled", () => {
  const bad = [
    asst("b1", "2026-10-15T09:00:06Z", undefined),
    asst("b2", "2026-10-15T09:00:07Z", { output_tokens: 5 }),
    asst("b3", "2026-10-15T09:00:08Z", usage({ input_tokens: Number.NaN })),
    asst("b4", "2026-10-15T09:00:09Z", usage({ cache_read_input_tokens: "12" })),
  ];
  it("validUsage requires every numeric field", () => {
    expect(validUsage(usage({}))).toBe(true);
    expect(validUsage(undefined)).toBe(false);
    expect(validUsage({ output_tokens: 5 })).toBe(false);
    expect(validUsage(usage({ input_tokens: Number.NaN }))).toBe(false);
  });
  it("parsePasses counts each such entry and leaves it out of every figure", () => {
    const stats = { badUsage: 0 };
    const passes = parsePasses([prompt("2026-10-15T09:00:00Z", "go"), asst("g1", "2026-10-15T09:00:05Z", usage({ input_tokens: 100, output_tokens: 10 })), ...bad], stats);
    expect(stats.badUsage).toBe(4);
    expect(passes[0].calls).toBe(1);
    expect(passes[0].ctxEnd).toBe(110); // not the 5 of the output-only block
  });
  it("toolCallCost counts the entries and reports a matching call it could not price", () => {
    const entries = [asst("t1", "2026-10-14T11:00:00Z", { output_tokens: 5 }, [{ type: "tool_use", id: "u1", input: { command: "check-bead-dispatch" } }])];
    expect(toolCallCost(entries, /check-bead-dispatch/)).toMatchObject({ calls: 1, turns: 0, ite: 0, unpriced: 1, badUsage: 1 });
  });
});

describe("scan and scanTool over a transcript directory", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join("\n");
  const call = (id, ts) => asst(id, ts, usage({ cache_read_input_tokens: 1000, output_tokens: 0, input_tokens: 0 }), [{ type: "tool_use", id: `u-${id}`, input: { command: "node scripts/check-bead-dispatch.mjs" } }]);
  function tree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apc-test-"));
    dirs.push(dir);
    return dir;
  }

  it("scanTool keeps the good lines of a file with a truncated last line and counts the bad one", () => {
    const dir = tree();
    for (const s of ["s1", "s2"]) fs.writeFileSync(path.join(dir, `${s}.jsonl`), `${jsonl(call("m1", "2026-10-14T11:00:00Z"))}\n{"type":"assistant","mess`);
    const r = scanTool(dir, /check-bead-dispatch/);
    expect(r).toMatchObject({ filesExamined: 2, unreadable: 0, malformedLines: 2 });
    expect(r.rows.reduce((a, x) => a + x.calls, 0)).toBe(2);
    expect(r.rows.reduce((a, x) => a + x.ite, 0)).toBe(200);
  });

  it("scanTool counts a file it cannot read as skipped, never as examined", () => {
    const dir = tree();
    fs.writeFileSync(path.join(dir, "ok.jsonl"), jsonl(call("m1", "2026-10-14T11:00:00Z")));
    fs.mkdirSync(path.join(dir, "dir-not-file.jsonl"));
    const r = scanTool(dir, /check-bead-dispatch/);
    expect(r).toMatchObject({ files: 2, filesExamined: 1, unreadable: 1 });
  });

  it("scan keeps the good lines of a subagent file with a truncated last line, counts it, and marks the rows a lower bound", () => {
    const dir = tree();
    const sub = path.join(dir, "s1", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), `${jsonl(prompt("2026-10-15T09:00:00Z", "go"), asst("m1", "2026-10-15T09:00:05Z", usage({ output_tokens: 10 })))}\n{"type":"assis`);
    const { rows, reach } = scan(dir);
    expect(reach).toMatchObject({ parsed: 1, unreadable: 0, malformedLines: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].lowerBound).toBe(true);
  });

  it("scan counts assistant entries with missing usage and marks the rows a lower bound", () => {
    const dir = tree();
    const sub = path.join(dir, "s1", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), jsonl(prompt("2026-10-15T09:00:00Z", "go"), asst("m1", "2026-10-15T09:00:05Z", usage({})), asst("m2", "2026-10-15T09:00:06Z", undefined)));
    const { rows, reach } = scan(dir);
    expect(reach.badUsage).toBe(1);
    expect(rows[0]).toMatchObject({ calls: 1, lowerBound: true });
  });
});

describe("the printed reach lines and warnings", () => {
  const zero = { filesExamined: 3, unreadable: 0, malformedLines: 0, badUsage: 0, unpriced: 0, rows: [] };
  const zeroScan = { rows: [], reach: { sessions: 1, agentFiles: 3, parsed: 3, unreadable: 0, malformedLines: 0, badUsage: 0 } };
  it("--tool prints all three skip counters and no warning on clean input", () => {
    const { err, out } = reportTool(zero, "x");
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/0 skipped unreadable, 0 malformed lines skipped, 0 assistant entries with missing\/invalid usage/);
    expect(out[out.length - 1]).not.toMatch(/lower bound/);
  });
  it("--tool prints each non-zero counter, the WARNING and the lower-bound mark", () => {
    const { err, out } = reportTool({ ...zero, unreadable: 2, malformedLines: 5, badUsage: 7, unpriced: 1 }, "x");
    expect(err[0]).toContain("2 skipped unreadable, 5 malformed lines skipped, 7 assistant entries with missing/invalid usage, 1 matching calls unpriced");
    expect(err[1]).toMatch(/^WARNING: .*LOWER BOUNDS/);
    expect(out[out.length - 1]).toMatch(/\(lower bound\)$/);
  });
  it("default mode prints all three skip counters and the WARNING when any is non-zero, none when clean", () => {
    expect(reportScan(zeroScan, "d").err).toHaveLength(1);
    const label = { unreadable: "skipped unreadable", malformedLines: "malformed lines skipped", badUsage: "assistant entries with missing/invalid usage" };
    for (const k of ["unreadable", "malformedLines", "badUsage"]) {
      const { err } = reportScan({ ...zeroScan, reach: { ...zeroScan.reach, [k]: 4 } }, "d");
      expect(err[0]).toContain(`4 ${label[k]}`);
      expect(err[1]).toMatch(/^WARNING: .*LOWER BOUNDS/);
    }
  });
});

describe("usage blocks and entries that cannot be priced", () => {
  it("an empty cache_creation object beside a cache write is invalid, not a free cache write", () => {
    const u = usage({ cache_creation_input_tokens: 30000, cache_creation: {} });
    expect(validUsage(u)).toBe(false);
    const stats = { badUsage: 0 };
    parsePasses([prompt("2026-10-15T09:00:00Z", "go"), asst("m1", "2026-10-15T09:00:05Z", u)], stats);
    expect(stats.badUsage).toBe(1);
  });
  it("toolCallCost counts an assistant entry without a message id the way parsePasses does, and reports its matching calls unpriced", () => {
    const e = { type: "assistant", timestamp: "2026-10-14T11:00:00Z", message: { usage: usage({}), content: [{ type: "tool_use", id: "u1", input: { command: "check-bead-dispatch" } }] } };
    const stats = { badUsage: 0 };
    parsePasses([prompt("2026-10-14T10:59:00Z", "go"), e], stats);
    expect(stats.badUsage).toBe(1);
    expect(toolCallCost([e], /check-bead-dispatch/)).toMatchObject({ calls: 1, turns: 0, ite: 0, unpriced: 1, badUsage: 1 });
  });
});

describe("roleOf", () => {
  it("classifies by agent type and description", () => {
    expect(roleOf("worker-reviewer", "Review PR 252")).toBe("review");
    expect(roleOf("general-purpose", "Fix PR 230 round-2 findings")).toBe("impl");
    expect(roleOf("general-purpose", "Re-verify premises: design beads")).toBe("analysis");
    expect(roleOf("fork", "Angle B removed-behavior auditor")).toBe("analysis");
    expect(roleOf(null, "Cut the v0.7.0 release")).toBe("other");
  });
});
