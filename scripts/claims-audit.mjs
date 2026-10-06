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
 * PR BODY MODE (`--pr <n>` / `--body`, ugcportal-bn94): the five categories
 * above plus one more, over the PR's DESCRIPTION rather than its diff. The
 * bead's own evidence is why this exists: on PR #125 five of six round 1-3
 * findings were Family 1 claims sitting in the body, not a comment; #107's
 * round-3 low and #117's F3 were body-only; #112 round 4's stale figures
 * were in the body's own pre-review checklist. A PR body is prose a reviewer
 * reads before the diff, so a false "N corrected" or "copied verbatim"
 * costs exactly the review round a stale comment does, and this script
 * could not see it at all before this mode existed -- it only ever read
 * files the diff touched.
 *
 *   DONE   a line matching deleted/removed/fixed/corrected (`both X
 *          corrected`/`all N corrected` need no separate pattern -- the
 *          aggregate count sits next to the same verb). Checked against the
 *          diff (`gh pr diff <n>`, or the local working tree's diff for
 *          `--body`): any quoted or code-span token (`"24 characters"`,
 *          `` `[ -n "$me" ]` ``) in that line that STILL appears on an added
 *          or unchanged line is reported as "DONE contradicted" -- the diff
 *          itself, not a human's second-guessing, shows the claim is false
 *          (observed 2026-10-06: PR #147's body said a stale "24 characters"
 *          comment was gone, and the diff still had it on an added line).
 *          When no diff is available, or a line names nothing quotable, the
 *          line is still flagged DONE for a human to check by hand.
 *
 * Body-mode output is a SEPARATE block with its own "body candidates found"
 * count, never summed into file-mode's "candidates found" (K2): the two
 * modes are mutually exclusive per invocation (parseArgs refuses `--pr`/
 * `--body` combined with each other or with `--all-lines`), so there is no
 * shared total to compute even by accident. `--pr <n>` fetches both the
 * body (`gh pr view <n> --json body -q .body`) and the diff (`gh pr diff
 * <n>`) over the network; `--body` reads the body from stdin instead (the
 * shape the pre-review skill uses on a draft body before `gh pr create` has
 * even run) and diffs the local working tree against `--base` (or its
 * default), the same ref resolution file mode uses. Out of scope, per the
 * bead: auditing review comments, and changing the five original
 * categories' vocabulary -- DONE is additive, not a rewrite of ABSOLUTE.
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
 *   node scripts/claims-audit.mjs --pr <n>
 *     PR BODY MODE (ugcportal-bn94, see above): fetches PR <n>'s body and
 *       diff with `gh` and audits the body text. `--pr=<n>` works the same.
 *   node scripts/claims-audit.mjs --body < /tmp/pr-body-draft.md
 *     PR BODY MODE from stdin: audits a not-yet-posted body (what the
 *       pre-review skill runs) against the LOCAL working tree's diff,
 *       using `--base` the same way file mode does.
 *     Neither form combines with `--all-lines` (a body has no added-lines
 *       concept) or with each other; `--pr` does not take `--base` (its
 *       diff is the PR's own, from `gh`, not a local ref).
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  getChangedLineNumbersSince,
  getUnifiedDiffSince,
  listTrackedFiles,
  listUntrackedFiles,
  readFileFromWorkingTree,
  resolveDefaultBase,
  resolveMergeBase,
} from "./lib/git-diff.mjs";
import { isMainModule } from "./lib/is-main.mjs";

// A PR diff (or body) can be large; same ceiling as scripts/lib/git-diff.mjs's
// LARGE_MAX_BUFFER, kept local here since this constant is about `gh`
// subprocess output, not a `git` plumbing concern that file owns.
const GH_MAX_BUFFER = 64 * 1024 * 1024;

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

// ugcportal-bn94: a PR-body "done" claim -- the body says a thing was
// deleted, removed, fixed or corrected, which (unlike ABSOLUTE/MEASUREMENT/
// TEMPORAL/HISTORY, all judged from the sentence alone) is mechanically
// checkable whenever the sentence also names what, in a quoted span: if
// that literal text is still sitting in an added or unchanged line of the
// diff, the "done" claim is contradicted by the diff itself, not merely
// worth a human's judgement. "both X corrected" / "all N corrected" need no
// separate pattern -- the aggregate count is just the quantifier next to the
// same verb this regex already matches ("...both guards restored" still
// contains "restored"? no -- but "...both corrected"/"all three fixed" do
// contain "corrected"/"fixed", which this regex does match).
const DONE_RE = /\b(deleted|removed|fixed|corrected)\b/i;
// A quoted or code-span token: "24 characters", `[ -n "$me" ]`. Double quotes
// and backticks only -- a single-quote pair is not reliable prose punctuation
// to pair on, since an ordinary contraction's apostrophe ("isn't ... won't")
// would otherwise pair across two unrelated words as if it were one quoted
// span. Requires at least 2 characters so a lone punctuation mark inside
// quotes does not become a token every line of the universe would trivially
// contain.
const QUOTED_SPAN_RE = /"([^"\n]{2,200})"|`([^`\n]{2,200})`/g;

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

/**
 * Quoted or code-span tokens in a line, as plain strings with the quote
 * marks stripped, deduplicated and order-preserved. These are the only
 * "referenced text" a done-claim check (below) trusts enough to search the
 * diff for literally -- a bare word or number in free prose is too likely to
 * recur by coincidence, but a quoted phrase or a code span is, by the
 * writer's own formatting, the specific thing the sentence is about.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findQuotedSpans(text) {
  const spans = [];
  const seen = new Set();
  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    const span = match[1] ?? match[2];
    if (!seen.has(span)) {
      seen.add(span);
      spans.push(span);
    }
  }
  return spans;
}

/**
 * True when `token` (a literal substring, not a pattern) appears on an ADDED
 * line or an unchanged CONTEXT line of `diffText` -- a standard unified diff
 * with git's normal context (not `-U0`: a done claim's referenced text can
 * sit on a line the diff never touched at all, and `-U0`'s zero-context
 * output would not include that line to search). File-header lines (`+++
 * b/path`, `--- a/path`) are excluded so a token that happens to equal part
 * of a file's own path is not mistaken for code content. A line that was
 * only REMOVED (`-`, and not `---`) does not count: that is exactly what a
 * true "deleted" or "removed" claim predicts, not a contradiction of it.
 *
 * @param {string} token
 * @param {string} diffText
 * @returns {boolean}
 */
export function tokenStillInDiff(token, diffText) {
  if (!token) return false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      if (line.slice(1).includes(token)) return true;
    }
  }
  return false;
}

// --- PR body audit (ugcportal-bn94) ---------------------------------------
//
// claims-audit's original mode (below, in main()) only ever read files the
// diff touched -- a PR's own DESCRIPTION, where most late-round Family 1
// findings now land (the bead's own evidence: PR #125 round 3, #107 round 3,
// #112 round 4), was invisible to it. This section runs the SAME claim
// vocabulary (ABSOLUTE/MEASUREMENT/TEMPORAL/HISTORY/REFERENCE -- none of it
// changed, per the bead's explicit "out of scope") over the PR body's own
// text, plus one new category that only makes sense for a body: a "done"
// claim (DONE_RE above) that the diff itself can contradict.
//
// Deliberately a SEPARATE code path from the file-mode audit above/below,
// with its own candidate list and its own printed counts -- never unioned
// into the file-mode count (K2): a clean diff must never hide a dirty body,
// and a dirty diff must never bury a clean body's count inside a larger
// combined number a reader would misread as "the diff's problem", when it
// was the prose that was wrong. The two modes are also mutually exclusive
// per run (see parseArgs/main below): there is structurally no shared
// "total" to accidentally compute in the first place.

/**
 * Every non-blank line of a PR body, as `{ line, text }` -- the same
 * granularity extractProseLines uses for a Markdown file (every line is
 * prose; a PR body has no comment markers to strip), since a PR body IS
 * Markdown.
 *
 * @param {string} bodyText
 * @returns {{ line: number, text: string }[]}
 */
export function extractBodyLines(bodyText) {
  const out = [];
  bodyText.split("\n").forEach((raw, i) => {
    const text = raw.trim();
    if (text !== "") out.push({ line: i + 1, text });
  });
  return out;
}

/**
 * @typedef {{ line: number, text: string, categories: string[],
 *            missingReferences: string[], doneClaimStillPresent: string[] }} BodyClaimCandidate
 */

/**
 * Audits a PR body's text with the same categories auditContent uses for a
 * comment (ABSOLUTE/MEASUREMENT/TEMPORAL/HISTORY via classifyClaimLine,
 * REFERENCE via findPathReferences/referenceExists), plus DONE: a line
 * matching DONE_RE is reported with category "DONE", and any of its quoted
 * spans found still present in `diffText` (via tokenStillInDiff) is reported
 * in `doneClaimStillPresent` -- a "this thing was deleted/removed/fixed/
 * corrected" claim the diff itself shows is not true. `diffText` is optional
 * (null when no diff could be fetched): a DONE line is still flagged for a
 * human either way, only the mechanical contradiction check is skipped, per
 * the bead's "where that is mechanically checkable".
 *
 * @param {string} bodyText
 * @param {{ diffText?: string | null, existingFiles?: string[] }} options
 * @returns {BodyClaimCandidate[]}
 */
export function auditBodyText(bodyText, { diffText = null, existingFiles = [] } = {}) {
  const candidates = [];
  for (const { line, text } of extractBodyLines(bodyText)) {
    const categories = classifyClaimLine(text);
    const missingReferences = findPathReferences(text)
      .filter((ref) => !referenceExists(ref.token, "", existingFiles))
      .map((ref) => ref.token);
    const isDoneClaim = DONE_RE.test(text);
    const doneClaimStillPresent = isDoneClaim && diffText ? findQuotedSpans(text).filter((span) => tokenStillInDiff(span, diffText)) : [];
    if (isDoneClaim) categories.push("DONE");
    if (categories.length === 0 && missingReferences.length === 0) continue;
    candidates.push({ line, text, categories, missingReferences, doneClaimStillPresent });
  }
  return candidates;
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

const KNOWN_FLAGS_HELP = "recognized: --base <ref>, --base=<ref>, --all-lines, --pr <n>, --pr=<n>, --body";

/**
 * Parses argv into `{ base, allLines, prNumber, bodyFromStdin }`, or a
 * single named `error` instead of any silent fallback. Replaces the
 * narrower parseBaseArg (ugcportal-np1i round 1 findings L1/L2):
 *
 * - `--base <ref>` and `--base=<ref>` both set `base`, the same (K2).
 * - `--base` followed by nothing, by an empty `=value`, or by a token that
 *   itself looks like a flag (`--base --all-lines` -- the shape an unset
 *   shell variable in a wrapper script produces) is a named "requires a
 *   value" error (L1), not a silent swallow of the next flag as the ref.
 * - `--pr <n>` and `--pr=<n>` (ugcportal-bn94) switch to PR-body mode: `n`
 *   must be a bare positive integer, the same "requires a value" shape as
 *   `--base` above for anything else (missing, flag-shaped, non-numeric).
 * - `--body` (ugcportal-bn94) also switches to PR-body mode, reading the
 *   body text from stdin instead of fetching it with `gh pr view`.
 * - `--pr` and `--body` are mutually exclusive (two body sources), and
 *   neither combines with `--all-lines` (a PR body has no "added lines"
 *   concept -- the whole body is always audited) or `--base` on `--pr`
 *   specifically (its diff comes from `gh pr diff <n>`, not a local ref;
 *   `--base` DOES combine with `--body`, which diffs the local working tree).
 * - Any other `--`-prefixed token that isn't one of the above -- a genuine
 *   typo like `--bas=foo`, not just a broken `--base` -- is a named "unknown
 *   flag" error (L2), not a silent fallback to the default base.
 * - A bare positional argument (no leading `--`) is also a named error:
 *   this script takes no positional arguments, so one is almost always a
 *   mistyped flag.
 *
 * @param {string[]} args
 * @returns {{ base?: string, allLines: boolean, prNumber?: number, bodyFromStdin?: boolean, error?: string }}
 */
export function parseArgs(args) {
  let base;
  let allLines = false;
  let prNumber;
  let bodyFromStdin = false;
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
    if (arg === "--pr") {
      const value = args[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        return { allLines, error: "--pr requires a PR number, e.g. --pr 147 or --pr=147" };
      }
      prNumber = Number(value);
      i++;
      continue;
    }
    if (arg.startsWith("--pr=")) {
      const value = arg.slice("--pr=".length);
      if (!/^\d+$/.test(value)) {
        return { allLines, error: "--pr= requires a PR number after the =, e.g. --pr=147" };
      }
      prNumber = Number(value);
      continue;
    }
    if (arg === "--body") {
      bodyFromStdin = true;
      continue;
    }
    if (arg.startsWith("--")) {
      return { allLines, error: `unknown flag: ${arg} (${KNOWN_FLAGS_HELP})` };
    }
    return { allLines, error: `unexpected argument: ${arg} (${KNOWN_FLAGS_HELP})` };
  }
  if (prNumber !== undefined && bodyFromStdin) {
    return { allLines, error: "--pr and --body are mutually exclusive -- pick one PR-body source" };
  }
  if (allLines && (prNumber !== undefined || bodyFromStdin)) {
    return { allLines, error: "--all-lines does not apply to PR-body mode (--pr / --body) -- the whole body is always audited" };
  }
  if (base !== undefined && prNumber !== undefined) {
    return { allLines, error: "--base does not apply to --pr <n> -- its diff comes from `gh pr diff <n>`, not a local ref" };
  }
  return { base, allLines, prNumber, bodyFromStdin: bodyFromStdin || undefined };
}

function allLineNumbers(content) {
  const lineCount = content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
  const lines = new Set();
  for (let i = 1; i <= lineCount; i++) lines.add(i);
  return lines;
}

/**
 * The impure half of PR-body mode: fetches the body text and (best-effort)
 * a diff to check "done" claims against, then prints auditBodyText's result
 * in a block that never shares a "candidates found" line, a counts line, or
 * any other printed total with file-mode's (K2). Exits non-zero only when
 * the body itself could not be obtained at all (an empty or unreadable PR
 * body makes every other step meaningless) -- same refusal posture as
 * file-mode's workingTreeReadFailed guard below, but body-mode's own
 * failure, never combined with it. A diff that cannot be fetched degrades
 * to flagging DONE claims without the mechanical contradiction check,
 * rather than refusing the whole run, since the ABSOLUTE/MEASUREMENT/
 * TEMPORAL/HISTORY/REFERENCE categories do not need a diff at all.
 *
 * @param {{ prNumber?: number, base?: string }} parsed `bodyFromStdin` itself
 *   is not read here -- the caller already established that exactly one of
 *   `prNumber`/`bodyFromStdin` is set (main()'s dispatch condition), so
 *   `prNumber === undefined` already means "read the body from stdin".
 */
function runBodyMode({ prNumber, base: explicitBase }) {
  const source = prNumber !== undefined ? `PR #${prNumber}` : "stdin";
  let bodyText;
  let diffText = null;

  if (prNumber !== undefined) {
    try {
      bodyText = execFileSync("gh", ["pr", "view", String(prNumber), "--json", "body", "-q", ".body"], {
        encoding: "utf8",
        maxBuffer: GH_MAX_BUFFER,
      });
    } catch (err) {
      console.error(`claims-audit: gh pr view ${prNumber} --json body failed: ${((err.stderr ?? err.message) + "").trim()}`);
      process.exit(1);
    }
    try {
      diffText = execFileSync("gh", ["pr", "diff", String(prNumber)], { encoding: "utf8", maxBuffer: GH_MAX_BUFFER });
    } catch (err) {
      console.error(
        `claims-audit: gh pr diff ${prNumber} failed (${((err.stderr ?? err.message) + "").trim()}) -- DONE claims will be flagged without the mechanical still-present check.`,
      );
    }
  } else {
    try {
      bodyText = fs.readFileSync(0, "utf8");
    } catch (err) {
      console.error(`claims-audit: could not read a PR body from stdin: ${err.message}`);
      process.exit(1);
    }
    const base = explicitBase ?? resolveDefaultBase();
    let mergeBase = null;
    try {
      mergeBase = resolveMergeBase(base);
    } catch (err) {
      if (explicitBase !== undefined) {
        // An explicitly-given --base that doesn't resolve is refused, same
        // as file-mode's M1 (ugcportal-np1i): a silent fall-through here
        // would report DONE claims checked against a diff the caller never
        // asked for.
        console.error(`claims-audit: --base ${base} does not resolve against HEAD: ${err.message}`);
        process.exit(1);
      }
      // No explicit --base, and the computed default (e.g. HEAD~1 before a
      // second commit exists) doesn't resolve either: there is no earlier
      // commit to diff against, but the working tree may still be worth
      // reporting against HEAD alone, below.
    }
    const diffRef = mergeBase ?? "HEAD";
    try {
      diffText = getUnifiedDiffSince(diffRef);
    } catch (err) {
      console.error(
        `claims-audit: could not diff ${diffRef} against the working tree (${err.message}) -- DONE claims will be flagged without the mechanical still-present check.`,
      );
    }
  }

  if (bodyText.trim() === "") {
    console.error(`claims-audit: the PR body (source: ${source}) is empty -- nothing to audit.`);
    process.exit(1);
  }

  let existingFiles = [];
  try {
    existingFiles = [...listTrackedFiles(), ...listUntrackedFiles()];
  } catch (err) {
    console.error(`claims-audit: git ls-files failed, REFERENCE checks disabled: ${err.message}`);
  }

  const candidates = auditBodyText(bodyText, { diffText, existingFiles });

  const counts = { ABSOLUTE: 0, MEASUREMENT: 0, TEMPORAL: 0, HISTORY: 0, DONE: 0, "REFERENCE not found": 0, "DONE contradicted": 0 };
  console.log(`--- claims-audit: PR BODY claims (source: ${source}${diffText === null ? ", no diff available" : ""}) ---`);
  console.log(`body candidates found: ${candidates.length}`);
  for (const c of candidates) {
    for (const cat of c.categories) counts[cat]++;
    if (c.missingReferences.length > 0) counts["REFERENCE not found"]++;
    if (c.doneClaimStillPresent.length > 0) counts["DONE contradicted"]++;
    const tags = [
      ...c.categories,
      ...c.missingReferences.map((t) => `REFERENCE not found: ${t}`),
      ...c.doneClaimStillPresent.map((t) => `DONE contradicted, still in diff: ${JSON.stringify(t)}`),
    ].join(", ");
    console.log(`  body:${c.line} [${tags}] ${c.text}`);
  }
  console.log(
    `by category: ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  console.log(
    "(advisory only -- does not affect exit status; printed and counted separately from file-mode's candidates, never merged into that count (K2); a DONE contradicted by the diff is strong evidence the claim is false, not merely worth asking about)",
  );
}

function main() {
  const args = process.argv.slice(2);
  const { base: explicitBase, allLines, prNumber, bodyFromStdin, error: argError } = parseArgs(args);
  if (argError) {
    console.error(`claims-audit: ${argError}`);
    process.exit(1);
  }
  if (prNumber !== undefined || bodyFromStdin) {
    runBodyMode({ prNumber, bodyFromStdin, base: explicitBase });
    return;
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
