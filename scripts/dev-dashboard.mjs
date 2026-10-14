#!/usr/bin/env node
/**
 * Development dashboard for working on this repo with Claude agents in cmux.
 *
 * Renders ONE self-contained HTML file that joins four sources by bead id:
 *
 *   bd    in_progress / ready / blocked beads, the database totals, and
 *         every bead carrying a semver release label (v0.7.0), closed
 *         included, for the "Remaining in <release>" section
 *   gh    open pull requests, their checks, review state and mergeability
 *   cmux  `cmux current --json`: which workspaces have an agent, and whether
 *         any agent is waiting on a human
 *   git   worktrees, so a bead's branch can be tied to the directory an
 *         agent is sitting in
 *
 * A bead, its branch, its worktree and its PR are tied together by the
 * `<prefix>-<id>` token that this repo's branch naming carries
 * (`feat/ugcportal-kt3k-bead-validator`), with worktree paths as a fallback.
 *
 * The page is compact by default and expands on click: every bead and PR is
 * a row that opens into the full record. It reloads itself on the --watch
 * interval, keeps open rows and the filter across reloads, and shows a stale
 * banner when the file stops being rewritten. See scripts/lib/dashboard-html.mjs.
 *
 * Every source is fetched independently. A source that fails renders as a
 * visible error block in every section built from it, as a "Source down" item
 * in "Needs you", and as "-" in every count derived from it. It never renders
 * as an empty list or a 0: an instrument that silently matches nothing is
 * worse than one that says it is broken (ugcportal-kssp).
 *
 * Purely advisory and read-only against bd, gh and git. What it writes is the
 * output file and, only on request, cmux state: a browser pane (--open),
 * sidebar pills (--sidebar) and a workspace (--workspace).
 *
 * Usage:
 *   node scripts/dev-dashboard.mjs                 render once to .runtime/dashboard.html
 *   node scripts/dev-dashboard.mjs --watch 30      re-render every 30 s
 *   node scripts/dev-dashboard.mjs --open          also open it in a cmux browser pane
 *   node scripts/dev-dashboard.mjs --sidebar       also set cmux sidebar status pills
 *   node scripts/dev-dashboard.mjs --repo <path> --out <path>
 *
 * As a cmux workspace: `.cmux/cmux.json` defines a "ugcportal dashboard"
 * workspace command (Command Palette, or the + button's context menu) whose
 * layout opens the page in a browser pane in the left column, a Claude
 * terminal top-right and this script's --watch loop bottom-right. The same
 * layout is registered globally as the `ugcportal-dashboard` action in
 * ~/.config/cmux/cmux.json. `.cmux/dock.json` seeds lazygit and the cmux Feed
 * in the right-hand Dock. The project config's browser URL is the placeholder
 * DASHBOARD_URL_PLACEHOLDER; the Refresh pane navigates it to the rendered
 * page under its own cwd. From a shell, `--workspace` creates that workspace
 * directly from the project config, with the placeholder already resolved:
 *   node scripts/dev-dashboard.mjs --workspace      (or: npm run dashboard:workspace)
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { renderHtml } from "./lib/dashboard-html.mjs";
import { isMainModule } from "./lib/is-main.mjs";

export * from "./lib/dashboard-data.mjs";
export { esc, renderHtml, TEXT_CAP } from "./lib/dashboard-html.mjs";

const execFile = promisify(execFileCb);

/** Default seconds between renders with --watch, and the page's reload interval. */
export const DEFAULT_REFRESH_SECONDS = 30;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Options
 * @property {string} repo
 * @property {string} out
 * @property {number | null} watchSeconds
 * @property {boolean} open
 * @property {boolean} sidebar
 * @property {boolean} workspace
 * @property {boolean} [help]
 */

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {Options}
 */
export function parseArgs(argv, cwd) {
  /** @type {Options} */
  const opts = { repo: cwd, out: "", watchSeconds: null, open: false, sidebar: false, workspace: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--repo") opts.repo = path.resolve(cwd, next());
    else if (arg === "--out") opts.out = path.resolve(cwd, next());
    else if (arg === "--watch") {
      const peek = argv[i + 1];
      if (peek !== undefined && /^\d+$/.test(peek)) {
        i += 1;
        opts.watchSeconds = Number(peek);
      } else {
        opts.watchSeconds = DEFAULT_REFRESH_SECONDS;
      }
    } else if (arg === "--open") opts.open = true;
    else if (arg === "--sidebar") opts.sidebar = true;
    else if (arg === "--workspace") opts.workspace = true;
    else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const defaultOut = path.join(opts.repo, ".runtime", "dashboard.html");
  // The workspace's Refresh pane renders to the default path and navigates the
  // browser pane there, so a different --out would open a page nothing writes.
  if (opts.workspace && opts.out && opts.out !== defaultOut)
    throw new Error(`--workspace opens the page its Refresh pane renders, ${defaultOut}; it does not take a different --out`);
  if (!opts.out) opts.out = defaultOut;
  return opts;
}

// ---------------------------------------------------------------------------
// Source fetching
// ---------------------------------------------------------------------------

/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: string }} Result
 */

function describeFailure(cmd, args, err) {
  const stderr = (err.stderr ?? "").toString().trim().split("\n")[0];
  const reason = err.code === "ENOENT" ? `${cmd} not found on PATH` : stderr || err.message;
  return `${cmd} ${args.slice(0, 2).join(" ")}: ${reason}`;
}

/**
 * Runs a command and parses stdout as JSON. Never throws: failure becomes a
 * `{ ok: false, error }` so one broken tool cannot take the dashboard down.
 * @returns {Promise<Result<unknown>>}
 */
async function runJsonDefault(cmd, args, cwd) {
  try {
    const { stdout } = await execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    const trimmed = stdout.trim();
    return { ok: true, value: trimmed === "" ? [] : JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, error: describeFailure(cmd, args, err) };
  }
}

/** @returns {Promise<Result<string>>} */
async function runTextDefault(cmd, args, cwd) {
  try {
    const { stdout } = await execFile(cmd, args, { cwd });
    return { ok: true, value: stdout };
  } catch (err) {
    return { ok: false, error: describeFailure(cmd, args, err) };
  }
}

const PR_FIELDS = [
  "number",
  "title",
  "url",
  "body",
  "headRefName",
  "baseRefName",
  "isDraft",
  "reviewDecision",
  "mergeable",
  "statusCheckRollup",
  "labels",
  "createdAt",
  "updatedAt",
  "additions",
  "deletions",
  "author",
].join(",");

/**
 * Fetches every source concurrently. Each entry is a Result so the renderer
 * can show per-section failures. The runners are injectable so the test can
 * read the exact arguments each command is given.
 * @param {string} repo
 * @param {{ runJson?: typeof runJsonDefault, runText?: typeof runTextDefault }} [runners]
 */
export async function gatherSources(repo, { runJson = runJsonDefault, runText = runTextDefault } = {}) {
  const [inProgress, ready, blocked, status, release, prs, merged, current, worktrees, mainLog, version] =
    await Promise.all([
      // Every list below that the page shows in full passes a limit no real
      // queue reaches, because a truncated list renders as a complete one,
      // tile and count included. For bd, `--limit 0` is "unlimited"; the
      // defaults are 50 for `bd list` and 100 for `bd ready` (92 beads were
      // ready on 2026-10-14).
      runJson("bd", ["list", "--status", "in_progress", "--limit", "0", "--json"], repo),
      runJson("bd", ["ready", "--limit", "0", "--json"], repo),
      // `bd blocked` (bd 1.3) has no --limit flag, so there is no limit to raise.
      runJson("bd", ["blocked", "--json"], repo),
      runJson("bd", ["status", "--json"], repo),
      // Every bead, closed included, that carries a semver release label.
      runJson("bd", ["list", "--all", "--label-pattern", "v*.*.*", "--limit", "0", "--json"], repo),
      // gh has no unlimited value; 200 open PRs is far past anything this
      // repo has had open at once. The default would be 30.
      runJson("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", PR_FIELDS], repo),
      // Deliberately short: this section is "recently merged", not a history.
      runJson(
        "gh",
        ["pr", "list", "--state", "merged", "--limit", "8", "--json", "number,title,mergedAt,url"],
        repo,
      ),
      runJson("cmux", ["current", "--json", "--limit", "200"], repo),
      runText("git", ["worktree", "list", "--porcelain"], repo),
      runText("git", ["log", "-1", "--format=%h %cr", "origin/main"], repo),
      readVersion(repo),
    ]);
  return { inProgress, ready, blocked, status, release, prs, merged, current, worktrees, mainLog, version };
}

/**
 * package.json's version, which the release section compares against the
 * release label to tell "done, not cut" from "cut".
 * @param {string} repo
 * @returns {Promise<Result<string>>}
 */
async function readVersion(repo) {
  const file = path.join(repo, "package.json");
  try {
    const v = JSON.parse(await readFile(file, "utf8")).version;
    if (typeof v !== "string" || v === "") return { ok: false, error: `${file}: no "version" field` };
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, error: `${file}: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Side effects: file write, cmux browser, sidebar pills, workspace
// ---------------------------------------------------------------------------

/**
 * Writes atomically (tmp + rename) so a browser reloading mid-write never
 * gets a half file.
 */
async function writeAtomic(outPath, content) {
  await mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, outPath);
}

/**
 * The `cmux set-status` argument lists for the sidebar pills. A count whose
 * source failed is "-", never 0, exactly as on the page's tiles.
 * @param {number} attentionCount
 * @param {Record<string, {ok: boolean, value?: any}>} sources
 * @returns {string[][]}
 */
export function sidebarPills(attentionCount, sources) {
  const color = attentionCount > 0 ? "#ff3b30" : "#34c759";
  const inProgress = sources.inProgress?.ok ? sources.inProgress.value.length : "-";
  const prs = sources.prs?.ok ? sources.prs.value.length : "-";
  return [
    ["set-status", "dash", `${attentionCount} need you`, "--icon", "bell", "--color", color, "--priority", "90"],
    ["set-status", "beads", `${inProgress} in progress`, "--icon", "hammer", "--priority", "80"],
    ["set-status", "prs", `${prs} open PR${prs === 1 ? "" : "s"}`, "--icon", "arrow.triangle.pull", "--priority", "70"],
  ];
}

/**
 * Pushes a compact summary into cmux's sidebar for the calling workspace.
 * Best effort: a missing cmux is reported once and otherwise ignored.
 */
async function updateSidebar(repo, attentionCount, sources) {
  const results = await Promise.all(sidebarPills(attentionCount, sources).map((args) => runTextDefault("cmux", args, repo)));
  const failed = results.find((r) => !r.ok);
  if (failed) process.stderr.write(`sidebar: ${failed.error}\n`);
}

/**
 * The bead id prefix is whatever `bd` uses for this database; the directory
 * name is the fallback when `bd` is down.
 */
async function detectPrefix(repo, fallback) {
  const res = await runJsonDefault("bd", ["list", "--limit", "1", "--json"], repo);
  if (res.ok && Array.isArray(res.value) && res.value[0]?.id) {
    const m = /^(.+)-[a-z0-9]+(?:\.[0-9]+)*$/i.exec(res.value[0].id);
    if (m) return m[1];
  }
  return fallback;
}

/**
 * One full render cycle.
 * @param {Options} opts
 * @param {Date} now
 */
export async function renderOnce(opts, now = new Date()) {
  const repoName = path.basename(opts.repo);
  const prefix = await detectPrefix(opts.repo, repoName);
  const sources = await gatherSources(opts.repo);
  const refreshSeconds = opts.watchSeconds ?? DEFAULT_REFRESH_SECONDS;
  const { html, attention } = renderHtml({ repoName, prefix, sources, now, refreshSeconds });
  await writeAtomic(opts.out, html);
  if (opts.sidebar) await updateSidebar(opts.repo, attention.length, sources);
  return { html, attention, sources };
}

/** Name of the workspace command in .cmux/cmux.json that --workspace opens. */
export const WORKSPACE_COMMAND = "ugcportal dashboard";

/**
 * Picks the workspace definition `--workspace` should open out of a parsed
 * .cmux/cmux.json. Exported so the test can pin the contract between this
 * flag and the config file: the command must exist and carry a layout.
 * @param {any} config parsed .cmux/cmux.json
 * @param {string} name
 */
export function findWorkspaceCommand(config, name = WORKSPACE_COMMAND) {
  const cmd = (config?.commands ?? []).find((c) => c?.name === name);
  if (!cmd?.workspace?.layout) throw new Error(`.cmux/cmux.json has no command "${name}" with a workspace.layout`);
  return cmd.workspace;
}

/**
 * The placeholder the committed .cmux/cmux.json carries for the browser
 * pane's URL, so the file names no machine's home directory.
 */
export const DASHBOARD_URL_PLACEHOLDER = "file://DASHBOARD_HTML";

/**
 * A copy of the workspace layout with every browser surface whose url is the
 * placeholder pointed at `outPath`. Throws when no surface carries the
 * placeholder, so a renamed placeholder fails here and not as a blank pane.
 * @param {any} layout
 * @param {string} outPath absolute path of the rendered page
 */
export function resolveWorkspaceLayout(layout, outPath) {
  const url = pathToFileURL(outPath).href;
  let replaced = 0;
  const copy = JSON.parse(JSON.stringify(layout), (key, value) => {
    if (key === "url" && value === DASHBOARD_URL_PLACEHOLDER) {
      replaced += 1;
      return url;
    }
    return value;
  });
  if (replaced === 0) throw new Error(`no browser surface in the layout has url ${DASHBOARD_URL_PLACEHOLDER}`);
  return copy;
}

/**
 * Creates the dashboard workspace in cmux from .cmux/cmux.json, so the
 * shell path and the Command Palette path build the same layout. The
 * browser pane opens `opts.out` (parseArgs pins it to the default path, the
 * one the Refresh pane renders to); the Command Palette path opens the
 * placeholder until the Refresh pane's first render navigates it there.
 * @param {Options} opts
 */
async function openWorkspace(opts) {
  const repo = opts.repo;
  const configPath = path.join(repo, ".cmux", "cmux.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const ws = findWorkspaceCommand(config);
  const cwd = path.resolve(repo, ws.cwd ?? ".");
  const layout = resolveWorkspaceLayout(ws.layout, opts.out);
  const res = await runTextDefault(
    "cmux",
    ["new-workspace", "--name", ws.name ?? WORKSPACE_COMMAND, "--cwd", cwd, "--focus", "true", "--layout", JSON.stringify(layout)],
    repo,
  );
  if (!res.ok) throw new Error(res.error);
  process.stdout.write(res.value.trim().split("\n").filter((l) => !l.startsWith("cmux:")).join("\n") + "\n");
}

const HELP = `dev-dashboard: render an HTML dashboard of beads, PRs and cmux agents.

  --repo <path>    repository to read (default: cwd)
  --out <path>     output file (default: <repo>/.runtime/dashboard.html)
  --watch [secs]   re-render on an interval (default ${DEFAULT_REFRESH_SECONDS} s); the page reloads on the same interval
  --open           open the output in a cmux browser pane once
  --sidebar        set cmux sidebar status pills on each render
  --workspace      create the cmux dashboard workspace defined in .cmux/cmux.json and exit
`;

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv, process.cwd());
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.workspace) {
    try {
      await openWorkspace(opts);
    } catch (err) {
      process.stderr.write(`could not open workspace: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const cycle = async () => {
    const started = Date.now();
    try {
      const { sources, attention } = await renderOnce(opts);
      const down = Object.entries(sources).filter(([, r]) => !r.ok).map(([k]) => k);
      const ms = Date.now() - started;
      process.stdout.write(
        `${new Date().toLocaleTimeString()} rendered ${opts.out} in ${ms} ms · ${attention.length} need you${
          down.length ? ` · down: ${down.join(", ")}` : ""
        }\n`,
      );
    } catch (err) {
      process.stderr.write(`render failed: ${err.message}\n`);
      process.exitCode = 1;
    }
  };

  await cycle();
  if (opts.open) {
    const res = await runTextDefault("cmux", ["browser", "open", pathToFileURL(opts.out).href, "--focus", "false"], opts.repo);
    if (!res.ok) process.stderr.write(`could not open cmux browser: ${res.error}\n`);
  }
  if (opts.watchSeconds !== null) {
    process.stdout.write(`watching every ${opts.watchSeconds} s; Ctrl-C to stop\n`);
    for (;;) {
      await new Promise((r) => setTimeout(r, opts.watchSeconds * 1000));
      await cycle();
    }
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
