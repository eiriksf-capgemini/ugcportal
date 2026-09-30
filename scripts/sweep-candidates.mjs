#!/usr/bin/env node
/**
 * Enumerates review-sweep candidates from a diff (ugcportal-plp6).
 *
 * Purely advisory: lists candidates for a human (implementer or reviewer) to
 * judge against review-standards/SKILL.md section 2's three-family sweep.
 * Never judges correctness itself, and never fails a build or blocks a push
 * (K4) -- this is not a substitute for that semantic sweep or for the
 * severity-gated round rule (ugcportal-2yj), both of which stay exactly as
 * they are.
 *
 * Two checks:
 *
 *   1. Every `.toContain(` / `.not.toContain(` call in a changed test file,
 *      listed by file:line with its literal needle -- the exact Family-3
 *      shape named in review-standards/SKILL.md ("what weaker
 *      implementation would still pass this, and could the needle ever
 *      actually be absent?").
 *
 *   2. Sibling object/type literals in the SAME file that share 3+ field
 *      names, where this diff changed one sibling's copy of a shared field
 *      but left the textually identical field in the other sibling(s)
 *      untouched. This is a narrower, honestly-scoped stand-in for "a fix
 *      applied to one of several parallel structures but not the other" --
 *      it flags an ASYMMETRIC EDIT WITHIN THE LITERALS THEMSELVES. It does
 *      NOT trace whether code elsewhere that *reads* a sibling's field was
 *      also fixed; that would need real type/data-flow analysis, which
 *      ugcportal-plp6 explicitly scopes out ("if (b) turns out to need a
 *      real type checker to avoid false negatives, that's a scope decision
 *      for whoever builds this, not assumed here").
 *
 * Usage:
 *   node scripts/sweep-candidates.mjs [--base <git-ref>]
 *     --base defaults to `origin/main`, falling back to `HEAD~1` if that
 *     ref can't be resolved (e.g. no network, or a shallow/fresh clone).
 *
 * Self-test: npm test -- runs scripts/sweep-candidates.test.mjs (vitest).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;

const CONTROL_FLOW_KEYWORDS = new Set(["if", "for", "while", "function", "else", "try", "switch", "catch", "do", "finally"]);

// --- Check 1: toContain / not.toContain enumeration ---------------------

/**
 * @param {string} content
 * @param {string} filePath
 * @returns {{file: string, line: number, negated: boolean, needle: string}[]}
 */
export function findToContainCandidates(content, filePath) {
  const candidates = [];
  const lines = content.split("\n");
  const re = /(\.not)?\.toContain\(\s*([\s\S]*?)\s*\)/g;
  lines.forEach((lineText, idx) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lineText)) !== null) {
      candidates.push({
        file: filePath,
        line: idx + 1,
        negated: Boolean(m[1]),
        needle: m[2],
      });
    }
  });
  return candidates;
}

// --- Check 2: sibling object/type-literal guard omissions ---------------

/**
 * Finds brace-delimited blocks that look like an object/type literal
 * (preceded by `=`, `:`, `(`, `,`, `return`, or nothing -- not a control-flow
 * keyword), tracking string/template literal state so braces inside strings
 * don't confuse the depth counter.
 *
 * @param {string} content
 * @returns {{startLine: number, endLine: number, fieldLines: Map<string, number>}[]}
 */
export function findObjectLikeBlocks(content) {
  const blocks = [];
  const stack = [];
  let line = 1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  // `{` preceded (after whitespace) by `)` is virtually always a code block
  // -- an if/for/while/catch condition or a function's parameter list --
  // never an object literal, so it's treated as control-flow without
  // needing to identify which keyword introduced it. `=> {` (an arrow
  // function body) is the same case with no parens. Anything else falls
  // through to reading the single word immediately before `{`.
  const isControlFlowBrace = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(content[j])) j--;
    if (j < 0) return false;
    if (content[j] === ")") return true;
    if (content[j] === ">" && content[j - 1] === "=") return true;
    let end = j + 1;
    while (j >= 0 && /[\w$]/.test(content[j])) j--;
    const w = content.slice(j + 1, end);
    return CONTROL_FLOW_KEYWORDS.has(w);
  };

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const prev = content[i - 1];

    if (c === "\n") line++;

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === "*" && c === "/") inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (c === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === "`" && prev !== "\\") inTemplate = false;
      continue;
    }
    if (c === "/" && content[i + 1] === "/") {
      inLineComment = true;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      inBlockComment = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      inTemplate = true;
      continue;
    }

    if (c === "{") {
      stack.push({ startLine: line, startIndex: i, isControlFlow: isControlFlowBrace(i) });
    } else if (c === "}") {
      const open = stack.pop();
      if (open && !open.isControlFlow) {
        const text = content.slice(open.startIndex, i + 1);
        blocks.push({
          startLine: open.startLine,
          endLine: line,
          fieldLines: extractFieldLines(text, open.startLine),
        });
      }
    }
  }

  return blocks;
}

/**
 * @param {string} blockText
 * @param {number} blockStartLine
 * @returns {Map<string, number>} field name -> absolute line number of its
 *   first occurrence in the block
 */
function extractFieldLines(blockText, blockStartLine) {
  const fieldLines = new Map();
  const lines = blockText.split("\n");
  const fieldRe = /(^|[{,(])\s*([A-Za-z_$][\w$]*)\s*:/;
  lines.forEach((lineText, idx) => {
    const m = fieldRe.exec(lineText);
    if (m && !fieldLines.has(m[2])) {
      fieldLines.set(m[2], blockStartLine + idx);
    }
  });
  return fieldLines;
}

/**
 * @param {string} content
 * @param {Set<number>} changedLines absolute line numbers touched by the diff
 * @param {string} filePath
 * @returns {{file: string, field: string, touchedLine: number, siblingLine: number}[]}
 */
export function findSiblingGuardOmissions(content, changedLines, filePath) {
  const blocks = findObjectLikeBlocks(content);
  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < blocks.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue;
      const a = blocks[i];
      const b = blocks[j];
      const shared = [...a.fieldLines.keys()].filter((f) => b.fieldLines.has(f));
      if (shared.length < 3) continue;

      for (const field of shared) {
        const lineInA = a.fieldLines.get(field);
        const lineInB = b.fieldLines.get(field);
        if (lineInA === lineInB) continue; // same literal block matched itself via overlap; skip
        const aChanged = changedLines.has(lineInA);
        const bChanged = changedLines.has(lineInB);
        if (aChanged && !bChanged) {
          const key = `${filePath}:${field}:${lineInA}:${lineInB}`;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push({ file: filePath, field, touchedLine: lineInA, siblingLine: lineInB });
          }
        }
      }
    }
  }

  return candidates;
}

// --- git integration (not unit-tested directly; the two functions above
// are, against synthetic fixtures per ugcportal-plp6 K1/K2) ---------------

function resolveDefaultBase() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: ["ignore", "ignore", "ignore"] });
    return "origin/main";
  } catch {
    return "HEAD~1";
  }
}

function getChangedFiles(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** @returns {Set<number>} */
function getChangedLineNumbers(base, filePath) {
  const out = execFileSync("git", ["diff", "-U0", `${base}...HEAD`, "--", filePath], { encoding: "utf8" });
  const changed = new Set();
  let newLine = null;
  for (const line of out.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.add(newLine);
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return changed;
}

function readFile(filePath) {
  return execFileSync("git", ["show", `HEAD:${filePath}`], { encoding: "utf8" });
}

function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : resolveDefaultBase();

  let changedFiles;
  try {
    changedFiles = getChangedFiles(base);
  } catch (err) {
    console.error(`sweep-candidates: could not diff against ${base}: ${err.message}`);
    process.exit(0); // advisory tool -- never block on its own failure
  }

  const toContainCandidates = [];
  const siblingCandidates = [];

  for (const filePath of changedFiles) {
    if (TEST_FILE_RE.test(filePath)) {
      let content;
      try {
        content = readFile(filePath);
      } catch {
        continue; // deleted file
      }
      toContainCandidates.push(...findToContainCandidates(content, filePath));
    }

    if (SOURCE_FILE_RE.test(filePath)) {
      let content;
      try {
        content = readFile(filePath);
      } catch {
        continue;
      }
      let changedLines;
      try {
        changedLines = getChangedLineNumbers(base, filePath);
      } catch {
        continue;
      }
      siblingCandidates.push(...findSiblingGuardOmissions(content, changedLines, filePath));
    }
  }

  console.log("--- sweep-candidates: Family 3 (toContain needles) ---");
  console.log(`candidates found: ${toContainCandidates.length}`);
  for (const c of toContainCandidates) {
    console.log(`  ${c.file}:${c.line} ${c.negated ? ".not.toContain(" : ".toContain("}${c.needle})`);
  }

  console.log("--- sweep-candidates: sibling literal guard omissions ---");
  console.log(`candidates found: ${siblingCandidates.length}`);
  for (const c of siblingCandidates) {
    console.log(
      `  ${c.file}:${c.touchedLine} changed field '${c.field}' -- sibling literal at ${c.file}:${c.siblingLine} untouched by this diff`,
    );
  }

  console.log("(advisory only -- does not affect exit status; paste relevant lines into the PR's sweep report)");
}

if (import.meta.url === `file://${path.resolve(process.argv[1] ?? "")}`) {
  main();
}
