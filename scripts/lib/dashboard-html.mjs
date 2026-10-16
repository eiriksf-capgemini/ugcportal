/**
 * HTML renderer for the dev dashboard (scripts/dev-dashboard.mjs).
 *
 * Produces ONE self-contained file: no external CSS, JS or fonts, so it
 * renders from a file:// URL inside a cmux browser pane. The page is dense
 * by default and expands on demand:
 *
 *   - every bead and PR is a <details> row: one line closed, the full record
 *     (description, acceptance criteria, notes, checks, PR body, commands) open
 *   - sections collapse, long queues show QUEUE_LIMIT rows then "Show all"
 *   - a filter box narrows every section at once
 *   - the page reloads itself every `refreshSeconds`; while the filter has
 *     focus, text is selected or the pointer rests on an open row it waits,
 *     but it forces the reload once five intervals have passed since it loaded
 *   - open rows, collapsed sections, "show all", filter text and scroll
 *     position survive the reload (localStorage / sessionStorage)
 *   - a stale banner appears when the file has not been rewritten for three
 *     refresh intervals, so a dead --watch loop is visible instead of silent
 *
 * Everything from bd, gh, cmux or git goes through esc() before it reaches
 * the document. No exceptions, including attribute values.
 *
 * A count derived from a source that failed renders as "-", never as 0, in
 * the header tiles and the section headings alike (test: "a down source never
 * shows a 0 count"). A section with more than one input lists every input
 * that is down and shows no rows rather than a guess from the inputs left.
 */
import path from "node:path";

import {
  agentStateOf,
  ageOf,
  blockedByThis,
  blockersOf,
  buildAttention,
  HUMAN_WAIT_BEAD_LABELS,
  HUMAN_WAIT_PR_LABELS,
  humanWaitChecked,
  humanWaitLabel,
  uniqueOpenBeads,
  extractBeadId,
  joinRows,
  normalisePath,
  parseWorktrees,
  plural,
  QUEUE_LIMIT,
  RELEASE_GROUP_TITLE,
  RELEASE_GROUPS,
  releaseLabelOf,
  releaseProgress,
  summariseChecks,
} from "./dashboard-data.mjs";

/** Characters of description / notes / PR body shown before "open in bd/gh". */
export const TEXT_CAP = 4000;

/** HTML-escapes text and attribute values. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Inline SVG sprite (Feather-style 24x24 strokes, MIT). Referenced with
 * <use href="#i-name"> so the page stays a single file.
 */
const ICON_PATHS = {
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  commit: '<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  "x-circle": '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  circle: '<circle cx="12" cy="12" r="10" stroke-dasharray="3 3"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  draft: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  pause: '<circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/>',
  message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  jump: '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  text: '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l5.64 5.36A9 9 0 0 0 20.49 15"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
};

function sprite() {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${Object.entries(ICON_PATHS)
    .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`)
    .join("")}</svg>`;
}

/**
 * An inline icon. With a label it is an accessible image (aria-label and a
 * tooltip); without one it is decorative and hidden from assistive tech.
 * @param {keyof typeof ICON_PATHS} name
 * @param {string} [label]
 * @param {string} [cls]
 */
export function icon(name, label, cls = "") {
  if (!ICON_PATHS[name]) throw new Error(`unknown icon ${name}`);
  const c = `ic${cls ? ` ${cls}` : ""}`;
  if (label) return `<svg class="${c}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><use href="#i-${name}"/></svg>`;
  return `<svg class="${c}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const CHECK_ICON = { green: "check-circle", red: "x-circle", pending: "clock", unknown: "alert", none: "circle" };
const CHECK_CLASS = { green: "ok", red: "bad", pending: "warn", unknown: "warn", none: "muted" };
const REVIEW_ICON = { approved: "check-circle", "changes requested": "edit", "review required": "eye", unreviewed: "eye", draft: "draft" };
const REVIEW_CLASS = { approved: "ok", "changes requested": "bad", "review required": "warn", unreviewed: "muted", draft: "muted" };
const AGENT_ICON = { working: "activity", idle: "pause", waiting: "message", ended: "cpu", attached: "cpu" };

/** CI state as an accessible icon. */
function ciIcon(kind) {
  return icon(CHECK_ICON[kind], CHECK_LABEL[kind], `ci ${CHECK_CLASS[kind]}`);
}

/** Review state as an accessible icon. */
function reviewIcon(pr) {
  const word = reviewWord(pr);
  return icon(REVIEW_ICON[word] ?? "eye", `review: ${word}`, REVIEW_CLASS[word] ?? "muted");
}

/** Agent state as an icon pill with hidden text. */
function agentPill(state) {
  if (!state) return "";
  return `<span class="agent ${esc(state)}" title="${esc(AGENT_LABEL[state])}">${icon(AGENT_ICON[state])}<span class="sr">${esc(AGENT_LABEL[state])}</span></span>`;
}

const CHECK_LABEL = { green: "CI green", red: "CI red", pending: "CI pending", unknown: "CI unknown", none: "no CI" };
const AGENT_LABEL = { working: "agent working", idle: "agent idle", waiting: "agent waiting", ended: "agent ended", attached: "agent attached", "": "" };

function reviewWord(pr) {
  if (!pr) return "";
  if (pr.isDraft) return "draft";
  switch (pr.reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes requested";
    case "REVIEW_REQUIRED":
      return "review required";
    default:
      return "unreviewed";
  }
}

function mergeWord(pr) {
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (pr.mergeable === "MERGEABLE") return "clean";
  return "merge state unknown";
}

/** Value or a quiet "Not set" placeholder. */
function val(v, placeholder = "Not set") {
  return v === null || v === undefined || v === "" ? `<span class="muted">${esc(placeholder)}</span>` : esc(v);
}

/** Pre-wrapped text, capped, with a pointer to the full record. */
function textBlock(text, cap, moreHint) {
  if (!text) return `<span class="muted">Not set</span>`;
  const s = String(text);
  if (s.length <= cap) return `<pre>${esc(s)}</pre>`;
  return `<pre>${esc(s.slice(0, cap))}</pre><p class="muted">${esc(`${s.length - cap} more characters. ${moreHint}`)}</p>`;
}

function time(iso, now) {
  if (!iso) return `<span class="muted">?</span>`;
  return `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ageOf(iso, now))}</time>`;
}

function timeIcon(iso, now) {
  return `<span class="age" title="updated ${esc(iso ?? "?")}">${icon("clock")}${time(iso, now)}</span>`;
}

function copyable(cmd) {
  return `<span class="cmd"><code>${esc(cmd)}</code><button type="button" class="copy" data-copy="${esc(cmd)}" aria-label="Copy command" title="Copy command">${icon("copy")}${icon("check", undefined, "done")}</button></span>`;
}

function link(href, text, cls = "", iconName = null) {
  return `<a href="${esc(href)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ""}>${iconName ? icon(iconName) : ""}${esc(text)}</a>`;
}

/**
 * Chip linking to a bead row in this document when it exists. "hot" says the
 * bead is in progress, so with bd list --status in_progress down no chip can
 * be hot and every chip is marked "in-progress state unknown" (dashed, with a
 * title and screen-reader text) instead of reading as "not in progress".
 */
function beadChip(id, ctx) {
  const { known, inProgressIds } = ctx;
  const hot = inProgressIds.has(id) ? " hot" : "";
  const unk = ctx.inProgressUp ? "" : " unk";
  const unkTitle = ctx.inProgressUp ? "" : " (in-progress state unknown: bd list --status in_progress is down)";
  const unkSr = ctx.inProgressUp ? "" : `<span class="sr"> in-progress state unknown</span>`;
  const title = known.get(id)?.title;
  if (known.has(id)) return `<a href="#bead-${esc(id)}" class="chip jump${hot}${unk}" title="${esc(`${title ?? ""}${unkTitle}`)}">${esc(id)}${unkSr}</a>`;
  return `<span class="chip${hot}${unk}" title="${esc(`Not in this dashboard: bd show ${id}${unkTitle}`)}">${esc(id)}${unkSr}</span>`;
}

/**
 * The expanded body of a bead row.
 */
function beadBody({ bead, pr, worktree, cmuxItems, agentState }, ctx) {
  const { now, repoUrl } = ctx;
  const meta = bead.metadata ?? {};
  const dependsOn = blockersOf(bead);
  const blocks = blockedByThis(bead);
  const rows = [];
  rows.push(["Title", `<span class="full-title">${esc(bead.title)}</span>`, "info"]);
  rows.push([
    "Status",
    `${esc(bead.status ?? "?")} · ${esc(bead.issue_type ?? "task")} · P${esc(bead.priority ?? "?")} · ${icon("user")}${val(bead.assignee)} · created ${time(bead.created_at, now)} ago · updated ${time(bead.updated_at, now)} ago`,
    "activity",
  ]);
  rows.push([
    "Classification",
    `${val(meta.cc_type, "no cc_type")}(${val(meta.cc_scope, "no cc_scope")}) · model ${val(meta.model)} / ${val(meta.model_effort)}${
      meta.model_why ? `<div class="muted why">${esc(meta.model_why)}</div>` : ""
    }`,
    "tag",
  ]);
  if (dependsOn.length || blocks.length) {
    rows.push([
      "Dependencies",
      `${dependsOn.length ? `depends on ${dependsOn.map((id) => beadChip(id, ctx)).join(" ")}` : ""}${
        dependsOn.length && blocks.length ? " · " : ""
      }${blocks.length ? `blocks ${blocks.map((id) => beadChip(id, ctx)).join(" ")}` : ""}`,
      "link",
    ]);
  } else if ((bead.dependency_count ?? 0) + (bead.dependent_count ?? 0) > 0) {
    rows.push(["Dependencies", `<span class="muted">${esc(plural(bead.dependency_count ?? 0, "dependency", "dependencies"))}, ${esc(plural(bead.dependent_count ?? 0, "dependent"))}. bd show ${esc(bead.id)}</span>`, "link"]);
  }
  rows.push(["Description", textBlock(bead.description, TEXT_CAP, `bd show ${bead.id}`), "text"]);
  rows.push(["Acceptance criteria", textBlock(bead.acceptance_criteria, TEXT_CAP, `bd show ${bead.id}`), "list"]);
  if (bead.notes) rows.push(["Notes", textBlock(bead.notes, TEXT_CAP, `bd show ${bead.id}`), "note"]);
  if (pr) rows.push(["Pull request", prBody(pr, ctx, false), "pr"]);
  else if (!ctx.prsUp) rows.push(["Pull request", `<span class="muted">unknown: gh pr list is down</span>`, "pr"]);
  if (worktree) rows.push(["Worktree", `<code>${esc(worktree.path)}</code> on ${icon("branch")}<code>${esc(worktree.branch ?? "detached")}</code> at ${esc(worktree.head ?? "?")}`, "folder"]);
  else if (!ctx.worktreesUp) rows.push(["Worktree", `<span class="muted">unknown: git worktree list is down</span>`, "folder"]);
  // The agent state rests on git worktree list and, for a bead with a
  // worktree, on cmux current; agentUnknownReason says when it is unknown.
  const agentUnknown = agentUnknownReason({ worktree }, ctx);
  if (cmuxItems.length)
    rows.push(["cmux", cmuxItems.map((it) => `${esc(it.label ?? it.cwd)} ${agentPill(agentStateOf(it)) || `<span class="muted">no agent</span>`}`).join("<br>"), "layout"]);
  else if (agentState) rows.push(["cmux", agentPill(agentState), "layout"]);
  else if (agentUnknown) rows.push(["cmux", `<span class="muted">unknown: ${esc(agentUnknown)}</span>`, "layout"]);
  const cmds = [`bd show ${bead.id}`];
  if (pr) cmds.push(`gh pr view ${pr.number} --web`);
  if (worktree) cmds.push(`cd ${worktree.path}`);
  // Suggesting a claim concludes "nobody holds this": not already in progress
  // or closed, and no open PR or worktree. `pr` and `worktree` come from
  // joinRows' joinBead for every bead row on the page, so the last two are
  // looked up, not assumed; with either source down they are not known, so
  // the suggestion waits for both.
  const claimable = bead.status !== "in_progress" && bead.status !== "closed" && !ctx.inProgressIds.has(bead.id);
  if (claimable && !worktree && !pr && repoUrl && ctx.prsUp && ctx.worktreesUp) cmds.push(`bd update ${bead.id} --claim`);
  rows.push(["Commands", cmds.map(copyable).join(" "), "terminal"]);
  return dl(rows);
}

/** Expanded body of a PR row (or the PR block inside a bead row). */
function prBody(pr, ctx, standalone) {
  const { now, repoUrl, prefix, known } = ctx;
  const rows = [];
  if (standalone) rows.push(["Title", `<span class="full-title">${link(pr.url, pr.title, "", "external")}</span>`, "info"]);
  else rows.push(["", `${link(pr.url, `#${pr.number} ${pr.title}`, "", "external")}`]);
  const branchLink = repoUrl ? link(`${repoUrl}/tree/${pr.headRefName}`, pr.headRefName) : esc(pr.headRefName);
  rows.push([
    "Branch",
    `${icon("branch")}<code>${branchLink}</code> into <code>${esc(pr.baseRefName ?? "main")}</code> · ${esc(mergeWord(pr))} · +${esc(pr.additions ?? "?")} / -${esc(
      pr.deletions ?? "?",
    )} · ${icon("user")}${esc(pr.author?.login ?? "?")} · opened ${time(pr.createdAt, now)} ago · updated ${time(pr.updatedAt, now)} ago`,
    "merge",
  ]);
  rows.push(["Review", `${reviewIcon(pr)} ${esc(reviewWord(pr))}${pr.labels?.length ? ` · ${pr.labels.map((l) => `<span class="chip">${icon("tag")}${esc(l.name ?? l)}</span>`).join(" ")}` : ""}`, "eye"]);
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  if (checks.length) {
    const seen = new Set();
    const items = [];
    for (const c of checks) {
      const name = c.name ?? c.context ?? "check";
      const concl = (c.conclusion || c.state || c.status || "pending").toLowerCase();
      const key = `${name}:${concl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = summariseChecks([c]);
      const label = c.detailsUrl || c.targetUrl ? link(c.detailsUrl ?? c.targetUrl, name) : esc(name);
      items.push(`<li>${ciIcon(kind)} ${label} <span class="muted">${esc(concl)}${c.workflowName ? ` · ${esc(c.workflowName)}` : ""}</span></li>`);
    }
    rows.push(["Checks", `<ul class="checks">${items.join("")}</ul>`, "check-circle"]);
  } else rows.push(["Checks", `<span class="muted">No checks reported</span>`, "check-circle"]);
  if (standalone) {
    const beadId = extractBeadId(pr.headRefName, prefix) ?? extractBeadId(pr.title, prefix);
    // "not in progress" is a conclusion from bd list --status in_progress, so
    // with that source down the row says the state is unknown instead.
    if (beadId)
      rows.push([
        "Bead",
        known.has(beadId)
          ? `<a href="#bead-${esc(beadId)}" class="jump">${icon("jump")}${esc(beadId)}</a>`
          : `${esc(beadId)} <span class="muted">(${ctx.inProgressUp ? "not in progress" : "in-progress state unknown"})</span>`,
        "tool",
      ]);
  }
  rows.push(["Body", textBlock(pr.body, TEXT_CAP, `gh pr view ${pr.number}`), "text"]);
  if (standalone) rows.push(["Commands", [`gh pr view ${pr.number} --web`, `gh pr checks ${pr.number}`, `gh pr diff ${pr.number}`].map(copyable).join(" "), "terminal"]);
  return dl(rows);
}

function dl(rows) {
  return `<dl>${rows
    .map(([k, v, ic]) => `<dt>${ic ? icon(ic) : ""}${esc(k)}</dt><dd>${v}</dd>`)
    .join("")}</dl>`;
}

/** Text the filter box matches against; lowercased, generous but bounded. */
function searchText(...parts) {
  return esc(
    parts
      .flat()
      .filter(Boolean)
      .map((p) => String(p).slice(0, 600))
      .join(" ")
      .toLowerCase(),
  );
}

/**
 * One bead as a collapsed row with an expandable body.
 * @param {object} row a joinRows() row: joined.rows for in-progress beads,
 *   joined.joinBead(bead) for every other bead, so each row carries its open
 *   PR and worktree
 * @param {object} ctx
 * @param {string} rightMeta extra summary content on the right
 * @param {boolean} overflow hidden until "Show all"
 */
/**
 * `idPrefix` keeps element ids unique when the same bead is rendered in two
 * sections: the primary queues use `bead-<id>`, the release section
 * `rel-<id>`. Jump links and chips always target the primary one.
 */
function beadRow(row, ctx, rightMeta, overflow, idPrefix = "bead") {
  const { bead } = row;
  const search = searchText(bead.id, bead.title, bead.metadata?.cc_scope, bead.metadata?.cc_type, bead.issue_type, row.pr?.number && `#${row.pr.number}`, row.pr?.headRefName, bead.description);
  return `<details class="row${overflow ? " overflow" : ""}${row.stale ? " stale" : ""}" id="${esc(idPrefix)}-${esc(bead.id)}" data-search="${search}">
<summary>
<span class="id">${esc(bead.id)}</span>
<span class="pri">P${esc(bead.priority ?? "?")}</span>
<span class="title" title="${esc(bead.title)}">${esc(bead.title)}</span>
<span class="meta">${humanWaitChip(bead, HUMAN_WAIT_BEAD_LABELS)}${rightMeta}</span>
</summary>
<div class="body">${beadBody({ cmuxItems: [], agentState: "", pr: null, worktree: null, ...row }, ctx)}</div>
</details>`;
}

/** The collapsed-line marker for a bead's PR when gh pr list is down. */
function prUnknownMark() {
  return `<span class="muted" title="gh pr list is down">${icon("pr", "PR state unknown", "muted")}</span>`;
}

/** The collapsed-line marker for a bead's worktree when git worktree list is down. */
function worktreeUnknownMark() {
  return `<span class="muted" title="git worktree list is down">${icon("folder", "worktree state unknown", "muted")}</span>`;
}

/**
 * Why a bead's agent state is unknown, or "" when it is known. The agent comes
 * from cmux current, joined to the bead through its worktree path (git
 * worktree list), so it is unknown whenever git worktree list is down, and
 * when cmux current is down for a bead that has a worktree. A bead with no
 * worktree while git worktree list answered has no workspace to join, so its
 * agent state is known: none.
 * @returns {string} e.g. "cmux current is down"
 */
function agentUnknownReason(row, ctx) {
  const down = [];
  if (!ctx.currentUp && (row.worktree || !ctx.worktreesUp)) down.push("cmux current");
  if (!ctx.worktreesUp) down.push("git worktree list");
  return down.length === 0 ? "" : `${down.join(" and ")} ${down.length === 1 ? "is" : "are"} down`;
}

/** The collapsed-line marker for a bead's agent when its state is unknown. */
function agentUnknownMark(reason) {
  return `<span class="muted" title="${esc(reason)}">${icon("cpu", "agent state unknown", "muted")}</span>`;
}

/**
 * A bead's worktree on its collapsed line: the worktree when it has one, the
 * unknown marker when git worktree list is down, nothing when it has none.
 */
function worktreeMeta(row, ctx) {
  if (row.worktree) return `<code class="muted wt" title="worktree ${esc(row.worktree.path)}">${icon("folder")}${esc(path.basename(row.worktree.path))}</code>`;
  return ctx.worktreesUp ? "" : worktreeUnknownMark();
}

function inProgressMeta(row, ctx) {
  const parts = [];
  if (row.pr) parts.push(`${link(row.pr.url, `#${row.pr.number}`, "", "pr")} ${ciIcon(row.checks)} ${reviewIcon(row.pr)}`);
  else if (ctx.prsUp) parts.push(`<span class="muted" title="no open pull request">${icon("pr", "no open PR", "muted")}</span>`);
  else parts.push(prUnknownMark());
  const agentUnknown = agentUnknownReason(row, ctx);
  parts.push(agentUnknown ? agentUnknownMark(agentUnknown) : agentPill(row.agentState));
  parts.push(worktreeMeta(row, ctx));
  parts.push(timeIcon(row.bead.updated_at, ctx.now));
  return parts.filter(Boolean).join(" ");
}

/**
 * The open PR and worktree of a bead outside "In progress", when it has
 * either. Nothing when it has neither and both sources answered: a ready bead
 * without a PR is the normal case, not something to mark. A down source reads
 * "unknown" instead, so "gh is down" never looks like "no PR".
 */
function linkedMeta(row, ctx) {
  const parts = [];
  if (row.pr) parts.push(`${link(row.pr.url, `#${row.pr.number}`, "", "pr")} ${ciIcon(row.checks)}`);
  else if (!ctx.prsUp) parts.push(prUnknownMark());
  parts.push(worktreeMeta(row, ctx));
  return parts.filter(Boolean).join(" ");
}

function blockedMeta(row, ctx) {
  const { bead } = row;
  const chips = blockersOf(bead).map((id) => beadChip(id, ctx)).join(" ");
  return [linkedMeta(row, ctx), `${icon("lock", "blocked by", "muted")} ${chips || `<span class="muted">?</span>`}`, timeIcon(bead.updated_at, ctx.now)].filter(Boolean).join(" ");
}

function queueMeta(row, ctx) {
  const { bead } = row;
  const parts = [linkedMeta(row, ctx)].filter(Boolean);
  if (bead.metadata?.cc_scope) parts.push(`<span class="muted chipish">${icon("tag")}${esc(bead.metadata.cc_scope)}</span>`);
  if (bead.issue_type && bead.issue_type !== "task") parts.push(`<span class="muted">${esc(bead.issue_type)}</span>`);
  parts.push(timeIcon(bead.updated_at, ctx.now));
  return parts.join(" ");
}

/** The human-wait label as a chip on a row's collapsed line, "" when it has none. */
function humanWaitChip(x, wanted) {
  const label = humanWaitLabel(x, wanted);
  return label ? `<span class="chip human-wait">${icon("tag")}${esc(label)}</span> ` : "";
}

function prRow(pr, ctx, overflow) {
  const checks = summariseChecks(pr.statusCheckRollup);
  const search = searchText(`#${pr.number}`, pr.title, pr.headRefName, pr.author?.login, pr.labels?.map((l) => l.name ?? l), pr.body);
  return `<details class="row${overflow ? " overflow" : ""}" id="pr-${esc(pr.number)}" data-search="${search}">
<summary>
<span class="id">${link(pr.url, `#${pr.number}`, "", "pr")}</span>
<span class="title" title="${esc(pr.title)}">${esc(pr.title)}</span>
<span class="meta">${humanWaitChip(pr, HUMAN_WAIT_PR_LABELS)}${ciIcon(checks)} ${reviewIcon(pr)} ${
    pr.mergeable === "CONFLICTING" ? icon("alert", "merge conflict", "bad") : ""
  }<code class="muted wt" title="${esc(pr.headRefName)}">${icon("branch")}${esc(pr.headRefName)}</code> <span class="num muted">+${esc(pr.additions ?? "?")} / -${esc(pr.deletions ?? "?")}</span> ${timeIcon(pr.updatedAt, ctx.now)}</span>
</summary>
<div class="body">${prBody(pr, ctx, true)}</div>
</details>`;
}

/**
 * A section: collapsible heading with count, then one of error / empty /
 * rows. `rows` is an array of already-rendered row strings. `inputs` lists
 * every source the rows are built from as [result, command]; one error block
 * is rendered per input that is down, and then no rows at all, because rows
 * built from the inputs that are left would be a guess (the release section
 * groups by `bd blocked`, the cmux section filters by `git worktree list`).
 */
function section({ key, title, count, inputs, rows, emptyText, limited = 0, iconName = "list" }) {
  const body = [];
  const downInputs = inputs.filter(([source]) => !source?.ok);
  if (downInputs.length > 0) {
    for (const [source, cmd] of downInputs)
      body.push(
        `<div class="error" role="alert">${icon("x-circle", undefined, "bad")}<div><strong>${esc(cmd)} unavailable.</strong> ${esc(source?.error ?? "no result")}<div class="muted">The rest of the dashboard is current. Fix the command and the next refresh fills this in.</div></div></div>`,
      );
  } else if (rows.length === 0) body.push(`<p class="empty">${esc(emptyText)}</p>`);
  else {
    body.push(rows.join("\n"));
    if (limited > 0) body.push(`<button type="button" class="more">${icon("chevron-down")}Show all ${esc(count)}</button>`);
  }
  body.push(`<p class="nomatch" hidden>No rows here match <q class="q"></q>. <button type="button" class="clear">Clear filter</button></p>`);
  return `<details class="sec" id="sec-${esc(key)}" open>
<summary><h2>${icon(iconName)}${esc(title)} <span class="count">${esc(count)}</span></h2></summary>
<div class="sec-body">${body.join("\n")}</div>
</details>`;
}

function deriveRepoUrl(prs, merged) {
  const url = prs[0]?.url ?? merged[0]?.url;
  if (!url) return null;
  const m = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return m ? m[1] : null;
}

/**
 * Renders the whole page.
 * @param {object} args
 * @param {string} args.repoName
 * @param {string} args.prefix bead id prefix
 * @param {Record<string, {ok: boolean, value?: any, error?: string}>} args.sources from gatherSources()
 * @param {Date} args.now
 * @param {number} [args.refreshSeconds]
 * @returns {{ html: string, attention: import("./dashboard-data.mjs").Attention[], joined: ReturnType<typeof joinRows> }}
 */
export function renderHtml({ repoName, prefix, sources, now, refreshSeconds = 30 }) {
  const get = (k) => (sources[k]?.ok ? sources[k].value : null);
  // A count is only a number when every source it is derived from answered;
  // otherwise "-", so a failed source never reads as "0 left".
  const countOf = (n, ...keys) => (keys.every((k) => sources[k]?.ok) ? n : "-");
  const inProgress = get("inProgress") ?? [];
  const ready = get("ready") ?? [];
  const blocked = get("blocked") ?? [];
  const prs = get("prs") ?? [];
  const merged = get("merged") ?? [];
  const worktrees = sources.worktrees?.ok ? parseWorktrees(sources.worktrees.value) : [];
  const currentItems = get("current")?.items ?? [];
  const summary = get("status")?.summary ?? {};
  const mainLog = sources.mainLog?.ok ? sources.mainLog.value.trim() : "";

  const joined = joinRows({ prefix, inProgress, prs, worktrees, currentItems, now });
  const labelledBeads = get("labelled") ?? [];
  const humanWaitBeads = uniqueOpenBeads(inProgress, ready, blocked, labelledBeads);
  const attention = buildAttention({ prefix, joined, currentItems, sources, now, prs, beads: humanWaitBeads });
  const checkedText = humanWaitChecked({
    prs,
    beads: humanWaitBeads,
    prsUp: sources.prs?.ok === true,
    beadsUp: ["inProgress", "ready", "blocked"].every((k) => sources[k]?.ok === true),
    labelledUp: sources.labelled?.ok === true,
    labelled: uniqueOpenBeads(labelledBeads).length,
  });
  const inProgressIds = new Set(inProgress.map((b) => b.id));
  const known = new Map();
  for (const b of [...inProgress, ...ready, ...blocked]) if (b?.id && !known.has(b.id)) known.set(b.id, b);
  const repoUrl = deriveRepoUrl(prs, merged);
  const ctx = {
    now,
    known,
    inProgressIds,
    repoUrl,
    prefix,
    prsUp: sources.prs?.ok === true,
    worktreesUp: sources.worktrees?.ok === true,
    currentUp: sources.current?.ok === true,
    inProgressUp: sources.inProgress?.ok === true,
  };
  // Computed here because the header tiles need it before the sections do.
  const releaseBeads = get("release") ?? [];
  const releaseLabel = releaseLabelOf(releaseBeads);
  const release = releaseLabel ? releaseProgress(releaseBeads, releaseLabel, new Set(blocked.map((b) => b.id))) : null;

  // Header -----------------------------------------------------------------
  const [mainSha, ...mainRest] = mainLog.split(" ");
  const mainText = mainLog ? `${icon("commit")}origin/main ${repoUrl ? link(`${repoUrl}/commit/${mainSha}`, mainSha) : esc(mainSha)} <span class="muted">${esc(mainRest.join(" "))}</span>` : `<span class="muted">${icon("commit")}origin/main unknown</span>`;
  const tiles = [
    ["needs", "Needs you", attention.length, attention.length > 0 ? "bad" : "ok", "bell"],
    ["inprogress", "In progress", countOf(inProgress.length, "inProgress"), "", "tool"],
    ["prs", "Open PRs", countOf(prs.length, "prs"), "", "pr"],
    ["ready", "Ready", countOf(ready.length, "ready"), "", "play"],
    ["blocked", "Blocked", countOf(blocked.length, "blocked"), "", "lock"],
    ["release", release ? `Left in ${release.label}` : "Release", release ? countOf(release.remaining, "release") : "-", "", "tag"],
  ]
    .map(([key, label, n, cls, ic]) => `<a class="tile ${cls}" href="#sec-${key}">${icon(ic)}<span class="n">${esc(n)}</span><span class="l">${esc(label)}</span></a>`)
    .join("");

  // Needs you ---------------------------------------------------------------
  const attnRows = attention.map(
    (a) =>
      `<li class="sev-${esc(a.severity)}">${icon(a.severity === "bad" ? "x-circle" : "alert", undefined, a.severity)}<span><strong>${esc(a.label)}:</strong> ${esc(a.text)}${
        a.anchor ? ` <a href="#${esc(a.anchor)}" class="jump act">${icon("jump")}Show</a>` : ""
      }${a.href ? ` ${link(a.href, "PR", "act", "external")}` : ""}</span></li>`,
  );
  const attnSection = `<section class="attn" id="sec-needs" aria-labelledby="attn-h">
<h2 id="attn-h">${icon("bell")}Needs you <span class="count">${attention.length}</span></h2>
<p class="muted checked" id="human-wait-checked">${esc(checkedText)}</p>
${attention.length === 0 ? `<p class="empty win">${icon("check-circle", undefined, "ok")}Nothing is waiting on you.</p>` : `<ul>${attnRows.join("\n")}</ul>`}
</section>`;

  // In progress -------------------------------------------------------------
  const inProgressRows = joined.rows.map((row) => beadRow(row, ctx, inProgressMeta(row, ctx), false));

  // PRs ---------------------------------------------------------------------
  const prRows = [...prs].sort((a, b) => b.number - a.number).map((pr) => prRow(pr, ctx, false));

  // cmux workspaces ---------------------------------------------------------
  const repoItems = currentItems.filter(
    (it) =>
      typeof it.cwd === "string" &&
      (it.cwd.includes(`/${repoName}`) || worktrees.some((w) => normalisePath(w.path) === normalisePath(it.cwd))),
  );
  const wsTable =
    repoItems.length === 0
      ? ""
      : `<div class="tablewrap"><table><colgroup><col style="width:44%"><col style="width:32%"><col style="width:14%"><col style="width:10%"></colgroup><thead><tr><th>Workspace</th><th>cwd</th><th>Agent</th><th>PRs</th></tr></thead><tbody>${repoItems
          .map((it) => {
            const st = agentStateOf(it);
            const prNums = (it.pull_requests ?? []).map((p) => (p.url ? link(p.url, `#${p.number}`) : esc(`#${p.number}`))).join(" ");
            return `<tr><td>${esc(it.label ?? "")}</td><td><code>${icon("folder")}${esc(String(it.cwd).replace(process.env.HOME ?? "\u0000", "~"))}</code></td><td>${
              agentPill(st) || `<span class="muted">no agent</span>`
            }</td><td>${prNums || `<span class="muted">-</span>`}</td></tr>`;
          })
          .join("")}</tbody></table></div>`;

  // Ready -------------------------------------------------------------------
  // Every bead row below goes through joined.joinBead, the same lookup the
  // in-progress rows are built with, so a ready or blocked bead with an open
  // PR or a worktree shows it and is never offered a claim.
  const readyRows = ready.map((b, i) => {
    const row = joined.joinBead(b);
    return beadRow(row, ctx, queueMeta(row, ctx), i >= QUEUE_LIMIT);
  });

  // Blocked -----------------------------------------------------------------
  const sortedBlocked = [...blocked].sort((a, b) => {
    const aHot = blockersOf(a).some((id) => inProgressIds.has(id)) ? 0 : 1;
    const bHot = blockersOf(b).some((id) => inProgressIds.has(id)) ? 0 : 1;
    return aHot - bHot || (a.priority ?? 9) - (b.priority ?? 9);
  });
  const blockedRows = sortedBlocked.map((b, i) => {
    const row = joined.joinBead(b);
    return beadRow(row, ctx, blockedMeta(row, ctx), i >= QUEUE_LIMIT);
  });

  // Release -----------------------------------------------------------------
  // Everything the release label still has to deliver, grouped by what stands
  // between it and done. Closed beads only count in the figures: done, and of
  // those how many cut-release has released (metadata.released_in) and how
  // many it has not.
  const releaseRows = [];
  if (release && release.remaining > 0) {
    const pct = release.total > 0 ? Math.round((release.done / release.total) * 100) : 0;
    releaseRows.push(
      `<div class="bar" role="progressbar" aria-label="${esc(release.label)} progress" aria-valuemin="0" aria-valuemax="${esc(release.total)}" aria-valuenow="${esc(release.done)}"><span style="width:${pct}%"></span></div>`,
      `<p class="progress muted">${esc(release.done)} of ${esc(release.total)} done · ${esc(release.released)} released · ${esc(release.unreleased)} not yet released · ${esc(plural(release.remaining, "bead"))} remaining · ${pct}%</p>`,
    );
    for (const g of RELEASE_GROUPS) {
      const list = release.groups[g];
      if (list.length === 0) continue;
      releaseRows.push(`<h3 class="grp">${esc(RELEASE_GROUP_TITLE[g])} <span class="count">${esc(list.length)}</span></h3>`);
      for (const b of list) {
        const row = joined.joinBead(b);
        const meta = g === "in_progress" ? inProgressMeta(row, ctx) : g === "blocked" ? blockedMeta(row, ctx) : queueMeta(row, ctx);
        releaseRows.push(beadRow(row, ctx, meta, false, "rel"));
      }
    }
  }
  // Every labelled bead closed: cut or not is read off each bead's
  // released_in, which cut-release writes on every bead it releases. One
  // closed bead without it is a candidate for the next cut-release, even
  // when others in the label were released earlier.
  let releaseEmpty = "No bead carries a semver label (v1.2.3), so there is no release to track. Label the beads that belong to the next release.";
  if (release && release.unreleased > 0)
    releaseEmpty = `Everything labelled ${release.label} is closed and ${release.unreleased} of them ${release.unreleased === 1 ? "is" : "are"} not yet released. Time to cut the release.`;
  else if (release)
    releaseEmpty = `${release.label} is cut (${plural(release.released, "bead")} released as ${release.releasedIn.join(", ")}); label the next release's beads.`;

  // Merged ------------------------------------------------------------------
  const mergedRows = merged.map((pr) => `<li>${icon("merge", undefined, "ok")}${link(pr.url, `#${pr.number}`)} ${esc(pr.title)} <span class="muted">merged ${esc(ageOf(pr.mergedAt, now))} ago</span></li>`);

  const sections = [
    attnSection,
    section({ key: "inprogress", title: "In progress", count: countOf(inProgress.length, "inProgress"), inputs: [[sources.inProgress, "bd list --status in_progress"]], rows: inProgressRows, emptyText: "No beads are in progress.", iconName: "tool" }),
    section({ key: "prs", title: "Open pull requests", count: countOf(prs.length, "prs"), inputs: [[sources.prs, "gh pr list"]], rows: prRows, emptyText: "No open pull requests.", iconName: "pr" }),
    section({ key: "cmux", title: "cmux workspaces on this repo", count: countOf(repoItems.length, "current", "worktrees"), inputs: [[sources.current, "cmux current"], [sources.worktrees, "git worktree list"]], rows: wsTable ? [wsTable] : [], emptyText: "No cmux workspace has this repo or one of its worktrees as cwd.", iconName: "layout" }),
    section({ key: "ready", title: "Ready to pick up", count: countOf(ready.length, "ready"), inputs: [[sources.ready, "bd ready"]], rows: readyRows, emptyText: "Nothing is ready. Everything open is blocked or in progress.", limited: Math.max(0, ready.length - QUEUE_LIMIT), iconName: "play" }),
    section({ key: "blocked", title: "Blocked", count: countOf(blocked.length, "blocked"), inputs: [[sources.blocked, "bd blocked"]], rows: blockedRows, emptyText: "Nothing is blocked.", limited: Math.max(0, blocked.length - QUEUE_LIMIT), iconName: "lock" }),
    // Grouped by `bd blocked` as well as its own source, so both are inputs:
    // with `blocked` down every blocked bead would land under "Ready".
    // The count is release.remaining, which only the release source decides.
    section({ key: "release", title: release ? `Remaining in ${release.label}` : "Remaining in the release", count: release ? countOf(release.remaining, "release") : "-", inputs: [[sources.release, "bd list --all --label-pattern 'v*.*.*'"], [sources.blocked, "bd blocked"]], rows: releaseRows, emptyText: releaseEmpty, iconName: "tag" }),
    section({ key: "merged", title: "Recently merged", count: countOf(merged.length, "merged"), inputs: [[sources.merged, "gh pr list --state merged"]], rows: mergedRows.length ? [`<ul class="plain">${mergedRows.join("")}</ul>`] : [], emptyText: "Nothing merged recently.", iconName: "merge" }),
  ];

  const sourceList = Object.entries(sources)
    .map(([k, r]) => `<li>${ciIcon(r.ok ? "green" : "red")} ${esc(k)}${r.ok ? "" : ` <span class="muted">${esc(r.error)}</span>`}</li>`)
    .join("");
  const totals = sources.status?.ok
    ? `${esc(summary.open_issues ?? "?")} open · ${esc(summary.closed_issues ?? "?")} closed · ${esc(summary.total_issues ?? "?")} total beads`
    : `<span class="muted">bead totals unavailable</span>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="generated" content="${esc(now.toISOString())}">
<meta name="refresh-seconds" content="${esc(refreshSeconds)}">
<title>${esc(repoName)} · dev dashboard</title>
<style>${CSS}</style>
</head>
<body data-repo="${esc(repoName)}">
${sprite()}
<header>
<div class="hl">
<h1>${esc(repoName)} <span class="muted">dev dashboard</span></h1>
<span class="upd muted">${icon("refresh")}updated <span id="age">just now</span></span>
<span id="stale" class="stale" role="status" hidden>${icon("alert")}Not refreshed since <time datetime="${esc(now.toISOString())}">${esc(now.toISOString().replace("T", " ").slice(0, 16))} UTC</time>. Is the --watch loop running?</span>
<span class="main">${mainText}</span>
</div>
<div class="tiles">${tiles}</div>
<div class="toolbar">
<label class="search">${icon("search")}<input id="filter" type="search" placeholder="Filter rows: bead id, title, PR, branch, scope" aria-label="Filter rows" autocomplete="off" spellcheck="false"></label>
<span class="muted hint">Press / to filter, Esc to clear. Click a row to expand it.</span>
</div>
</header>
<main>
${sections.join("\n")}
</main>
<footer>
<div>${icon("database")}${totals} · ${icon("refresh")}every ${esc(plural(refreshSeconds, "second"))} · ${icon("terminal")}<code>node scripts/dev-dashboard.mjs</code></div>
<details><summary>${icon("database")}Sources</summary><ul class="plain">${sourceList}</ul></details>
</footer>
<script>${JS}</script>
</body>
</html>
`;
  return { html, attention, joined };
}

const CSS = `
:root{color-scheme:dark light;
--bg:#111214;--panel:#17181b;--line:#2a2b30;--line-soft:#202126;--fg:#e8e8ea;--muted:#9a9ba3;
--accent:#4c8dff;--ok:#34c759;--warn:#ff9f0a;--bad:#ff453a;--hover:#1d1e23;--focus:#8ab4ff;
--row-h:28px;--font:13px;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--line:#d9d9de;--line-soft:#ececf0;--fg:#1c1c1e;--muted:#6b6b73;--hover:#f0f0f3;--focus:#2f6fe0}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:var(--font)/1.45 system-ui,-apple-system,"Segoe UI",Inter,sans-serif}
body{padding:0 0 32px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,.id,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
code{font-size:12px}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;max-height:60vh;overflow:auto;padding:8px 10px;background:var(--bg);border:1px solid var(--line-soft);border-radius:4px}
.muted{color:var(--muted)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.ic{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-2px;flex:none;margin-right:4px}
.ic:last-child{margin-right:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
h1 .ic,h2 .ic{width:15px;height:15px;vertical-align:-2px;margin-right:6px}
a .ic{margin-right:3px}
header{position:sticky;top:0;z-index:100;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 14px 8px}
.hl{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;min-width:0}
h1{font-size:16px;margin:0;font-weight:600}
h2{font-size:13px;margin:0;font-weight:600;display:inline}
.count{display:inline-block;min-width:1.6em;padding:0 6px;border-radius:9px;background:var(--line);color:var(--fg);font-size:11px;text-align:center;font-variant-numeric:tabular-nums;vertical-align:1px}
.stale{color:var(--warn);font-weight:600}
.tiles{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.tile{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:8px;align-items:center;min-width:92px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg)}
.tile .ic{grid-row:1/3;width:18px;height:18px;margin:0;color:var(--muted)}
.tile.bad .ic{color:var(--bad)}.tile.ok .ic{color:var(--ok)}
.tile:hover{text-decoration:none;background:var(--hover)}
.tile .n{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.tile .l{font-size:11px;color:var(--muted)}
.tile.bad .n{color:var(--bad)}.tile.ok .n{color:var(--ok)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.search{position:relative;flex:1 1 260px;max-width:480px;min-width:0;display:block}
.search>.ic{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--muted);margin:0;pointer-events:none}
#filter{width:100%;padding:5px 8px 5px 28px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--fg);font:inherit}
#filter:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.hint{font-size:11px}
main{padding:0 14px}
details.sec{border-bottom:1px solid var(--line);padding:6px 0 10px}
details.sec>summary{list-style:none;cursor:pointer;padding:8px 0 6px;display:flex;align-items:center;gap:8px}
details.sec>summary::-webkit-details-marker{display:none}
details.sec>summary::before{content:"";width:0;height:0;border:5px solid transparent;border-left-color:var(--muted);margin-left:2px;transition:none}
details.sec[open]>summary::before{transform:rotate(90deg);margin-top:3px}
.attn{padding:8px 0 10px;border-bottom:1px solid var(--line)}
.attn h2{display:block;margin:8px 0 6px}
.attn ul{margin:0;padding:0;list-style:none}
.attn li{display:flex;align-items:baseline;gap:6px;padding:3px 0 3px 10px;border-left:3px solid var(--warn)}
.attn li>.ic{position:relative;top:2px;margin:0}
.attn li.sev-bad{border-left-color:var(--bad)}
.attn li+li{margin-top:2px}
.act{display:inline-flex;align-items:center;font-size:11px;line-height:16px;padding:0 7px;margin-left:4px;border:1px solid var(--line);border-radius:9px;vertical-align:1px}
.act .ic{width:11px;height:11px;margin-right:3px}
.act:hover{background:var(--hover);text-decoration:none}
.empty{color:var(--muted);margin:4px 0 0}.empty.win{color:var(--ok)}
.error{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--bad);border-left-width:4px;border-radius:4px;padding:8px 10px;margin:4px 0}
.error>.ic{margin-top:2px}
details.row{border-top:1px solid var(--line-soft)}
details.row:first-of-type{border-top:0}
details.row>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:0 10px;align-items:baseline;min-height:var(--row-h);padding:4px 6px 4px 18px;position:relative}
details.row>summary::-webkit-details-marker{display:none}
details.row>summary::before{content:"";position:absolute;left:5px;top:11px;width:0;height:0;border:4px solid transparent;border-left-color:var(--muted)}
details.row[open]>summary::before{transform:rotate(90deg);top:12px}
details.row>summary:hover{background:var(--hover)}
details.row>summary:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
details.row[open]>summary{background:var(--hover);position:sticky;top:0}
.id{font-size:12px;white-space:nowrap}
.pri{font-size:11px;color:var(--muted);white-space:nowrap}
.title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.row[open]>summary .title{white-space:normal;grid-column:1/-1;grid-row:2;padding-top:2px}
details.row[open]>summary .meta{grid-column:3/5;grid-row:1}
.meta{display:flex;flex-wrap:wrap;gap:0 8px;align-items:center;justify-content:flex-end;white-space:nowrap;font-size:12px;color:var(--fg)}
.meta .ic{margin-right:0}
.meta .wt .ic,.meta .age .ic,.meta a .ic,.chipish .ic{margin-right:3px}
.meta .wt{max-width:22ch;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}
details.row.stale .id::after{content:" stale";color:var(--warn);font-family:system-ui;font-size:11px}
.agent{display:inline-flex;align-items:center;position:relative;padding:1px 5px;border-radius:9px;border:1px solid var(--line);white-space:nowrap;color:var(--muted)}
.agent .ic{margin:0}
.agent.working{border-color:var(--ok);color:var(--ok)}.agent.waiting{border-color:var(--bad);color:var(--bad)}.agent.idle{border-color:var(--warn);color:var(--warn)}
.chip{display:inline-block;font-family:var(--mono);font-size:11px;padding:0 6px;border-radius:9px;border:1px solid var(--line);color:var(--fg);white-space:nowrap}
.chip .ic{width:11px;height:11px;vertical-align:-1px;margin-right:3px}
.chip.hot{border-color:var(--accent);color:var(--accent);font-weight:600}
.chip.unk{border-style:dashed}
.body{padding:6px 10px 12px 18px;border-top:1px solid var(--line-soft);background:var(--panel)}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:0}
dt{color:var(--muted);font-size:12px;padding-top:1px;white-space:nowrap}
dt .ic{margin-right:5px;vertical-align:-3px}
dd .ic{vertical-align:-3px}
dd{margin:0;min-width:0;overflow-wrap:anywhere}
.full-title{font-weight:600}
.why{font-size:12px;margin-top:2px}
.checks{margin:0;padding:0;list-style:none}
.checks li{padding:1px 0}
.cmd{display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0;max-width:100%}
.cmd code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60ch}
button{font:inherit;font-size:11px;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 7px;cursor:pointer;min-height:22px;display:inline-flex;align-items:center;gap:4px}
button .ic{margin:0}
button.copy{padding:1px 5px;min-width:24px;justify-content:center;color:var(--muted)}
button.copy .done{display:none;color:var(--ok)}
button.copy.copied .done{display:inline}button.copy.copied .ic:not(.done){display:none}
button:hover{background:var(--hover)}button:focus-visible{outline:2px solid var(--focus)}
button.more{margin:8px 0 0 18px}
.nomatch{margin:6px 0 0 18px;color:var(--muted)}
details.row.overflow:not(.fhit){display:none}
details.sec.all details.row.overflow{display:block}
details.row.fmiss{display:none}
body.filtering details.sec.all details.row.fmiss{display:none}
.tablewrap{overflow:auto;max-height:50vh;border:1px solid var(--line-soft);border-radius:4px}
table{border-collapse:collapse;width:100%;table-layout:fixed}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line-soft);vertical-align:top;overflow-wrap:anywhere}
th{white-space:nowrap}
td code{overflow-wrap:anywhere}
th{position:sticky;top:0;background:var(--panel);font-weight:600;color:var(--muted);font-size:12px;z-index:1}
tr:last-child td{border-bottom:0}
.grp{margin:12px 0 4px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.bar{height:6px;margin:6px 0 4px;border-radius:3px;background:var(--line);overflow:hidden}
.bar span{display:block;height:100%;background:var(--ok)}
.progress{margin:0 0 4px;font-variant-numeric:tabular-nums}
ul.plain{margin:4px 0 0;padding:0 0 0 18px;list-style:none}
ul.plain li{padding:2px 0}
footer .ic{vertical-align:-3px}
footer{padding:12px 14px 0;color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}
footer details summary{cursor:pointer}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-width:640px){details.row>summary{grid-template-columns:auto minmax(0,1fr)}.pri,.meta{grid-column:2}.meta{justify-content:flex-start}}
`;

const JS = `
(() => {
  const repo = document.body.dataset.repo || "repo";
  const K = (k) => "devdash:" + repo + ":" + k;
  const ls = { get(k, d) { try { const v = JSON.parse(localStorage.getItem(K(k))); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(K(k), JSON.stringify(v)); } catch {} } };
  const ss = { get(k) { try { return sessionStorage.getItem(K(k)); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(K(k), v); } catch {} } };

  // Open rows and collapsed sections survive the reload.
  const open = new Set(ls.get("open", []));
  const closedSecs = new Set(ls.get("closedSecs", []));
  for (const d of document.querySelectorAll("details.row")) if (open.has(d.id)) d.open = true;
  for (const d of document.querySelectorAll("details.sec")) if (closedSecs.has(d.id)) d.open = false;
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (d.classList.contains("row")) { d.open ? open.add(d.id) : open.delete(d.id); ls.set("open", [...open]); }
    else if (d.classList.contains("sec")) { d.open ? closedSecs.delete(d.id) : closedSecs.add(d.id); ls.set("closedSecs", [...closedSecs]); }
  }, true);

  // "Show all" per section.
  const showAll = new Set(ls.get("showAll", []));
  const applyShowAll = (sec) => { sec.classList.add("all"); const b = sec.querySelector("button.more"); if (b) b.hidden = true; };
  for (const sec of document.querySelectorAll("details.sec")) if (showAll.has(sec.id)) applyShowAll(sec);
  for (const b of document.querySelectorAll("button.more")) b.addEventListener("click", () => { const sec = b.closest("details.sec"); showAll.add(sec.id); ls.set("showAll", [...showAll]); applyShowAll(sec); });

  // Filter across every section; survives reload; "/" focuses, Esc clears.
  const input = document.getElementById("filter");
  const applyFilter = () => {
    const q = input.value.trim().toLowerCase();
    ss.set("q", q);
    document.body.classList.toggle("filtering", q.length > 0);
    for (const sec of document.querySelectorAll("details.sec")) {
      const rows = sec.querySelectorAll("details.row");
      let hits = 0;
      for (const r of rows) {
        const hit = !q || (r.dataset.search || "").includes(q);
        r.classList.toggle("fmiss", !hit);
        r.classList.toggle("fhit", q.length > 0 && hit);
        if (hit) hits++;
      }
      const nm = sec.querySelector(".nomatch");
      if (nm) { nm.hidden = !(q && rows.length > 0 && hits === 0); nm.querySelector(".q").textContent = q; }
      if (q && hits > 0) sec.open = true;
    }
  };
  input.value = ss.get("q") || "";
  input.addEventListener("input", applyFilter);
  input.addEventListener("focus", () => ss.set("focus", "1"));
  input.addEventListener("blur", () => ss.set("focus", "0"));
  for (const b of document.querySelectorAll("button.clear")) b.addEventListener("click", () => { input.value = ""; applyFilter(); input.focus(); });
  document.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "/" && !typing) { e.preventDefault(); input.focus(); input.select(); }
    else if (e.key === "Escape" && e.target === input) { input.value = ""; applyFilter(); input.blur(); }
  });
  applyFilter();
  if (ss.get("focus") === "1") { input.focus(); const n = input.value.length; input.setSelectionRange(n, n); }

  // Jump links open the target row and its section before scrolling.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.jump");
    if (!a) return;
    // getElementById, not querySelector: in "#bead-ugcportal-qnq9.13" a
    // selector parser reads ".13" as a class, so dotted child ids never match.
    const t = document.getElementById((a.getAttribute("href") || "").slice(1));
    if (!t) return;
    e.preventDefault();
    const sec = t.closest("details.sec");
    if (sec) { sec.open = true; if (t.classList.contains("overflow")) applyShowAll(sec); }
    t.open = true;
    t.scrollIntoView({ block: "start" });
    t.querySelector("summary")?.focus({ preventScroll: true });
  });

  // Copy buttons (clipboard API, with a textarea fallback for file://).
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button.copy");
    if (!b) return;
    const text = b.dataset.copy;
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    b.classList.add("copied"); b.setAttribute("aria-label", "Copied"); setTimeout(() => { b.classList.remove("copied"); b.setAttribute("aria-label", "Copy command"); }, 1200);
  });

  // Scroll position survives the reload.
  let scrollTimer = 0;
  addEventListener("scroll", () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => ss.set("y", String(scrollY)), 100); }, { passive: true });
  const y = Number(ss.get("y") || 0);
  if (y > 0 && !location.hash) requestAnimationFrame(() => scrollTo(0, y));

  // Age ticker, stale banner, and the reload loop.
  const generated = Date.parse(document.querySelector('meta[name="generated"]').content);
  const interval = Math.max(5, Number(document.querySelector('meta[name="refresh-seconds"]').content) || 30) * 1000;
  const ageEl = document.getElementById("age");
  const staleEl = document.getElementById("stale");
  const fmt = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return s + "s"; const m = Math.round(s / 60); if (m < 60) return m + "m"; return Math.round(m / 60) + "h"; };
  const tick = () => { const age = Date.now() - generated; ageEl.textContent = fmt(age) + " ago"; staleEl.hidden = age < interval * 3; };
  tick(); setInterval(tick, 1000);
  const loadedAt = Date.now();
  const busy = () => document.activeElement === input || String(getSelection() || "").length > 0 || document.querySelector("details.row[open] > summary:hover, details.row[open] > .body:hover");
  const scheduleReload = (ms) => setTimeout(() => {
    const forced = Date.now() - loadedAt > interval * 5;
    if (busy() && !forced) return scheduleReload(5000);
    location.reload();
  }, ms);
  scheduleReload(interval);
})();
`;
