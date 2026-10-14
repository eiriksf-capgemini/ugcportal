/**
 * Pure data layer for the dev dashboard (scripts/dev-dashboard.mjs): joins
 * beads, pull requests, worktrees and cmux agents by bead id and derives the
 * "needs you" list. No I/O here, so every function is testable with fixtures.
 *
 * The HTML renderer lives in scripts/lib/dashboard-html.mjs; fetching and the
 * CLI live in scripts/dev-dashboard.mjs.
 */
import path from "node:path";

/** Hours an in_progress bead may go without an update before it is flagged. */
export const STALE_IN_PROGRESS_HOURS = 24;
/** Hours a green, unreviewed PR may sit before the dashboard nags about it. */
export const REVIEW_WAIT_HOURS = 2;
/** How many ready / blocked beads are shown before "Show all". */
export const QUEUE_LIMIT = 12;

/**
 * Extracts the bead id from a branch name, worktree path or title, if any.
 * The repo prefix is required so an unrelated token like `pr-129` in a
 * worktree path is not mistaken for a bead.
 * @param {string | undefined} text
 * @param {string} prefix e.g. "ugcportal"
 * @returns {string | null}
 */
export function extractBeadId(text, prefix) {
  if (!text) return null;
  const re = new RegExp(`\\b(${escapeRegExp(prefix)}-[a-z0-9]+(?:\\.[0-9]+)*)\\b`, "i");
  const m = re.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/**
 * macOS reports /tmp worktrees as /private/tmp in `git worktree list` while a
 * shell started in /tmp reports /tmp, so the two are folded together.
 * @param {string} p
 */
export function normalisePath(p) {
  return p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses `git worktree list --porcelain` into { path, branch, head, detached }[].
 * @param {string} text
 */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null, head: null, detached: false };
      out.push(cur);
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice("branch refs/heads/".length);
    else if (cur && line === "detached") cur.detached = true;
  }
  return out;
}

/**
 * Collapses a PR's statusCheckRollup into one word.
 * @param {Array<{conclusion?: string, state?: string, status?: string}>} rollup
 * @returns {"green" | "red" | "pending" | "none"}
 */
export function summariseChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  const states = rollup.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s)))
    return "red";
  if (states.some((s) => ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(s)))
    return "pending";
  return "green";
}

/**
 * Human-readable age like "3h" or "2d". Returns "?" for unparseable input.
 * @param {string | undefined} iso
 * @param {Date} now
 */
export function ageOf(iso, now) {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * "1 item" / "3 items" / "0 items". Counts are never string-concatenated
 * without going through here.
 * @param {number} n
 * @param {string} singular
 * @param {string} [plural]
 */
export function plural(n, singular, pluralForm = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Picks a short agent state for a cmux `current` item: "working", "idle",
 * "waiting", "ended", "attached" or "" when no agent is attached.
 * @param {object} item one element of `cmux current --json`.items
 */
export function agentStateOf(item) {
  const agents = Array.isArray(item?.agents) ? item.agents : [];
  const attention = (item?.attention?.length ?? 0) + (item?.possible_human_obligations?.length ?? 0);
  if (attention > 0) return "waiting";
  const states = agents.map((a) => String(a.state ?? a.status ?? a.phase ?? "").toLowerCase());
  if (states.some((s) => s.includes("work") || s.includes("run") || s.includes("busy"))) return "working";
  if (states.some((s) => s.includes("idle") || s.includes("wait"))) return "idle";
  if (agents.length > 0) return agents.length === states.filter((s) => s.includes("end")).length ? "ended" : "attached";
  return "";
}

/**
 * Joins beads, PRs, worktrees and cmux items into one row per in_progress
 * bead, plus the PRs that map to no in_progress bead and the worktrees that
 * map to nothing at all.
 *
 * @param {object} args
 * @param {string} args.prefix bead id prefix, e.g. "ugcportal"
 * @param {any[]} args.inProgress
 * @param {any[]} args.prs
 * @param {ReturnType<typeof parseWorktrees>} args.worktrees
 * @param {any[]} args.currentItems
 * @param {Date} args.now
 */
export function joinRows({ prefix, inProgress, prs, worktrees, currentItems, now }) {
  const prByBead = new Map();
  for (const pr of prs) {
    const id = extractBeadId(pr.headRefName, prefix) ?? extractBeadId(pr.title, prefix);
    if (id && !prByBead.has(id)) prByBead.set(id, pr);
  }
  const wtByBead = new Map();
  const wtByBranch = new Map();
  for (const wt of worktrees) {
    if (wt.branch) wtByBranch.set(wt.branch, wt);
    const id = extractBeadId(wt.branch, prefix) ?? extractBeadId(path.basename(wt.path), prefix);
    if (id && !wtByBead.has(id)) wtByBead.set(id, wt);
  }
  const itemsByCwd = new Map();
  for (const item of currentItems) {
    if (!item?.cwd) continue;
    const key = normalisePath(item.cwd);
    const list = itemsByCwd.get(key) ?? [];
    list.push(item);
    itemsByCwd.set(key, list);
  }

  const rows = inProgress.map((bead) => {
    const pr = prByBead.get(bead.id) ?? null;
    const wt = wtByBead.get(bead.id) ?? (pr ? wtByBranch.get(pr.headRefName) : null) ?? null;
    const items = wt ? itemsByCwd.get(normalisePath(wt.path)) ?? [] : [];
    const agentState = items.map(agentStateOf).find((s) => s !== "") ?? "";
    const ageHours = (now.getTime() - Date.parse(bead.updated_at ?? "")) / 3600000;
    // bd's lease (lease_expires_at) is deliberately NOT read: it is a 5-minute
    // TTL kept alive by `bd heartbeat`, which nothing in this repo's agent
    // flow runs, so every in_progress bead always looks expired. updated_at
    // against STALE_IN_PROGRESS_HOURS is the honest staleness signal here.
    return {
      bead,
      pr,
      worktree: wt,
      cmuxItems: items,
      agentState,
      checks: pr ? summariseChecks(pr.statusCheckRollup) : "none",
      stale: Number.isFinite(ageHours) && ageHours > STALE_IN_PROGRESS_HOURS,
      ageHours,
    };
  });

  const inProgressIds = new Set(inProgress.map((b) => b.id));
  const unlinkedPrs = prs.filter((pr) => {
    const id = extractBeadId(pr.headRefName, prefix) ?? extractBeadId(pr.title, prefix);
    return !id || !inProgressIds.has(id);
  });

  const orphanWorktrees = worktrees.filter((wt, i) => {
    if (i === 0) return false; // the main checkout
    if (wt.detached) return false; // review checkouts are expected to be detached
    const id = extractBeadId(wt.branch, prefix) ?? extractBeadId(path.basename(wt.path), prefix);
    const hasPr = prs.some((pr) => pr.headRefName === wt.branch);
    return !(id && inProgressIds.has(id)) && !hasPr;
  });

  return { rows, unlinkedPrs, orphanWorktrees };
}

/**
 * @typedef {object} Attention
 * @property {string} label two-word bold label, e.g. "CI red"
 * @property {string} text plain sentence without the label
 * @property {"bad" | "warn"} severity
 * @property {string} [anchor] element id of the row this is about, e.g. "bead-ugcportal-h0ef"
 * @property {string} [href] external link, usually the PR
 */

/**
 * Everything that needs a human, most urgent first.
 * @param {object} args
 * @param {ReturnType<typeof joinRows>} args.joined
 * @param {any[]} args.currentItems
 * @param {Record<string, {ok: boolean, error?: string}>} args.sources
 * @param {Date} args.now
 * @returns {Attention[]}
 */
export function buildAttention({ joined, currentItems, sources, now }) {
  /** @type {Attention[]} */
  const out = [];
  const add = (label, text, extra = {}) => out.push({ label, text, severity: "warn", ...extra });

  for (const [name, res] of Object.entries(sources)) {
    if (!res.ok) add("Source down", `${name} is unavailable: ${res.error}`, { severity: "bad" });
  }
  for (const item of currentItems) {
    const n = (item.attention?.length ?? 0) + (item.possible_human_obligations?.length ?? 0);
    if (n > 0) add("Agent waiting", `${item.label ?? item.cwd} has ${plural(n, "item")} needing you`, { severity: "bad" });
  }
  const prProblems = (pr, suffix, anchor) => {
    const extra = { anchor, href: pr.url };
    if (pr.reviewDecision === "CHANGES_REQUESTED") add("Changes requested", `#${pr.number}${suffix}`, { ...extra, severity: "bad" });
    if (summariseChecks(pr.statusCheckRollup) === "red") add("CI red", `#${pr.number}${suffix}`, { ...extra, severity: "bad" });
    if (pr.mergeable === "CONFLICTING") add("Merge conflict", `#${pr.number}${suffix}`, { ...extra, severity: "bad" });
  };
  // A bead whose PR already merged but which is still in_progress is a
  // different problem from one nobody has started on. The recent merges are
  // the cheapest evidence available for telling the two apart.
  const merged = sources.merged?.ok && Array.isArray(sources.merged.value) ? sources.merged.value : [];
  const mergedFor = (id) => merged.find((pr) => (pr.title ?? "").toLowerCase().includes(id.toLowerCase()) || (pr.headRefName ?? "").toLowerCase().includes(id.toLowerCase()));
  for (const row of joined.rows) {
    const id = row.bead.id;
    const anchor = `bead-${id}`;
    if (row.pr) prProblems(row.pr, ` for ${id}`, anchor);
    const mergedPr = !row.pr ? mergedFor(id) : null;
    if (mergedPr)
      add("Merged, bead open", `#${mergedPr.number} for ${id} merged ${ageOf(mergedPr.mergedAt, now)} ago but the bead is still in_progress. bd close ${id}?`, {
        anchor,
        href: mergedPr.url,
      });
    else if (row.stale)
      add("Stale", `${id} has had no update for ${ageOf(row.bead.updated_at, now)} and ${row.pr ? "has an open PR" : "has no PR"}`, { anchor });
    else if (!row.pr && !row.worktree) add("Unstarted claim", `${id} is in_progress with no branch, worktree or PR yet`, { anchor });
    if (
      row.pr &&
      !row.pr.isDraft &&
      row.checks === "green" &&
      !row.pr.reviewDecision &&
      row.agentState !== "working" &&
      row.ageHours > REVIEW_WAIT_HOURS
    )
      add("Review pending", `#${row.pr.number} for ${id} is green and unreviewed for ${ageOf(row.pr.updatedAt, now)}`, {
        anchor,
        href: row.pr.url,
      });
  }
  for (const pr of joined.unlinkedPrs) prProblems(pr, "", `pr-${pr.number}`);
  for (const wt of joined.orphanWorktrees) {
    add("Orphan worktree", `${wt.path} on ${wt.branch} has no in_progress bead and no open PR`);
  }
  return out;
}

/** Plain-text form of an attention item, for logs and tests. */
export function attentionText(a) {
  return `${a.label}: ${a.text}`;
}

/**
 * Open dependency ids a blocked bead is waiting on. `bd blocked --json`
 * (bd 1.3) carries them as `blocked_by`; the full `dependencies` list is
 * the fallback for other bd commands, where `blocks` edges and untyped
 * edges count (the filter below accepts both) and `related` edges do not.
 * @param {any} bead
 * @returns {string[]}
 */
export function blockersOf(bead) {
  if (Array.isArray(bead?.blocked_by) && bead.blocked_by.length > 0) return bead.blocked_by.filter(Boolean);
  const deps = Array.isArray(bead?.dependencies) ? bead.dependencies : [];
  return deps
    .filter((d) => (d.type === "blocks" || d.type === undefined) && (!d.issue_id || d.issue_id === bead.id))
    .map((d) => d.depends_on_id)
    .filter(Boolean);
}

/**
 * Ids this bead blocks, from its `dependencies` edges where it is the target.
 * @param {any} bead
 * @returns {string[]}
 */
export function blockedByThis(bead) {
  const deps = Array.isArray(bead?.dependencies) ? bead.dependencies : [];
  return deps
    .filter((d) => d.type === "blocks" && d.depends_on_id === bead.id && d.issue_id)
    .map((d) => d.issue_id);
}

// ---------------------------------------------------------------------------
// Release progress
// ---------------------------------------------------------------------------

/** The label shape beads carry to scope them to a release: `v0.7.0`. */
export const RELEASE_LABEL = /^v\d+\.\d+\.\d+$/;

/** Groups a remaining release bead can fall into, in display order. */
export const RELEASE_GROUPS = ["in_progress", "ready", "blocked", "deferred"];
export const RELEASE_GROUP_TITLE = { in_progress: "In progress", ready: "Ready", blocked: "Blocked", deferred: "Deferred" };

function compareSemver(a, b) {
  const x = a.slice(1).split(".").map(Number);
  const y = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The release in progress: the highest semver label carried by any bead that
 * is not closed. When every labelled bead is closed it falls back to the
 * highest label overall (the release is done but not cut), and to `null`
 * when no bead carries a semver label at all. Compared as semver, so v0.10.0
 * beats v0.9.0.
 * @param {any[]} beads
 * @returns {string | null}
 */
export function releaseLabelOf(beads) {
  const open = new Set();
  const all = new Set();
  for (const b of beads ?? []) {
    for (const l of b?.labels ?? []) {
      if (!RELEASE_LABEL.test(l)) continue;
      all.add(l);
      if (b.status !== "closed") open.add(l);
    }
  }
  const pool = open.size > 0 ? open : all;
  return pool.size > 0 ? [...pool].sort(compareSemver).at(-1) : null;
}

/**
 * Done/total for one release label, and the beads still to do grouped by
 * what stands between them and done. `blockedIds` comes from `bd blocked`,
 * because a labelled bead's own dependency list cannot tell an open blocker
 * from a closed one. Closed beads count towards `done` and appear in no
 * group.
 * @param {any[]} beads
 * @param {string} label
 * @param {Set<string>} blockedIds
 */
export function releaseProgress(beads, label, blockedIds = new Set()) {
  const labelled = (beads ?? []).filter((b) => (b?.labels ?? []).includes(label));
  const done = labelled.filter((b) => b.status === "closed").length;
  const groups = Object.fromEntries(RELEASE_GROUPS.map((g) => [g, []]));
  for (const b of labelled) {
    if (b.status === "closed") continue;
    let g = "ready";
    if (b.status === "in_progress") g = "in_progress";
    else if (b.status === "deferred") g = "deferred";
    else if (b.status === "blocked" || blockedIds.has(b.id)) g = "blocked";
    groups[g].push(b);
  }
  for (const g of RELEASE_GROUPS) {
    groups[g].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || String(a.id).localeCompare(String(b.id)));
  }
  return { label, total: labelled.length, done, remaining: labelled.length - done, groups };
}
