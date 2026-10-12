#!/usr/bin/env node
/**
 * Enumerates every place under `scripts/` and `.claude/skills/` where a
 * command's stderr is thrown away, and fails unless each one is on the
 * allowlist below with a reason (ugcportal-kssp, mitigation 2: "never
 * silence stderr on a mutating command").
 *
 * WHY A GUARD AND NOT A SENTENCE. The recorded instance is in
 * docs/process/development-process.md section 9, weakness 6: `bd` writes
 * silenced with a redirect to the null device were reported as applied when
 * they had failed. The rule that would have stopped it already existed as
 * advice; what did not exist was anything that could tell, afterwards,
 * whether anyone had applied it. `grep` run by hand is the same advice one
 * step further along -- it answers the question only for whoever happened to
 * run it, on the day they ran it. This file answers it on every `vitest run`
 * (scripts/check-silenced-stderr.test.mjs), and the answer is a list, not a
 * boolean, so the reader sees what was examined.
 *
 * TWO FAILURE DIRECTIONS, BOTH CLOSED. A hit with no allowlist entry fails,
 * which is the obvious one. An allowlist entry that matches nothing ALSO
 * fails -- an entry kept after the code it described moved or was deleted is
 * a standing permission nobody decided to grant, and "this entry matched
 * nothing" is exactly the silence this bead is about, reproduced inside the
 * checker. Scanning zero files fails for the same reason.
 *
 * WHAT COUNTS AS SILENCED, and what deliberately does not:
 *
 *   - a `2>` redirect to the null device, and the close-stderr form: the
 *     error text is destroyed. In a shell pipeline this usually destroys the
 *     exit status too, because the silenced command is nearly always inside
 *     `$(...)`, a `||` fallback or an `if`. FLAGGED.
 *   - an `stdio` option set to the string "ignore", and an `stdio` array
 *     whose third slot is "ignore": the child's stderr goes nowhere, so a
 *     thrown `execFileSync` error carries no `stderr` to report. FLAGGED.
 *   - an `stdio` array of ["ignore", "pipe", "pipe"]: stderr is CAPTURED, not
 *     discarded. It is not printed on success, and it is available on
 *     `err.stderr` on failure -- which is how scripts/sweep-merged-branches.mjs
 *     and scripts/lib/git-diff.mjs report git's own message. NOT flagged,
 *     and that distinction is the whole reason this scanner inspects the
 *     third slot instead of matching `stdio:` at all.
 *
 * Usage:
 *   node scripts/check-silenced-stderr.mjs          # prints the audit, exit 0/1
 *
 * Self-test: scripts/check-silenced-stderr.test.mjs (vitest).
 */

import fs from "node:fs";
import path from "node:path";

import { getRepoRoot } from "./lib/git-diff.mjs";
import { isMainModule } from "./lib/is-main.mjs";

// Assembled from pieces rather than written literally, so that this file and
// its test do not match their own patterns. A scanner that has to exclude
// itself from its own scan has a hole in it the size of itself -- so this one
// scans itself like every other file, and pays for that by never writing any
// of the three silencing forms as a literal, in code OR in prose. That is the
// cost of the property, stated here rather than left for whoever next adds a
// line and watches the guard go red for a reason nothing explains.
const NULL_DEVICE = `/${"dev"}/${"null"}`;
const SHELL_DEVNULL_RE = new RegExp(String.raw`2>\s*&?\s*` + NULL_DEVICE.replace(/\//g, String.raw`\/`), "g");
const SHELL_CLOSE_RE = new RegExp("2>&" + "-", "g");
const STDIO_STRING_IGNORE_RE = /stdio\s*:\s*["']ignore["']/g;
const STDIO_ARRAY_RE = /stdio\s*:\s*\[([^\]]*)\]/g;

/** Files this guard reads. Everything else is out of its remit, by the bead's own scope. */
export const SCAN_ROOTS = ["scripts", ".claude/skills"];
export const SCAN_EXTENSIONS = [".mjs", ".js", ".md", ".py", ".sh"];

/**
 * Every stderr-silencing site in one file's text.
 *
 * @param {string} content
 * @param {string} filePath repo-relative, for reporting
 * @returns {{file: string, line: number, kind: string, snippet: string}[]}
 */
export function findStderrSilencers(content, filePath) {
  const hits = [];
  const lines = content.split("\n");

  lines.forEach((text, i) => {
    // `context` is this line plus the three above it, because the command a
    // redirect belongs to is routinely on an earlier line of the same shell
    // pipeline -- an allowlist entry has to be able to name the COMMAND, not
    // just whatever fragment happens to share a line with the redirect.
    const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const push = (kind) => hits.push({ file: filePath, line: i + 1, kind, snippet: text.trim().slice(0, 160), context });

    if (new RegExp(SHELL_DEVNULL_RE.source).test(text)) push("shell-devnull");
    if (new RegExp(SHELL_CLOSE_RE.source).test(text)) push("shell-close");
    if (new RegExp(STDIO_STRING_IGNORE_RE.source).test(text)) push("stdio-ignore");

    for (const m of text.matchAll(new RegExp(STDIO_ARRAY_RE.source, "g"))) {
      const slots = m[1].split(",").map((s) => s.trim());
      // Index 2 is stderr. A shorter array leaves stderr at its default,
      // "pipe", which is not silencing.
      if (slots.length > 2 && /^["']ignore["']$/.test(slots[2])) push("stdio-array-ignore");
    }
  });

  return hits;
}

/**
 * Every silenced-stderr site this repo currently has, each with the reason it
 * is allowed. The bead's K2 asks for exactly this list -- "every remaining
 * instance is on a read-only command, named one by one" -- and both entries
 * below are read-only probes whose exit status is still acted on.
 *
 * To add an entry you must state the command and why losing its error text
 * is safe. "It is noisy" is not a reason; "the command is read-only and the
 * caller branches on its exit status" is.
 */
export const ALLOWLIST = [
  {
    file: ".claude/skills/pr-review-merge/SKILL.md",
    kind: "shell-devnull",
    contains: "gh api repos/:owner/:repo/compare",
    reason:
      "Read-only. Step 4.2's trigger probes whether the previous round's head SHA still resolves; a 404 is an EXPECTED answer there (a captured GitHub Actions run id, a force-pushed branch), and the `if !` around it takes a live fail-safe branch that widens the review scope. The exit status is the signal; the text is not.",
  },
  {
    file: "scripts/lib/git-diff.mjs",
    kind: "stdio-array-ignore",
    contains: 'execFileSync("git", ["rev-parse", "--verify", "origin/main"]',
    reason:
      "Read-only. resolveDefaultBase probes whether `origin/main` exists at all; on a shallow or offline clone it is expected not to, and the catch returns the `HEAD~1` fallback. Printing git's `fatal: ...` on that normal path would be noise, and the caller already reports which base it settled on.",
  },
];

/**
 * Walks SCAN_ROOTS and returns the repo-relative paths this guard reads.
 *
 * @param {string} repoRoot
 * @returns {string[]} sorted
 */
export function listScannableFiles(repoRoot) {
  const found = [];
  const walk = (rel) => {
    const abs = path.join(repoRoot, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // a root that does not exist contributes nothing; auditTree's zero-file check is what catches "none of them existed"
    }
    for (const entry of entries) {
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(childRel);
      } else if (SCAN_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(childRel);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return found.sort();
}

/**
 * The audit itself. Pure given its two inputs, so the test can run it over
 * a synthetic tree as well as over the real one.
 *
 * @param {string[]} files repo-relative paths
 * @param {(file: string) => string} readFile
 * @param {typeof ALLOWLIST} allowlist
 */
export function auditTree(files, readFile, allowlist = ALLOWLIST) {
  const hits = [];
  for (const file of files) hits.push(...findStderrSilencers(readFile(file), file));

  const used = new Set();
  const unallowed = [];
  for (const hit of hits) {
    const idx = allowlist.findIndex((a) => a.file === hit.file && a.kind === hit.kind && hit.context.includes(a.contains));
    if (idx === -1) unallowed.push(hit);
    else used.add(idx);
  }
  const staleAllowlistEntries = allowlist.filter((_, i) => !used.has(i));

  return { filesScanned: files.length, hits, unallowed, staleAllowlistEntries };
}

/**
 * The report. Always states what was examined before it states what was
 * found -- the shape this whole bead is about.
 *
 * @returns {{lines: string[], ok: boolean}}
 */
export function formatAudit({ filesScanned, hits, unallowed, staleAllowlistEntries }) {
  const lines = [
    "--- check-silenced-stderr ---",
    `files examined: ${filesScanned} under ${SCAN_ROOTS.join(", ")}`,
    `stderr-silencing sites found: ${hits.length} (allowed: ${hits.length - unallowed.length}, not allowed: ${unallowed.length})`,
  ];
  for (const hit of hits) lines.push(`  ${hit.file}:${hit.line} [${hit.kind}] ${hit.snippet}`);

  let ok = true;

  if (filesScanned === 0) {
    ok = false;
    lines.push("*** EXAMINED NOTHING: 0 files matched the scan roots. A clean result here is the scanner failing to look, not the tree being clean.");
  }
  for (const hit of unallowed) {
    ok = false;
    lines.push(`*** NOT ALLOWED ${hit.file}:${hit.line} [${hit.kind}]: ${hit.snippet}`);
    lines.push("    Either stop discarding stderr here, or add an ALLOWLIST entry naming the command and why losing its error text is safe.");
  }
  for (const entry of staleAllowlistEntries) {
    ok = false;
    lines.push(`*** STALE ALLOWLIST ENTRY matched nothing: ${entry.file} [${entry.kind}] containing ${JSON.stringify(entry.contains)}`);
    lines.push("    The code it described moved or was deleted. Remove the entry rather than leaving a permission nobody decided to grant.");
  }

  lines.push(ok ? "OK: every silenced-stderr site is allowlisted with a reason, and every allowlist entry matched." : "FAIL: see the *** lines above.");
  return { lines, ok };
}

export function main({ repoRoot = getRepoRoot(), log = console.log } = {}) {
  const files = listScannableFiles(repoRoot);
  const audit = auditTree(files, (f) => fs.readFileSync(path.join(repoRoot, f), "utf8"));
  const { lines, ok } = formatAudit(audit);
  for (const line of lines) log(line);
  return ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
