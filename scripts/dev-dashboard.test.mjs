/**
 * Tests for the cmux development dashboard (scripts/dev-dashboard.mjs and
 * scripts/lib/dashboard-*.mjs).
 *
 * The pure parts are exercised with fixtures shaped like real `bd`, `gh`,
 * `cmux current --json` and `git worktree list --porcelain` output captured
 * on 2026-10-13. The properties that matter most:
 *
 *   1. The join is by bead id, so a bead, its branch, its worktree and its
 *      PR end up on one row even though no tool knows about the others.
 *   2. A source that fails renders as a visible error block AND as a
 *      "Needs you" item, and every count derived from it renders as "-".
 *      It must never render as an empty list or a 0, which would read as
 *      "nothing to do" (the fail-open shape ugcportal-kssp is about).
 *   3. Nothing from bd, gh or git reaches the HTML unescaped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  agentStateOf,
  ageOf,
  attentionText,
  blockedByThis,
  blockersOf,
  buildAttention,
  compareSemver,
  DASHBOARD_URL_PLACEHOLDER,
  dashboardUrl,
  esc,
  extractBeadId,
  findWorkspaceCommand,
  gatherSources,
  joinRows,
  normalisePath,
  parseArgs,
  parseWorktrees,
  plural,
  QUEUE_LIMIT,
  recordedPrsOf,
  RELEASE_GROUPS,
  releasedInOf,
  releaseLabelOf,
  releaseProgress,
  renderHtml,
  resolveWorkspaceLayout,
  sidebarPills,
  STALE_IN_PROGRESS_HOURS,
  summariseChecks,
  TEXT_CAP,
  WORKSPACE_COMMAND,
} from "./dev-dashboard.mjs";

const NOW = new Date("2026-10-13T12:00:00Z");
const PREFIX = "ugcportal";

const WORKTREE_PORCELAIN = `worktree /Users/eiriksf/code/ugcportal
HEAD 4c8584e000000000000000000000000000000000
branch refs/heads/main

worktree /private/tmp/wt-h0ef
HEAD fa51435000000000000000000000000000000000
branch refs/heads/fix/ugcportal-h0ef-ci-gate-per-run

worktree /private/tmp/wt-review-230
HEAD f7c5144000000000000000000000000000000000
detached

worktree /private/tmp/wt-stray
HEAD 1234567000000000000000000000000000000000
branch refs/heads/spike/no-bead-here
`;

const PR_232 = {
  number: 232,
  title: "fix(process): the CI gate reads the head's own run",
  url: "https://github.com/eiriksf-capgemini/ugcportal/pull/232",
  body: "## What\n\nReads the head SHA's own run.",
  headRefName: "fix/ugcportal-h0ef-ci-gate-per-run",
  baseRefName: "main",
  isDraft: false,
  reviewDecision: "",
  mergeable: "MERGEABLE",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "Guards", conclusion: "SUCCESS", status: "COMPLETED", detailsUrl: "https://github.com/x/runs/1", workflowName: "CI" },
    { __typename: "CheckRun", name: "Lint, test, typecheck, build", conclusion: "SKIPPED", status: "COMPLETED", detailsUrl: "https://github.com/x/runs/2", workflowName: "CI" },
  ],
  labels: [],
  createdAt: "2026-10-13T07:00:00Z",
  updatedAt: "2026-10-13T08:00:00Z",
  additions: 36,
  deletions: 2,
  author: { login: "eiriksf-capgemini" },
};

const PR_UNLINKED_RED = {
  number: 240,
  title: "chore: bump deps <script>alert(1)</script>",
  url: "https://github.com/eiriksf-capgemini/ugcportal/pull/240",
  body: "",
  headRefName: "chore/bump-deps",
  baseRefName: "main",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "CONFLICTING",
  statusCheckRollup: [{ name: "CI", conclusion: "FAILURE" }],
  labels: [{ name: "dependencies" }],
  createdAt: "2026-10-13T10:00:00Z",
  updatedAt: "2026-10-13T11:00:00Z",
  additions: 1,
  deletions: 1,
  author: { login: "eiriksf-capgemini" },
};

const BEAD_H0EF = {
  id: "ugcportal-h0ef",
  title: "pr-review-merge's CI gate reads `gh pr checks` & \"friends\"",
  description: "As a reviewer I want the gate to read the head's own run.",
  acceptance_criteria: "K1 Given a PR ... Then ...",
  notes: "",
  priority: 1,
  issue_type: "task",
  status: "in_progress",
  assignee: "Eirik Sander-Fjeld",
  created_at: "2026-10-13T09:00:00Z",
  updated_at: "2026-10-13T11:40:00Z",
  lease_expires_at: "2026-10-13T09:27:40Z", // long expired; must NOT be flagged
  metadata: { cc_type: "fix", cc_scope: "process", model: "opus", model_effort: "xhigh", model_why: "gate correctness" },
  dependencies: [{ issue_id: "ugcportal-ul2j", depends_on_id: "ugcportal-h0ef", type: "blocks" }],
};

const BEAD_STALE_NO_PR = {
  id: "ugcportal-ybv",
  title: "Register ugcportal in platform-gitops scripts/up.sh",
  priority: 2,
  status: "in_progress",
  updated_at: "2026-10-08T12:20:27Z",
  metadata: {},
};

const BEAD_FRESH_NO_PR = {
  id: "ugcportal-new1",
  title: "Just claimed",
  priority: 2,
  status: "in_progress",
  updated_at: "2026-10-13T11:55:00Z",
};

const BLOCKED_UL2J = {
  id: "ugcportal-ul2j",
  title: "premise-fresh invalidates every bead on every merge",
  priority: 1,
  status: "open",
  updated_at: "2026-10-13T10:06:44Z",
  blocked_by: ["ugcportal-h0ef"],
  metadata: { cc_scope: "process" },
};

const CMUX_ITEM_WORKING = {
  label: "h0ef implementer",
  cwd: "/tmp/wt-h0ef",
  agents: [{ state: "working" }],
  attention: [],
  possible_human_obligations: [],
  pull_requests: [],
};

function ok(value) {
  return { ok: true, value };
}
function down(error) {
  return { ok: false, error };
}

/** Shaped like `bd list --all --label-pattern 'v*.*.*' --limit 0 --json` rows (2026-10-14). */
function rel(id, status, priority, labels = ["v0.7.0"], releasedIn = "") {
  const metadata = { cc_scope: "process", cc_type: "fix", ...(releasedIn ? { released_in: releasedIn } : {}) };
  return { id, title: `Release bead ${id}`, description: "", status, priority, issue_type: "task", labels, updated_at: "2026-10-12T12:00:00Z", metadata, dependencies: [] };
}
const RELEASE_BEADS = [
  rel("ugcportal-r1", "closed", 2),
  rel("ugcportal-r2", "closed", 1),
  rel("ugcportal-r3", "in_progress", 1),
  rel("ugcportal-r4", "open", 2),
  rel("ugcportal-ul2j", "open", 1), // also in the `blocked` fixture, so it lands in the Blocked group
  rel("ugcportal-r6", "deferred", 3),
  rel("ugcportal-r0", "closed", 2, ["v0.6.0"], "v0.6.0"), // last release; must not count
];

function allSourcesOk(overrides = {}) {
  return {
    release: ok(RELEASE_BEADS),
    inProgress: ok([BEAD_H0EF, BEAD_STALE_NO_PR]),
    ready: ok([{ id: "ugcportal-74w", priority: 1, title: "Curation UI", updated_at: "2026-10-12T12:00:00Z", metadata: { cc_scope: "curation" } }]),
    blocked: ok([BLOCKED_UL2J]),
    status: ok({ summary: { in_progress_issues: 2, ready_issues: 1, blocked_issues: 1, open_issues: 4, closed_issues: 9, total_issues: 15 } }),
    prs: ok([PR_232, PR_UNLINKED_RED]),
    merged: ok([{ number: 228, title: "ci(ci): stacked PR", url: "https://github.com/eiriksf-capgemini/ugcportal/pull/228", mergedAt: "2026-10-12T12:58:19Z" }]),
    current: ok({ items: [CMUX_ITEM_WORKING] }),
    worktrees: ok(WORKTREE_PORCELAIN),
    mainLog: ok("4c8584e 65 minutes ago\n"),
    ...overrides,
  };
}

function page(overrides = {}, now = NOW) {
  return renderHtml({ repoName: "ugcportal", prefix: PREFIX, sources: allSourcesOk(overrides), now, refreshSeconds: 30 });
}

/** The markup of one section, from its id to the next section. */
function sectionOf(html, key) {
  const start = html.indexOf(`<details class="sec" id="sec-${key}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<details class="sec" id="sec-', start + 1);
  return html.slice(start, next === -1 ? html.indexOf("</main>") : next);
}

/**
 * Runs the page's own script in jsdom. There is no browser here, so this is
 * the closest the tests get to clicking: scrollIntoView is stubbed (jsdom has
 * no layout) and the window is closed after use so the reload timer dies.
 */
function dom(html) {
  const d = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/dashboard.html", pretendToBeVisual: true });
  d.window.HTMLElement.prototype.scrollIntoView = () => {};
  return d;
}

/** Every section heading count and header tile number, in document order. */
function counts(html) {
  return {
    headings: [...html.matchAll(/<h2[^>]*>.*?<span class="count">([^<]*)<\/span><\/h2>/g)].map((m) => m[1]),
    tiles: [...html.matchAll(/<span class="n">([^<]*)<\/span>/g)].map((m) => m[1]),
  };
}

describe("extractBeadId", () => {
  it("reads the bead id out of a branch name, including dotted child ids", () => {
    expect(extractBeadId("feat/ugcportal-kt3k-bead-validator", PREFIX)).toBe("ugcportal-kt3k");
    expect(extractBeadId("docs/ugcportal-qnq9.11-wine-grid", PREFIX)).toBe("ugcportal-qnq9.11");
  });
  it("ignores tokens that are not this repo's beads", () => {
    expect(extractBeadId("pr-129-review", PREFIX)).toBeNull();
    expect(extractBeadId("spike/no-bead-here", PREFIX)).toBeNull();
    expect(extractBeadId(undefined, PREFIX)).toBeNull();
  });
});

describe("parseWorktrees", () => {
  it("parses path, branch and detached state", () => {
    const wts = parseWorktrees(WORKTREE_PORCELAIN);
    expect(wts).toHaveLength(4);
    expect(wts[0]).toMatchObject({ path: "/Users/eiriksf/code/ugcportal", branch: "main", detached: false });
    expect(wts[1]).toMatchObject({ path: "/private/tmp/wt-h0ef", branch: "fix/ugcportal-h0ef-ci-gate-per-run" });
    expect(wts[2]).toMatchObject({ branch: null, detached: true });
  });
});

describe("summariseChecks", () => {
  it("is red on any failure, pending on any unfinished check, green only when every check is known-good", () => {
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("red");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "" }])).toBe("pending");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }])).toBe("green");
    expect(summariseChecks([])).toBe("none");
    expect(summariseChecks(undefined)).toBe("none");
  });
  it("never reads a workflow that failed to start, or a conclusion it does not know, as green", () => {
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "STARTUP_FAILURE" }])).toBe("red");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "SOMETHING_NEW" }])).toBe("unknown");
    // Unknown outranks pending: a check that is both unknown and unfinished is still not known to pass.
    expect(summariseChecks([{ conclusion: "SOMETHING_NEW" }, { status: "QUEUED" }])).toBe("unknown");
  });
  it("puts an unknown conclusion in Needs you and never raises Review pending for it", () => {
    const odd = { ...PR_232, statusCheckRollup: [{ name: "CI", conclusion: "SOMETHING_NEW" }] };
    const joined = joinRows({ prefix: PREFIX, inProgress: [BEAD_H0EF], prs: [odd], worktrees: [], currentItems: [], now: NOW });
    const text = buildAttention({ prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk(), now: NOW }).map(attentionText).join("\n");
    expect(text).toContain("CI unknown: #232 for ugcportal-h0ef");
    expect(text).not.toContain("Review pending");
    expect(renderHtml({ repoName: "ugcportal", prefix: PREFIX, sources: allSourcesOk({ prs: ok([odd]) }), now: NOW }).html).toContain('aria-label="CI unknown"');
  });
});

describe("ageOf and plural", () => {
  it("formats minutes, hours and days", () => {
    expect(ageOf("2026-10-13T11:50:00Z", NOW)).toBe("10m");
    expect(ageOf("2026-10-13T08:00:00Z", NOW)).toBe("4h");
    expect(ageOf("2026-10-08T12:00:00Z", NOW)).toBe("5d");
    expect(ageOf("not a date", NOW)).toBe("?");
    expect(ageOf(undefined, NOW)).toBe("?");
  });
  it("pluralises 0 / 1 / many", () => {
    expect(plural(0, "item")).toBe("0 items");
    expect(plural(1, "item")).toBe("1 item");
    expect(plural(2, "dependency", "dependencies")).toBe("2 dependencies");
  });
});

describe("agentStateOf", () => {
  it("prioritises a human obligation over the agent's own state", () => {
    expect(agentStateOf({ agents: [{ state: "working" }], attention: [{}], possible_human_obligations: [] })).toBe("waiting");
    expect(agentStateOf({ agents: [{ state: "working" }], attention: [] })).toBe("working");
    expect(agentStateOf({ agents: [{ state: "idle" }, { state: "ended" }] })).toBe("idle");
    expect(agentStateOf({ agents: [] })).toBe("");
  });
});

describe("normalisePath", () => {
  it("folds macOS /private/tmp into /tmp and strips trailing slashes", () => {
    expect(normalisePath("/private/tmp/wt-h0ef")).toBe("/tmp/wt-h0ef");
    expect(normalisePath("/tmp/wt-h0ef/")).toBe("/tmp/wt-h0ef");
    expect(normalisePath("/Users/eiriksf/private/x")).toBe("/Users/eiriksf/private/x");
  });
});

describe("blockersOf and blockedByThis", () => {
  it("prefers bd 1.3's blocked_by and falls back to blocks-type dependencies", () => {
    expect(blockersOf({ blocked_by: ["ugcportal-a"] })).toEqual(["ugcportal-a"]);
    expect(
      blockersOf({
        id: "ugcportal-x",
        dependencies: [
          { issue_id: "ugcportal-x", depends_on_id: "ugcportal-b", type: "blocks" },
          { issue_id: "ugcportal-x", depends_on_id: "ugcportal-c", type: "related" },
          { issue_id: "ugcportal-other", depends_on_id: "ugcportal-x", type: "blocks" },
        ],
      }),
    ).toEqual(["ugcportal-b"]);
    expect(blockersOf({})).toEqual([]);
  });
  it("lists the beads this one blocks from the reverse edges", () => {
    expect(blockedByThis(BEAD_H0EF)).toEqual(["ugcportal-ul2j"]);
    expect(blockedByThis({})).toEqual([]);
  });
});

describe("joinRows", () => {
  const joined = joinRows({
    prefix: PREFIX,
    inProgress: [BEAD_H0EF, BEAD_STALE_NO_PR, BEAD_FRESH_NO_PR],
    prs: [PR_232, PR_UNLINKED_RED],
    worktrees: parseWorktrees(WORKTREE_PORCELAIN),
    currentItems: [CMUX_ITEM_WORKING],
    now: NOW,
  });

  it("ties a bead to its PR, worktree and cmux agent by bead id", () => {
    const row = joined.rows.find((r) => r.bead.id === "ugcportal-h0ef");
    expect(row.pr.number).toBe(232);
    expect(row.worktree.path).toBe("/private/tmp/wt-h0ef");
    expect(row.agentState).toBe("working"); // cmux reported /tmp, git reported /private/tmp
    expect(row.cmuxItems).toHaveLength(1);
    expect(row.checks).toBe("green");
    expect(row.stale).toBe(false);
  });

  it("marks a bead stale by updated_at, not by bd's 5-minute lease", () => {
    const stale = joined.rows.find((r) => r.bead.id === "ugcportal-ybv");
    expect(stale.stale).toBe(true);
    expect(stale.ageHours).toBeGreaterThan(STALE_IN_PROGRESS_HOURS);
    const fresh = joined.rows.find((r) => r.bead.id === "ugcportal-h0ef");
    expect(fresh.stale).toBe(false);
    expect(fresh).not.toHaveProperty("leaseExpired");
  });

  it("separates PRs with no in_progress bead and worktrees with neither bead nor PR", () => {
    expect(joined.unlinkedPrs.map((p) => p.number)).toEqual([240]);
    expect(joined.orphanWorktrees.map((w) => w.path)).toEqual(["/private/tmp/wt-stray"]);
  });
});

describe("buildAttention", () => {
  it("lists a down source, red CI, changes requested, conflicts, stale and unstarted claims, orphans", () => {
    const sources = allSourcesOk({ current: down("cmux current: socket refused") });
    const joined = joinRows({
      prefix: PREFIX,
      inProgress: [BEAD_H0EF, BEAD_STALE_NO_PR, BEAD_FRESH_NO_PR],
      prs: [PR_232, PR_UNLINKED_RED],
      worktrees: parseWorktrees(WORKTREE_PORCELAIN),
      currentItems: [],
      now: NOW,
    });
    const items = buildAttention({ prefix: PREFIX, joined, currentItems: [], sources, now: NOW });
    const text = items.map(attentionText).join("\n");
    expect(text).toContain("Source down: current is unavailable");
    expect(text).toContain("CI red: #240");
    expect(text).toContain("Changes requested: #240");
    expect(text).toContain("Merge conflict: #240");
    expect(text).toContain("Stale: ugcportal-ybv has had no update for 5d and has no open PR");
    expect(text).toContain("Unstarted claim: ugcportal-new1");
    expect(text).toContain("Orphan worktree: /private/tmp/wt-stray on spike/no-bead-here");
    expect(text).not.toContain("Lease expired");
    // Items carry the anchors the page uses to jump to the row.
    expect(items.find((a) => a.label === "Stale").anchor).toBe("bead-ugcportal-ybv");
    expect(items.find((a) => a.label === "CI red").anchor).toBe("pr-240");
    expect(items.find((a) => a.label === "Source down").severity).toBe("bad");
  });

  it("nags about a green unreviewed PR by the PR's own age, and not while an agent is working on it", () => {
    const nag = (bead, pr, currentItems = []) =>
      buildAttention({
        prefix: PREFIX,
        joined: joinRows({ prefix: PREFIX, inProgress: [bead], prs: [pr], worktrees: parseWorktrees(WORKTREE_PORCELAIN), currentItems, now: NOW }),
        currentItems,
        sources: allSourcesOk(),
        now: NOW,
      })
        .map(attentionText)
        .join("\n");
    // Bead touched 20m ago, PR untouched for 4h: the PR has waited, so it nags,
    // and the age it prints is the PR's.
    expect(BEAD_H0EF.updated_at).toBe("2026-10-13T11:40:00Z");
    expect(nag(BEAD_H0EF, PR_232)).toContain("Review pending: #232 for ugcportal-h0ef is green and unreviewed for 4h");
    // The reverse: bead 6h old, PR updated 5m ago. Not yet.
    const oldBead = { ...BEAD_H0EF, updated_at: "2026-10-13T06:00:00Z" };
    expect(nag(oldBead, { ...PR_232, updatedAt: "2026-10-13T11:55:00Z" })).not.toContain("Review pending");
    // A working agent suppresses it whatever the age.
    expect(nag(BEAD_H0EF, PR_232, [CMUX_ITEM_WORKING])).not.toContain("Review pending");
  });

  it("still nags with the agent source down, but says the agent state is unknown", () => {
    const nag = (overrides) =>
      buildAttention({
        prefix: PREFIX,
        joined: joinRows({ prefix: PREFIX, inProgress: [BEAD_H0EF], prs: [PR_232], worktrees: parseWorktrees(WORKTREE_PORCELAIN), currentItems: [], now: NOW }),
        currentItems: [],
        sources: allSourcesOk(overrides),
        now: NOW,
      })
        .map(attentionText)
        .join("\n");
    expect(nag({})).toContain("Review pending: #232 for ugcportal-h0ef is green and unreviewed for 4h");
    expect(nag({})).not.toContain("agent state unknown");
    expect(nag({ current: down("cmux current: socket refused") })).toContain("is green and unreviewed for 4h (agent state unknown)");
    expect(nag({ worktrees: down("git worktree list: refused") })).toContain("is green and unreviewed for 4h (agent state unknown)");
  });

  it("tells a merged-but-open bead apart from an unstarted claim", () => {
    const mergedPr = { number: 250, title: "fix(x): done (ugcportal-new1)", url: "https://github.com/eiriksf-capgemini/ugcportal/pull/250", mergedAt: "2026-10-13T11:00:00Z" };
    const joined = joinRows({ prefix: PREFIX, inProgress: [BEAD_FRESH_NO_PR], prs: [], worktrees: [], currentItems: [], now: NOW });
    const items = buildAttention({ prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk({ merged: ok([mergedPr]) }), now: NOW });
    const text = items.map(attentionText).join("\n");
    expect(text).toContain("Merged, bead open: #250 for ugcportal-new1 merged 1h ago but the bead is still in_progress. bd close ugcportal-new1?");
    expect(text).not.toContain("Unstarted claim");
    expect(items.find((a) => a.label === "Merged, bead open").href).toBe(mergedPr.url);
    // With gh pr list down an open follow-up PR cannot be ruled out, so no close advice.
    const prsDown = buildAttention({ prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk({ merged: ok([mergedPr]), prs: down("gh pr list: offline") }), now: NOW })
      .map(attentionText)
      .join("\n");
    expect(prsDown).toContain("Merged, bead open: #250 for ugcportal-new1 merged 1h ago but the bead is still in_progress. Its open PRs are unknown");
    expect(prsDown).not.toContain("bd close");
  });

  it("does not conclude 'no PR', 'no worktree' or 'no bead' from a source that is down", () => {
    const inProgress = [BEAD_STALE_NO_PR, BEAD_FRESH_NO_PR];
    const joined = joinRows({ prefix: PREFIX, inProgress, prs: [], worktrees: parseWorktrees(WORKTREE_PORCELAIN), currentItems: [], now: NOW });
    const text = (overrides) =>
      buildAttention({ prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk(overrides), now: NOW })
        .map(attentionText)
        .join("\n");
    // With every source up, the same rows do raise these items.
    expect(text({})).toContain("Unstarted claim: ugcportal-new1");
    expect(text({})).toContain("Orphan worktree: /private/tmp/wt-stray");
    expect(text({})).toContain("Stale: ugcportal-ybv has had no update for 5d and has no open PR");
    const prsDown = text({ prs: down("gh pr list: offline") });
    expect(prsDown).not.toContain("Unstarted claim");
    expect(prsDown).not.toContain("Orphan worktree");
    expect(prsDown).toContain("Stale: ugcportal-ybv has had no update for 5d and its PR state is unknown");
    expect(text({ worktrees: down("git worktree list: not a git repository") })).not.toContain("Unstarted claim");
    expect(text({ inProgress: down("bd list: refused") })).not.toContain("Orphan worktree");
    // merged down, prs and worktrees up: the bead's PR may already have merged,
    // so "nobody has started" is not known either.
    expect(text({ merged: down("gh pr list --state merged: offline") })).not.toContain("Unstarted claim");
    // ugcportal-ybv is in progress with no open PR: up says "no open PR",
    // down says the PR state is unknown.
    expect(page().html).toContain('aria-label="no open PR"');
    expect(page().html).not.toContain('aria-label="PR state unknown"');
    const html = page({ prs: down("gh pr list: offline") }).html;
    expect(html).toContain('aria-label="PR state unknown"');
    expect(html).not.toContain('aria-label="no open PR"');
  });

  it("a bead that records a PR in metadata.prs is never an unstarted claim, even when that PR fell off the recent merges", () => {
    // Shaped like live ugcportal-dabx: in progress, PR #227 merged, no open
    // PR, no worktree, not stale, and #227 not among the 8 recent merges.
    const dabx = { ...BEAD_FRESH_NO_PR, id: "ugcportal-dabx", metadata: { prs: "gh-227" } };
    const unrecorded = { ...BEAD_FRESH_NO_PR, id: "ugcportal-dabx", metadata: {} };
    const text = (bead) =>
      buildAttention({
        prefix: PREFIX,
        joined: joinRows({ prefix: PREFIX, inProgress: [bead], prs: [], worktrees: [], currentItems: [], now: NOW }),
        currentItems: [],
        sources: allSourcesOk(), // merged holds #228 only
        now: NOW,
      })
        .map(attentionText)
        .join("\n");
    expect(text(dabx)).not.toContain("Unstarted claim");
    // The same bead with nothing recorded is flagged, so the needle above is reachable.
    expect(text(unrecorded)).toContain("Unstarted claim: ugcportal-dabx is in_progress with no worktree, no open or recently merged PR, and no PR recorded in its metadata.prs");
    // Blank or whitespace-only metadata.prs records nothing.
    expect(text({ ...unrecorded, metadata: { prs: " , " } })).toContain("Unstarted claim: ugcportal-dabx");
    expect(recordedPrsOf(dabx)).toEqual(["gh-227"]);
    expect(recordedPrsOf({ metadata: { prs: "gh-71, gh-80" } })).toEqual(["gh-71", "gh-80"]);
    expect(recordedPrsOf({})).toEqual([]);
  });

  it("matches a merged PR to a bead by whole id, never by substring", () => {
    const abc = { id: "ugcportal-abc", title: "Parent", priority: 2, status: "in_progress", updated_at: "2026-10-13T11:55:00Z" };
    const joined = joinRows({ prefix: PREFIX, inProgress: [abc], prs: [], worktrees: [], currentItems: [], now: NOW });
    const merged = (prs) =>
      buildAttention({ prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk({ merged: ok(prs) }), now: NOW })
        .map(attentionText)
        .join("\n");
    const pr = (number, title, headRefName) => ({ number, title, headRefName, url: `https://github.com/eiriksf-capgemini/ugcportal/pull/${number}`, mergedAt: "2026-10-13T11:00:00Z" });
    // A dotted child and a longer sibling id, in the title and in the branch.
    expect(merged([pr(301, "feat(x): child (ugcportal-abc.1)", "feat/ugcportal-abc.1-child"), pr(302, "fix(x): sibling (ugcportal-abcd)", "fix/ugcportal-abcd-sibling")])).not.toContain(
      "Merged, bead open",
    );
    // The bead's own PR still matches, by branch alone or by title alone.
    expect(merged([pr(303, "feat(x): no id in this title", "feat/ugcportal-abc-parent")])).toContain("Merged, bead open: #303 for ugcportal-abc");
    expect(merged([pr(304, "feat(x): parent (ugcportal-abc)", "some-branch")])).toContain("Merged, bead open: #304 for ugcportal-abc");
  });

  it("surfaces a cmux workspace whose agent is waiting on a human, with a correct plural", () => {
    const waiting = { label: "kt3k implementer", cwd: "/tmp/wt-kt3k", agents: [{ state: "idle" }], attention: [{}] };
    const joined = joinRows({ prefix: PREFIX, inProgress: [], prs: [], worktrees: [], currentItems: [waiting], now: NOW });
    const items = buildAttention({ prefix: PREFIX, joined, currentItems: [waiting], sources: allSourcesOk(), now: NOW });
    expect(items.map(attentionText).join("\n")).toContain("Agent waiting: kt3k implementer has 1 item needing you");
  });
});

describe("esc", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(esc(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
    expect(esc(undefined)).toBe("");
  });
});

describe("renderHtml", () => {
  it("is one self-contained document with every section and the counts in the headings", () => {
    const { html, attention } = page();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<link[^>]+href=|<script[^>]+src=/); // no external assets: it must work from file://
    expect(html).toContain('<meta name="generated" content="2026-10-13T12:00:00.000Z">');
    expect(html).toContain('<meta name="refresh-seconds" content="30">');
    for (const [title, n] of [["In progress", 2], ["Open pull requests", 2], ["Ready to pick up", 1], ["Blocked", 1], ["Recently merged", 1]]) {
      expect(html).toContain(`${title} <span class="count">${n}</span></h2>`);
    }
    expect(html).toContain(`Needs you <span class="count">${attention.length}</span>`);
  });

  it("renders each bead as a collapsed row whose body carries the full record and the PR details", () => {
    const { html } = page();
    const start = html.indexOf('<details class="row" id="bead-ugcportal-h0ef"');
    expect(start).toBeGreaterThan(-1);
    const row = html.slice(start, html.indexOf("</details>", start));
    // Summary line: id, priority, title, PR link with CI state, agent, worktree, age.
    expect(row).toContain('<span class="id">ugcportal-h0ef</span>');
    expect(row).toContain('<span class="pri">P1</span>');
    expect(row).toMatch(/href="https:\/\/github\.com\/eiriksf-capgemini\/ugcportal\/pull\/232" target="_blank" rel="noopener">(<svg[^>]*><use href="#i-pr"\/><\/svg>)?#232<\/a>/);
    expect(row).toContain('aria-label="CI green"');
    expect(row).toContain('aria-label="review: unreviewed"');
    expect(row).toContain('<span class="agent working" title="agent working">');
    expect(row).toContain('<span class="sr">agent working</span>');
    expect(row).toContain("wt-h0ef");
    // Body: description, acceptance criteria, classification, dependencies, checks, body, commands.
    expect(row).toContain("As a reviewer I want the gate");
    expect(row).toContain("K1 Given a PR");
    expect(row).toContain("fix(process)");
    expect(row).toContain('blocks <a href="#bead-ugcportal-ul2j" class="chip jump"');
    expect(row).toContain('<a href="https://github.com/x/runs/1" target="_blank" rel="noopener">Guards</a>');
    expect(row).toContain("Reads the head SHA&#39;s own run.");
    expect(row).toContain('data-copy="bd show ugcportal-h0ef"');
    expect(row).toContain('data-copy="gh pr view 232 --web"');
    expect(row).toContain('data-copy="cd /private/tmp/wt-h0ef"');
  });

  it("escapes everything that came from a tool, including attribute values", () => {
    const { html } = page();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("reads `gh pr checks` &amp; &quot;friends&quot;");
    // The only <script> is the inline page script; it carries no data.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("ships its icons as one inline sprite and every status icon carries a text label", () => {
    const { html } = page();
    expect(html.match(/<symbol id="i-/g).length).toBeGreaterThan(20);
    expect(html).not.toMatch(/<img\b/);
    // Every role="img" svg has an aria-label; decorative ones are aria-hidden.
    for (const m of html.matchAll(/<svg class="ic[^"]*"([^>]*)>/g)) {
      expect(m[1]).toMatch(/role="img" aria-label="[^"]+"|aria-hidden="true"/);
    }
    expect(html).toContain('<button type="button" class="copy" data-copy="bd show ugcportal-h0ef" aria-label="Copy command"');
  });

  it("renders a failed source as an error block in its section and a Needs-you item, never as an empty list", () => {
    const { html, attention } = page({ prs: down("gh pr list: gh not found on PATH") });
    expect(html).toContain('<strong>gh pr list unavailable.</strong> gh pr list: gh not found on PATH');
    expect(html).toContain('<div class="error" role="alert">');
    expect(html).not.toContain("No open pull requests.");
    expect(attention.map(attentionText).join("\n")).toContain("Source down: prs is unavailable");
    expect(html).toContain("<strong>Source down:</strong> prs is unavailable");
  });

  it("a down source never shows a 0 count: tiles, section headings and sidebar pills read -", () => {
    // Every list source down at once. Before the fix each of these read 0.
    const listSources = ["inProgress", "prs", "ready", "blocked", "release", "merged", "current", "worktrees"];
    const allDown = Object.fromEntries(listSources.map((k) => [k, down(`${k}: refused`)]));
    const { html, attention } = page(allDown);
    const c = counts(html);
    expect(c.headings).toHaveLength(8); // Needs you plus the seven sections
    expect(c.tiles).toHaveLength(6);
    expect(c.headings.slice(1)).toEqual(["-", "-", "-", "-", "-", "-", "-"]);
    expect(c.tiles.slice(1)).toEqual(["-", "-", "-", "-", "-"]);
    expect([...c.headings, ...c.tiles]).not.toContain("0");
    // Needs you is the one count still known, and it carries one item per source.
    expect(c.headings[0]).toBe(String(attention.length));
    expect(attention.filter((a) => a.label === "Source down")).toHaveLength(listSources.length);
    const pills = sidebarPills(attention.length, allSourcesOk(allDown)).map((a) => a[2]);
    expect(pills).toEqual([`${attention.length} need you`, "- in progress", "- open PRs"]);
    // One at a time: the down source's own tile and heading read -, the rest stay numbers.
    for (const [key, tileIndex, headingIndex] of [["inProgress", 1, 1], ["prs", 2, 2], ["ready", 3, 4], ["blocked", 4, 5], ["release", 5, 6]]) {
      const one = counts(page({ [key]: down("refused") }).html);
      expect(one.tiles[tileIndex], key).toBe("-");
      expect(one.headings[headingIndex], key).toBe("-");
    }
  });

  it("an empty-but-working source still shows its 0, so the - above is the failure and not the emptiness", () => {
    const c = counts(page({ inProgress: ok([]), prs: ok([]) }).html);
    expect(c.tiles.slice(1, 3)).toEqual(["0", "0"]);
    expect(sidebarPills(0, allSourcesOk({ inProgress: ok([]), prs: ok([]) })).map((a) => a[2]).slice(1)).toEqual(["0 in progress", "0 open PRs"]);
  });

  it("an open PR's bead reads 'not in progress' only when bd list --status in_progress answered", () => {
    const other = { ...PR_232, number: 260, headRefName: "feat/ugcportal-zzz9-elsewhere", title: "feat(x): elsewhere (ugcportal-zzz9)" };
    const up = sectionOf(page({ prs: ok([PR_232, other]) }).html, "prs");
    // In progress: the jump link. Not in progress, with the source up: says so.
    expect(up).toContain('<a href="#bead-ugcportal-h0ef" class="jump">');
    expect(up).toContain('ugcportal-zzz9 <span class="muted">(not in progress)</span>');
    expect(up).not.toContain("in-progress state unknown");
    // Source down: neither bead may be called "not in progress".
    const downSec = sectionOf(page({ prs: ok([PR_232, other]), inProgress: down("bd list: refused") }).html, "prs");
    expect(downSec).not.toContain("(not in progress)");
    expect(downSec).toContain('ugcportal-h0ef <span class="muted">(in-progress state unknown)</span>');
    expect(downSec).toContain('ugcportal-zzz9 <span class="muted">(in-progress state unknown)</span>');
  });

  it("suggests claiming a bead only when the PR and worktree sources both answered", () => {
    const claim = 'data-copy="bd update ugcportal-74w --claim"';
    expect(page().html).toContain(claim);
    expect(page({ prs: down("gh pr list: offline") }).html).not.toContain(claim);
    expect(page({ worktrees: down("git worktree list: refused") }).html).not.toContain(claim);
  });

  it("joins every bead row to its open PR and worktree, so a ready, blocked or release row with one shows it and is never offered a claim", () => {
    const readyBead = { id: "ugcportal-74w", priority: 1, title: "Curation UI", status: "open", updated_at: "2026-10-12T12:00:00Z", metadata: { cc_scope: "curation" } };
    // An open PR tied to the ready bead by its branch name alone.
    const prReady = { ...PR_232, number: 261, title: "feat(curation): curation UI", headRefName: "feat/ugcportal-74w-curation-ui", url: "https://github.com/eiriksf-capgemini/ugcportal/pull/261" };
    const claim = 'data-copy="bd update ugcportal-74w --claim"';
    const withPr = page({ ready: ok([readyBead]), prs: ok([PR_232, PR_UNLINKED_RED, prReady]) }).html;
    const readySec = sectionOf(withPr, "ready");
    expect(readySec).toContain('href="https://github.com/eiriksf-capgemini/ugcportal/pull/261"');
    expect(readySec).toContain("gh pr view 261 --web");
    // The collapsed line shows it too, not only the expanded body.
    const summaryOf = (sec, id) => {
      const at = sec.indexOf(`id="${id}"`);
      return sec.slice(sec.indexOf("<summary>", at), sec.indexOf("</summary>", at));
    };
    expect(summaryOf(readySec, "bead-ugcportal-74w")).toContain("pull/261");
    expect(withPr).not.toContain(claim);
    // Mutation: the same page without that PR offers the claim again.
    expect(page({ ready: ok([readyBead]) }).html).toContain(claim);

    // A worktree alone also counts.
    const wt74w = `${WORKTREE_PORCELAIN}\nworktree /private/tmp/wt-74w\nHEAD 89abcde000000000000000000000000000000000\nbranch refs/heads/feat/ugcportal-74w-curation-ui\n`;
    const withWt = page({ ready: ok([readyBead]), worktrees: ok(wt74w) }).html;
    expect(sectionOf(withWt, "ready")).toContain("cd /private/tmp/wt-74w");
    expect(summaryOf(sectionOf(withWt, "ready"), "bead-ugcportal-74w")).toContain('title="worktree /private/tmp/wt-74w"');
    expect(withWt).not.toContain(claim);

    // Blocked: ugcportal-ul2j with an open PR shows it and is not offered a claim.
    const prUl2j = { ...PR_232, number: 262, title: "fix(x): premise", headRefName: "fix/ugcportal-ul2j-premise", url: "https://github.com/eiriksf-capgemini/ugcportal/pull/262" };
    const blockedUp = page({ prs: ok([PR_232, prUl2j]) }).html;
    expect(summaryOf(sectionOf(blockedUp, "blocked"), "bead-ugcportal-ul2j")).toContain("pull/262");
    expect(blockedUp).not.toContain('data-copy="bd update ugcportal-ul2j --claim"');
    expect(page().html).toContain('data-copy="bd update ugcportal-ul2j --claim"');

    // Release section, shaped like live rel-ugcportal-vr9q: a labelled
    // in-progress bead with an open PR and a worktree. Its release row shows
    // the PR and the worktree, like its In progress row, and offers no claim.
    const relH0ef = { ...rel("ugcportal-h0ef", "in_progress", 1), title: BEAD_H0EF.title };
    const relPage = page({ release: ok([...RELEASE_BEADS, relH0ef]) }).html;
    const relSec = sectionOf(relPage, "release");
    const relRow = relSec.slice(relSec.indexOf('id="rel-ugcportal-h0ef"'), relSec.indexOf("</details>", relSec.indexOf('id="rel-ugcportal-h0ef"')));
    expect(relRow).toContain('href="https://github.com/eiriksf-capgemini/ugcportal/pull/232"');
    expect(relRow).toContain("cd /private/tmp/wt-h0ef");
    expect(relRow).not.toContain("--claim");
    // Mutation: with the PR and worktree gone (sources up, nothing matching),
    // the row is still in progress, so it is still not offered a claim.
    const bare = sectionOf(page({ release: ok([...RELEASE_BEADS, relH0ef]), prs: ok([]), worktrees: ok("worktree /Users/eiriksf/code/ugcportal\nHEAD 4c8584e0\nbranch refs/heads/main\n") }).html, "release");
    expect(bare).not.toContain("pull/232");
    expect(bare).not.toContain('data-copy="bd update ugcportal-h0ef --claim"');
  });

  it("a down prs or worktrees source reads unknown on a bead row, never like no PR or no worktree", () => {
    const summaryOf = (sec, id) => {
      const at = sec.indexOf(`id="${id}"`);
      return sec.slice(sec.indexOf("<summary>", at), sec.indexOf("</summary>", at));
    };
    const rowOf = (sec, id) => sec.slice(sec.indexOf(`id="${id}"`), sec.indexOf("</details>", sec.indexOf(`id="${id}"`)));
    const prUnknown = 'aria-label="PR state unknown"';
    const wtUnknown = 'aria-label="worktree state unknown"';
    const ready = (o) => summaryOf(sectionOf(page(o).html, "ready"), "bead-ugcportal-74w");
    // Ready row (linkedMeta): prs down marks the PR unknown; prs up with no PR
    // for this bead marks nothing (the mutation: source up, marker absent).
    expect(ready({ prs: down("gh pr list: offline") })).toContain(prUnknown);
    expect(ready()).not.toContain(prUnknown);
    expect(ready({ worktrees: down("git worktree list: refused") })).toContain(wtUnknown);
    expect(ready()).not.toContain(wtUnknown);
    // The expanded body says so as well.
    expect(rowOf(sectionOf(page({ prs: down("gh pr list: offline") }).html, "ready"), "bead-ugcportal-74w")).toContain("unknown: gh pr list is down");
    expect(rowOf(sectionOf(page({ worktrees: down("git worktree list: refused") }).html, "ready"), "bead-ugcportal-74w")).toContain("unknown: git worktree list is down");
    expect(rowOf(sectionOf(page().html, "ready"), "bead-ugcportal-74w")).not.toContain("unknown: g");
    // In progress row (inProgressMeta): h0ef has wt-h0ef with the source up;
    // with worktrees down it reads unknown instead of dropping the worktree.
    const inProg = (o) => summaryOf(sectionOf(page(o).html, "inprogress"), "bead-ugcportal-h0ef");
    expect(inProg({ worktrees: down("git worktree list: refused") })).toContain(wtUnknown);
    expect(inProg()).not.toContain(wtUnknown);
    expect(inProg()).toContain('title="worktree /private/tmp/wt-h0ef"');
  });

  it("a down git worktree list, or a down cmux current for a bead with a worktree, reads 'agent state unknown', never like no agent", () => {
    const summaryOf = (o, id) => {
      const sec = sectionOf(page(o).html, "inprogress");
      const at = sec.indexOf(`id="${id}"`);
      return sec.slice(sec.indexOf("<summary>", at), sec.indexOf("</summary>", at));
    };
    const rowOf = (o, id) => {
      const sec = sectionOf(page(o).html, "inprogress");
      return sec.slice(sec.indexOf(`id="${id}"`), sec.indexOf("</details>", sec.indexOf(`id="${id}"`)));
    };
    const H0EF = "bead-ugcportal-h0ef"; // worktree /private/tmp/wt-h0ef, where CMUX_ITEM_WORKING sits
    const YBV = "bead-ugcportal-ybv"; // no worktree
    const agentUnknown = 'aria-label="agent state unknown"';
    const cmuxLine = (reason) => `cmux</dt><dd><span class="muted">unknown: ${reason}</span>`;
    const curDown = { current: down("cmux current: socket not found") };
    const wtDown = { worktrees: down("git worktree list: refused") };
    // Positive control: both sources up and an agent working in wt-h0ef: the pill, no marker.
    expect(summaryOf({}, H0EF)).toContain('class="agent working"');
    expect(summaryOf({}, H0EF)).not.toContain(agentUnknown);
    expect(rowOf({}, H0EF)).not.toContain("unknown: cmux");
    // cmux current down: the collapsed line and the body both say unknown.
    expect(summaryOf(curDown, H0EF)).toContain(agentUnknown);
    expect(summaryOf(curDown, H0EF)).not.toContain('class="agent ');
    expect(rowOf(curDown, H0EF)).toContain(cmuxLine("cmux current is down"));
    // cmux current up with no workspace in wt-h0ef: no pill and no marker,
    // because "no agent here" is then known (the mutation: source up, marker absent).
    const noWorkspace = { current: ok({ items: [] }) };
    expect(summaryOf(noWorkspace, H0EF)).not.toContain(agentUnknown);
    expect(summaryOf(noWorkspace, H0EF)).not.toContain('class="agent ');
    expect(rowOf(noWorkspace, H0EF)).not.toContain("cmux</dt>");
    // A bead with no worktree, git worktree list up, has no workspace to join,
    // so cmux current being down changes nothing about it.
    expect(summaryOf(curDown, YBV)).not.toContain(agentUnknown);
    // git worktree list down: the join from cmux cwd to the bead is gone, so
    // the agent state is unknown on every in-progress row, with cmux current up.
    expect(summaryOf(wtDown, H0EF)).toContain(agentUnknown);
    expect(summaryOf(wtDown, YBV)).toContain(agentUnknown);
    expect(rowOf(wtDown, H0EF)).toContain(cmuxLine("git worktree list is down"));
    expect(rowOf({ ...curDown, ...wtDown }, YBV)).toContain(cmuxLine("cmux current and git worktree list are down"));
  });

  it("with bd list --status in_progress down a blocker chip reads in-progress state unknown, never like not in progress", () => {
    const up = sectionOf(page().html, "blocked");
    expect(up).toContain('class="chip jump hot"');
    expect(up).not.toContain("in-progress state unknown");
    const dn = sectionOf(page({ inProgress: down("bd list: database locked") }).html, "blocked");
    expect(dn).toContain('<span class="chip unk" title="Not in this dashboard: bd show ugcportal-h0ef (in-progress state unknown: bd list --status in_progress is down)">');
    expect(dn).toContain('<span class="sr"> in-progress state unknown</span>');
    expect(dn).not.toContain(" hot");
    // The other branch: a chip whose target IS on the page (a jump link) must
    // carry the same marker. Round 6 found only the plain-span branch tested.
    const BLOCKED_ON_READY = { id: "ugcportal-chip2", title: "waits on a ready bead", priority: 2, status: "open", updated_at: "2026-10-13T10:06:44Z", blocked_by: ["ugcportal-74w"], metadata: {} };
    const both = ok([BLOCKED_UL2J, BLOCKED_ON_READY]);
    const upJump = sectionOf(page({ blocked: both }).html, "blocked");
    expect(upJump).toContain('<a href="#bead-ugcportal-74w" class="chip jump" title="Curation UI">ugcportal-74w</a>');
    const dnJump = sectionOf(page({ inProgress: down("bd list: database locked"), blocked: both }).html, "blocked");
    expect(dnJump).toContain(
      '<a href="#bead-ugcportal-74w" class="chip jump unk" title="Curation UI (in-progress state unknown: bd list --status in_progress is down)">ugcportal-74w<span class="sr"> in-progress state unknown</span></a>',
    );
  });

  it("the cmux section needs git worktree list too, and says so when it is down", () => {
    const sec = sectionOf(page({ worktrees: down("git worktree list: not a git repository") }).html, "cmux");
    expect(sec).toContain("<strong>git worktree list unavailable.</strong>");
    expect(sec).toContain('<span class="count">-</span>');
    expect(sec).not.toContain("<table>");
  });

  it("distinguishes the three empty states: zero-as-a-win, nothing here, and filtered to nothing", () => {
    const quiet = page({
      inProgress: ok([]),
      prs: ok([]),
      blocked: ok([]),
      current: ok({ items: [] }),
      worktrees: ok("worktree /Users/eiriksf/code/ugcportal\nHEAD 4c8584e0\nbranch refs/heads/main\n"),
    });
    expect(quiet.attention).toHaveLength(0);
    expect(quiet.html).toMatch(/<p class="empty win">.*Nothing is waiting on you\.<\/p>/);
    expect(quiet.html).toContain('<p class="empty">No beads are in progress.</p>');
  });

  it("filtered to nothing: the page script shows No rows here match only in sections whose rows all missed", () => {
    const d = dom(page().html);
    const doc = d.window.document;
    const shown = () => [...doc.querySelectorAll("details.sec")].filter((sec) => !sec.querySelector(".nomatch").hidden).map((sec) => sec.id);
    // One per section, hidden until a filter runs.
    expect(doc.querySelectorAll(".nomatch")).toHaveLength(doc.querySelectorAll("details.sec").length);
    expect(shown()).toEqual([]);
    const input = doc.getElementById("filter");
    const filter = (q) => {
      input.value = q;
      input.dispatchEvent(new d.window.Event("input"));
    };
    // "h0ef" hits a row in In progress and Open PRs and nothing in Ready.
    filter("h0ef");
    expect(shown()).toContain("sec-ready");
    expect(shown()).not.toContain("sec-inprogress");
    expect(shown()).not.toContain("sec-prs");
    expect(doc.querySelector("#sec-ready .nomatch .q").textContent).toBe("h0ef");
    // Sections with no rows at all (merged is a list, cmux a table) never claim a miss.
    expect(shown()).not.toContain("sec-merged");
    filter("");
    expect(shown()).toEqual([]);
    d.window.close();
  });

  it("shows the first QUEUE_LIMIT queue rows and hides the rest behind Show all", () => {
    const many = Array.from({ length: QUEUE_LIMIT + 5 }, (_, i) => ({ id: `ugcportal-r${i}`, title: `Ready ${i}`, priority: 2, updated_at: "2026-10-13T10:00:00Z" }));
    const { html } = page({ ready: ok(many) });
    expect(html.match(/<details class="row overflow" id="bead-ugcportal-r/g)).toHaveLength(5);
    expect(html).toMatch(new RegExp(`<button type="button" class="more">(<svg[^>]*><use href="#i-chevron-down"/></svg>)?Show all ${QUEUE_LIMIT + 5}</button>`));
  });

  it("marks the blocker that is in progress as hot and links it to its row", () => {
    const { html } = page();
    expect(html).toContain('<a href="#bead-ugcportal-h0ef" class="chip jump hot"');
  });

  it("a jump link to a dotted child id opens its row, even when the row is behind Show all", () => {
    // ugcportal-qnq9.13 is the last of QUEUE_LIMIT + 1 ready beads, so it is an
    // overflow row, and a blocked bead waits on it, so a chip jumps to it.
    const ready = Array.from({ length: QUEUE_LIMIT }, (_, i) => ({ id: `ugcportal-q${i}`, title: `Ready ${i}`, priority: 1, updated_at: "2026-10-13T10:00:00Z" }));
    ready.push({ id: "ugcportal-qnq9.13", title: "Dotted child", priority: 3, updated_at: "2026-10-13T10:00:00Z" });
    const { html } = page({ ready: ok(ready), blocked: ok([{ ...BLOCKED_UL2J, blocked_by: ["ugcportal-qnq9.13"] }]) });
    expect(html).toContain('<a href="#bead-ugcportal-qnq9.13" class="chip jump"');
    expect(html.match(/id="bead-ugcportal-qnq9\.13"/g)).toHaveLength(1);
    // The script resolves ids with getElementById and never feeds an href to a selector.
    const script = html.slice(html.lastIndexOf("<script>"), html.lastIndexOf("</script>"));
    expect(script).toContain('document.getElementById((a.getAttribute("href") || "").slice(1))');
    expect(script).not.toMatch(/querySelector(All)?\(\s*(a\.getAttribute|location\.hash|"#"|'#'|`#)/);
    // And it works: click the chip, the overflow row opens and its section shows all.
    const d = dom(html);
    const doc = d.window.document;
    const target = doc.getElementById("bead-ugcportal-qnq9.13");
    expect(target.classList.contains("overflow")).toBe(true);
    expect(target.open).toBe(false);
    doc.querySelector('a.chip.jump[href="#bead-ugcportal-qnq9.13"]').dispatchEvent(new d.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(target.open).toBe(true);
    expect(doc.getElementById("sec-ready").classList.contains("all")).toBe(true);
    d.window.close();
  });

  it("carries the stale-banner markup with the generated time, and shows it after three intervals without a new file", () => {
    const { html } = page();
    expect(html).toContain('<meta name="refresh-seconds" content="30">');
    expect(html).toMatch(/<span id="stale" class="stale" role="status" hidden>.*Not refreshed since <time datetime="2026-10-13T12:00:00.000Z">2026-10-13 12:00 UTC<\/time>/);
    // Generated long ago (NOW is in the past for this run): the script unhides it.
    const old = dom(html);
    expect(old.window.document.getElementById("stale").hidden).toBe(false);
    old.window.close();
    // Generated just now: it stays hidden.
    const fresh = dom(page({}, new Date()).html);
    expect(fresh.window.document.getElementById("stale").hidden).toBe(true);
    fresh.window.close();
  });

  it("caps long text and points at the full record", () => {
    const long = { ...BEAD_H0EF, notes: "x".repeat(TEXT_CAP + 250) };
    const { html } = page({ inProgress: ok([long]) });
    expect(html).toContain("250 more characters. bd show ugcportal-h0ef");
  });

  it("uses a hyphen, never an em-dash or minus sign, for placeholders and diff counts", () => {
    const { html } = page();
    expect(html).not.toContain("—");
    expect(html).not.toContain("−");
    expect(html).toContain("+36 / -2");
  });
});

describe("parseArgs", () => {
  it("defaults to cwd and .runtime/dashboard.html, and reads --watch with or without a number", () => {
    expect(parseArgs([], "/repo")).toMatchObject({ repo: "/repo", out: "/repo/.runtime/dashboard.html", watchSeconds: null });
    expect(parseArgs(["--watch"], "/repo").watchSeconds).toBe(30);
    expect(parseArgs(["--watch", "5", "--open", "--sidebar"], "/repo")).toMatchObject({ watchSeconds: 5, open: true, sidebar: true });
    expect(parseArgs(["--repo", "../x", "--out", "o.html"], "/repo")).toMatchObject({ repo: "/x", out: "/repo/o.html" });
  });
  it("rejects unknown flags and a missing value", () => {
    expect(() => parseArgs(["--bogus"], "/repo")).toThrow(/unknown argument/);
    expect(() => parseArgs(["--repo"], "/repo")).toThrow(/needs a value/);
  });
  it("--print-url prints the output's percent-encoded file:// URL and exits", () => {
    expect(parseArgs(["--print-url"], "/repo")).toMatchObject({ printUrl: true, out: "/repo/.runtime/dashboard.html" });
    expect(parseArgs([], "/repo").printUrl).toBeUndefined();
    expect(dashboardUrl("/Users/x/a#b/.runtime/dashboard.html")).toBe("file:///Users/x/a%23b/.runtime/dashboard.html");
    expect(dashboardUrl("/Users/x/a?b%41/.runtime/dashboard.html")).toBe("file:///Users/x/a%3Fb%2541/.runtime/dashboard.html");
    // The real CLI, end to end: what the Refresh pane's $(...) captures.
    const script = fileURLToPath(new URL("./dev-dashboard.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--print-url", "--out", "/tmp/a#b/x.html"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("file:///tmp/a%23b/x.html\n");
  });
  it("--workspace opens the page its Refresh pane renders, so it refuses a different --out", () => {
    expect(parseArgs(["--workspace"], "/repo").out).toBe("/repo/.runtime/dashboard.html");
    expect(parseArgs(["--workspace", "--out", ".runtime/dashboard.html"], "/repo").out).toBe("/repo/.runtime/dashboard.html");
    expect(() => parseArgs(["--workspace", "--out", "/tmp/elsewhere.html"], "/repo")).toThrow(/does not take a different --out/);
  });
});

describe("gatherSources", () => {
  it("asks every full-list source for more than a real queue holds", async () => {
    const calls = [];
    const runJson = async (cmd, args) => (calls.push([cmd, ...args]), { ok: true, value: [] });
    const runText = async (cmd, args) => (calls.push([cmd, ...args]), { ok: true, value: "" });
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const sources = await gatherSources(repo, { runJson, runText });
    const call = (...prefix) => calls.find((c) => prefix.every((p, i) => c[i] === p));
    const limitOf = (c) => c[c.indexOf("--limit") + 1];
    expect(limitOf(call("bd", "list", "--status", "in_progress"))).toBe("0");
    expect(limitOf(call("bd", "ready"))).toBe("0");
    expect(limitOf(call("bd", "list", "--all"))).toBe("0");
    expect(limitOf(call("gh", "pr", "list", "--state", "open"))).toBe("200");
    expect(limitOf(call("gh", "pr", "list", "--state", "merged"))).toBe("8"); // intentionally recent only
    // Release state is read off each bead's released_in, not package.json.
    expect(sources).not.toHaveProperty("version");
  });
});

describe("release progress", () => {
  it("picks the lowest semver label not yet fully released, compared as semver", () => {
    expect(releaseLabelOf(RELEASE_BEADS)).toBe("v0.7.0");
    // Semver, not string order: as strings "v0.10.0" sorts before "v0.9.0".
    expect(releaseLabelOf([rel("a", "open", 1, ["v0.9.0"]), rel("b", "open", 1, ["v0.10.0"])])).toBe("v0.9.0");
    // Live 2026-10-14: beads relabelled for v0.8.0 while v0.7.0 still has open
    // beads. The next release to cut is v0.7.0.
    expect(releaseLabelOf([rel("a", "closed", 1, ["v0.7.0"]), rel("b", "open", 1, ["v0.7.0"]), rel("c", "open", 1, ["v0.8.0"])])).toBe("v0.7.0");
    // v0.7.0 all closed but not cut: it stays the release in progress (and
    // says it is time to cut it) while v0.8.0 has open beads.
    expect(releaseLabelOf([rel("a", "closed", 1, ["v0.7.0"]), rel("b", "closed", 1, ["v0.7.0"]), rel("c", "open", 1, ["v0.8.0"])])).toBe("v0.7.0");
    // v0.7.0 all closed and released: it moves on to v0.8.0.
    expect(
      releaseLabelOf([rel("a", "closed", 1, ["v0.7.0"], "v0.7.0"), rel("b", "closed", 1, ["v0.7.0"], "v0.7.0"), rel("c", "open", 1, ["v0.8.0"])]),
    ).toBe("v0.8.0");
    // Everything closed: the lowest uncut label, so a finished but uncut
    // release still shows as 100% rather than vanishing.
    expect(releaseLabelOf([rel("a", "closed", 1, ["v0.6.0"], "v0.6.0"), rel("b", "closed", 1, ["v0.7.0"])])).toBe("v0.7.0");
    // Everything released: fall back to the highest label overall.
    expect(releaseLabelOf([rel("a", "closed", 1, ["v0.6.0"], "v0.6.0"), rel("b", "closed", 1, ["v0.7.0"], "v0.7.0")])).toBe("v0.7.0");
    expect(releaseLabelOf([rel("a", "open", 1, ["backlog"])])).toBeNull();
    expect(releaseLabelOf([])).toBeNull();
  });
  it("counts closed beads as done and groups the rest by what stands in their way", () => {
    const p = releaseProgress(RELEASE_BEADS, "v0.7.0", new Set(["ugcportal-ul2j"]));
    expect(p).toMatchObject({ label: "v0.7.0", total: 6, done: 2, remaining: 4 });
    expect(RELEASE_GROUPS.map((g) => p.groups[g].map((b) => b.id))).toEqual([["ugcportal-r3"], ["ugcportal-r4"], ["ugcportal-ul2j"], ["ugcportal-r6"]]);
    // v0.6.0's bead is not in this release at all.
    expect(JSON.stringify(p)).not.toContain("ugcportal-r0");
  });
  it("mutation: closing one open bead moves the done/total figure and empties its group", () => {
    const closed = RELEASE_BEADS.map((b) => (b.id === "ugcportal-r4" ? { ...b, status: "closed" } : b));
    const p = releaseProgress(closed, "v0.7.0", new Set(["ugcportal-ul2j"]));
    expect(p).toMatchObject({ total: 6, done: 3, remaining: 3 });
    expect(p.groups.ready).toEqual([]);
  });
  it("renders the section with done/total, group headings and only the unfinished beads", () => {
    const { html } = page();
    expect(html).toContain("Remaining in v0.7.0");
    expect(html).toContain("2 of 6 done");
    expect(html).toContain("4 beads remaining");
    expect(html).toContain('aria-valuenow="2"');
    for (const title of ["In progress", "Ready", "Blocked", "Deferred"]) expect(html).toContain(`<h3 class="grp">${title} `);
    expect(html).toContain('id="rel-ugcportal-r4"');
    expect(html).toContain('id="rel-ugcportal-r6"');
    expect(html).not.toContain('id="rel-ugcportal-r1"');
    expect(html).not.toContain('id="rel-ugcportal-r0"');
    // The same bead in two sections keeps distinct element ids, so anchors and
    // the saved open/closed state never collide.
    expect(html.match(/id="bead-ugcportal-ul2j"/g)).toHaveLength(1);
    expect(html.match(/id="rel-ugcportal-ul2j"/g)).toHaveLength(1);
    expect(html).toContain("Left in v0.7.0");
  });
  it("models each labelled bead as remaining, done but unreleased, or released, from metadata.released_in", () => {
    const beads = [rel("a", "open", 1), rel("b", "closed", 1), rel("c", "closed", 1, ["v0.7.0"], "v0.7.0"), rel("d", "closed", 1, ["v0.7.0"], "v0.6.1")];
    expect(releaseProgress(beads, "v0.7.0")).toMatchObject({ total: 4, done: 3, released: 2, unreleased: 1, remaining: 1, releasedIn: ["v0.6.1", "v0.7.0"] });
    expect(releasedInOf(rel("x", "closed", 1, ["v0.7.0"], "v0.7.0"))).toBe("v0.7.0");
    expect(releasedInOf(rel("x", "closed", 1))).toBe("");
    // Mutation: dropping released_in from c moves it from released to unreleased.
    const dropped = beads.map((b) => (b.id === "c" ? rel("c", "closed", 1) : b));
    expect(releaseProgress(dropped, "v0.7.0")).toMatchObject({ released: 1, unreleased: 2 });
  });
  it("the progress line shows how many done beads are released and how many are not", () => {
    const sec = sectionOf(page().html, "release");
    expect(sec).toContain("2 of 6 done · 0 released · 2 not yet released · 4 beads remaining · 33%");
    // Mutation: one of the two closed beads released.
    const oneReleased = RELEASE_BEADS.map((b) => (b.id === "ugcportal-r1" ? rel("ugcportal-r1", "closed", 2, ["v0.7.0"], "v0.7.0") : b));
    expect(sectionOf(page({ release: ok(oneReleased) }).html, "release")).toContain("2 of 6 done · 1 released · 1 not yet released · 4 beads remaining");
  });
  it("everything closed, some not yet released: time to cut", () => {
    // Probe B: one bead released as v0.7.0, the rest closed after the cut.
    const allClosed = RELEASE_BEADS.map((b) => (b.labels.includes("v0.7.0") ? { ...b, status: "closed" } : b));
    allClosed[0] = rel("ugcportal-r1", "closed", 2, ["v0.7.0"], "v0.7.0");
    const html = page({ release: ok(allClosed) }).html;
    expect(html).toContain("Everything labelled v0.7.0 is closed and 5 of them are not yet released. Time to cut the release.");
    expect(html).not.toContain("is cut (");
    // Singular: only one left unreleased.
    const oneLeft = allClosed.map((b) => (b.labels.includes("v0.7.0") && b.id !== "ugcportal-r2" ? { ...b, metadata: { ...b.metadata, released_in: "v0.7.0" } } : b));
    expect(page({ release: ok(oneLeft) }).html).toContain("Everything labelled v0.7.0 is closed and 1 of them is not yet released. Time to cut the release.");
  });
  it("everything closed and released: cut, named by the version it was released as", () => {
    // Probe A: a patch-only cut from 0.6.0 released every v0.7.0 bead as v0.6.1.
    const released = RELEASE_BEADS.map((b) => (b.labels.includes("v0.7.0") ? { ...b, status: "closed", metadata: { ...b.metadata, released_in: "v0.6.1" } } : b));
    const html = page({ release: ok(released) }).html;
    expect(html).toContain("v0.7.0 is cut (6 beads released as v0.6.1); label the next release&#39;s beads.");
    expect(html).not.toContain("Time to cut the release");
    // Mutation: strip released_in from one bead and it is time to cut again.
    const oneMissing = released.map((b) => (b.id === "ugcportal-r4" ? { ...b, metadata: { cc_scope: "process", cc_type: "fix" } } : b));
    const again = page({ release: ok(oneMissing) }).html;
    expect(again).toContain("Everything labelled v0.7.0 is closed and 1 of them is not yet released. Time to cut the release.");
    expect(again).not.toContain("is cut (");
    expect(page({ release: ok([]) }).html).toContain("No bead carries a semver label");
  });
  it("orders release labels as semver, and refuses anything that is not one", () => {
    expect(compareSemver("v0.9.0", "v0.10.0")).toBeLessThan(0);
    expect(compareSemver("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("v0.7.0", "v0.7.0")).toBe(0);
    expect(() => compareSemver("v0.7.0", "0.7.0-rc.1")).toThrow(/not a release label/);
  });
  it("with bd blocked down the release section says so instead of listing blocked beads as Ready", () => {
    const up = sectionOf(page().html, "release");
    expect(up).toContain('id="rel-ugcportal-ul2j"');
    const sec = sectionOf(page({ blocked: down("bd blocked: dolt: connection refused") }).html, "release");
    expect(sec).toContain("<strong>bd blocked unavailable.</strong> bd blocked: dolt: connection refused");
    expect(sec).not.toContain('id="rel-ugcportal-ul2j"');
    expect(sec).not.toContain('<h3 class="grp">Ready ');
    // remaining comes from the release source alone, so the count stays a number.
    expect(sec).toContain('Remaining in v0.7.0 <span class="count">4</span>');
  });
  it("a failed release source is an error block and a Needs-you item, not an empty list", () => {
    const { html, attention } = page({ release: down("bd list --all: dolt: connection refused") });
    expect(html).toContain("bd list --all --label-pattern &#39;v*.*.*&#39; unavailable.");
    expect(html).not.toContain("No bead carries a semver label");
    expect(attention.map(attentionText).join("\n")).toContain("release is unavailable");
  });
});

describe("findWorkspaceCommand", () => {
  it("resolves the dashboard workspace out of the committed .cmux/cmux.json", () => {
    const configPath = fileURLToPath(new URL("../.cmux/cmux.json", import.meta.url));
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const ws = findWorkspaceCommand(config);
    expect(ws.layout.direction).toBe("horizontal");
    // The left column must open the rendered page; the right column must run
    // the refresh loop, or the page's stale banner is the only thing left.
    const text = JSON.stringify(ws.layout);
    expect(ws.layout.children[0].pane.surfaces[0]).toMatchObject({ type: "browser" });
    // No machine's path is committed: --workspace fills the placeholder in from
    // --out, and the Refresh pane navigates to the page under its own cwd.
    expect(ws.layout.children[0].pane.surfaces[0].url).toBe(DASHBOARD_URL_PLACEHOLDER);
    expect(text).not.toMatch(/\/Users\/|\/home\//);
    const resolved = resolveWorkspaceLayout(ws.layout, "/some/clone/.runtime/dashboard.html");
    expect(resolved.children[0].pane.surfaces[0].url).toBe("file:///some/clone/.runtime/dashboard.html");
    expect(ws.layout.children[0].pane.surfaces[0].url).toBe(DASHBOARD_URL_PLACEHOLDER); // the input is not mutated
    expect(() => resolveWorkspaceLayout({ pane: { surfaces: [{ type: "browser", url: "file:///x" }] } }, "/o.html")).toThrow(/DASHBOARD_HTML/);
    // The Refresh pane may drop stdout but never stderr (review-standards section 6).
    const refresh = ws.layout.children[1].children[1].pane.surfaces[0].command;
    // The URL comes from the script's own pathToFileURL, never a shell-built
    // "file://$PWD/...", which a # or ? in the checkout path would misroute.
    expect(refresh).toContain('U="$(sh scripts/dashboard.sh --print-url)"');
    expect(refresh).toContain('navigate "$U"');
    expect(refresh).not.toContain("$PWD");
    expect(refresh).not.toContain("file://");
    expect(refresh).not.toMatch(/2>\s*\/dev\/null|2>&1|&>/);
    // Both the one-shot render and the loop go through the nvm-aware wrapper:
    // a fresh cmux terminal has no node on PATH, and the wrapper is the one
    // place that fixes that. A direct `node scripts/dev-dashboard.mjs` here
    // would fail with "command not found" and leave the stale banner up.
    expect(text).toContain("sh scripts/dashboard.sh --watch");
    expect(text).not.toContain("node scripts/dev-dashboard.mjs");
    // The + button action must point at this same command name.
    expect(config.actions["ugcportal-dashboard"].commandName).toBe(WORKSPACE_COMMAND);
  });
  it("npm run dashboard goes through the same wrapper, and the wrapper runs the real script", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    expect(pkg.scripts.dashboard).toMatch(/^sh scripts\/dashboard\.sh .*--watch/);
    expect(pkg.scripts["dashboard:workspace"]).toBe("sh scripts/dashboard.sh --workspace");
    const wrapper = readFileSync(fileURLToPath(new URL("./dashboard.sh", import.meta.url)), "utf8");
    expect(wrapper).toContain('exec node scripts/dev-dashboard.mjs "$@"');
    expect(wrapper).toContain(".nvm/versions/node");
  });
  it("fails loudly when the command is missing rather than opening an empty workspace", () => {
    expect(() => findWorkspaceCommand({ commands: [] })).toThrow(/no command "ugcportal dashboard"/);
    expect(() => findWorkspaceCommand({ commands: [{ name: WORKSPACE_COMMAND, workspace: {} }] })).toThrow(/workspace.layout/);
  });
});

describe("human-wait rules in Needs you (ugcportal-a2fl)", () => {
  const labelled = (n, branch, labels = [{ name: "needs-human-merge" }]) => ({
    ...PR_232,
    number: n,
    headRefName: branch,
    url: `https://github.com/eiriksf-capgemini/ugcportal/pull/${n}`,
    labels,
  });
  const queued = (id, labels, extra = {}) => ({ id, title: `Title of ${id}`, priority: 2, status: "open", updated_at: "2026-10-12T12:00:00Z", labels, metadata: {}, ...extra });
  const items = (a, label) => a.filter((x) => x.label === label);
  /** A page with every list source empty except the ones given, so the fixture's own rows are most of what Needs you can say. */
  const quietPage = (overrides) =>
    page(
      {
        inProgress: ok([]),
        ready: ok([]),
        blocked: ok([]),
        prs: ok([]),
        current: ok({ items: [] }),
        worktrees: ok("worktree /Users/eiriksf/code/ugcportal\nHEAD 4c8584e0\nbranch refs/heads/main\n"),
        ...overrides,
      },
    );

  it("K1: one labelled and one unlabelled PR give exactly one Merge needed item, anchored to the PR row, severity bad", () => {
    const unlabelled = { ...labelled(271, "fix/ugcportal-zzzz-other", []), statusCheckRollup: PR_232.statusCheckRollup };
    const { attention, html } = quietPage({ prs: ok([labelled(270, "fix/ugcportal-aaaa-thing"), unlabelled]) });
    const merge = items(attention, "Merge needed");
    expect(merge).toHaveLength(1);
    expect(merge[0]).toMatchObject({ severity: "bad", anchor: "pr-270" });
    expect(merge[0].text).toContain("#270 for ugcportal-aaaa, reviewed clean, sensitive path");
    expect(attention.map((a) => a.text).join("\n")).not.toContain("#271");
    // The anchor exists on the page, and the PR row's collapsed line shows the label.
    expect(html).toContain('id="pr-270"');
    const row = html.slice(html.indexOf('id="pr-270"'), html.indexOf("</summary>", html.indexOf('id="pr-270"')));
    expect(row).toContain('class="chip human-wait"');
    expect(row).toContain("needs-human-merge");
    const row271 = html.slice(html.indexOf('id="pr-271"'), html.indexOf("</summary>", html.indexOf('id="pr-271"')));
    expect(row271).not.toContain("human-wait");
  });

  it("K1: a PR whose branch names no bead is still listed, without a bead id", () => {
    const { attention } = quietPage({ prs: ok([labelled(272, "chore/no-bead")]) });
    expect(items(attention, "Merge needed").map((a) => a.text)).toEqual(["#272, reviewed clean, sensitive path (needs-human-merge)"]);
  });

  it.each(["stalled-on-human", "human-only"])("K2: an open bead labelled %s gets one Waiting on you item, anchored to its row; without the label it does not", (label) => {
    const withLabel = quietPage({ ready: ok([queued("ugcportal-wait1", [label, "v0.8.1"]), queued("ugcportal-calm", ["v0.8.1"])]) });
    const wait = items(withLabel.attention, "Waiting on you");
    expect(wait).toHaveLength(1);
    expect(wait[0]).toMatchObject({ severity: "warn", anchor: "bead-ugcportal-wait1" });
    expect(wait[0].text).toBe(`ugcportal-wait1 \u2014 Title of ugcportal-wait1 (${label})`);
    expect(withLabel.html).toContain('id="bead-ugcportal-wait1"');
    // Mutated fixture: the label removed, the item is gone.
    const without = quietPage({ ready: ok([queued("ugcportal-wait1", ["v0.8.1"])]) });
    expect(items(without.attention, "Waiting on you")).toHaveLength(0);
  });

  it("K2: a closed bead carrying the label is not waiting on anyone, and a bead in two lists counts once", () => {
    const closed = queued("ugcportal-done", ["human-only"], { status: "closed" });
    const twice = queued("ugcportal-twice", ["stalled-on-human"], { status: "in_progress" });
    const { attention } = quietPage({ inProgress: ok([twice]), blocked: ok([twice]), ready: ok([closed]) });
    expect(items(attention, "Waiting on you").map((a) => a.anchor)).toEqual(["bead-ugcportal-twice"]);
  });

  it("K2: a bead and its own PR both waiting give one Merge needed and one Waiting on you, no duplicates", () => {
    const bead = queued("ugcportal-both", ["stalled-on-human"], { status: "in_progress" });
    const { attention } = quietPage({ inProgress: ok([bead]), prs: ok([labelled(273, "fix/ugcportal-both-thing")]) });
    expect(items(attention, "Merge needed")).toHaveLength(1);
    expect(items(attention, "Waiting on you")).toHaveLength(1);
    expect(attention.filter((a) => ["Merge needed", "Waiting on you"].includes(a.label) && /ugcportal-both/.test(a.text))).toHaveLength(2);
  });

  it("the label names are parameters of buildAttention, not literals in the rules", () => {
    const joined = joinRows({ prefix: PREFIX, inProgress: [], prs: [], worktrees: [], currentItems: [], now: NOW });
    const base = { prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk(), now: NOW };
    const prs = [labelled(274, "fix/ugcportal-cfg-x", [{ name: "needs-human-merge" }, { name: "custom-wait" }])];
    const beads = [queued("ugcportal-cfg", ["custom-bead-wait"])];
    expect(items(buildAttention({ ...base, prs, beads, humanWaitPrLabels: ["custom-wait"], humanWaitBeadLabels: ["custom-bead-wait"] }), "Merge needed")[0].text).toContain("(custom-wait)");
    expect(items(buildAttention({ ...base, prs, beads, humanWaitPrLabels: ["custom-wait"], humanWaitBeadLabels: ["custom-bead-wait"] }), "Waiting on you")).toHaveLength(1);
    const none = buildAttention({ ...base, prs, beads, humanWaitPrLabels: ["nope"], humanWaitBeadLabels: ["nope"] });
    expect(items(none, "Merge needed")).toHaveLength(0);
    expect(items(none, "Waiting on you")).toHaveLength(0);
  });

  it("K3: with gh down the page names prs as a Source down item and does not say nothing is waiting", () => {
    const { attention, html } = quietPage({ prs: down("gh pr list: gh not found on PATH") });
    expect(items(attention, "Merge needed")).toHaveLength(0);
    expect(attention.map(attentionText)).toContain("Source down: prs is unavailable: gh pr list: gh not found on PATH");
    expect(html).not.toContain("Nothing is waiting on you");
    expect(html).toContain("PRs unavailable (gh down), not and 0 beads checked for human-wait labels");
    expect(html).not.toMatch(/\b0 PRs\b/);
  });

  it("K3: buildAttention itself skips the PR rule when prs is down, even if handed PRs, and says Source down", () => {
    const joined = joinRows({ prefix: PREFIX, inProgress: [], prs: [], worktrees: [], currentItems: [], now: NOW });
    const a = buildAttention({ prefix: PREFIX, joined, currentItems: [], sources: allSourcesOk({ prs: down("gh refused") }), now: NOW, prs: [labelled(275, "fix/ugcportal-x-y")] });
    expect(items(a, "Merge needed")).toHaveLength(0);
    expect(items(a, "Source down").map((x) => x.text)).toEqual(["prs is unavailable: gh refused"]);
  });

  it("K4: with exactly the three labelled PRs and four labelled beads the sentence is absent, the count is non-zero and the checked line prints the counts", () => {
    const prs = [labelled(263, "fix/ugcportal-vtgz-a"), labelled(264, "fix/ugcportal-4bok-b"), labelled(265, "fix/ugcportal-xb68-c")];
    const inProgress = ["vtgz", "4bok", "xb68"].map((s) => queued(`ugcportal-${s}`, ["stalled-on-human"], { status: "in_progress" }));
    const ready = [queued("ugcportal-pyky", ["human-only"])];
    const { attention, html } = quietPage({ prs: ok(prs), inProgress: ok(inProgress), ready: ok(ready) });
    expect(html).not.toContain("Nothing is waiting on you");
    // Other rules (stale beads, unreviewed green PRs) may add items on these fixtures; the seven below are the point.
    expect(items(attention, "Merge needed")).toHaveLength(3);
    expect(items(attention, "Waiting on you")).toHaveLength(4);
    expect(attention.length).toBeGreaterThanOrEqual(7);
    expect(counts(html).headings[0]).toBe(String(attention.length));
    expect(html).toContain("3 PRs and 4 beads checked for human-wait labels");
    // Source summary does not hide the zero case either: nothing labelled, 0 shown, sentence shown.
    const quiet = quietPage({ prs: ok([]) });
    expect(quiet.html).toContain("Nothing is waiting on you");
    expect(quiet.html).toContain("0 PRs and 0 beads checked for human-wait labels");
  });
});
