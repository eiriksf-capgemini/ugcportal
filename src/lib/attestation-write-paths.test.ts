import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  isTestFile,
  sourceFileOf,
  walkSourceFiles,
} from "@/lib/design/scan-source";
import {
  type PrismaModelWrite,
  bindingsNamed,
  parameterCallSites,
  prismaModelWritesIn,
} from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-15r K3, as a claim about the WHOLE TREE: an attestation row is
 * written only in the files named below (one at first; the late-attestation
 * route since ugcportal-gkax; and a test-support fixture), and always with
 * `session.user.id`.
 *
 * WHY A TREE-WIDE SCAN AND NOT JUST THE ROUTE'S OWN TESTS. The route tests
 * next door prove the one write path there is names the session's user. They
 * cannot prove it is the only path — and the way this stops holding is not
 * that somebody deletes it, it is that somebody adds a SECOND writer (an
 * importer, an admin screen, a bulk re-attest tool, a server action) whose
 * review has no reason to think about §3.1. This repo's recurring defect
 * family 4: a rule enforced at one of N call sites. A second writer fails
 * this file by existing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT PARSES RATHER THAN GREPS, which is the whole design of this file
 * ---------------------------------------------------------------------------
 *
 * A scan built on `source.includes("prisma.mediaAttestation.create")` passes
 * on a file that merely MENTIONS the string — in a comment, in a log message,
 * in a test name, in a docstring like the one you are reading. This repo has
 * already shipped that exact defect once: a navigation guard matched a bare
 * path constant anywhere in a file, and passed on a page that imported the
 * constant and rendered no link. Stripping comments (which
 * `src/lib/design/scan-source.ts` does, and which the benefit-source scanner
 * next door relies on) fixes half of it and leaves the string-literal half
 * open.
 *
 * So this walks TypeScript's own AST and matches a CALL EXPRESSION whose
 * callee is a property access ending in a write method on a
 * `.mediaAttestation` member. A comment is not a node. A string literal is
 * not a call. The needle cannot be smuggled past this by writing it
 * somewhere that merely looks like code, and the test at the bottom of this
 * file proves exactly that against a temp-directory fixture rather than
 * asserting it in prose.
 *
 * The nested-write form is covered too — Prisma's
 * `data: { attestation: { create: … } }` writes the same row without ever
 * naming the model, and is the shape a second author is most likely to reach
 * for. It is a different kind of node, so it gets its own matcher.
 *
 * TEST FILES ARE EXCLUDED, with the same reasoning
 * alcohol-commerce.write-paths.test.ts gives: seeding an attestation is the
 * ordinary vocabulary of a fixture, this file's own temp fixtures do it, and
 * a rule requiring every such test to go through the route would be a rule
 * about tests rather than about write paths. What that exclusion costs is
 * paid for below, where the scanner is exercised against a real temp
 * directory instead of being trusted to be right about the one tree it
 * ordinarily sees.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The matcher itself lives in src/lib/test-support/prisma-write-scan.ts,
 * shared with ugcportal-qfy9's clearance scan next door. It used to be
 * inline here; a second table needing the identical AST walk is exactly
 * when a copy starts to drift, so the walk moved and this file kept the
 * part that is about attestations: which model, which relation, which file
 * is allowed to write it, and what the write has to say.
 *
 * `walkSourceFiles` is still called HERE rather than behind the helper, so
 * scripts/tree-walk-timeout-guard.test.mjs can still see that this file
 * walks the tree and hold it to the cached-helper mitigation below.
 */
export type AttestationWrite = PrismaModelWrite;

/** The relation field a nested write would go through. */
const RELATION_FIELD = "attestation";

export function attestationWritesIn(file: string): AttestationWrite[] {
  return prismaModelWritesIn(file, {
    model: "mediaAttestation",
    relationField: RELATION_FIELD,
  });
}

/** Files, relative to `root` with POSIX separators, that write an attestation. */
export function scanAttestationWritePaths(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => attestationWritesIn(file).length > 0)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

/**
 * Every binding of `userId` in a file, in the five shapes `bindingsNamed`
 * reads: a plain `const/let/var userId = …` as its initialiser's text, and a
 * destructured binding, a parameter, a function declaration or a declaration
 * with no initialiser as its kind and declaring text. Delegates to the shared scanner for the same reason the matcher above
 * does; the name is kept because it is what the cases below read.
 */
export function userIdBindingsIn(file: string): string[] {
  return bindingsNamed(file, "userId");
}

/**
 * ugcportal-gkax M1-r2: every DECLARATION of `name` in a file, in the four shapes
 * this visitor checks — variable declarations, destructured binding elements,
 * parameters, and function declarations: a plain `const/let/var name = …`, a destructured
 * `const { name } = …` or `const { other: name } = …`, a parameter, a
 * function. `bindingsNamed` (shared with POST /api/media's guard, and left
 * alone here) reads five shapes — the four above plus variable declarations
 * with no initialiser; see its docstring in src/lib/test-support/prisma-write-scan.ts.
 * A plain variable is reported as its initialiser's text, the way `bindingsNamed`
 * reports it; every other shape as its kind and the text of the node that declares it,
 * so it does not read as the one plain declaration a caller expects.
 */
export function declarationsNamed(file: string, name: string): string[] {
  const source = sourceFileOf(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(
        ts.isVariableDeclaration(node) && node.initializer
          ? node.initializer.getText(source)
          : `${ts.SyntaxKind[node.kind]}: ${node.parent.getText(source)}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The function the late-attestation route reads its parsed body through. */
export const ATTESTATION_BODY_READER = "attestationFromBody";

/** The `readJsonBody` result keys `POST` may read itself: the failure branch. */
const BODY_FAILURE_KEYS: ReadonlySet<string> = new Set(["ok", "status", "error"]);

/** An identifier used as a value, not a declared name or a property name. */
function referencesTo(root: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const isDeclaredName =
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionDeclaration(parent)) &&
        parent.name === node;
      const isPropertyName =
        ((ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isDeclaredName && !isPropertyName) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isCallTo(node: ts.Node | undefined, callee: string): node is ts.CallExpression {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === callee
  );
}

/** `await x`, `(x)`, `x as T` -> `x`. */
function unwrap(node: ts.Expression): ts.Expression {
  let at = node;
  while (
    ts.isAwaitExpression(at) ||
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at)
  ) {
    at = at.expression;
  }
  return at;
}

/** `return null;`, bare or as the only statement of a block. */
function returnsNull(statement: ts.Statement): boolean {
  const only =
    ts.isBlock(statement) && statement.statements.length === 1
      ? statement.statements[0]
      : statement;
  return (
    ts.isReturnStatement(only) &&
    only.expression !== undefined &&
    only.expression.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * ugcportal-gkax M1-r2: every place the late-attestation route's file reads
 * the request body other than through `parseAttestation`, as `line N: why:
 * text`. Empty means the body is read only through its object-shape check
 * and the parser's reader. It catches the natural shapes: a destructured
 * read, a parameter, an alias, a second alias, a module-level helper. It
 * does NOT cover deliberately obfuscated reads: a side effect hidden in the
 * shape-check condition (an assignment storing the raw body in module-level
 * state), or reassignment of the reader arrow's `name` parameter before
 * `alias[name]`. Both pass this rule today; closing them is not attempted
 * here. The
 * rule, all of it checked over the AST of that one file:
 *
 *  A. `POST` reads its `request` parameter only as the first argument of a
 *     `readJsonBody(…)` call (or of `isSameOriginRequest(…)`, which reads
 *     headers only; ugcportal-qf9v), calls `readJsonBody` exactly once, and never
 *     names `arguments`.
 *  B. The name bound from that call is read only as `.ok`, `.status` or
 *     `.error`, or as `.value` passed as the sole argument of
 *     `attestationFromBody(…)`, which happens exactly once. Nothing else: not
 *     a bare reference, not another property.
 *  C. In `attestationFromBody`, the parameter is read only in the condition
 *     of an `if` whose branch is `return null`, or as the whole initialiser
 *     of a declaration, through parentheses or `as` at most (an alias such
 *     as `fields`). Each alias is read only inside the reader arrow passed
 *     to a returned `parseAttestation(…)` call, and there only as
 *     `Object.hasOwn(alias, name)` or `alias[name]`, where `name` is that
 *     arrow's one parameter.
 *
 * So `POST` reads nothing of the raw object but `readJsonBody`'s failure
 * fields, and inside the one function that holds it, the object is read
 * only through the shape check and the parser's reader (subject to the
 * limits above).
 */
export function rawBodyLeaksIn(file: string): string[] {
  const source = sourceFileOf(file);
  const leaks: string[] = [];
  const leak = (node: ts.Node, why: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    leaks.push(`line ${line + 1}: ${why}: ${node.parent.getText(source)}`);
  };
  const functionNamed = (name: string): ts.FunctionDeclaration | undefined =>
    source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );

  const post = functionNamed("POST");
  const reader = functionNamed(ATTESTATION_BODY_READER);
  if (!post?.body) return ["no `POST` function declaration"];
  if (!reader?.body) return [`no \`${ATTESTATION_BODY_READER}\` function declaration`];

  // A. The request.
  const requestParam = post.parameters[0]?.name;
  if (requestParam === undefined || !ts.isIdentifier(requestParam)) {
    return ["`POST`'s first parameter is not a plain identifier"];
  }
  for (const ref of referencesTo(post.body, requestParam.text)) {
    const call = ref.parent;
    // `isSameOriginRequest(request)` (ugcportal-qf9v) reads two headers and
    // never the body, so it is the one other permitted use of the request.
    const permitted =
      (isCallTo(call, "readJsonBody") || isCallTo(call, "isSameOriginRequest")) &&
      call.arguments[0] === ref;
    if (!permitted) {
      leak(ref, "request read other than by readJsonBody");
    }
  }
  for (const ref of referencesTo(post.body, "arguments")) {
    leak(ref, "`arguments` read in POST");
  }
  const bodyDeclarations: ts.VariableDeclaration[] = [];
  let readJsonBodyCalls = 0;
  const visitPost = (node: ts.Node): void => {
    if (isCallTo(node, "readJsonBody")) readJsonBodyCalls += 1;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isCallTo(unwrap(node.initializer), "readJsonBody")
    ) {
      bodyDeclarations.push(node);
    }
    ts.forEachChild(node, visitPost);
  };
  visitPost(post.body);
  if (readJsonBodyCalls !== 1) {
    leaks.push(`readJsonBody called ${readJsonBodyCalls} times in POST, not once`);
  }
  if (bodyDeclarations.length !== 1 || !ts.isIdentifier(bodyDeclarations[0].name)) {
    leaks.push(
      `${bodyDeclarations.length} plain declarations bound from readJsonBody in POST, not one`,
    );
    return leaks;
  }

  // B. The parsed body, in POST.
  let valueReads = 0;
  for (const ref of referencesTo(post.body, bodyDeclarations[0].name.text)) {
    const access = ref.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== ref) {
      leak(ref, "body referenced other than through a property");
      continue;
    }
    const key = access.name.text;
    if (BODY_FAILURE_KEYS.has(key)) continue;
    const call = access.parent;
    if (
      key === "value" &&
      isCallTo(call, ATTESTATION_BODY_READER) &&
      call.arguments.length === 1 &&
      call.arguments[0] === access
    ) {
      valueReads += 1;
      continue;
    }
    leak(ref, `body.${key} read outside ${ATTESTATION_BODY_READER}`);
  }
  if (valueReads !== 1) {
    leaks.push(
      `body.value passed to ${ATTESTATION_BODY_READER} ${valueReads} times in POST, not once`,
    );
  }

  // C. The raw object, inside the reader.
  const valueParam = reader.parameters[0]?.name;
  if (
    reader.parameters.length !== 1 ||
    valueParam === undefined ||
    !ts.isIdentifier(valueParam)
  ) {
    leaks.push(`${ATTESTATION_BODY_READER} does not take exactly one plain parameter`);
    return leaks;
  }
  const aliases: string[] = [];
  for (const ref of referencesTo(reader.body, valueParam.text)) {
    let at: ts.Node = ref;
    while (
      ts.isParenthesizedExpression(at.parent) ||
      (ts.isAsExpression(at.parent) && at.parent.expression === at)
    ) {
      at = at.parent;
    }
    const declaration = at.parent;
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === at &&
      ts.isIdentifier(declaration.name)
    ) {
      aliases.push(declaration.name.text);
      continue;
    }
    let guarded = false;
    for (let up: ts.Node = ref; up !== reader.body; up = up.parent) {
      if (
        ts.isIfStatement(up.parent) &&
        up.parent.expression === up &&
        returnsNull(up.parent.thenStatement) &&
        up.parent.elseStatement === undefined
      ) {
        guarded = true;
        break;
      }
    }
    if (!guarded) leak(ref, "raw body read outside the shape check");
  }
  for (const alias of aliases) {
    for (const ref of referencesTo(reader.body, alias)) {
      const arrow = (() => {
        for (let up: ts.Node = ref; up !== reader.body; up = up.parent) {
          if (
            ts.isArrowFunction(up) &&
            isCallTo(up.parent, "parseAttestation") &&
            (up.parent as ts.CallExpression).arguments[0] === up &&
            ts.isReturnStatement(up.parent.parent)
          ) {
            return up;
          }
        }
        return undefined;
      })();
      const keyParam = arrow?.parameters[0]?.name;
      if (
        arrow === undefined ||
        arrow.parameters.length !== 1 ||
        keyParam === undefined ||
        !ts.isIdentifier(keyParam)
      ) {
        leak(ref, `${alias} read outside the reader passed to parseAttestation`);
        continue;
      }
      const isKey = (node: ts.Node | undefined): boolean =>
        node !== undefined && ts.isIdentifier(node) && node.text === keyParam.text;
      const parent = ref.parent;
      const indexed =
        ts.isElementAccessExpression(parent) &&
        parent.expression === ref &&
        isKey(parent.argumentExpression);
      const hasOwn =
        ts.isCallExpression(parent) &&
        parent.expression.getText(source) === "Object.hasOwn" &&
        parent.arguments.length === 2 &&
        parent.arguments[0] === ref &&
        isKey(parent.arguments[1]);
      if (!indexed && !hasOwn) {
        leak(ref, `${alias} read other than at the key parseAttestation asks for`);
      }
    }
  }
  return leaks;
}

/**
 * Every module specifier a file imports, as written — `import`/`export …
 * from`, and the dynamic `import("…")` form that `await import()` in a test
 * or a lazy loader uses.
 *
 * From the AST rather than from the text, for the reason the whole file
 * gives: a string that merely LOOKS like a path (a log line, a docstring,
 * this very comment) is not an import, and a text scan cannot tell.
 *
 * Parsed with `sourceFileOf` from src/lib/design/scan-source.ts, which is
 * also what the shared Prisma write scanner this file imports uses — one
 * "read and parse a source file in the right dialect" primitive for the
 * whole repo, next to the `scriptKindFor` that picks that dialect.
 */
export function importSpecifiersIn(file: string): string[] {
  const source = sourceFileOf(file);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
}

/**
 * Non-test files outside `test-support/` that import something from it,
 * relative to `root` with POSIX separators.
 *
 * Exported so the fixture cases at the bottom drive it over a temp
 * directory — the scanner is tested, not merely used, the same rule
 * `scanAttestationWritePaths` follows.
 */
export function scanTestSupportImporters(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => !file.split(path.sep).includes("test-support"))
    .filter((file) =>
      importSpecifiersIn(file).some(
        (specifier) =>
          specifier.includes("/test-support/") ||
          specifier.endsWith("/test-support"),
      ),
    )
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

/** The one PRODUCT file allowed to write one, and why. */
const WRITE_PATH = "app/api/media/route.ts";

/**
 * The one TEST-SUPPORT file allowed to write one (ugcportal-3ae).
 *
 * Why an allowance exists at all. From ugcportal-3ae on, a Media row with no
 * attestation is on no anonymous surface — `PUBLIC_MEDIA_SCOPE` filters it
 * out — so seven test files that import `seedMedia` from this module need a
 * declaration alongside it (not nine — the count and the method for
 * re-deriving it, by `import`/`from` declaration rather than by grepping the
 * bare path, live in that module's own comment above the write, since a
 * number restated in two places is a number that can drift in one of them).
 * `src/lib/test-support/media-fixtures.ts` is the one copy of "what a
 * published row looks like" those files share; the alternative is seven
 * copies of eleven columns, which is the sibling-omission family this scan's
 * own header names.
 *
 * Why it is safe, and the two things that keep it so rather than this
 * paragraph. The directory is test-only by construction, and
 * "nothing in the application imports test-support" below asserts that
 * directly — so this write cannot become a second way a real upload acquires
 * a declaration its uploader never gave. And the file writes it as a plain
 * `client.mediaAttestation.create` statement, which matcher (1) sees, rather
 * than as a nested create behind a ternary, which it would not
 * (ugcportal-xqal) — the allowance is taken in the open.
 */
const TEST_SUPPORT_WRITE_PATH = "lib/test-support/media-fixtures.ts";

/**
 * The SECOND product file allowed to write one (ugcportal-gkax): the owner
 * answering the questions for a file they already uploaded without answering
 * them — a configured uploader's, since ugcportal-ho7j.
 *
 * Admitted by name, and held below to everything the upload route is held
 * to: one explicit `tx.mediaAttestation.create`, naming `userId`, and that
 * `userId` traced back to the session through the ownership gate rather
 * than taken on the route's word. §3.1's whole point is that the row names
 * the person who uploaded the file; a second writer is only acceptable if
 * it provably cannot name anybody else.
 */
const LATE_ATTESTATION_WRITE_PATH = "app/api/media/[id]/attestation/route.ts";

/** The ownership gate that route takes its actor from. */
const MEDIA_ACCESS_PATH = "lib/media-access.ts";

/** All three, sorted the way `scanAttestationWritePaths` returns them. */
const ALLOWED_WRITE_PATHS = [
  WRITE_PATH,
  LATE_ATTESTATION_WRITE_PATH,
  TEST_SUPPORT_WRITE_PATH,
].sort();

/**
 * ONE WALK OF `src/`, AND ONE PARSE OF THE WRITE PATH, shared by every case
 * below. Required by scripts/tree-walk-timeout-guard.test.mjs and for its
 * reason (ugcportal-9faa): a per-test whole-tree walk is what pushes a suite
 * past vitest's default per-test timeout under load, and the failure then
 * looks like a flake rather than like a cost somebody chose.
 */
let cachedWritePaths: string[] | undefined;
let cachedRouteWrites: AttestationWrite[] | undefined;
let cachedTestSupportImporters: string[] | undefined;

function writePaths(): string[] {
  return (cachedWritePaths ??= scanAttestationWritePaths(SRC_ROOT));
}

function routeWrites(): AttestationWrite[] {
  return (cachedRouteWrites ??= attestationWritesIn(
    path.join(SRC_ROOT, WRITE_PATH),
  ));
}

function testSupportImporters(): string[] {
  return (cachedTestSupportImporters ??= scanTestSupportImporters(SRC_ROOT));
}

describe("ugcportal-15r K3: only the named places write an attestation", () => {
  const found = writePaths();

  it("finds the write path at all", () => {
    // Guards every assertion below against passing because the walker or the
    // matcher broke and came back with nothing — which is how a scan like
    // this most often stops meaning anything.
    expect(found.length).toBeGreaterThan(0);
  });

  it("finds it in exactly three files: POST /api/media, POST /api/media/[id]/attestation, and the test-support fixture", () => {
    /*
     * Two, not one, since ugcportal-3ae, and three since ugcportal-gkax —
     * and each is pinned by name rather than by a pattern, so a FOURTH
     * writer fails here by existing
     * IN EVERY SHAPE THE SCANNER SEES: a `*.mediaAttestation.<write>(…)`
     * call, and a nested `attestation: { <write>: … }` whose value is an
     * object literal. That covers an importer, an admin screen or a bulk
     * re-attest tool written the ordinary way.
     *
     * IT DOES NOT COVER A NESTED WRITE BEHIND A CONDITIONAL, and this is
     * the sentence where that matters rather than somewhere it can be
     * skipped (ugcportal-3ae review round 1, finding 4). The nested matcher
     * requires `ts.isObjectLiteralExpression(node.initializer)`, so
     * `attestation: grant ? { create: {…} } : undefined` is not an object
     * literal and is not reported — verified by adding exactly that third
     * writer and watching this suite stay green. That gap is ugcportal-xqal.
     * Nothing in this branch relies on it: the one test-support write
     * allowed below is a plain `client.mediaAttestation.create` statement,
     * which matcher (1) sees.
     */
    expect(found).toEqual(ALLOWED_WRITE_PATHS);
  });

  it("nothing in the application imports test-support", () => {
    /*
     * The compensating control for the allowance above (ugcportal-3ae), and
     * the reason that allowance does not weaken K3. `media-fixtures.ts`
     * writes an attestation attributed to whoever the caller names — which
     * is exactly the admin-asserts-what-they-cannot-know shape §3.1
     * forbids — and the only thing making that harmless is that no shipped
     * code path can reach it.
     *
     * Asserted over import SPECIFIERS from the AST, not over file text: a
     * comment or a docstring naming the directory (this repo is full of
     * them, including the one you are reading) is not an import, and a text
     * scan would have to allowlist each one until it meant nothing. Proved
     * against a fixture tree at the bottom of this file, both directions.
     */
    expect(testSupportImporters()).toEqual([]);
  });

  it("writes exactly one attestation there, through an explicit create", () => {
    const writes = routeWrites();

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("create");
    expect(writes[0].nested).toBe(false);
    // Inside the transaction's client, not the module-level `prisma`: a
    // Media row committed without the declaration its uploader just gave is
    // an upload that stays unsellable until attested late. The route tests assert the
    // behaviour; this asserts the shape that produces it.
    expect(writes[0].callee).toBe("tx.mediaAttestation.create");
  });

  it("always names the authenticated uploader as the actor", () => {
    const [write] = routeWrites();

    // The argument text, not the whole file: a file that mentions
    // `attestedByUserId` somewhere else entirely would satisfy a file-level
    // check and write anything it liked here.
    expect(write.argument).toMatch(/attestedByUserId:\s*userId\b/);
  });

  it("binds that `userId` from the session, and from nothing else", () => {
    /*
     * The other half, and the half a call-site check cannot give: `userId`
     * is only worth asserting on if it is the session's. Every declaration
     * of that name in the file is checked, in the five shapes
     * `bindingsNamed`'s docstring lists (plain, destructured, parameter,
     * function, uninitialised; ugcportal-2k2q), so a second
     * `const userId = body.get("userId")` added later fails here even if
     * the write itself is untouched.
     *
     * ONE SHAPE IS FOLLOWED RATHER THAN READ: a parameter. The write sits in
     * `handleUpload`, whose `userId: string` parameter is a declaration
     * that cannot say where its value came from — its callers decide that.
     * So a parameter is accepted only through `parameterCallSites`
     * (ugcportal-y1tn, folded into ugcportal-2k2q): the function must have
     * at least one call, be called from nowhere this file cannot see, the
     * parameter must be neither a rest parameter nor carry a default
     * initialiser (which would supply the value whenever a call passes
     * `undefined`, ugcportal-pm4t), and every call must pass at that
     * position an identifier whose own `const` binding has an initialiser
     * matching `sessionUserId` below, an unanchored regex that also accepts
     * `session?.user?.id ?? something` (anchoring it is ugcportal-xxb7).
     * Each call is checked by name and line, so a call passing anything
     * else fails naming that line. A parameter this loop never got to the
     * end of is not in `linked`, and falls through to the strict check
     * below like every other shape.
     */
    const file = path.join(SRC_ROOT, WRITE_PATH);
    const sessionUserId = /session\??\.user\??\.id/;
    const bindings = userIdBindingsIn(file);

    const linked = new Set<string>();
    for (const link of parameterCallSites(file, "userId")) {
      expect(link.problems, link.parameter).toEqual([]);
      for (const call of link.calls) {
        expect(
          call.binding ?? `unresolved (${call.reason})`,
          `${link.function} call at line ${call.line} passes ${JSON.stringify(call.argument)} as ${link.parameter}`,
        ).toMatch(sessionUserId);
      }
      linked.add(link.parameter);
    }

    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      if (linked.has(binding)) continue; // every call site checked above
      expect(binding, binding).toMatch(sessionUserId);
    }
  });
});

/**
 * ugcportal-gkax: the second product writer, held to what the first is held
 * to — and, because it takes its actor from the shared ownership gate rather
 * than from its own `auth()` call, with the chain back to the session
 * checked link by link rather than taken on trust.
 */
describe("ugcportal-gkax: the late-attestation route names the session's user too", () => {
  const routeFile = path.join(SRC_ROOT, LATE_ATTESTATION_WRITE_PATH);
  const accessFile = path.join(SRC_ROOT, MEDIA_ACCESS_PATH);

  it("writes exactly one attestation, through an explicit transactional create", () => {
    const writes = attestationWritesIn(routeFile);

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("create");
    expect(writes[0].nested).toBe(false);
    expect(writes[0].callee).toBe("tx.mediaAttestation.create");
  });

  it("names `userId` as the actor", () => {
    const [write] = attestationWritesIn(routeFile);

    expect(write.argument).toMatch(/attestedByUserId:\s*userId\b/);
  });

  it("binds `userId` from the ownership gate's result, and `access` from the gate, and from nothing else", () => {
    const userIds = bindingsNamed(routeFile, "userId");
    expect(userIds.length).toBeGreaterThan(0);
    for (const binding of userIds) {
      expect(binding, binding).toBe("access.userId");
    }

    const accesses = bindingsNamed(routeFile, "access");
    expect(accesses.length).toBeGreaterThan(0);
    for (const binding of accesses) {
      expect(binding, binding).toMatch(/^await requireOwnedMedia\(/);
    }
  });

  it("declares `userId` and `access` exactly once each, across variable declaration, destructured binding, parameter, and function declaration", () => {
    /*
     * ugcportal-gkax M1-r2. The case above checks what each binding is
     * bound from: since ugcportal-2k2q, `bindingsNamed` also reports a
     * destructured binding or a parameter, tagged with its kind, so either
     * fails that case's `toBe`. It does not check how many bindings there
     * are, so a second plain `const userId = access.userId` passes it. This
     * pins the count across variable declaration, destructured binding, parameter,
     * and function declaration, so a second binding of either name fails here
     * whatever it is bound from.
     */
    expect(declarationsNamed(routeFile, "userId")).toEqual(["access.userId"]);
    expect(declarationsNamed(routeFile, "access")).toEqual([
      "await requireOwnedMedia(id)",
    ]);
  });

  it("reads the request body only through `parseAttestation`, so no natural read of the body can reach the write", () => {
    /*
     * ugcportal-gkax M1-r2, the class rather than one more key. The route
     * test's K2 case sends a list of actor keys and can only ever cover that
     * list; a binding that reads a key nobody listed passed both suites in
     * review. This holds the route's source to the rule `rawBodyLeaksIn`
     * states (the request read by `readJsonBody` for its body and by
     * `isSameOriginRequest` for two headers, Origin and Sec-Fetch-Site, and by
     * nothing else; the parsed body
     * handed whole to `attestationFromBody`; inside that, the object read
     * only through the shape check and the parser's reader), so a read of any
     * key into a natural binding shape (destructured, parameter, alias,
     * second alias, module-level helper) is a reported leak. Deliberately
     * obfuscated reads (see the docblock on `rawBodyLeaksIn`) are not
     * covered. Proved against mutated
     * copies of this very file at the bottom of this one.
     */
    expect(rawBodyLeaksIn(routeFile)).toEqual([]);
  });

  it("and the gate takes that `userId` from the session", () => {
    /*
     * The link the route cannot vouch for itself: `access.userId` is only
     * the session's user if `requireOwnedMedia` makes it so. Every
     * declaration of each name in that file, in the five shapes
     * `bindingsNamed`'s docstring lists (ugcportal-2k2q), is checked, so a
     * second `userId` declaration read from anywhere else there fails here.
     */
    const userIds = bindingsNamed(accessFile, "userId");
    expect(userIds.length).toBeGreaterThan(0);
    for (const binding of userIds) expect(binding, binding).toBe("user.id");

    const users = bindingsNamed(accessFile, "user");
    expect(users.length).toBeGreaterThan(0);
    for (const binding of users) expect(binding, binding).toMatch(/^session\??\.user$/);

    const sessions = bindingsNamed(accessFile, "session");
    expect(sessions.length).toBeGreaterThan(0);
    for (const binding of sessions) expect(binding, binding).toBe("await auth()");
  });
});

describe("the scanner itself, against a fixture tree", () => {
  const roots: string[] = [];

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "attestation-scan-"));
    roots.push(root);
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("FAILS on a second call site — the fixture mutation K3 asks for", () => {
    /*
     * The mutation, run rather than described. A scan that could not see a
     * second writer would report one file here, and every assertion above
     * would be decoration.
     */
    const root = tree({
      "route.ts": "await tx.mediaAttestation.create({ data: { attestedByUserId: userId } });",
      "scratch/importer.ts":
        "await prisma.mediaAttestation.create({ data: { attestedByUserId: 'someone-else' } });",
    });

    expect(scanAttestationWritePaths(root)).toEqual([
      "route.ts",
      "scratch/importer.ts",
    ]);
  });

  it("sees a nested `attestation: { create: … }` as a write path too", () => {
    // The shape a second author is most likely to reach for, and the one a
    // model-name-only matcher would miss entirely.
    const root = tree({
      "nested.ts":
        "await tx.media.create({ data: { attestation: { create: { attestedByUserId: 'x' } } } });",
    });

    expect(scanAttestationWritePaths(root)).toEqual(["nested.ts"]);
  });

  it("sees an upsert and an update, not only a create", () => {
    const root = tree({
      "upsert.ts": "await prisma.mediaAttestation.upsert({ where: {}, create: {}, update: {} });",
      "update.ts": "await prisma.mediaAttestation.updateMany({ data: {} });",
    });

    expect(scanAttestationWritePaths(root)).toEqual(["update.ts", "upsert.ts"]);
  });

  it("does NOT match a file that only mentions the call in a comment", () => {
    /*
     * The defect this scanner is shaped to avoid, as a case. A
     * `source.includes(...)` scan reports this file, which means the
     * enumeration above would have to allowlist every file that discusses
     * the write — and an allowlist is where a scan like this stops meaning
     * what it says.
     */
    const root = tree({
      "docs-only.ts": [
        "// The one place this is written is prisma.mediaAttestation.create,",
        "// in POST /api/media. See attestation: { create: ... } for the",
        "// nested form it deliberately does not use.",
        "/* tx.mediaAttestation.upsert({ data: {} }) would be a second one. */",
        "export const NOTE = 1;",
      ].join("\n"),
    });

    expect(scanAttestationWritePaths(root)).toEqual([]);
  });

  it("does NOT match the call name inside a string literal", () => {
    // The half that stripping comments does not close: a log line, an error
    // message, a test name, a route constant.
    const root = tree({
      "strings.ts": [
        'export const MESSAGE = "prisma.mediaAttestation.create failed";',
        'export const OTHER = `tx.mediaAttestation.upsert({ data: {} })`;',
        'console.error("attestation: { create: ... } is not used here");',
      ].join("\n"),
    });

    expect(scanAttestationWritePaths(root)).toEqual([]);
  });

  it("does NOT match a read of the same model", () => {
    // `findUnique`/`findMany` are not write paths, and a matcher that
    // counted them would push every future reader onto an allowlist.
    const root = tree({
      "reader.ts": [
        "const row = await prisma.mediaAttestation.findUnique({ where: { mediaId } });",
        "const rows = await prisma.mediaAttestation.findMany();",
        "const n = await prisma.mediaAttestation.count();",
      ].join("\n"),
    });

    expect(scanAttestationWritePaths(root)).toEqual([]);
  });

  it("does NOT match a `select: { attestation: { … } }` projection", () => {
    // MEDIA_GATE_SELECT names the relation; it reads it. A nested-write
    // matcher that keyed on the property name alone would report
    // src/lib/resale-rights.ts as a write path, and the enumeration above
    // would have been written with it allowlisted — which is how a scan
    // quietly comes to permit the thing it exists to forbid.
    const root = tree({
      "select.ts":
        "export const S = { attestation: { select: { attestedByUserId: true, authorship: true } } };",
    });

    expect(scanAttestationWritePaths(root)).toEqual([]);
  });

  it("skips test files, so a fixture may seed one", () => {
    const root = tree({
      "seed.test.ts": "await prisma.mediaAttestation.create({ data: {} });",
    });

    expect(scanAttestationWritePaths(root)).toEqual([]);
  });

  it("reads the actor out of the argument, not out of the file", () => {
    // The assertion "always called with session.user.id" is about the CALL.
    // A file that names the column in an unrelated place must not satisfy
    // it, which is what this fixture checks the extractor on.
    const root = tree({
      "elsewhere.ts": [
        "const attestedByUserId = body.get('attestedByUserId');",
        "await tx.mediaAttestation.create({ data: { mediaId } });",
      ].join("\n"),
    });

    const [write] = attestationWritesIn(path.join(root, "elsewhere.ts"));
    expect(write.argument).not.toMatch(/attestedByUserId:\s*userId\b/);
  });

  it("sees an application file importing test-support — the mutation for the allowance", () => {
    /*
     * Run, not described. The allowance granted to media-fixtures.ts above
     * rests entirely on "no application file can reach it", and an
     * assertion that cannot fail would make that sentence decoration.
     */
    const root = tree({
      "lib/test-support/media-fixtures.ts": "export const seedMedia = 1;",
      "app/importer.ts": 'import { seedMedia } from "@/lib/test-support/media-fixtures";',
      "app/lazy.ts": 'const m = await import("@/lib/test-support/db");',
      "app/reexport.ts": 'export { seedMedia } from "../lib/test-support/media-fixtures";',
    });

    expect(scanTestSupportImporters(root)).toEqual([
      "app/importer.ts",
      "app/lazy.ts",
      "app/reexport.ts",
    ]);
  });

  it("does NOT report a file that only MENTIONS the directory, or a test that imports it", () => {
    const root = tree({
      // Prose, a string and a test file — the three shapes a text scan
      // would have had to allowlist one by one.
      "app/prose.ts": [
        "// see @/lib/test-support/media-fixtures for the fixture",
        'export const PATH = "@/lib/test-support/media-fixtures";',
        "export const N = 1;",
      ].join("\n"),
      "app/fine.test.ts":
        'import { seedMedia } from "@/lib/test-support/media-fixtures";',
      "lib/test-support/db.ts": 'import { x } from "@/lib/test-support/other";',
    });

    expect(scanTestSupportImporters(root)).toEqual([]);
  });

  /*
   * ugcportal-gkax M1-r2: the structural rule run against mutated copies of
   * the real route, so each mutation is the shape review actually tried, on
   * the file as it is now, rather than a toy. Each `mutate` asserts its
   * anchor was found, so a reworded route fails here loudly instead of
   * quietly checking an unmutated copy.
   */
  function mutatedRoute(...edits: Array<[string, string]>): string {
    let text = readFileSync(
      path.join(SRC_ROOT, LATE_ATTESTATION_WRITE_PATH),
      "utf8",
    );
    for (const [anchor, replacement] of edits) {
      expect(text, anchor).toContain(anchor);
      text = text.replace(anchor, replacement);
    }
    return path.join(tree({ "route.ts": text }), "route.ts");
  }

  const TRY = "  try {\n";
  const BODY_ALIAS_IN_POST =
    "  const fields = body.value as Record<string, unknown>;\n  try {\n";
  const CREATE = "const created = await tx.mediaAttestation.create({";

  it.each(["userId", "uploaderUserId", "anyKeyNobodyListed"])(
    "FAILS on round 1's destructured shadow reading `%s` from the body",
    (key) => {
      const file = mutatedRoute(
        [TRY, BODY_ALIAS_IN_POST],
        [
          CREATE,
          `const { userId } = { userId: (fields.${key} as string | undefined) ?? access.userId };\n      ${CREATE}`,
        ],
      );

      expect(rawBodyLeaksIn(file).join("\n")).toMatch(
        /body\.value read outside attestationFromBody/,
      );
      expect(declarationsNamed(file, "userId")).toHaveLength(2);
    },
  );

  it("FAILS on a parameter named `userId` shadowing the session's, fed from the body", () => {
    const file = mutatedRoute(
      [TRY, BODY_ALIAS_IN_POST],
      [CREATE, "const write = (userId: string) => tx.mediaAttestation.create({"],
      [
        '      });\n      return { kind: "created" as const, created };',
        '      });\n      const created = await write((fields.uploaderId as string | undefined) ?? userId);\n      return { kind: "created" as const, created };',
      ],
    );

    expect(rawBodyLeaksIn(file).join("\n")).toMatch(
      /body\.value read outside attestationFromBody/,
    );
    expect(declarationsNamed(file, "userId")).toEqual([
      "access.userId",
      expect.stringMatching(/^Parameter: /),
    ]);
  });

  it("FAILS on the body read again from the request, or the raw object let out of the reader", () => {
    const reread = mutatedRoute([
      TRY,
      "  const again = (await request.clone().json()) as Record<string, unknown>;\n  try {\n",
    ]);
    expect(rawBodyLeaksIn(reread).join("\n")).toMatch(
      /request read other than by readJsonBody/,
    );

    const escaped = mutatedRoute([
      "  return parseAttestation((name) =>",
      "  (globalThis as Record<string, unknown>).actor = fields.uploaderUserId;\n  return parseAttestation((name) =>",
    ]);
    expect(rawBodyLeaksIn(escaped).join("\n")).toMatch(
      /fields read outside the reader passed to parseAttestation/,
    );

    const keyed = mutatedRoute([
      "? fields[name] : undefined",
      "? fields[name] : fields.uploaderUserId",
    ]);
    expect(rawBodyLeaksIn(keyed).join("\n")).toMatch(
      /fields read other than at the key parseAttestation asks for/,
    );
  });

  it("reports every userId binding, so a second one cannot hide", () => {
    const root = tree({
      "two.ts": [
        "const userId = session?.user?.id;",
        "function other(body: FormData) { const userId = body.get('userId'); return userId; }",
      ].join("\n"),
    });

    expect(userIdBindingsIn(path.join(root, "two.ts"))).toEqual([
      "session?.user?.id",
      "body.get('userId')",
    ]);
  });
});
