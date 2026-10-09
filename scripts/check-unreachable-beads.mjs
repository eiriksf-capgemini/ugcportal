#!/usr/bin/env node
/**
 * Reports beads that can never reach `bd ready` because every hard blocking
 * path out of them terminates in a bead that is deferred, or missing (a
 * dependency id `bd show` cannot find). A dependency cycle is deliberately
 * NOT a third termination reason here, despite being the obvious thing a
 * reader expects next to those two: `canReach` below treats any cycle as
 * resolved, not stuck, so a pure `a -> b -> a` loop with nothing deferred
 * or missing flags nothing -- see "Deliberately out of scope" further down
 * (ugcportal-z4nh).
 *
 * Why this exists: the v0.7.0 premise audit (ugcportal-j5fl, 2026-10-08)
 * found seven beads in that release's line-up gated on beads that were
 * themselves deferred -- several to 2027-03-01 -- so the gated bead could
 * never reach `bd ready` no matter how long anyone waited, and nothing
 * noticed. The audit found this by walking the dependency graph by hand,
 * once. This script is that walk, repeatable.
 *
 * Only hard `blocks` edges gate readiness (`bd`'s own `GetReadyWork`
 * semantics: a bead is ready when it has no *active* blocker). `discovered
 * -from`, `parent-child`, `related`/`relates-to` and `supersedes` edges do
 * not gate anything and are ignored here, same as `bd ready` ignores them.
 *
 * Algorithm (`canReach` below): a bead can eventually reach ready --
 * "resolve" -- if:
 *   - it is already CLOSED (trivially satisfied), or
 *   - it is OPEN / IN_PROGRESS / any other non-terminal status AND every one
 *     of its direct `blocks` targets itself resolves (vacuously true for a
 *     bead with no blockers -- it is ready right now).
 * A bead does NOT resolve if:
 *   - it is DEFERRED (deferred beads are excluded from `bd ready` outright,
 *     regardless of their own blockers -- treated here as a scheduling dead
 *     end, not walked further), or
 *   - its id does not resolve via `bd show` at all (a dangling reference --
 *     there is nothing to ever close), or
 *   - at least one of its direct blockers does not resolve.
 *
 * A bead at the top of this recursion is reported when it is itself neither
 * CLOSED nor DEFERRED, but does not resolve -- i.e. it has at least one
 * blocking path (direct or transitive) that bottoms out in a DEFERRED or
 * missing bead. A bead with some blockers already closed and one still
 * deferred is still flagged: every blocker has to close for the bead to
 * become ready, so one dead blocker dooms it regardless of how many others
 * are already satisfied -- this is the real shape of ugcportal-5x8 and
 * ugcportal-rma below, each with several closed blockers alongside the
 * deferred ones that actually make them unreachable.
 *
 * Deliberately out of scope (see the bead): deciding what to do about any
 * flagged bead (a human call per bead); cycle detection (`bd` already does
 * this -- a cycle encountered mid-walk here is treated as resolved rather
 * than re-litigated, so it can never masquerade as a new kind of stuck
 * bead); re-triaging any release line-up.
 *
 * Data completeness (round-4 review fix): `bd list --all` does NOT mean
 * "every bead" -- `--all` only lifts the default closed-beads filter. Gate,
 * infra and template-molecule beads stay hidden regardless, unless
 * `--include-gates --include-infra --include-templates` are also passed.
 * Gate beads are real `blocks` targets (e.g. the live edges
 * `ugcportal-yck -> ugcportal-alg`, a CLOSED gate, and `ugcportal-847 ->
 * ugcportal-gj4`, a DEFERRED one) -- omitting them from the fetch does not
 * remove them from the graph, it just makes this script unable to resolve
 * them, so a bead gated on an already-CLOSED gate got reported "missing"
 * and therefore permanently stuck: a false positive, in the damaging
 * direction for a tool whose job is telling people which edges to cut.
 * `loadBeads` below passes all three include flags so every live blocker
 * id resolves to its real status. Deliberate choice, not a default
 * accepted blindly: gate/infra/template beads are walked and can be
 * EXAMINED/FLAGGED exactly like any other bead, not special-cased out of
 * the top-level report either -- a gate bead that is itself stuck behind a
 * deferred blocker is exactly as real a finding as any other bead's, and
 * filtering the report by `issue_type` would add a second, untested
 * branch for a distinction (claimable work vs. coordination bead) this
 * check's acceptance criteria never draws.
 *
 * Usage:
 *   node scripts/check-unreachable-beads.mjs [--beads <file.json>] [--json]
 *     --beads <file>   use a saved beads-array dump (see `BD_LIST_ARGS`
 *                      below for the exact `bd list` invocation this
 *                      produces) instead of running `bd` live (also how the
 *                      test fixtures drive this script's CLI end-to-end)
 *     --json           machine-readable output instead of the text report
 *
 * No `--execute`: this check only reads, nothing here mutates a bead.
 *
 * Self-test: npm test -- runs scripts/check-unreachable-beads.test.mjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { isMainModule } from "./lib/is-main.mjs";

const TERMINAL_STATUSES = new Set(["closed", "deferred"]);

// --- pure graph logic (unit-tested directly) --------------------------------

/** @param {Array<object>} beads a beads array shaped like `bd list` with BD_LIST_ARGS's flags (see below)
 *  @returns {Map<string, object>} id -> bead record */
export function buildBeadIndex(beads) {
  const index = new Map();
  for (const bead of beads) index.set(bead.id, bead);
  return index;
}

/** Direct hard-blocker ids of a bead: only `type === "blocks"` dependency
 *  edges gate readiness -- discovered-from/parent-child/related/supersedes
 *  do not, and are ignored. */
export function directBlockers(bead) {
  return (bead.dependencies || []).filter((d) => d.type === "blocks").map((d) => d.depends_on_id);
}

/**
 * Can `id` ever reach `bd ready` (possibly after some of its own blockers
 * close first)? Memoized across the whole walk; `stack` guards against a
 * dependency cycle recursing forever -- cycle detection itself is bd's job
 * (out of scope here), so a back-edge is simply treated as resolvable
 * rather than flagged as a new failure mode.
 */
export function canReach(id, beadIndex, memo = new Map(), stack = new Set()) {
  if (memo.has(id)) return memo.get(id);
  const bead = beadIndex.get(id);
  if (!bead) {
    memo.set(id, false);
    return false;
  }
  if (bead.status === "closed") {
    memo.set(id, true);
    return true;
  }
  if (bead.status === "deferred") {
    memo.set(id, false);
    return false;
  }
  if (stack.has(id)) return true; // cycle guard; do not memoize a provisional value
  const nextStack = new Set(stack);
  nextStack.add(id);
  const result = directBlockers(bead).every((b) => canReach(b, beadIndex, memo, nextStack));
  memo.set(id, result);
  return result;
}

/**
 * Describes one bead in a stuck chain, for reporting.
 * @returns {{id: string, status: "missing"|string, title?: string, deferUntil?: string|null}}
 */
function describeNode(id, beadIndex) {
  const bead = beadIndex.get(id);
  if (!bead) return { id, status: "missing" };
  const node = { id, status: bead.status, title: bead.title };
  if (bead.status === "deferred") node.deferUntil = bead.defer_until ?? null;
  return node;
}

/**
 * For a bead that does NOT resolve, walk from a single stuck direct blocker
 * down to its terminal -- deferred, missing, or a cycle back to a bead
 * already on this same path (marked and cut off, not followed further) --
 * through any intermediate open/in_progress beads that are themselves only
 * stuck because of it. Returns an array of node descriptions, starting at
 * `blockerId`.
 */
function buildChain(blockerId, beadIndex, memo, seen = new Set()) {
  const node = describeNode(blockerId, beadIndex);
  if (node.status === "missing" || node.status === "deferred") return [node];
  if (seen.has(blockerId)) return [{ ...node, note: "cycle" }];
  const nextSeen = new Set(seen);
  nextSeen.add(blockerId);
  const bead = beadIndex.get(blockerId);
  for (const b of directBlockers(bead)) {
    if (!canReach(b, beadIndex, memo)) return [node, ...buildChain(b, beadIndex, memo, nextSeen)];
  }
  // canReach(blockerId) was false but every direct blocker resolves: should
  // not happen given canReach's own definition, but fail safe rather than throw.
  return [node];
}

/**
 * Every stuck path out of a bead that does not resolve: one chain per
 * direct blocker that itself does not resolve (there can be more than
 * one -- see ugcportal-5x8, with five independently-deferred blockers
 * alongside four already-closed ones).
 */
export function explainStuckPaths(id, beadIndex, memo) {
  const bead = beadIndex.get(id);
  const paths = [];
  for (const b of directBlockers(bead)) {
    if (!canReach(b, beadIndex, memo)) paths.push(buildChain(b, beadIndex, memo));
  }
  return paths;
}

/**
 * The check itself. Examines every bead that is not itself closed or
 * deferred (a deferred or closed bead's own reachability is not this
 * check's concern -- deferred is addressed by un-deferring it, closed is
 * done), and flags the ones that cannot resolve.
 *
 * @param {Array<object>} beads a beads array shaped like `bd list` with BD_LIST_ARGS's flags (see below)
 * @returns {{examinedCount: number, examinedIds: string[], flagged: Array<{id, title, status, paths}>}}
 */
export function findUnreachableBeads(beads) {
  const beadIndex = buildBeadIndex(beads);
  const memo = new Map();
  const examinedIds = [];
  const flagged = [];
  for (const bead of beads) {
    if (TERMINAL_STATUSES.has(bead.status)) continue;
    examinedIds.push(bead.id);
    if (!canReach(bead.id, beadIndex, memo)) {
      flagged.push({
        id: bead.id,
        title: bead.title,
        status: bead.status,
        paths: explainStuckPaths(bead.id, beadIndex, memo),
      });
    }
  }
  return { examinedCount: examinedIds.length, examinedIds, flagged };
}

// --- reporting ---------------------------------------------------------------

function formatChain(chain) {
  return chain
    .map((node) => {
      if (node.status === "missing") return `${node.id} (does not exist)`;
      if (node.status === "deferred") {
        const until = node.deferUntil ? ` until ${node.deferUntil.slice(0, 10)}` : "";
        return `${node.id} [DEFERRED${until}] "${node.title}"`;
      }
      const cycleNote = node.note === "cycle" ? " (cycle, not followed further)" : "";
      return `${node.id} [${node.status}]${cycleNote} "${node.title}"`;
    })
    .join(" -> ");
}

export function formatReport({ examinedCount, flagged }) {
  const lines = [];
  lines.push(`Examined ${examinedCount} bead(s) not already closed or deferred.`);
  lines.push(`Flagged ${flagged.length} as unreachable: every blocking path ends in deferred or missing work.`);
  lines.push("");
  for (const bead of flagged) {
    lines.push(`${bead.id} [${bead.status}] "${bead.title}"`);
    for (const chain of bead.paths) {
      lines.push(`  stuck via: ${formatChain(chain)}`);
    }
  }
  if (flagged.length === 0) lines.push("(none)");
  return lines.join("\n");
}

// --- data access -------------------------------------------------------------

/**
 * The exact `bd list` argv this script runs live. `--all` alone only lifts
 * the default closed-beads filter -- it does NOT include gate, infra or
 * template-molecule beads, which `bd list` hides unconditionally unless
 * these three flags are also given. Exported (and unit-tested below, by
 * asserting its contents rather than by actually invoking `bd`) so a future
 * edit that silently drops one of the include flags -- reintroducing the
 * round-4 false-positive -- fails a fast local test instead of waiting for
 * the next `bd show <some-gate-id>` to catch it by hand again.
 */
export const BD_LIST_ARGS = ["list", "--all", "--include-gates", "--include-infra", "--include-templates", "--json"];

function loadBeads(opts) {
  if (opts.beads) return JSON.parse(fs.readFileSync(opts.beads, "utf8"));
  const out = execFileSync("bd", BD_LIST_ARGS, { encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(out);
}

function parseArgs(argv) {
  const opts = { beads: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--beads") opts.beads = argv[++i];
    else if (arg === "--json") opts.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const beads = loadBeads(opts);
  const result = findUnreachableBeads(beads);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }
  // Advisory only: never fails the build on what it finds (K: deciding what
  // to do about a flagged bead is a human call per bead, out of scope here).
}

if (isMainModule(import.meta.url)) main();
