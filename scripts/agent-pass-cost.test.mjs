/**
 * Tests for the pure parts of scripts/agent-pass-cost.mjs (ugcportal-l6t5):
 * pass segmentation, per-message-id dedupe of streamed usage records, the
 * input-token-equivalent weighting, the task-notification reader and the
 * tool-call pricer. Fixtures are shaped like the real Claude Code transcript
 * lines the script reads (a subagent's `agent-<id>.jsonl` and its parent
 * session's task-notification text); the filesystem walk is not exercised.
 */
import { describe, expect, it } from "vitest";

import { ctxOf, iteOf, notificationTotals, parsePasses, roleOf, toolCallCost } from "./agent-pass-cost.mjs";

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
    expect(toolCallCost(entries, /check-bead-dispatch/)).toEqual({ calls: 2, turns: 1, ite: 10000, seconds: 8 });
    expect(toolCallCost(entries, /no-such-command/)).toEqual({ calls: 0, turns: 0, ite: 0, seconds: 0 });
    // --before drops calls issued at or after the cutoff
    expect(toolCallCost(entries, /check-bead-dispatch/, "2026-10-14T11:00:00Z").calls).toBe(0);
    expect(toolCallCost(entries, /check-bead-dispatch/, "2026-10-14T11:00:01Z").calls).toBe(2);
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
