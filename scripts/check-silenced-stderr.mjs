#!/usr/bin/env node
/**
 * Enumerates, line by line, every place under `scripts/` and
 * `.claude/skills/` matching one of the stderr-discarding KINDS in
 * SILENCING_KINDS below, and fails unless each one is on the allowlist with a
 * reason (ugcportal-kssp, mitigation 2: "never silence stderr on a mutating
 * command").
 *
 * That list is the claim, and it is deliberately not "every place". A scanner
 * is a set of patterns; saying "every place" promises a completeness no
 * pattern set has, and the promise is what makes a green run look like an
 * answer. An earlier version of this file did say "every place" while
 * matching four of the seven kinds -- four `bd update` writes, one per
 * unmatched kind, scanned green at exit 0. What this file guarantees is
 * SILENCING_KINDS, applied to every scanned line; what it does not see is
 * stated under KNOWN LIMITS.
 *
 * The count in that sentence is not prose: SILENCING_KINDS is the array the
 * scanner pushes from, nothing may be pushed that is not in it, and the test
 * drives every member of it to a real hit. So "seven" is a number a reader
 * can check, and adding an eighth kind without a case for it turns the suite
 * red rather than quietly making this paragraph wrong.
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
 *   - the APPENDING stderr redirect (`2>>` to the null device): appending to
 *     the null device destroys the text exactly as truncating does. FLAGGED,
 *     by the same pattern as the plain form.
 *   - the both-streams shorthand (`&>` and `&>>` to the null device, and the
 *     older `>&` spelling): stdout and stderr both go nowhere. FLAGGED.
 *   - stdout sent to the null device and stderr then duplicated ONTO stdout,
 *     on the same line -- the single most common spelling of this in shell,
 *     and the one the first version of this file missed. FLAGGED. Note the
 *     order matters and the pattern encodes it: the dup must come AFTER the
 *     null redirect. The reverse order duplicates stderr onto the ORIGINAL
 *     stdout, which is not silencing, and is not flagged.
 *   - Python's `DEVNULL`, passed as the `stderr` keyword to `subprocess`
 *     (bare or qualified): the child's error text is discarded by the same
 *     mechanism as the `stdio` string form, and `.py` is in SCAN_EXTENSIONS.
 *     FLAGGED.
 *
 * KNOWN LIMITS, stated so a green run is read for what it is. This scanner is
 * line-oriented and textual. It does not see: a redirect built at runtime
 * from a variable (`cmd $QUIET`), a redirect split across a line
 * continuation from the command it belongs to in a way no pattern on the
 * redirect's own line catches, `exec`-style redirection of a whole script's
 * stderr followed later by a mutating command, a file outside SCAN_ROOTS or
 * SCAN_EXTENSIONS, or a library call that swallows stderr without naming it
 * (a `catch {}` around `execFileSync` loses the message just as thoroughly,
 * and is family-1 work for a human, not a pattern). Adding a form here means
 * adding it to this list and to a case in the test file, both.
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
const NULL_PATTERN = NULL_DEVICE.replace(/\//g, String.raw`\/`);
// `2>` and `2>>`: truncating and appending both destroy the text.
const SHELL_DEVNULL_RE = new RegExp(String.raw`2>>?\s*&?\s*` + NULL_PATTERN, "g");
const SHELL_CLOSE_RE = new RegExp("2>&" + "-", "g");
// Both streams at once: the `&>`/`&>>` shorthand, and the older `>&` spelling.
// The lookbehind keeps `2>&` out of this kind -- it is already SHELL_DEVNULL's.
const SHELL_MERGE_DEVNULL_RE = new RegExp(String.raw`(?:&>>?|(?<![0-9])>&)\s*` + NULL_PATTERN, "g");
// Null redirect FIRST, stderr duplicated onto it SECOND, same line. Order is
// load-bearing: the reverse order sends stderr to the original stdout and is
// not silencing, so the pattern cannot be written as an unordered pair.
const SHELL_DUP_DEVNULL_RE = new RegExp(String.raw`(?<![0-9&])1?>>?\s*` + NULL_PATTERN + String.raw`[^\n]*?2>\s*&\s*1`, "g");
// Python: the DEVNULL sentinel handed to subprocess as the stderr keyword,
// bare (`from subprocess import DEVNULL`) or qualified.
const PY_DEVNULL_RE = /stderr\s*=\s*(?:subprocess\.)?DEVNULL/g;
const STDIO_STRING_IGNORE_RE = /stdio\s*:\s*["']ignore["']/g;
const STDIO_ARRAY_RE = /stdio\s*:\s*\[([^\]]*)\]/g;

/**
 * Every kind of hit this scanner can report, in the order the forms are
 * described above. This array IS the "what it detects" claim: `findStderrSilencers`
 * refuses to push a kind that is not in it, and the test asserts both that it
 * has exactly these members and that each one is reachable from real text.
 */
export const SILENCING_KINDS = [
  "shell-devnull",
  "shell-merge-devnull",
  "shell-dup-devnull",
  "shell-close",
  "py-devnull",
  "stdio-ignore",
  "stdio-array-ignore",
];

/** Files this guard reads. Everything else is out of its remit, by the bead's own scope. */
export const SCAN_ROOTS = ["scripts", ".claude/skills"];
export const SCAN_EXTENSIONS = [".mjs", ".js", ".md", ".py", ".sh"];

/**
 * Every stderr-silencing site in one file's text.
 *
 * @param {string} content
 * @param {string} filePath repo-relative, for reporting
 * @returns {{file: string, line: number, kind: string, snippet: string,
 *            lineText: string, context: string}[]} `snippet` is the trimmed,
 *   160-char-capped line for display only. `lineText` is the hit line in
 *   full and `context` is that line plus the three above it -- both are
 *   REPORTED FIELDS, not decoration: `auditTree` keys the entire allowlist
 *   decision on them (`context` locates the command, `lineText` pins the
 *   redirect's own line), so a change to either changes what is allowed.
 *   They were omitted from this list once, in a file about claims that
 *   outrun the code.
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
    const push = (kind) => {
      // Not defensive padding: this is what makes SILENCING_KINDS the claim
      // rather than a comment beside it. A new pattern pushed without being
      // declared there throws here, on the first line it matches.
      if (!SILENCING_KINDS.includes(kind)) throw new Error(`undeclared silencing kind ${JSON.stringify(kind)} -- add it to SILENCING_KINDS and to the header's form list`);
      hits.push({ file: filePath, line: i + 1, kind, snippet: text.trim().slice(0, 160), lineText: text, context });
    };

    if (new RegExp(SHELL_DEVNULL_RE.source).test(text)) push("shell-devnull");
    if (new RegExp(SHELL_MERGE_DEVNULL_RE.source).test(text)) push("shell-merge-devnull");
    if (new RegExp(SHELL_DUP_DEVNULL_RE.source).test(text)) push("shell-dup-devnull");
    if (new RegExp(SHELL_CLOSE_RE.source).test(text)) push("shell-close");
    if (new RegExp(PY_DEVNULL_RE.source).test(text)) push("py-devnull");
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
 *
 * HOW AN ENTRY BINDS, and why it is two fields rather than one. An entry
 * grants an exemption to a SITE, never to a neighbourhood. By default
 * `commandContains` must appear on the hit's OWN line: the command and the
 * redirect that silences it are the same line, which is the ordinary case.
 *
 * `lineContains` is the explicit opt-in for the other case -- a shell
 * pipeline where the command is a continuation line or three above its own
 * redirect. It widens `commandContains` to the three-line context window AND
 * requires its own fragment on the hit line, so the entry still names the
 * exact line it is exempting.
 *
 * The default is strict because the first version was not: it matched
 * `commandContains` against the context window alone, with nothing checked on
 * the hit line. A `bd update ... --set-metadata` write placed ONE LINE BELOW
 * the read-only `gh api .../compare` probe was reported `allowed`, exit 0 --
 * blessed by an entry whose stated reason is "Read-only.". An exemption that
 * grants by proximity is a blanket exemption with a specific-sounding reason
 * on it. Forgetting `lineContains` on a genuinely cross-line site now fails
 * closed: the entry matches nothing, which the stale-entry check turns red.
 */
export const ALLOWLIST = [
  {
    file: ".claude/skills/pr-review-merge/SKILL.md",
    kind: "shell-devnull",
    commandContains: "gh api repos/:owner/:repo/compare",
    // The redirect sits on the probe's `--jq` continuation line, two below
    // the command itself. This fragment is what pins the exemption to THAT
    // line rather than to everything within three lines of the command.
    lineContains: "--jq '.files[] | [.status, .filename] | @tsv'",
    reason:
      "Read-only. Step 4.2's trigger probes whether the previous round's head SHA still resolves; a 404 is an EXPECTED answer there (a captured GitHub Actions run id, a force-pushed branch), and the `if !` around it takes a live fail-safe branch that widens the review scope. The exit status is the signal; the text is not.",
  },
  {
    file: "scripts/lib/git-diff.mjs",
    kind: "stdio-array-ignore",
    // Single-line site: no `lineContains`, so the default applies and this
    // string must be on the hit line itself.
    commandContains: 'execFileSync("git", ["rev-parse", "--verify", "origin/main"]',
    reason:
      "Read-only. resolveDefaultBase probes whether `origin/main` exists at all; on a shallow or offline clone it is expected not to, and the catch returns the `HEAD~1` fallback. Printing git's `fatal: ...` on that normal path would be noise, and the caller already reports which base it settled on.",
  },
  {
    file: "scripts/check-bead-dispatch.test.mjs",
    kind: "stdio-ignore",
    // Single-line site: the probe and the option that discards its streams
    // share one line, so the default binding (hit line itself) applies.
    commandContains: 'execFileSync(sh, ["-c", "exit 0"]',
    reason:
      "Read-only. The SHELLS filter probes whether each interpreter exists before the documented lines are run through it; on the ubuntu runner `zsh` is absent and spawning it fails with ENOENT, which is the EXPECTED answer and is turned into `false` by the filter. The exit status is the signal, and the test right below asserts that `bash` survived the filter, so a probe that wrongly dropped every shell cannot pass as an empty loop.",
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
 * Does one allowlist entry cover one hit? Exported so the test can drive the
 * binding rule directly, and separate from `auditTree` because this one
 * predicate is the whole of what "allowed" means here.
 *
 * @param {{file: string, kind: string, commandContains: string, lineContains?: string}} entry
 * @param {{file: string, kind: string, lineText: string, context: string}} hit
 * @returns {boolean}
 */
export function entryCoversHit(entry, hit) {
  if (entry.file !== hit.file || entry.kind !== hit.kind) return false;
  // Without `lineContains` the command itself must be on the hit line. With
  // it, the command may be up to three lines above, but the named fragment
  // still has to be on the hit line -- so either way the entry is bound to a
  // line, never to a window.
  const lineNeedle = entry.lineContains ?? entry.commandContains;
  return hit.context.includes(entry.commandContains) && hit.lineText.includes(lineNeedle);
}

/**
 * Entries that cannot be evaluated, reported rather than skipped. A malformed
 * entry that was simply ignored would be an allowlist whose size is not the
 * number of permissions in force -- the same shape of silence as a stale one.
 *
 * @param {typeof ALLOWLIST} allowlist
 * @returns {{entry: object, problem: string}[]}
 */
export function findMalformedAllowlistEntries(allowlist) {
  const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
  const problems = [];
  for (const entry of allowlist) {
    for (const field of ["file", "kind", "commandContains", "reason"]) {
      if (!nonEmpty(entry[field])) problems.push({ entry, problem: `${field} is missing or empty` });
    }
    if (entry.lineContains !== undefined && !nonEmpty(entry.lineContains)) {
      problems.push({ entry, problem: "lineContains is present but empty, which would widen the entry to the whole context window" });
    }
  }
  return problems;
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

  const malformedAllowlistEntries = findMalformedAllowlistEntries(allowlist);

  const used = new Set();
  const unallowed = [];
  for (const hit of hits) {
    const idx = allowlist.findIndex((entry) => entryCoversHit(entry, hit));
    if (idx === -1) unallowed.push(hit);
    else used.add(idx);
  }
  const staleAllowlistEntries = allowlist.filter((_, i) => !used.has(i));

  return { filesScanned: files.length, hits, unallowed, staleAllowlistEntries, malformedAllowlistEntries };
}

/**
 * The report. Always states what was examined before it states what was
 * found -- the shape this whole bead is about.
 *
 * @returns {{lines: string[], ok: boolean}}
 */
export function formatAudit({ filesScanned, hits, unallowed, staleAllowlistEntries, malformedAllowlistEntries = [] }) {
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
    lines.push(`*** STALE ALLOWLIST ENTRY matched nothing: ${entry.file} [${entry.kind}] containing ${JSON.stringify(entry.commandContains)}`);
    lines.push("    The code it described moved or was deleted, or the site is a cross-line pipeline and the entry has no `lineContains` naming the redirect's own line.");
    lines.push("    Fix it or remove it rather than leaving a permission nobody decided to grant.");
  }
  for (const { entry, problem } of malformedAllowlistEntries) {
    ok = false;
    lines.push(`*** MALFORMED ALLOWLIST ENTRY: ${entry.file ?? "(no file)"} [${entry.kind ?? "(no kind)"}]: ${problem}`);
    lines.push("    An entry that cannot be evaluated is not a permission anyone granted. Fill the field in or delete the entry.");
  }

  // "every site this scanner matches", not "every site": the same narrowing
  // the header makes. A pass line that overstates its own reach is the
  // defect this file exists to catch, printed by the file itself.
  lines.push(
    ok
      ? "OK: every site matching one of this scanner's enumerated forms (see its header) is allowlisted with a reason, and every allowlist entry matched a line."
      : "FAIL: see the *** lines above.",
  );
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
