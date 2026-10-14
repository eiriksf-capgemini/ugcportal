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
 *      "Needs you" item. It must never render as an empty list, which would
 *      read as "nothing to do" (the fail-open shape ugcportal-kssp is about).
 *   3. Nothing from bd, gh or git reaches the HTML unescaped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  agentStateOf,
  ageOf,
  attentionText,
  blockedByThis,
  blockersOf,
  buildAttention,
  esc,
  extractBeadId,
  findWorkspaceCommand,
  joinRows,
  normalisePath,
  parseArgs,
  parseWorktrees,
  plural,
  QUEUE_LIMIT,
  RELEASE_GROUPS,
  releaseLabelOf,
  releaseProgress,
  renderHtml,
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
function rel(id, status, priority, labels = ["v0.7.0"]) {
  return { id, title: `Release bead ${id}`, description: "", status, priority, issue_type: "task", labels, updated_at: "2026-10-12T12:00:00Z", metadata: { cc_scope: "process", cc_type: "fix" }, dependencies: [] };
}
const RELEASE_BEADS = [
  rel("ugcportal-r1", "closed", 2),
  rel("ugcportal-r2", "closed", 1),
  rel("ugcportal-r3", "in_progress", 1),
  rel("ugcportal-r4", "open", 2),
  rel("ugcportal-ul2j", "open", 1), // also in the `blocked` fixture, so it lands in the Blocked group
  rel("ugcportal-r6", "deferred", 3),
  rel("ugcportal-r0", "closed", 2, ["v0.6.0"]), // last release; must not count
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

function page(overrides = {}) {
  return renderHtml({ repoName: "ugcportal", prefix: PREFIX, sources: allSourcesOk(overrides), now: NOW, refreshSeconds: 30 });
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
  it("is red on any failure, pending on any unfinished check, green otherwise", () => {
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("red");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "" }])).toBe("pending");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }])).toBe("green");
    expect(summariseChecks([])).toBe("none");
    expect(summariseChecks(undefined)).toBe("none");
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
    const items = buildAttention({ joined, currentItems: [], sources, now: NOW });
    const text = items.map(attentionText).join("\n");
    expect(text).toContain("Source down: current is unavailable");
    expect(text).toContain("CI red: #240");
    expect(text).toContain("Changes requested: #240");
    expect(text).toContain("Merge conflict: #240");
    expect(text).toContain("Stale: ugcportal-ybv has had no update for 5d and has no PR");
    expect(text).toContain("Unstarted claim: ugcportal-new1");
    expect(text).toContain("Orphan worktree: /private/tmp/wt-stray on spike/no-bead-here");
    expect(text).not.toContain("Lease expired");
    // Items carry the anchors the page uses to jump to the row.
    expect(items.find((a) => a.label === "Stale").anchor).toBe("bead-ugcportal-ybv");
    expect(items.find((a) => a.label === "CI red").anchor).toBe("pr-240");
    expect(items.find((a) => a.label === "Source down").severity).toBe("bad");
  });

  it("nags about a green unreviewed PR only after the wait, and not while an agent is working on it", () => {
    const base = { prefix: PREFIX, prs: [PR_232], worktrees: parseWorktrees(WORKTREE_PORCELAIN), now: NOW };
    const oldBead = { ...BEAD_H0EF, updated_at: "2026-10-13T06:00:00Z" };
    const idle = joinRows({ ...base, inProgress: [oldBead], currentItems: [] });
    expect(buildAttention({ joined: idle, currentItems: [], sources: allSourcesOk(), now: NOW }).map(attentionText).join("\n")).toContain(
      "Review pending: #232",
    );
    const busy = joinRows({ ...base, inProgress: [oldBead], currentItems: [CMUX_ITEM_WORKING] });
    expect(
      buildAttention({ joined: busy, currentItems: [CMUX_ITEM_WORKING], sources: allSourcesOk(), now: NOW }).map(attentionText).join("\n"),
    ).not.toContain("Review pending");
    const recent = joinRows({ ...base, inProgress: [BEAD_H0EF], currentItems: [] });
    expect(buildAttention({ joined: recent, currentItems: [], sources: allSourcesOk(), now: NOW }).map(attentionText).join("\n")).not.toContain(
      "Review pending",
    );
  });

  it("tells a merged-but-open bead apart from an unstarted claim", () => {
    const mergedPr = { number: 250, title: "fix(x): done (ugcportal-new1)", url: "https://github.com/eiriksf-capgemini/ugcportal/pull/250", mergedAt: "2026-10-13T11:00:00Z" };
    const joined = joinRows({ prefix: PREFIX, inProgress: [BEAD_FRESH_NO_PR], prs: [], worktrees: [], currentItems: [], now: NOW });
    const items = buildAttention({ joined, currentItems: [], sources: allSourcesOk({ merged: ok([mergedPr]) }), now: NOW });
    const text = items.map(attentionText).join("\n");
    expect(text).toContain("Merged, bead open: #250 for ugcportal-new1 merged 1h ago but the bead is still in_progress. bd close ugcportal-new1?");
    expect(text).not.toContain("Unstarted claim");
    expect(items.find((a) => a.label === "Merged, bead open").href).toBe(mergedPr.url);
  });

  it("surfaces a cmux workspace whose agent is waiting on a human, with a correct plural", () => {
    const waiting = { label: "kt3k implementer", cwd: "/tmp/wt-kt3k", agents: [{ state: "idle" }], attention: [{}] };
    const joined = joinRows({ prefix: PREFIX, inProgress: [], prs: [], worktrees: [], currentItems: [waiting], now: NOW });
    const items = buildAttention({ joined, currentItems: [waiting], sources: allSourcesOk(), now: NOW });
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
    expect(quiet.html).toContain('<p class="nomatch" hidden>No rows here match');
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
});

describe("release progress", () => {
  it("picks the highest semver label among beads that are not closed, compared as semver", () => {
    expect(releaseLabelOf(RELEASE_BEADS)).toBe("v0.7.0");
    expect(releaseLabelOf([rel("a", "open", 1, ["v0.9.0"]), rel("b", "open", 1, ["v0.10.0"])])).toBe("v0.10.0");
    // Everything closed: fall back to the highest label overall, so a finished
    // but uncut release still shows as 100% rather than vanishing.
    expect(releaseLabelOf([rel("a", "closed", 1, ["v0.6.0"]), rel("b", "closed", 1, ["v0.7.0"])])).toBe("v0.7.0");
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
  it("says so when the release is done, and when nothing carries a release label", () => {
    const allClosed = RELEASE_BEADS.map((b) => ({ ...b, status: "closed" }));
    expect(page({ release: ok(allClosed) }).html).toContain("Everything labelled v0.7.0 is closed (6 of 6)");
    expect(page({ release: ok([]) }).html).toContain("No bead carries a semver label");
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
    expect(ws.layout.children[0].pane.surfaces[0].url).toMatch(/^file:\/\/.*\/\.runtime\/dashboard\.html$/);
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
