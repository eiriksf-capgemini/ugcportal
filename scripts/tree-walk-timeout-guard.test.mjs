/**
 * Guards against ugcportal-9faa recurring: a test suite that walks the
 * whole tree (via src/lib/design/scan-source.ts's shared `walkSourceFiles`
 * walker), spawns a real `git` subprocess, or does real libvips/sharp image
 * processing (an `import sharp` or an import of `@/lib/watermark`), with no
 * explicit timeout and no cached-helper mitigation, silently inherits
 * vitest's 5s default -- exactly the shape that made the pre-push hook
 * refuse three correct pushes in a row at load average 190
 * (scripts/claims-audit.test.mjs,
 * src/components/consent/analytics-host.grep.test.ts and
 * src/lib/throttled-log.no-sibling-copy.test.ts all did this; see that
 * bead for the measurements). This does not
 * know whether any SPECIFIC call site is actually slow -- it is a coarse,
 * file-level tripwire: any test file that calls the shared walker, spawns
 * `git`, or imports sharp/watermark must ALSO, somewhere in the same file,
 * either declare an explicit timeout (a `{ timeout: N }` describe/it/test/
 * beforeAll/beforeEach/afterAll/afterEach option, or the bare
 * `it(name, fn, N)` numeric form already used elsewhere in this repo) or
 * assign a module-level `cache*`-named binding with `??=`. Neither check
 * understands whether the call in question is actually slow (a
 * `walkSourceFiles` call over a three-file mkdtemp fixture does not need
 * either), so this will sometimes ask a genuinely cheap new test file to
 * add a token mitigation it doesn't strictly need -- a one-line cost, far
 * cheaper than a silent flake rediscovered at load average 190.
 *
 * ugcportal-9faa PR #163 round 1, finding 1 (CONFIRMED medium): the
 * original version of this file matched `TIMEOUT_OPTION_PATTERN` and
 * `CACHED_HELPER_PATTERN` against the file's raw text, so a decoy COMMENT
 * -- `// pretend this has timeout: 20000` or `// cache this result please
 * ??=` -- in a file that genuinely spawns `git` with no real mitigation
 * read as mitigated, and the guard's own "flags none of them" assertion
 * could not fail against that input. Fixed by parsing the file with the
 * same TypeScript compiler API scan-source.ts already uses for this exact
 * problem (`scriptKindFor`), and requiring each mitigation to be a REAL
 * syntax shape -- a `timeout` property inside the options object literal
 * passed to an actual describe/it/test/hook CALL, or a `??=` assignment
 * whose left side is an identifier declared by a module-level
 * `let`/`var`/`const` statement whose name starts with `cache` (case-
 * insensitive) -- rather than a textual pattern a comment or string can
 * imitate. `treeWalkTimeoutViolation`'s fixtures below include both decoy
 * shapes from that finding, now failing the guard as they should.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { scriptKindFor, walkSourceFiles } from "../src/lib/design/scan-source";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const TEST_FILE_PATTERN = /\.test\.(mjs|ts|tsx)$/;

const GIT_SPAWN_CALLEES = new Set(["execFileSync", "spawnSync", "execSync", "spawn"]);
const TIMEOUT_CALLEES = new Set([
  "describe",
  "it",
  "test",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
]);
// A binding declared at module scope (a direct statement of the
// SourceFile, not inside any function/block) whose name starts with
// `cache`/`Cache` -- the `let cachedFiles; ... (cachedFiles ??=
// walkSourceFiles(...))` idiom already used by dual-meaning-usage.test.ts
// and no-raw-hex.test.ts, generalised to any such name.
const CACHE_NAME_RE = /^cach/i;

/** The base callee name of a call expression: `describe(...)` -> "describe", `describe.only(...)` / `it.skip(...)` -> "describe"/"it". */
function calleeBaseName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return null;
}

function isWalkSourceFilesCall(node) {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "walkSourceFiles"
  );
}

function isGitSpawnCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const base = calleeBaseName(node.expression);
  if (base === null || !GIT_SPAWN_CALLEES.has(base)) return false;
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) && first.text === "git";
}

/** `import sharp from "sharp"` (or any import FROM the "sharp" package), or any import from `@/lib/watermark` / a relative path ending in `/watermark`. */
function isSharpOrWatermarkImport(node) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return false;
  const spec = node.moduleSpecifier.text;
  return spec === "sharp" || spec === "watermark" || spec.endsWith("/watermark");
}

function objectLiteralHasNumericTimeout(node) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === "timeout") ||
          (ts.isStringLiteralLike(prop.name) && prop.name.text === "timeout")) &&
        ts.isNumericLiteral(prop.initializer),
    )
  );
}

/**
 * A real `describe`/`it`/`test`/hook call declaring a timeout: either a
 * `{ timeout: N }` options object in any argument position (covers
 * `describe(name, { timeout }, fn)` and `describe(name, fn, { timeout })`),
 * or the bare trailing-numeric-literal form already used in this repo
 * (`it(name, fn, 20000)`, a hook's own `(fn, timeout)`).
 */
function callHasExplicitTimeout(node) {
  if (!ts.isCallExpression(node)) return false;
  const base = calleeBaseName(node.expression);
  if (base === null || !TIMEOUT_CALLEES.has(base)) return false;
  const args = node.arguments;
  if (args.length === 0) return false;
  const last = args[args.length - 1];
  if (ts.isNumericLiteral(last)) return true;
  return args.some(objectLiteralHasNumericTimeout);
}

/** Every `cache*`-named identifier declared directly at module (SourceFile) scope. */
function moduleLevelCacheNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && CACHE_NAME_RE.test(declaration.name.text)) {
        names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function isModuleCacheAssignment(node, cacheNames) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
    ts.isIdentifier(node.left) &&
    cacheNames.has(node.left.text)
  );
}

/**
 * Parses `content` as `fileName`'s dialect (reusing scan-source.ts's own
 * `scriptKindFor`, so a `.tsx` generic-arrow or a `.mjs` file parses the
 * same way the rest of this repo's scanners already do) and walks the real
 * AST once for every shape this guard cares about -- never the raw text,
 * so nothing here can be satisfied by a comment or a string literal that
 * merely contains the right words (PR #163 round 1, finding 1).
 *
 * @param {string} content
 * @param {string} fileName only used to pick the parse dialect; need not
 *   exist on disk (a fixture's `treeWalkTimeoutViolation` default below).
 */
function classify(content, fileName) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, scriptKindFor(fileName));
  const cacheNames = moduleLevelCacheNames(sourceFile);

  let walksTree = false;
  let spawnsGit = false;
  let usesSharpOrWatermark = false;
  let hasTimeout = false;
  let hasCache = false;

  function visit(node) {
    if (isWalkSourceFilesCall(node)) walksTree = true;
    if (isGitSpawnCall(node)) spawnsGit = true;
    if (isSharpOrWatermarkImport(node)) usesSharpOrWatermark = true;
    if (callHasExplicitTimeout(node)) hasTimeout = true;
    if (isModuleCacheAssignment(node, cacheNames)) hasCache = true;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return { walksTree, spawnsGit, usesSharpOrWatermark, hasTimeout, hasCache };
}

/**
 * @param {string} content a test file's full source
 * @param {string} [fileName] real path (picks TS vs TSX vs JS dialect);
 *   defaults to a plain `.ts` fixture name for unit tests below.
 * @returns {string | null} a violation reason, or null when this file does
 *   none of the three tree-wide/subprocess/image-processing things, or
 *   already declares a real mitigation.
 */
export function treeWalkTimeoutViolation(content, fileName = "fixture.ts") {
  const { walksTree, spawnsGit, usesSharpOrWatermark, hasTimeout, hasCache } = classify(content, fileName);
  if (!walksTree && !spawnsGit && !usesSharpOrWatermark) return null;
  if (hasTimeout || hasCache) return null;

  const reasons = [];
  if (walksTree) reasons.push("calls the shared walkSourceFiles() walker");
  if (spawnsGit) reasons.push("spawns a real `git` subprocess");
  if (usesSharpOrWatermark) reasons.push("imports sharp or @/lib/watermark (real libvips image processing)");

  return (
    `${reasons.join(" and ")} with no declared timeout ` +
    "(`{ timeout: N }` or `it(name, fn, N)`) and no module-level `cache* ??=` memoization anywhere in the file"
  );
}

describe("treeWalkTimeoutViolation", () => {
  it("is silent for a file that does none of the three things", () => {
    expect(
      treeWalkTimeoutViolation("describe('x', () => { it('y', () => { expect(1).toBe(1); }); });"),
    ).toBeNull();
  });

  it("flags a file that walks the tree with no timeout and no cache", () => {
    const content = `
      import { walkSourceFiles } from "./scan-source";
      describe("x", () => {
        const files = walkSourceFiles(ROOT, () => false);
        it("y", () => { expect(files.length).toBeGreaterThan(0); });
      });
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/walkSourceFiles/);
  });

  it("MUTATION: the same file with a real describe-level { timeout } is not flagged", () => {
    const content = `
      describe("x", { timeout: 15_000 }, () => {
        const files = walkSourceFiles(ROOT, () => false);
      });
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("MUTATION: the same file using a real module-level cache ??= assignment is not flagged", () => {
    const content = `
      let cachedFiles;
      function scannedFiles() { return (cachedFiles ??= walkSourceFiles(ROOT, isExcluded)); }
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("flags a file that spawns git with no timeout and no cache", () => {
    const content = 'function fixtureGit(cwd, args) { return execFileSync("git", args, { cwd }); }';
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("MUTATION: the same file with the repo's existing bare it(..., N) timeout form is not flagged", () => {
    const content = `
      it("slow", () => {
        execFileSync("git", ["status"]);
      }, 20000);
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("MUTATION CHECK: an unrelated numeric literal does not count as a timeout", () => {
    // Guards the guard itself: a bare 5-digit constant that is NOT a
    // trailing it(...)/hook timeout argument must not be read as one, or
    // this check would pass on every file with any large number in it.
    const content = `
      const SOME_UNRELATED_CONSTANT = 20000;
      execFileSync("git", ["status"]);
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("does not match `which`/`gh`/other non-git spawns", () => {
    const content = 'execFileSync("which", ["git"]); execFileSync("gh", ["pr", "list"]);';
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("flags a file importing sharp with no timeout and no cache", () => {
    const content = 'import sharp from "sharp";\nconst img = sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } });';
    expect(treeWalkTimeoutViolation(content)).toMatch(/sharp/);
  });

  it("MUTATION: the same sharp import with a real timeout is not flagged", () => {
    const content = `
      import sharp from "sharp";
      describe("x", { timeout: 15_000 }, () => {});
    `;
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  it("flags a file importing from @/lib/watermark with no timeout and no cache", () => {
    const content = 'import { resolveWatermarkConcurrencySettings } from "@/lib/watermark";';
    expect(treeWalkTimeoutViolation(content)).toMatch(/watermark/);
  });

  it("does not flag an unrelated import merely containing the substring 'watermark' in its own name, not path", () => {
    // `spec.endsWith("/watermark")` deliberately does not match
    // "@/lib/watermark-utils" or "@/lib/watermarked-thing" -- only the
    // module actually named `watermark`.
    const content = 'import { x } from "@/lib/watermark-utils";';
    expect(treeWalkTimeoutViolation(content)).toBeNull();
  });

  // ugcportal-9faa PR #163 round 1, finding 1 (CONFIRMED medium): the two
  // decoy shapes the reviewer used to defeat the previous, text-regex
  // version of this guard. Both must now be flagged.
  it("PR #163 round 1 finding 1, decoy 1: a `// cache this result please ??=` COMMENT does not count as a real cache assignment", () => {
    const content = `
      // cache this result please ??=
      function fixtureGit(cwd, args) { return execFileSync("git", args, { cwd }); }
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("PR #163 round 1 finding 1, decoy 2: a `// pretend this has timeout: 20000` COMMENT does not count as a real timeout option", () => {
    const content = `
      // pretend this has timeout: 20000
      function fixtureGit(cwd, args) { return execFileSync("git", args, { cwd }); }
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("does not accept a cache ??= assignment to a binding that is not declared at module scope", () => {
    // The declaration lives INSIDE a function, not as a direct statement of
    // the SourceFile -- moduleLevelCacheNames must not pick it up, or a
    // decoy could declare a throwaway local named `cache` purely to satisfy
    // this check without memoizing anything real.
    const content = `
      function fixtureGit(cwd, args) {
        function run() {
          let cacheLocal;
          return (cacheLocal ??= execFileSync("git", args, { cwd }));
        }
        return run();
      }
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });

  it("does not accept a timeout-shaped property on an unrelated object passed to an unrelated call", () => {
    // `{ timeout: N }` only counts when it is actually an argument to
    // describe/it/test/a hook -- not any object literal anywhere in the
    // file that happens to have a `timeout` key (e.g. a fetch options bag).
    const content = `
      function fixtureGit(cwd, args) {
        fetch("https://example.invalid", { timeout: 20000 });
        return execFileSync("git", args, { cwd });
      }
    `;
    expect(treeWalkTimeoutViolation(content)).toMatch(/git/);
  });
});

// ugcportal-9faa: a single real-tree walk, listing test files only (no
// per-file TypeScript parse at THIS step -- the parse happens once per
// scanned file inside the real-tree assertion below) -- cheap relative to
// the suites this guards, but still a repo-wide walk, so it gets the same
// explicit-timeout treatment as everything else in this bead rather than
// an exception.
describe("every test file that walks the tree, spawns git, or does real image processing declares a timeout or a cache", { timeout: 15_000 }, () => {
  // Excludes only this file itself: its own fixtures above deliberately
  // contain the literal patterns being matched (as strings, not real
  // calls), and its own real walkSourceFiles call below is given its own
  // timeout rather than being asked to also satisfy its own rule.
  const files = walkSourceFiles(
    REPO_ROOT,
    (file) => path.resolve(file) === path.resolve(THIS_FILE),
    TEST_FILE_PATTERN,
  );

  it("finds test files to check (sanity check on the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("flags none of them", () => {
    const violations = files
      .map((file) => {
        const reason = treeWalkTimeoutViolation(readFileSync(file, "utf8"), file);
        return reason === null ? null : `${path.relative(REPO_ROOT, file)}: ${reason}`;
      })
      .filter((v) => v !== null);

    expect(
      violations,
      "a test file walks the whole tree, spawns a real git subprocess, or does " +
        "real libvips/sharp image processing, with no declared timeout and no " +
        "cached-helper mitigation (ugcportal-9faa). Either add an explicit " +
        "{ timeout: N } (or it(name, fn, N)) with a one-line comment naming why " +
        "the cost is inherent, or share one cached result instead of " +
        "recomputing it per test (see analytics-host.grep.test.ts or " +
        `dual-meaning-usage.test.ts). Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
