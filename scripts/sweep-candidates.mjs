#!/usr/bin/env node
/**
 * Enumerates review-sweep candidates from a diff (ugcportal-plp6).
 *
 * Purely advisory: lists candidates for a human (implementer or reviewer) to
 * judge against review-standards/SKILL.md section 2's four-family sweep.
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
 *   2. Sibling object/type literals in the SAME non-test file that share 3+
 *      field names, where this diff changed one sibling's copy of a shared
 *      field but left the textually identical field in the other
 *      sibling(s) untouched. This is a narrower, honestly-scoped stand-in
 *      for "a fix applied to one of several parallel structures but not the
 *      other" -- it flags an ASYMMETRIC EDIT WITHIN THE LITERALS
 *      THEMSELVES. It does NOT trace whether code elsewhere that *reads* a
 *      sibling's field was also fixed; that would need real type/data-flow
 *      analysis, which ugcportal-plp6 explicitly scopes out ("if (b) turns
 *      out to need a real type checker to avoid false negatives, that's a
 *      scope decision for whoever builds this, not assumed here"). Test
 *      files are deliberately excluded from this check (round 4 finding):
 *      table-driven tests routinely repeat a same-shaped fixture object
 *      across many cases, which is indistinguishable from the real defect
 *      shape by field-name matching alone and drowns it in noise.
 *
 * Usage:
 *   node scripts/sweep-candidates.mjs [--base <git-ref>]
 *     --base defaults to `origin/main`, falling back to `HEAD~1` if that
 *     ref can't be resolved (e.g. no network, or a shallow/fresh clone).
 *
 * Self-test: npm test -- runs scripts/sweep-candidates.test.mjs (vitest).
 *
 * KNOWN LIMITATION (ugcportal-lykb): the "HEAD" half of every comparison
 * this script makes -- getChangedFiles/getChangedLineNumbersByFile/readFile
 * below -- is the currently CHECKED-OUT HEAD, not necessarily the content
 * of whatever is actually being pushed. When invoked from
 * .beads/hooks/pre-push (see that file's own KNOWN LIMITATION note), an
 * unusual push -- a different local branch than the one checked out, an
 * explicit SHA, `git push origin X:main` -- means this script silently
 * sweeps HEAD's diff instead of the pushed ref's. This is a deliberate
 * scope decision, not an oversight: this tool is advisory-only (see K4
 * above), has no CI equivalent (nothing under .github/workflows/ invokes
 * it -- it only ever runs locally, manually or from this repo's pre-push
 * hook), and never blocks a push or a merge on its own -- so the blast
 * radius of inspecting the wrong ref here is a missed local hint, not a
 * bypassed gate.
 *
 * Both checks below parse with the TypeScript compiler API (`typescript`,
 * already a project dependency for `tsc --noEmit`) rather than hand-rolled
 * string/regex scanning. An earlier version hand-rolled a
 * string/template/regex/comment-aware character scanner for both checks;
 * three rounds of review on ugcportal-5dr6/plp6 found a new edge case in it
 * almost every round (an escaped backslash before a closing quote, a regex
 * character class containing a paren, nested template interpolation, a
 * bare block statement, `return`/`typeof` as valid regex-literal
 * precedents...), because hand-written JS/TS tokenizing is an open-ended
 * bug surface, not a finite one. A real parser closes the whole class by
 * construction instead of requiring each new syntax shape to be
 * hand-patched in as it's discovered.
 */

import { execFileSync } from "node:child_process";

import ts from "typescript";

import { isMainModule } from "./lib/is-main.mjs";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;

function scriptKindFor(filePath) {
  if (/\.tsx$/.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.ts$/.test(filePath)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(filePath)) return ts.ScriptKind.JS;
  // Lenient default: TSX parses plain JS/JSX fine too, for a filePath the
  // caller didn't give a recognizable extension for (e.g. a test fixture).
  return ts.ScriptKind.TSX;
}

function parse(content, filePath) {
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(filePath));
}

function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

// --- Check 1: toContain / not.toContain enumeration ---------------------

/**
 * @param {string} content
 * @param {string} filePath
 * @returns {{file: string, line: number, negated: boolean, needle: string}[]}
 */
export function findToContainCandidates(content, filePath) {
  const candidates = [];
  const sourceFile = parse(content, filePath);

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toContain") {
      const callee = node.expression.expression;
      const negated = ts.isPropertyAccessExpression(callee) && callee.name.text === "not";
      const [arg] = node.arguments;
      if (arg) {
        candidates.push({
          file: filePath,
          line: lineOf(sourceFile, node.expression.name.getStart(sourceFile)),
          negated,
          needle: arg.getText(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return candidates;
}

// --- Check 2: sibling object/type-literal guard omissions ---------------

/**
 * @param {ts.ObjectLiteralExpression | ts.TypeLiteralNode} member's container
 * @returns {string | null}
 */
function propertyName(member) {
  if (
    ts.isPropertyAssignment(member) ||
    ts.isPropertySignature(member) ||
    ts.isShorthandPropertyAssignment(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isMethodSignature(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    const { name } = member;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
  }
  return null;
}

/**
 * Finds object literals (`{ a: 1, b: 2 }`) and type literals (`type X = { a:
 * string }`) -- but deliberately NOT interface or class bodies. An earlier
 * version included interfaces too and round 1 of review found that two
 * unrelated interfaces sharing common prop names (id/name/role, extremely
 * common in a React codebase) produced constant false-positive "siblings"
 * unrelated to any real defect; excluding them is a deliberate precision
 * trade-off, not an oversight. Each object literal's fieldLines contains
 * only its OWN direct properties -- a nested object literal used as a
 * field's value is a separate node, visited (and reported) separately, so
 * its fields are never misattributed to the parent.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{startLine: number, endLine: number, fieldLines: Map<string, number>}[]}
 */
export function findObjectLikeBlocks(content, filePath = "input.tsx") {
  const sourceFile = parse(content, filePath);
  const blocks = [];

  function visit(node) {
    if (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node)) {
      const fieldLines = new Map();
      for (const member of node.members ?? node.properties) {
        const name = propertyName(member);
        // A later duplicate key is the one that actually takes effect in a
        // JS/TS object literal, so it -- not the first occurrence -- is
        // what a diff touching it should be compared against.
        if (name !== null) {
          fieldLines.set(name, lineOf(sourceFile, member.getStart(sourceFile)));
        }
      }
      if (fieldLines.size > 0) {
        blocks.push({
          startLine: lineOf(sourceFile, node.getStart(sourceFile)),
          endLine: lineOf(sourceFile, node.getEnd()),
          fieldLines,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return blocks;
}

/**
 * @param {string} content
 * @param {Set<number>} changedLines absolute line numbers touched by the diff
 * @param {string} filePath
 * @returns {{file: string, field: string, touchedLine: number, siblingLine: number}[]}
 */
export function findSiblingGuardOmissions(content, changedLines, filePath) {
  const blocks = findObjectLikeBlocks(content, filePath);
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

// NOTE (ugcportal-lykb): `...HEAD` is checked-out HEAD, not necessarily
// what's actually being pushed -- see the KNOWN LIMITATION note in this
// file's header docstring.
function getChangedFiles(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/**
 * One `git diff` call for the whole PR, not one per file (an earlier
 * version spawned a `git diff -U0 base...HEAD -- <file>` per changed file,
 * which review found could mean ~100 subprocess spawns on a 50-file PR for
 * data a single whole-diff parse already has).
 *
 * NOTE (ugcportal-lykb): `...HEAD` is checked-out HEAD, not necessarily
 * what's actually being pushed -- see the KNOWN LIMITATION note in this
 * file's header docstring.
 *
 * @returns {Map<string, Set<number>>} filePath -> changed absolute line numbers
 */
function getChangedLineNumbersByFile(base) {
  const out = execFileSync("git", ["diff", "-U0", `${base}...HEAD`], { encoding: "utf8" });
  const result = new Map();
  let currentFile = null;
  let newLine = null;
  for (const line of out.split("\n")) {
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileHeader) {
      currentFile = fileHeader[1];
      if (!result.has(currentFile)) result.set(currentFile, new Set());
      newLine = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (currentFile === null || newLine === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.get(currentFile).add(newLine);
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return result;
}

// NOTE (ugcportal-lykb): reads the file's content at checked-out HEAD, not
// necessarily what's actually being pushed -- see the KNOWN LIMITATION
// note in this file's header docstring.
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

  let changedLinesByFile;
  try {
    changedLinesByFile = getChangedLineNumbersByFile(base);
  } catch (err) {
    console.error(`sweep-candidates: could not diff line ranges against ${base}: ${err.message}`);
    changedLinesByFile = new Map();
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

    // Deliberately excludes test files: a table-driven test's fixtures
    // routinely repeat a `{field, field, field}`-shaped object across many
    // `it()` blocks (this very file's own test suite does), which is
    // structurally identical to the parallel-structure defect this check
    // looks for but isn't one. Reproduced: scanning this PR's own test file
    // reported dozens of candidates, all fixture repetition -- noisy enough
    // that a human is likely to start ignoring the block's output
    // wholesale, including the rare push where it flags a real defect.
    if (SOURCE_FILE_RE.test(filePath) && !TEST_FILE_RE.test(filePath)) {
      let content;
      try {
        content = readFile(filePath);
      } catch {
        continue;
      }
      const changedLines = changedLinesByFile.get(filePath) ?? new Set();
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

if (isMainModule(import.meta.url)) {
  main();
}
