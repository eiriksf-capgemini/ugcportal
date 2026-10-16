#!/usr/bin/env node
/**
 * Per-pass token cost of every subagent run recorded in Claude Code's local
 * transcripts (ugcportal-l6t5). Written to test two claims of the v0.7.0
 * reviews against primary data rather than against bead metadata:
 *
 *   - what the `subagent_tokens` figure in a task-notification -- the number
 *     copied into `tokens_impl` / `tokens_qa` -- actually measures, and
 *   - whether a resumed agent's pass pays rent on its accumulated history.
 *
 * Input: a Claude Code project transcript directory, by default
 * ~/.claude/projects/-Users-eiriksf-code-ugcportal. Each session `<id>.jsonl`
 * may have a `<id>/subagents/agent-<agentId>.jsonl` per subagent, with a
 * `.meta.json` beside it (agentType, description, model).
 *
 * A PASS is the run between two prompts: the first prompt, then every later
 * plain-string user message that is not a bare <system-reminder> and arrives
 * after at least one assistant call (a SendMessage resume). Per pass the
 * script sums the API usage of each distinct assistant message id (the last
 * usage record per id wins, since streamed entries repeat it):
 *
 *   ctxStart / ctxEnd  context size (input + cache read + cache write + output)
 *                      of the pass's first and last call
 *   cacheRead, cacheWrite5m, cacheWrite1h, input, output   sums over the pass
 *   firstCallCacheWrite  cache written by the pass's first call: close to
 *                      ctxStart when the prompt cache expired while the agent
 *                      sat idle, so the whole history is re-written at 1.25x
 *   idleSeconds        gap between the previous pass's last call and this
 *                      pass's prompt
 *   ite                input-token equivalents: input + 0.1*cacheRead +
 *                      1.25*cacheWrite5m + 2*cacheWrite1h + 5*output -- the
 *                      ratios of Anthropic's published price list, so ite is
 *                      proportional to dollars for any one model
 *
 * It also reads every task-notification in the parent session and records
 * the `subagent_tokens` (or older `total_tokens:`) figure per agent id, in
 * order, so a row can be checked against what the orchestrator was told.
 *
 * Usage: node scripts/agent-pass-cost.mjs [--dir <projects dir>] [--before <iso>] [--json out]
 *        node scripts/agent-pass-cost.mjs --tool <regex> [--dir <projects dir>] [--before <iso>]
 * --before keeps only passes (or tool calls) that start before that instant,
 * so a figure stays reproducible while new sessions keep being written.
 * The second form prices every tool call whose input matches <regex>, in the
 * orchestrator sessions and the subagents alike (see toolCallCost).
 * Both print a reach line (what was examined, what matched) to stderr.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";

export const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };

export function ctxOf(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
}

function isPrompt(entry) {
  if (entry.type !== "user") return false;
  const c = entry.message?.content;
  return typeof c === "string" && !c.trimStart().startsWith("<system-reminder>");
}

/** Split one agent transcript (array of parsed jsonl entries) into passes. */
export function parsePasses(entries) {
  const passes = [];
  let cur = null;
  const open = (ts, prompt) => { cur = { startTs: ts, prompt: prompt.slice(0, 200), usageById: new Map(), order: [] }; passes.push(cur); };
  for (const e of entries) {
    if (isPrompt(e)) {
      if (!cur || cur.order.length > 0) open(e.timestamp, e.message.content);
      continue;
    }
    if (e.type === "assistant" && e.message?.usage && e.message.id) {
      if (!cur) open(e.timestamp, "");
      if (!cur.usageById.has(e.message.id)) cur.order.push(e.message.id);
      cur.usageById.set(e.message.id, e.message.usage);
      cur.endTs = e.timestamp;
    }
  }
  let prevEnd = null;
  return passes.filter((p) => p.order.length > 0).map((p, i) => {
    const us = p.order.map((id) => p.usageById.get(id));
    const sum = (f) => us.reduce((a, u) => a + f(u), 0);
    const w5 = (u) => u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation ? 0 : u.cache_creation_input_tokens || 0);
    const w1 = (u) => u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const row = {
      pass: i + 1, startTs: p.startTs, endTs: p.endTs, prompt: p.prompt, calls: us.length,
      ctxStart: ctxOf(us[0]), ctxEnd: ctxOf(us[us.length - 1]),
      input: sum((u) => u.input_tokens || 0), cacheRead: sum((u) => u.cache_read_input_tokens || 0),
      cacheWrite5m: sum(w5), cacheWrite1h: sum(w1), output: sum((u) => u.output_tokens || 0),
      firstCallCacheWrite: us[0].cache_creation_input_tokens || 0,
      idleSeconds: i === 0 || !prevEnd ? null : Math.round((Date.parse(p.startTs) - Date.parse(prevEnd)) / 1000),
    };
    prevEnd = p.endTs;
    row.ite = Math.round(us.reduce((a, u) => a + iteOf(u), 0));
    return row;
  });
}

/** Every task-notification's token figure in a parent session's text, keyed by task id, in order. */
export function notificationTotals(text) {
  const out = new Map();
  const re = /<task-id>([a-z0-9]+)<\/task-id>([\s\S]{0,20000}?)<\/task-notification>/g;
  for (const m of text.matchAll(re)) {
    const t = /<subagent_tokens>(\d+)<\/subagent_tokens>|total_tokens:\s*(\d+)/.exec(m[2].replace(/\\n/g, "\n"));
    if (!t) continue;
    const v = Number(t[1] ?? t[2]);
    const list = out.get(m[1]) || [];
    if (list[list.length - 1] !== v) list.push(v); // the same notification is echoed into several entries
    out.set(m[1], list);
  }
  return out;
}

/**
 * Price of the tool calls whose input matches `re` in one transcript: per
 * matching call, the ite of the API call that issued it (the turn that chose
 * to run it, carrying the whole context at that point) and the wall-clock
 * seconds from the tool_use to its tool_result. A turn that issues several
 * matching calls is counted once per call but priced once.
 */
export function toolCallCost(entries, re, before = null) {
  const usage = new Map(), issued = new Map(), resultAt = new Map();
  for (const e of entries) {
    if (e.type === "assistant" && e.message?.id) {
      if (e.message.usage) usage.set(e.message.id, e.message.usage);
      for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
        if (before && e.timestamp >= before) continue;
        if (c.type === "tool_use" && re.test(JSON.stringify(c.input ?? {}))) issued.set(c.id, { msg: e.message.id, at: e.timestamp });
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) if (c.type === "tool_result" && issued.has(c.tool_use_id)) resultAt.set(c.tool_use_id, e.timestamp);
    }
  }
  const priced = new Set();
  let ite = 0, seconds = 0;
  for (const [id, { msg, at }] of issued) {
    if (!priced.has(msg) && usage.has(msg)) { priced.add(msg); ite += iteOf(usage.get(msg)); }
    if (resultAt.has(id)) seconds += (Date.parse(resultAt.get(id)) - Date.parse(at)) / 1000;
  }
  return { calls: issued.size, turns: priced.size, ite: Math.round(ite), seconds: Math.round(seconds) };
}

export function iteOf(u) {
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation ? 0 : u.cache_creation_input_tokens || 0);
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return (u.input_tokens || 0) * WEIGHTS.input + (u.cache_read_input_tokens || 0) * WEIGHTS.cacheRead + w5 * WEIGHTS.cacheWrite5m + w1 * WEIGHTS.cacheWrite1h + (u.output_tokens || 0) * WEIGHTS.output;
}

export function beadIdsOf(text) {
  return [...new Set((text || "").match(/ugcportal-[a-z0-9]+(?:\.\d+)?/g) || [])];
}

export function roleOf(agentType, description) {
  const d = `${agentType || ""} ${description || ""}`.toLowerCase();
  if (/review/.test(d)) return "review";
  if (/implement|fix|build|round-?\d|rebase|merge/.test(d)) return "impl";
  if (/analy|verify|premise|audit|measure|explore|search/.test(d)) return "analysis";
  return "other";
}

export function scan(dir, before = null) {
  const rows = [];
  const reach = { sessions: 0, agentFiles: 0, parsed: 0, unreadable: 0 };
  for (const s of fs.readdirSync(dir)) {
    const sub = path.join(dir, s, "subagents");
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    reach.sessions++;
    const parentFile = path.join(dir, `${s}.jsonl`);
    const notes = fs.existsSync(parentFile) ? notificationTotals(fs.readFileSync(parentFile, "utf8")) : new Map();
    for (const f of fs.readdirSync(sub).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
      reach.agentFiles++;
      const agentId = f.slice(6, -6);
      let entries, meta = {};
      try {
        entries = fs.readFileSync(path.join(sub, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        reach.unreadable++;
        continue;
      }
      const metaFile = path.join(sub, `agent-${agentId}.meta.json`);
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      reach.parsed++;
      const passes = parsePasses(entries);
      const first = passes[0]?.prompt || "";
      const model = entries.find((e) => e.type === "assistant" && e.message?.model)?.message.model;
      passes.filter((p) => !before || p.startTs < before).forEach((p) => rows.push({
        session: s, agentId, agentType: meta.agentType || null, description: meta.description || null,
        model: model || meta.model || null, role: roleOf(meta.agentType, meta.description),
        beads: beadIdsOf(`${meta.description || ""} ${first}`), passes: passes.length,
        notified: notes.get(agentId) || [], ...p,
      }));
    }
  }
  return { rows, reach };
}

/** --tool mode: price every matching tool call across parent sessions and subagents, per session. */
export function scanTool(dir, re, before = null) {
  const out = [];
  const files = [];
  for (const s of fs.readdirSync(dir)) {
    if (s.endsWith(".jsonl")) files.push({ session: s.slice(0, -6), who: "orchestrator", file: path.join(dir, s) });
    const sub = path.join(dir, s, "subagents");
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) for (const f of fs.readdirSync(sub).filter((x) => /^agent-.*\.jsonl$/.test(x))) files.push({ session: s, who: f.slice(6, -6), file: path.join(sub, f) });
  }
  for (const f of files) {
    let entries;
    try { entries = fs.readFileSync(f.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { continue; }
    const c = toolCallCost(entries, re, before);
    if (c.calls) out.push({ session: f.session, who: f.who, firstAt: entries.find((e) => e.timestamp)?.timestamp ?? null, ...c });
  }
  return { rows: out, filesExamined: files.length };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const dir = opt("--dir", path.join(os.homedir(), ".claude/projects/-Users-eiriksf-code-ugcportal"));
  const tool = opt("--tool");
  const before = opt("--before", null);
  if (tool) {
    const { rows, filesExamined } = scanTool(dir, new RegExp(tool), before);
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    console.error(`reach: ${filesExamined} transcript files examined, ${rows.length} with a matching tool call; /${tool}/${before ? `; calls before ${before}` : ""}`);
    for (const r of rows) console.log([r.session, r.who, r.firstAt, r.calls, r.turns, r.ite, r.seconds].join("\t"));
    console.log(`TOTAL\tcalls=${sum("calls")}\tturns=${sum("turns")}\tite=${sum("ite")}\tseconds=${sum("seconds")}`);
    return;
  }
  const { rows, reach } = scan(dir, before);
  console.error(`reach: ${dir}: ${reach.sessions} sessions with subagents, ${reach.agentFiles} agent files, ${reach.parsed} parsed, ${reach.unreadable} unreadable, ${rows.length} passes${before ? ` starting before ${before}` : ""}`);
  const json = opt("--json");
  if (json) fs.writeFileSync(json, JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log([r.agentId, r.role, r.model, r.pass, r.calls, r.ctxStart, r.ctxEnd, r.ite, r.beads.join(",")].join("\t"));
}

if (isMainModule(import.meta.url)) main();
