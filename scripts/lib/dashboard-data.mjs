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
/**
 * Hours a green, unreviewed PR may sit before the dashboard nags about it,
 * measured on the PR's own updatedAt (the same field the nag prints).
 */
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
 * Check conclusions / states that mean "this check passed or does not apply".
 * Enumerated rather than inferred: anything not listed here and not in
 * CHECKS_RED or CHECKS_PENDING is "unknown", never green, so a conclusion
 * GitHub adds later cannot read as CI green.
 */
export const CHECKS_GREEN = ["SUCCESS", "NEUTRAL", "SKIPPED"];
/** Conclusions / states that mean a check failed or could not run. */
export const CHECKS_RED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];
/** States of a check that has not finished; "" is a CheckRun with no conclusion yet. */
export const CHECKS_PENDING = ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"];

/**
 * Collapses a PR's statusCheckRollup into one word. Precedence is red, then
 * unknown, then pending; "green" needs every check in CHECKS_GREEN.
 * @param {Array<{conclusion?: string, state?: string, status?: string}>} rollup
 * @returns {"green" | "red" | "pending" | "unknown" | "none"}
 */
export function summariseChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  const states = rollup.map((c) => String(c?.conclusion || c?.state || c?.status || "").toUpperCase());
  if (states.some((s) => CHECKS_RED.includes(s))) return "red";
  if (states.some((s) => !CHECKS_GREEN.includes(s) && !CHECKS_PENDING.includes(s))) return "unknown";
  if (states.some((s) => CHECKS_PENDING.includes(s))) return "pending";
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
 * `joinBead` is the same per-bead lookup the rows are built with, returned so
 * every other bead the page renders (Ready, Blocked, the release section) is
 * joined to its open PR and worktree too, rather than rendered as if it had
 * neither. A row the renderer would build from `{ bead }` alone says "no PR"
 * about a PR nobody looked up.
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

  const inProgressIds = new Set(inProgress.map((b) => b.id));
  /**
   * One bead joined to its open PR, worktree and cmux agent. `stale` only
   * applies to a bead that is in progress; a ready bead that nobody has
   * touched for a week is not stale, it is waiting.
   * @param {any} bead
   */
  const joinBead = (bead) => {
    const pr = prByBead.get(bead.id) ?? null;
    const wt = wtByBead.get(bead.id) ?? (pr ? wtByBranch.get(pr.headRefName) : null) ?? null;
    const items = wt ? itemsByCwd.get(normalisePath(wt.path)) ?? [] : [];
    const agentState = items.map(agentStateOf).find((s) => s !== "") ?? "";
    const ageHours = (now.getTime() - Date.parse(bead.updated_at ?? "")) / 3600000;
    const inProgressNow = inProgressIds.has(bead.id) || bead.status === "in_progress";
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
      stale: inProgressNow && Number.isFinite(ageHours) && ageHours > STALE_IN_PROGRESS_HOURS,
      ageHours,
    };
  };
  const rows = inProgress.map(joinBead);

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

  return { rows, unlinkedPrs, orphanWorktrees, joinBead };
}

/**
 * The PRs a bead records as having shipped it (`metadata.prs`, e.g.
 * "gh-227,gh-231"), which the bead-close step writes (CLAUDE.md).
 * cut-release reads it to check each PR merged; what it writes is
 * `released_in`. Unlike the
 * recently-merged list it is not truncated, so it is what tells "this bead has
 * had a PR" apart from "nobody has started it".
 * @param {any} bead
 * @returns {string[]}
 */
export function recordedPrsOf(bead) {
  const raw = bead?.metadata?.prs;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
 * GitHub labels that mean "reviewed clean, stopped for a human merge", and
 * bead labels that mean "waiting on a human". Defaults only: buildAttention
 * takes both as parameters so they can move into per-repo config.
 */
export const HUMAN_WAIT_PR_LABELS = ["needs-human-merge"];
export const HUMAN_WAIT_BEAD_LABELS = ["stalled-on-human", "human-only"];

/** Label names of a PR ({name} objects from gh) or a bead (strings from bd). */
function labelNames(x) {
  return (x?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
}

/** The first of `wanted` that `x` carries, or null. */
export function humanWaitLabel(x, wanted) {
  return labelNames(x).find((l) => wanted.includes(l)) ?? null;
}

/**
 * Open (not closed) beads from the in-progress, ready, blocked and
 * labelled-bead lists, each once (first list wins by id). The labelled list
 * is the only one that carries deferred beads; the printed sentence names
 * the lists it covers (humanWaitChecked).
 * @param {any[][]} lists
 */
export function uniqueOpenBeads(...lists) {
  const seen = new Map();
  for (const b of lists.flat()) if (b?.id && b.status !== "closed" && !seen.has(b.id)) seen.set(b.id, b);
  return [...seen.values()];
}

/**
 * The sentence that makes a zero visible: how many PRs and beads the
 * human-wait rules actually looked at. A source that is down is named as
 * unavailable instead of counted as 0 (dev-dashboard.test.mjs, K3 test).
 * @param {{ prs: any[], beads: any[], prsUp: boolean, beadsUp: boolean }} a
 */
export function humanWaitChecked({ prs, beads, prsUp, beadsUp, labelledUp = true, labelled = 0 }) {
  const lists = "beads from the in_progress, ready and blocked lists";
  // The labelled-bead source (bd list --all --label-any ...) is the only one
  // that sees deferred beads. Down, the sentence says so and still counts what
  // the three lists gave; the page never then reads as a complete check.
  const where = labelledUp
    ? `${lists} plus ${plural(labelled, "labelled bead")} of any non-closed status`
    : `${lists}; labelled-bead source unavailable (bd down), so deferred beads were not checked`;
  if (prsUp && beadsUp) return `${plural(prs.length, "PR")} and ${plural(beads.length, "bead")} checked for human-wait labels (${where})`;
  if (prsUp) return `${plural(prs.length, "PR")} checked for human-wait labels; beads unavailable (bd down)`;
  if (beadsUp) return `PRs unavailable (gh down); ${plural(beads.length, "bead")} checked for human-wait labels (${where})`;
  return "PRs unavailable (gh down); beads unavailable (bd down); nothing checked for human-wait labels";
}

/**
 * Everything that needs a human, most urgent first.
 * @param {object} args
 * @param {string} args.prefix bead id prefix, e.g. "ugcportal"
 * @param {ReturnType<typeof joinRows>} args.joined
 * @param {any[]} args.currentItems
 * @param {Record<string, {ok: boolean, error?: string}>} args.sources
 * @param {Date} args.now
 * @param {any[]} [args.prs] open PRs, for the human-wait rule
 * @param {any[]} [args.beads] open beads (see uniqueOpenBeads), for the human-wait rule
 * @param {string[]} [args.humanWaitPrLabels]
 * @param {string[]} [args.humanWaitBeadLabels]
 * @returns {Attention[]}
 */
export function buildAttention({
  prefix,
  joined,
  currentItems,
  sources,
  now,
  prs = [],
  beads = [],
  humanWaitPrLabels = HUMAN_WAIT_PR_LABELS,
  humanWaitBeadLabels = HUMAN_WAIT_BEAD_LABELS,
}) {
  /** @type {Attention[]} */
  const out = [];
  const add = (label, text, extra = {}) => out.push({ label, text, severity: "warn", ...extra });
  // A rule that concludes "there is no PR / worktree / bead" from a source
  // that is down would be a guess, so each such rule waits for every source
  // its conclusion rests on and the "Source down" item is what the human
  // sees instead: "Unstarted claim" waits for prs, worktrees and merged
  // (and a PR recorded in the bead's metadata.prs rules it out outright),
  // "Orphan worktree" for inProgress and prs (worktrees is its own list),
  // and "Stale" says its PR state is unknown rather than "has no open PR".
  const up = (k) => sources[k]?.ok === true;

  for (const [name, res] of Object.entries(sources)) {
    if (!res.ok) add("Source down", `${name} is unavailable: ${res.error}`, { severity: "bad" });
  }
  for (const item of currentItems) {
    const n = (item.attention?.length ?? 0) + (item.possible_human_obligations?.length ?? 0);
    if (n > 0) add("Agent waiting", `${item.label ?? item.cwd} has ${plural(n, "item")} needing you`, { severity: "bad" });
  }
  // Human-wait rule 1. Rests on prs only: with prs down `prs` is [], which
  // would read as "no PR is waiting", so it is skipped and the "Source down"
  // item above is what the page shows instead.
  for (const pr of up("prs") ? prs : []) {
    const label = humanWaitLabel(pr, humanWaitPrLabels);
    if (!label) continue;
    const bead = extractBeadId(pr.headRefName, prefix) ?? extractBeadId(pr.title, prefix);
    add("Merge needed", `#${pr.number}${bead ? ` for ${bead}` : ""}, reviewed clean, sensitive path (${label})`, {
      anchor: `pr-${pr.number}`,
      href: pr.url,
      severity: "bad",
    });
  }
  const prProblems = (pr, suffix, anchor) => {
    const extra = { anchor, href: pr.url };
    if (pr.reviewDecision === "CHANGES_REQUESTED") add("Changes requested", `#${pr.number}${suffix}`, { ...extra, severity: "bad" });
    const ci = summariseChecks(pr.statusCheckRollup);
    if (ci === "red") add("CI red", `#${pr.number}${suffix}`, { ...extra, severity: "bad" });
    else if (ci === "unknown") add("CI unknown", `#${pr.number}${suffix} has a check conclusion this dashboard does not recognise`, extra);
    if (pr.mergeable === "CONFLICTING") add("Merge conflict", `#${pr.number}${suffix}`, { ...extra, severity: "bad" });
  };
  // A bead whose PR already merged but which is still in_progress is a
  // different problem from one nobody has started on. The recent merges name
  // the PR for the "bd close" advice; they are capped at 8, so a bead whose
  // PR fell off them is kept from reading as unstarted by its own
  // metadata.prs instead (see "Unstarted claim" below).
  const merged = sources.merged?.ok && Array.isArray(sources.merged.value) ? sources.merged.value : [];
  // Whole-id match through the same extractBeadId the join uses, never a
  // substring: ugcportal-abc.1 or ugcportal-abcd is not ugcportal-abc.
  const mergedFor = (id) =>
    merged.find((pr) => extractBeadId(pr.headRefName, prefix) === id || extractBeadId(pr.title, prefix) === id);
  for (const row of joined.rows) {
    const id = row.bead.id;
    const anchor = `bead-${id}`;
    if (row.pr) prProblems(row.pr, ` for ${id}`, anchor);
    const mergedPr = !row.pr ? mergedFor(id) : null;
    // "bd close" also rests on there being no open PR left for the bead (a
    // follow-up fix PR keeps it open), and with prs down row.pr is null
    // whether or not one exists, so the advice waits for prs.
    if (mergedPr)
      add("Merged, bead open", `#${mergedPr.number} for ${id} merged ${ageOf(mergedPr.mergedAt, now)} ago but the bead is still in_progress. ${up("prs") ? `bd close ${id}?` : "Its open PRs are unknown, so check them before closing it."}`, {
        anchor,
        href: mergedPr.url,
      });
    else if (row.stale)
      // "open": prs is the open list only, and a PR that merged can have fallen
      // off the 8 recent merges, so "has no PR" would be a guess.
      add("Stale", `${id} has had no update for ${ageOf(row.bead.updated_at, now)} and ${row.pr ? "has an open PR" : up("prs") ? "has no open PR" : "its PR state is unknown"}`, { anchor });
    // "Nobody has started it" rests on four inputs: no open PR (prs), no
    // worktree (worktrees), no PR among the recent merges (merged, which is
    // capped at 8 and so cannot alone say "never had one"), and no PR
    // recorded on the bead itself (metadata.prs, which is not capped). A down
    // source, or a PR recorded on the bead, means it is not concluded.
    else if (!row.pr && !row.worktree && recordedPrsOf(row.bead).length === 0 && up("prs") && up("worktrees") && up("merged"))
      add("Unstarted claim", `${id} is in_progress with no worktree, no open or recently merged PR, and no PR recorded in its metadata.prs`, { anchor });
    // Decided and printed on the same field, the PR's updatedAt. An
    // unparseable date gives NaN, and NaN > n is false, so it does not nag.
    // A working agent suppresses the nag, and agentState comes from cmux
    // current joined through git worktree list. With either down the agent
    // state is not known: the nag still fires (its own claim, green and
    // unreviewed, rests on prs alone) and says the agent state is unknown.
    const agentKnown = up("current") && up("worktrees");
    const prAgeHours = row.pr ? (now.getTime() - Date.parse(row.pr.updatedAt ?? "")) / 3600000 : NaN;
    if (
      row.pr &&
      !row.pr.isDraft &&
      row.checks === "green" &&
      !row.pr.reviewDecision &&
      row.agentState !== "working" &&
      prAgeHours > REVIEW_WAIT_HOURS
    )
      add("Review pending", `#${row.pr.number} for ${id} is green and unreviewed for ${ageOf(row.pr.updatedAt, now)}${agentKnown ? "" : " (agent state unknown)"}`, {
        anchor,
        href: row.pr.url,
      });
  }
  for (const pr of joined.unlinkedPrs) prProblems(pr, "", `pr-${pr.number}`);
  // Human-wait rule 2: one item per bead (uniqueOpenBeads), whether or not
  // its PR is also a "Merge needed" item. A bead list that is down is a
  // "Source down" item above, and its beads are simply absent here.
  for (const bead of beads) {
    const label = humanWaitLabel(bead, humanWaitBeadLabels);
    // A deferred bead has no row on the page, so no anchor: a link to it would be dead.
    const deferred = bead.status === "deferred";
    if (label)
      add("Waiting on you", `${bead.id} \u2014 ${bead.title}${deferred ? " (deferred)" : ""} (${label})`, deferred ? {} : { anchor: `bead-${bead.id}` });
  }
  for (const wt of up("inProgress") && up("prs") ? joined.orphanWorktrees : []) {
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

/**
 * Orders two release labels (`v0.7.0`) as semver, so v0.10.0 sorts after
 * v0.9.0. Its only caller is releaseLabelOf, which only passes labels that
 * match RELEASE_LABEL; anything else throws rather than sorting somewhere.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, 0 or positive
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
    if (!m) throw new Error(`compareSemver: ${JSON.stringify(v)} is not a release label like v1.2.3`);
    return m.slice(1).map(Number);
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The release in progress: the lowest semver label not yet fully released,
 * that is, carried by any bead that is either not closed or closed without
 * `released_in`. That is the next release to cut: beads already labelled for
 * a later one do not move it on, and a fully closed but uncut release stays
 * on the page (saying it is time to cut it) until cut-release has stamped
 * every bead in it. When every labelled bead is released it falls back to the
 * highest label overall (so the page says that label is cut), and to `null`
 * when no bead carries a semver label at all. Compared as semver, so v0.9.0
 * comes before v0.10.0.
 * @param {any[]} beads
 * @returns {string | null}
 */
export function releaseLabelOf(beads) {
  const unreleased = new Set();
  const all = new Set();
  for (const b of beads ?? []) {
    for (const l of b?.labels ?? []) {
      if (!RELEASE_LABEL.test(l)) continue;
      all.add(l);
      if (b.status !== "closed" || releasedInOf(b) === "") unreleased.add(l);
    }
  }
  if (unreleased.size > 0) return [...unreleased].sort(compareSemver)[0];
  return all.size > 0 ? [...all].sort(compareSemver).at(-1) : null;
}

/**
 * The version cut-release shipped a bead in (`metadata.released_in`, e.g.
 * "v0.6.0"), or "" when it has not shipped it. cut-release selects every
 * closed bead without it and writes it on each one it releases, so this is
 * the exact record of "released", where the release label is only the plan.
 * @param {any} bead
 * @returns {string}
 */
export function releasedInOf(bead) {
  const v = bead?.metadata?.released_in;
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Done/total for one release label, and the beads still to do grouped by
 * what stands between them and done. `blockedIds` comes from `bd blocked`,
 * because a labelled bead's own dependency list cannot tell an open blocker
 * from a closed one. Every labelled bead is in exactly one of three states:
 * remaining (not closed, in one of the groups), unreleased (closed, no
 * `released_in` yet, so the next cut-release considers it; cut-release
 * itself still drops one whose PR has not merged) or released
 * (closed with `released_in`). `done` is unreleased + released.
 * `releasedIn` lists the distinct `released_in` values, sorted.
 * @param {any[]} beads
 * @param {string} label
 * @param {Set<string>} blockedIds
 */
export function releaseProgress(beads, label, blockedIds = new Set()) {
  const labelled = (beads ?? []).filter((b) => (b?.labels ?? []).includes(label));
  const closed = labelled.filter((b) => b.status === "closed");
  const released = closed.filter((b) => releasedInOf(b) !== "");
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
  return {
    label,
    total: labelled.length,
    done: closed.length,
    released: released.length,
    unreleased: closed.length - released.length,
    releasedIn: [...new Set(released.map(releasedInOf))].sort(),
    remaining: labelled.length - closed.length,
    groups,
  };
}
