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
 * sentences for a human to judge; it never decides a claim is false and it
 * never fails a build or blocks a push. The one thing it does check
 * mechanically is whether a file a comment points at still exists in the
 * tree, because that is the family-1 shape that is pure fact (PR #98 round
 * 3: "sign-in-policy.ts:125 cites configured-users.ts, which no longer
 * exists"; PR #97 round 1: a comment citing a contrast entry that does not
 * exist; PR #96 pre-push: a test header pointing at the wrong e2e path).
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
 *   node scripts/claims-audit.mjs [--base <git-ref>] [--all-lines]
 *     --base defaults to `origin/main`, falling back to `HEAD~1`.
 *     --all-lines audits every comment in every changed file, not only the
 *       added lines -- the sweep for stale SIBLINGS of a sentence a fix
 *       just changed (the Family 4 case: PR #102 found the same corrected
 *       model stated five places, over four rounds).
 *
 * Self-test: npm test -- runs scripts/claims-audit.test.mjs (vitest).
 *
 * KNOWN LIMITATION (ugcportal-lykb): compares checked-out HEAD, not
 * necessarily what is being pushed -- see scripts/lib/git-diff.mjs.
 */

import path from "node:path";

import ts from "typescript";

import {
  getChangedFiles,
  getChangedLineNumbersByFile,
  listTrackedFiles,
  readFileAtHead,
  resolveDefaultBase,
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
 * True when `token` names a tracked file: an exact repo-relative path, a
 * path relative to the commenting file's directory, or a bare filename (or
 * path suffix) that at least one tracked path ends with.
 *
 * @param {string} token
 * @param {string} fromFile repo-relative path of the file holding the comment
 * @param {string[]} trackedFiles
 * @returns {boolean}
 */
export function referenceExists(token, fromFile, trackedFiles) {
  const tracked = new Set(trackedFiles);
  if (tracked.has(token)) return true;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), token));
  if (tracked.has(relative)) return true;
  const suffix = `/${token}`;
  return trackedFiles.some((p) => p.endsWith(suffix));
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
 * @param {{ trackedFiles: string[] }} options
 * @returns {ClaimCandidate[]}
 */
export function auditContent(content, filePath, changedLines, { trackedFiles }) {
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
        .filter((ref) => !referenceExists(ref.token, filePath, trackedFiles))
        .map((ref) => ref.token);
      if (categories.length === 0 && missingReferences.length === 0) return;
      candidates.push({ file: filePath, line: block.line + offset, categories, text: text.trim(), missingReferences });
    });
  }
  return candidates;
}

function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : resolveDefaultBase();
  const allLines = args.includes("--all-lines");

  let changedFiles;
  try {
    changedFiles = getChangedFiles(base);
  } catch (err) {
    console.error(`claims-audit: could not diff against ${base}: ${err.message}`);
    process.exit(0); // advisory tool -- never block on its own failure
  }

  let changedLinesByFile = new Map();
  if (!allLines) {
    try {
      changedLinesByFile = getChangedLineNumbersByFile(base);
    } catch (err) {
      console.error(`claims-audit: could not diff line ranges against ${base}: ${err.message}`);
    }
  }

  let trackedFiles = [];
  try {
    trackedFiles = listTrackedFiles();
  } catch (err) {
    console.error(`claims-audit: git ls-files failed, reference checks disabled: ${err.message}`);
  }

  const candidates = [];
  for (const filePath of changedFiles) {
    let content;
    try {
      content = readFileAtHead(filePath);
    } catch {
      continue; // deleted file
    }
    const changedLines = allLines ? null : (changedLinesByFile.get(filePath) ?? new Set());
    candidates.push(...auditContent(content, filePath, changedLines, { trackedFiles }));
  }

  const counts = { ABSOLUTE: 0, MEASUREMENT: 0, TEMPORAL: 0, HISTORY: 0, "REFERENCE not found": 0 };
  console.log(`--- claims-audit: comment and prose claims on ${allLines ? "every" : "added"} lines (base ${base}) ---`);
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
