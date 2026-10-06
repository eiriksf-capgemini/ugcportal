#!/usr/bin/env node
/**
 * Enumerates the claims a branch's new comments and prose make, so the
 * implementer can put the evidence beside each one before a reviewer does
 * (ugcportal-wzgw, the /pre-review skill).
 *
 * Why this exists, measured: across PRs #94-#102 of the v0.5.0 cut, 57 of
 * the findings raised at review round 4 or later were lows, and 35 of those
 * (61%) were review-standards Family 1 -- a comment claiming something the
 * code does not do. About half of them were sentences WRITTEN DURING A FIX
 * ROUND (a measurement, a "never", a pointer at a sibling file), and about a
 * third were sentences a fix had left stale one file over. Every one of
 * them cost a full review round under the strict chain rule. See
 * docs/process/review-rounds-v0.5.0.md, Part 2.
 *
 * Purely advisory, like scripts/sweep-candidates.mjs: it lists candidate
 * sentences for a human to judge; it never decides a claim is false, and
 * nothing in the build or push path (CI, the pre-push hook) calls it, so its
 * exit code never blocks either. It does exit non-zero on its own, in main()
 * below, in exactly three shapes -- every one of them a refusal to print a
 * count it cannot stand behind, never a verdict on a claim: an argument it
 * cannot parse (an unrecognized flag, or `--base` with no usable value);
 * an explicitly-given `--base` that does not resolve against HEAD; and any
 * required git read failing, unconditionally -- not only while the working
 * tree happens to be dirty (K3; ugcportal-np1i round 2 H1 narrowed this from
 * "while dirty" to "always", because a fully-committed clean branch can
 * still have a real diff to report, and a failed read there is exactly as
 * untrustworthy as one on a dirty tree). All three only affect whoever ran
 * it directly, same as above. The one thing it does check
 * mechanically is whether a file a comment points at still exists in the
 * tree, because that is the family-1 shape that is pure fact (PR #98 round
 * 3: "sign-in-policy.ts:125 cites configured-users.ts, which no longer
 * exists"; PR #97 round 1: a comment citing a contrast entry that does not
 * exist; PR #96 pre-push: a test header pointing at the wrong e2e path).
 * That check now also counts an untracked file as existing (ugcportal-np1i
 * round 3 L1): untracked files are a first-class scanned input since this
 * bead's own K1 fix, so a reference to one is a real, existing file, not a
 * stale pointer -- checking only `git ls-files`'s tracked list used to
 * flag it "not found" regardless.
 *
 * What it reports, for every comment (or prose line) on a line this branch
 * ADDED relative to the base:
 *
 *   ABSOLUTE     never / always / cannot / only / exactly / guarantee(s) /
 *                ensure(s) / impossible / unreachable / by construction.
 *                The check: is that true on every path, and which test
 *                proves it? If no test does, either write one or weaken
 *                the sentence to what the code actually does.
 *   MEASUREMENT  a number with a unit (85px, 3.18:1, ~46x, 2588 tests,
 *                12,266 B). The rule (review-standards section 5): a
 *                measurement belongs in a test that fails when it drifts;
 *                the comment points at the test. PR #86 round 1 carried
 *                two measurements of the same scenario in one schema file,
 *                neither matching the back-of-envelope line between them.
 *   TEMPORAL     still / not yet / currently / today / for now / once X
 *                merges / will. True when written and false a round later:
 *                PR #82 round 1 ("remains to be switched" -- this PR was
 *                the switch), PR #98 round 3 (a bootstrap rule rewritten
 *                in round 1 and still described the old way in three files).
 *   HISTORY      review-round narration ("round 4 finding 2", "PR #94
 *                review round 4/5") inside code or a test name. That is a
 *                changelog, not a reason; it is also the cheapest thing to
 *                leave stale (PR #94 round 5: two cross-file comments left
 *                behind by the header move).
 *   REFERENCE    a path-shaped token (foo/bar.ts, bar.test.tsx:123). Marked
 *                "not found" when `git ls-files` has no path that is, or
 *                ends with, that token -- a stale pointer, or a dependency
 *                file the comment should name as one.
 *
 * Comments are found with the TypeScript compiler API's own AST
 * (`typescript` is already a project dependency), never a hand-rolled
 * tokenizer -- the same decision scripts/sweep-candidates.mjs records, for
 * the same reason (three review rounds of edge cases in a hand-written
 * scanner there; PR #92 spent rounds 3-6 on one in src/lib/design and PR
 * #95 replaced it with TypeScript's lexer). For files TypeScript does not
 * parse (.md, .prisma, .sh, .yml, .yaml), a line is prose when the file is
 * Markdown or when it starts with `#` or `//`.
 *
 * Usage:
 *   node scripts/claims-audit.mjs [--base <git-ref>|--base=<git-ref>] [--all-lines]
 *     --base defaults to `origin/main`, falling back to `HEAD~1`; it accepts
 *       either `--base <ref>` or `--base=<ref>` and diffs the same either way
 *       (ugcportal-np1i K2 -- the `=` form used to be silently ignored,
 *       which meant a given base was never actually applied). Any other
 *       `--base`-shaped or unrecognized flag is a named error, not a silent
 *       fallback to the default (ugcportal-np1i L1/L2).
 *     --all-lines audits every comment in every changed file, not only the
 *       added lines -- the sweep for stale SIBLINGS of a sentence a fix
 *       just changed (the Family 4 case: PR #102 found the same corrected
 *       model stated five places, over four rounds).
 *
 * Self-test: npm test -- runs scripts/claims-audit.test.mjs (vitest).
 *
 * Instead of diffing `base` against HEAD and separately against the working
 * tree (two coordinate systems that can disagree -- see ugcportal-np1i M2
 * below), this script resolves the merge base of `base` and HEAD once
 * (resolveMergeBase) and diffs THAT directly against the CURRENT WORKING
 * TREE (resolveMergeBase/getChangedLineNumbersSince/listUntrackedFiles/
 * readFileFromWorkingTree, all in scripts/lib/git-diff.mjs -- one `git diff
 * -U0` provides both the changed-file list and the changed line numbers,
 * ugcportal-np1i round 2 L3). A file changed in a commit already on this
 * branch and a file with only an uncommitted edit are both just "changed
 * since the merge base" -- including an untracked file, which has no HEAD
 * side to diff against at all and so counts as entirely new. Before this,
 * a run before the first commit diffed an empty `base...HEAD` and printed
 * "candidates found: 0" -- true of the committed diff, false of the working
 * tree -- which two implementers independently hit the same day
 * (ugcportal-nvg0, ugcportal-euqi: M1/the original bug). A later review
 * round (ugcportal-np1i round 1) reproduced two further ways the same false
 * zero could still happen after that first fix: an unresolvable `--base`
 * falling through silently (M1, now closed by resolveMergeBase throwing and
 * main() refusing when `base` was given explicitly), and a committed change
 * plus an uncommitted edit to the same file producing two line-numbering
 * systems whose union pointed at the wrong lines (M2, now closed by this
 * single merge-base-to-working-tree diff, which has only one coordinate
 * system). If `base` was only the computed default (not given explicitly)
 * and it still does not resolve -- the original first-commit case, where
 * `HEAD~1` does not exist yet -- main() degrades to diffing HEAD itself
 * against the working tree, rather than refusing: there is no earlier
 * commit to compare against, but any uncommitted work is still worth
 * reporting; the printed banner then names `HEAD`, the ref actually used,
 * rather than the unresolvable default (round 2 L1). If a required git read
 * fails for any other reason, main() refuses with a non-zero exit instead
 * of printing a candidate count that silently excludes whatever that failed
 * read would have added -- unconditionally, not only when the working tree
 * is dirty (M3's original fix only covered the line-range read failing
 * while dirty; round 2 H1 found the same gap reachable on a clean,
 * fully-committed branch, which is also the ordinary `/pre-review` case,
 * and removed the dirty-tree precondition from the guard entirely).
 * Every working-tree path above is resolved against the REPOSITORY ROOT
 * (scripts/lib/git-diff.mjs's getRepoRoot), not `process.cwd()` (round 3
 * H1): a bare `fs.readFileSync` -- unlike the `git show HEAD:path` the
 * round-2 redesign replaced, which git itself always resolves against the
 * repo root -- resolves against whatever directory the process happens to
 * be started from, so running this script from a subdirectory used to make
 * every file lookup throw, each one silently caught as "deleted", again
 * reproducing the exact false "candidates found: 0" this bead exists to
 * eliminate.
 *
 * KNOWN LIMITATION (ugcportal-lykb), narrowed: scripts/sweep-candidates.mjs,
 * which shares this same scripts/lib/git-diff.mjs, still reads checked-out
 * HEAD rather than the working tree (it was not in this bead's scope --
 * review round 1 flagged this as a worthwhile follow-up). This script no
 * longer has that limitation in either half of its comparison: it reads
 * what is actually on disk.
 */

import path from "node:path";

import ts from "typescript";

import {
  getChangedLineNumbersSince,
  listTrackedFiles,
  listUntrackedFiles,
  readFileFromWorkingTree,
  resolveDefaultBase,
  resolveMergeBase,
} from "./lib/git-diff.mjs";
import { isMainModule } from "./lib/is-main.mjs";

const TS_FAMILY_RE = /\.[cm]?[jt]sx?$/;
const MARKDOWN_RE = /\.mdx?$/;
const HASH_COMMENT_RE = /\.(sh|ya?ml|toml|env|example)$/;
const SLASH_COMMENT_RE = /\.prisma$/;

// --- claim classification ------------------------------------------------

const ABSOLUTE_RE =
  /\b(never|always|cannot|can['’]t|can not|only|exactly|guarantees?d?|ensures?d?|impossible|unreachable|by construction|in every case|on every path|nothing else|no other)\b/i;
const TEMPORAL_RE =
  /\b(still|not yet|currently|today|for now|once (?:#\d+|PR|this|that|it)\b|will (?:be|do|read|run|become)|remains? to be|until|TODO|FIXME)\b/i;
const HISTORY_RE = /\b(review )?round \d\b|\bPR #\d+\b|\bfinding \d\b|\bround-\d\b/i;
// A number with a unit, a ratio, a multiplier, or a count of a thing a test
// could pin. Deliberately NOT every number: "line 2", "HTTP 500" and
// "React 19" are identifiers, not measurements.
const MEASUREMENT_RE =
  /(?:~|≈|about |roughly |exactly )?\b\d[\d,]*(?:\.\d+)?\s?(?:x\b|%|px\b|rem\b|ms\b|s\b|µs\b|B\b|kB\b|KB\b|MB\b|GB\b|:1\b|tests?\b|files?\b|rows?\b|bytes?\b|lines?\b|rules?\b|cases?\b|rounds?\b|requests?\b|calls?\b|tokens?\b|minutes?\b|seconds?\b|hours?\b)/;
// The lookbehind excludes `$` so a shell fragment like `pr-$n-issue.json`
// does not read as a reference to a file named `n-issue.json`.
const PATH_RE =
  /(?<![\w@$/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|css|scss|md|mdx|prisma|sh|ya?ml|json|html|pem|sql))(?::(\d+)(?:-\d+)?)?(?![\w/-])/g;
const URL_RE = /https?:\/\/\S+/g;

/**
 * Which claim categories a single comment line triggers.
 *
 * @param {string} text one line of comment or prose, markers stripped
 * @returns {string[]} zero or more of ABSOLUTE, MEASUREMENT, TEMPORAL, HISTORY
 */
export function classifyClaimLine(text) {
  const categories = [];
  if (ABSOLUTE_RE.test(text)) categories.push("ABSOLUTE");
  if (MEASUREMENT_RE.test(text)) categories.push("MEASUREMENT");
  if (TEMPORAL_RE.test(text)) categories.push("TEMPORAL");
  if (HISTORY_RE.test(text)) categories.push("HISTORY");
  return categories;
}

/**
 * Path-shaped tokens in a comment line, URLs excluded.
 *
 * @param {string} text
 * @returns {{ token: string, line: number | null }[]}
 */
export function findPathReferences(text) {
  const withoutUrls = text.replace(URL_RE, " ");
  const refs = [];
  for (const match of withoutUrls.matchAll(PATH_RE)) {
    refs.push({ token: match[1], line: match[2] ? Number(match[2]) : null });
  }
  return refs;
}

/**
 * True when `token` names a file that exists in the tree: an exact
 * repo-relative path, a path relative to the commenting file's directory, or
 * a bare filename (or path suffix) that at least one known path ends with.
 * `existingFiles` is expected to be tracked files UNIONED with untracked
 * ones (ugcportal-np1i round 3 L1): a reference to an untracked sibling --
 * first auditable at all only since this bead's own K1 fix made untracked
 * files a scanned input -- used to be flagged "not found" even though the
 * file is sitting right there on disk, because only `git ls-files`'s
 * tracked list was ever checked.
 *
 * @param {string} token
 * @param {string} fromFile repo-relative path of the file holding the comment
 * @param {string[]} existingFiles tracked and untracked paths, combined
 * @returns {boolean}
 */
export function referenceExists(token, fromFile, existingFiles) {
  const existing = new Set(existingFiles);
  if (existing.has(token)) return true;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), token));
  if (existing.has(relative)) return true;
  const suffix = `/${token}`;
  return existingFiles.some((p) => p.endsWith(suffix));
}

// --- comment extraction --------------------------------------------------

function scriptKindFor(filePath) {
  if (/\.tsx$/.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(filePath)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(filePath)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Every comment in a TS-family file, as {line, endLine, lines, text}, with
 * the comment markers stripped and each line trimmed (`lines[i]` is source
 * line `line + i`; `text` joins them). Found by asking the AST
 * for the trivia around every node (leading, trailing, and the trivia
 * before a container's closing token, which is where a comment in an empty
 * block or a `{/* ... *\/}` JSX expression lives).
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{ line: number, endLine: number, lines: string[], text: string }[]}
 */
export function extractComments(content, filePath) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const seen = new Set();
  const comments = [];

  function record(range) {
    if (range === undefined || seen.has(range.pos)) return;
    seen.add(range.pos);
    const raw = content.slice(range.pos, range.end);
    const isLineComment = range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
    const rawLines = raw.split("\n");
    // `lines[i]` is source line `line + i` with its comment markers removed,
    // so a finding can be reported at the sentence's own line rather than
    // the block's first line. `text` is the same content for display.
    const lines = rawLines.map((l, i) => {
      let s = l;
      if (i === 0) s = isLineComment ? s.replace(/^\/\/+/, "") : s.replace(/^\/\*+/, "");
      if (!isLineComment && i === rawLines.length - 1) s = s.replace(/\*+\/\s*$/, "");
      if (!isLineComment && i > 0) s = s.replace(/^\s*\*+\s?/, "");
      return s.trim();
    });
    comments.push({
      line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(range.end).line + 1,
      lines,
      text: lines.join("\n").trim(),
    });
  }

  function probe(pos) {
    for (const range of ts.getLeadingCommentRanges(content, pos) ?? []) record(range);
    for (const range of ts.getTrailingCommentRanges(content, pos) ?? []) record(range);
  }

  function visit(node) {
    probe(node.getFullStart());
    let lastChildEnd = null;
    let sawChild = false;
    ts.forEachChild(node, (child) => {
      visit(child);
      lastChildEnd = child.end;
      sawChild = true;
    });
    // Trivia before this node's closing token: the comment in `{ /* x */ }`
    // or in a JSX `{/* x */}`, which no child node's leading trivia covers.
    const closingProbe = sawChild ? lastChildEnd : node.getStart(sourceFile) + 1;
    if (closingProbe < node.end) probe(closingProbe);
    probe(node.end);
  }

  visit(sourceFile);
  comments.sort((a, b) => a.line - b.line);
  return comments;
}

/**
 * Prose lines of a non-TS file: every line of a Markdown file; lines
 * beginning with `#` (shell, YAML, env) or `//` (Prisma) elsewhere.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{ line: number, endLine: number, text: string }[]}
 */
export function extractProseLines(content, filePath) {
  const lines = content.split("\n");
  const isMarkdown = MARKDOWN_RE.test(filePath);
  const marker = SLASH_COMMENT_RE.test(filePath) ? /^\s*\/\/\s?/ : /^\s*#\s?/;
  const out = [];
  lines.forEach((raw, i) => {
    if (isMarkdown) {
      const text = raw.trim();
      if (text !== "") out.push({ line: i + 1, endLine: i + 1, text });
    } else if (marker.test(raw)) {
      out.push({ line: i + 1, endLine: i + 1, text: raw.replace(marker, "").trim() });
    }
  });
  return out;
}

// --- the audit -----------------------------------------------------------

/**
 * @typedef {{ file: string, line: number, categories: string[], text: string,
 *            missingReferences: string[] }} ClaimCandidate
 */

/**
 * Audit one file's comments. A comment is in scope when any of its lines is
 * in `changedLines` (or always, when `changedLines` is null -- `--all-lines`).
 * A comment line is reported when it triggers a category or names a path
 * that does not exist; a comment with neither is silent.
 *
 * @param {string} content
 * @param {string} filePath
 * @param {Set<number> | null} changedLines
 * @param {{ existingFiles: string[] }} options tracked and untracked paths, combined
 * @returns {ClaimCandidate[]}
 */
export function auditContent(content, filePath, changedLines, { existingFiles }) {
  const blocks = TS_FAMILY_RE.test(filePath)
    ? extractComments(content, filePath)
    : MARKDOWN_RE.test(filePath) || HASH_COMMENT_RE.test(filePath) || SLASH_COMMENT_RE.test(filePath)
      ? extractProseLines(content, filePath)
      : [];

  const candidates = [];
  for (const block of blocks) {
    if (changedLines !== null) {
      let touched = false;
      for (let l = block.line; l <= block.endLine; l++) {
        if (changedLines.has(l)) {
          touched = true;
          break;
        }
      }
      if (!touched) continue;
    }
    const lines = block.lines ?? block.text.split("\n");
    lines.forEach((text, offset) => {
      if (text.trim() === "") return;
      const categories = classifyClaimLine(text);
      const missingReferences = findPathReferences(text)
        .filter((ref) => !referenceExists(ref.token, filePath, existingFiles))
        .map((ref) => ref.token);
      if (categories.length === 0 && missingReferences.length === 0) return;
      candidates.push({ file: filePath, line: block.line + offset, categories, text: text.trim(), missingReferences });
    });
  }
  return candidates;
}

const KNOWN_FLAGS_HELP = "recognized: --base <ref>, --base=<ref>, --all-lines";

/**
 * Parses argv into `{ base, allLines }`, or a single named `error` instead
 * of any silent fallback. Replaces the narrower parseBaseArg (ugcportal-np1i
 * round 1 findings L1/L2):
 *
 * - `--base <ref>` and `--base=<ref>` both set `base`, the same (K2).
 * - `--base` followed by nothing, by an empty `=value`, or by a token that
 *   itself looks like a flag (`--base --all-lines` -- the shape an unset
 *   shell variable in a wrapper script produces) is a named "requires a
 *   value" error (L1), not a silent swallow of the next flag as the ref.
 * - Any other `--`-prefixed token that isn't `--all-lines` -- a genuine typo
 *   like `--bas=foo`, not just a broken `--base` -- is a named "unknown
 *   flag" error (L2), not a silent fallback to the default base.
 * - A bare positional argument (no leading `--`) is also a named error:
 *   this script takes no positional arguments, so one is almost always a
 *   mistyped flag.
 *
 * @param {string[]} args
 * @returns {{ base?: string, allLines: boolean, error?: string }}
 */
export function parseArgs(args) {
  let base;
  let allLines = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { allLines, error: "--base requires a value, e.g. --base origin/main or --base=origin/main" };
      }
      base = value;
      i++;
      continue;
    }
    if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (value === "") {
        return { allLines, error: "--base= requires a value after the =, e.g. --base=origin/main" };
      }
      base = value;
      continue;
    }
    if (arg === "--all-lines") {
      allLines = true;
      continue;
    }
    if (arg.startsWith("--")) {
      return { allLines, error: `unknown flag: ${arg} (${KNOWN_FLAGS_HELP})` };
    }
    return { allLines, error: `unexpected argument: ${arg} (${KNOWN_FLAGS_HELP})` };
  }
  return { base, allLines };
}

function allLineNumbers(content) {
  const lineCount = content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
  const lines = new Set();
  for (let i = 1; i <= lineCount; i++) lines.add(i);
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const { base: explicitBase, allLines, error: argError } = parseArgs(args);
  if (argError) {
    console.error(`claims-audit: ${argError}`);
    process.exit(1);
  }
  const base = explicitBase ?? resolveDefaultBase();
  const baseWasExplicit = explicitBase !== undefined;

  // The merge base of `base` and HEAD is diffed directly against the
  // CURRENT WORKING TREE below -- one coordinate system, not `base...HEAD`
  // unioned with a separate HEAD-vs-worktree diff (ugcportal-np1i M2).
  let mergeBase = null;
  try {
    mergeBase = resolveMergeBase(base);
  } catch (err) {
    console.error(`claims-audit: could not resolve ${base} against HEAD: ${err.message}`);
    if (baseWasExplicit) {
      // An explicitly-given --base that doesn't resolve is the M1 case:
      // refuse by name rather than silently falling through to a count that
      // only reflects the working tree, not the diff the caller asked for.
      console.error(
        `claims-audit: --base ${base} does not resolve against HEAD -- refusing to report a candidate count computed without it.`,
      );
      process.exit(1);
    }
    // No explicit --base, and the computed default (e.g. HEAD~1 before a
    // second commit exists) doesn't resolve either: there is no committed
    // baseline yet, but the working tree may still have something to
    // report, diffed against HEAD alone below -- this is the original
    // "before the first commit" case, not a failure to refuse over.
  }
  const diffRef = mergeBase ?? "HEAD";
  // The banner printed below reports diffRef, not base, whenever they
  // differ (the degrade above): base itself (e.g. HEAD~1) was never
  // actually diffed against anything once that happens, and printing it
  // anyway would be a stale claim the next reader has no way to check
  // against what the script actually did (ugcportal-np1i round 2 L1).
  const reportedBase = mergeBase === null ? diffRef : base;

  let untrackedFiles = [];
  let workingTreeReadFailed = false;
  try {
    untrackedFiles = listUntrackedFiles();
  } catch (err) {
    workingTreeReadFailed = true;
    console.error(`claims-audit: git ls-files --others failed: ${err.message}`);
  }

  // One diff covers both the file list and the line numbers (ugcportal-np1i
  // round 2 L3 -- a separate `git diff --name-only` call used to recompute
  // the same diff a second time just for the file list). Run unconditionally,
  // even under --all-lines: the file list is still needed there, only the
  // per-file line numbers go unused (auditContent gets changedLines=null
  // instead, below). A failure here sets workingTreeReadFailed exactly like
  // the untracked-file read's failure above does, so the guardrail below
  // covers every required read (ugcportal-np1i M3).
  let changedLinesByFile = new Map();
  try {
    changedLinesByFile = getChangedLineNumbersSince(diffRef);
  } catch (err) {
    workingTreeReadFailed = true;
    console.error(`claims-audit: could not diff ${diffRef} against the working tree: ${err.message}`);
  }

  const untrackedSet = new Set(untrackedFiles);
  const changedFiles = [...new Set([...changedLinesByFile.keys(), ...untrackedFiles])];

  let trackedFiles = [];
  try {
    trackedFiles = listTrackedFiles();
  } catch (err) {
    console.error(`claims-audit: git ls-files failed, reference checks disabled: ${err.message}`);
  }
  // A reference check needs both lists: untracked files are a first-class
  // scanned input since this bead's own K1 fix, so a comment pointing at one
  // is a real, existing file, not a stale pointer (ugcportal-np1i round 3 L1).
  const existingFiles = [...trackedFiles, ...untrackedFiles];

  const candidates = [];
  for (const filePath of changedFiles) {
    let content;
    try {
      // Every changed file -- committed-only, uncommitted-only, or both --
      // is read straight off the working tree, because that is what a push
      // would actually carry, and because changedLinesByFile's line numbers
      // (from a single diff of diffRef against the working tree) are
      // already in that same coordinate system either way.
      content = readFileFromWorkingTree(filePath);
    } catch {
      continue; // deleted in the working tree
    }
    // An untracked file has no `diffRef` side to diff against at all, so it
    // never appears in changedLinesByFile -- every line in it counts as new.
    const changedLines = allLines ? null : untrackedSet.has(filePath) ? allLineNumbers(content) : (changedLinesByFile.get(filePath) ?? new Set());
    candidates.push(...auditContent(content, filePath, changedLines, { existingFiles }));
  }

  // K3 guardrail: never report the false all-clean this bug used to produce.
  // Refuses on ANY required-read failure, unconditionally -- not gated on
  // whether the working tree happens to be dirty. Dirtiness ("is there
  // uncommitted work") and "did the read succeed" are different questions:
  // a fully-committed, clean branch -- the normal /pre-review case -- can
  // still have a real committed-since-base diff to report, and a failed
  // read there is just as untrustworthy as one on a dirty tree (ugcportal-
  // np1i round 2 H1 -- the previous isWorkingTreeDirty() gate answered the
  // wrong question and so missed exactly that clean-tree case).
  if (workingTreeReadFailed) {
    console.error(
      "claims-audit: a required git read failed (see the error above) -- refusing to report a possibly-false candidate count. Fix the git error and re-run.",
    );
    process.exit(1);
  }

  const counts = { ABSOLUTE: 0, MEASUREMENT: 0, TEMPORAL: 0, HISTORY: 0, "REFERENCE not found": 0 };
  console.log(`--- claims-audit: comment and prose claims on ${allLines ? "every" : "added"} lines (base ${reportedBase}) ---`);
  console.log(`candidates found: ${candidates.length}`);
  for (const c of candidates) {
    for (const cat of c.categories) counts[cat]++;
    if (c.missingReferences.length > 0) counts["REFERENCE not found"]++;
    const tags = [...c.categories, ...c.missingReferences.map((t) => `REFERENCE not found: ${t}`)].join(", ");
    console.log(`  ${c.file}:${c.line} [${tags}] ${c.text}`);
  }
  console.log(
    `by category: ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  console.log(
    "(advisory only -- does not affect exit status; for each line, put the evidence beside the claim or weaken it, and paste the counts into the PR body's pre-review checklist)",
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
