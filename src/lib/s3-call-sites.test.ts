import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ugcportal-98rb K4, the structural half: "a storage outage that is
 * indistinguishable, in the response or the logs, from a credentials or
 * policy error on any S3-touching route" must never happen.
 *
 * The per-route runtime halves live next to each route — the 503 and its log
 * in preview/[previewId]/route.test.ts, the distinct `?error=` code in
 * admin/rights/decision/route.test.ts, the unchanged 204 and its second log
 * line in media/[id]/route.test.ts. Each of those proves one route behaves.
 * None of them can prove anything about a route that does not exist yet, and
 * a sibling added later without the branch is exactly how this bead came to
 * be filed in the first place: ugcportal-1b2c fixed POST /api/media and left
 * three siblings behind, each of which looked fine in its own passing tests.
 *
 * So this file enumerates the call sites instead of trusting that anyone
 * remembers. Three rules, two of them with a named, commented exception list
 * — adding to one of those lists is the deliberate act this file exists to
 * force, and a list entry that no longer matches anything fails too, so the
 * lists cannot quietly rot into permission for whatever happens to be there.
 *
 * The third rule is the one that keeps the other two honest, and it is
 * about ANALYSABILITY rather than correctness: a client, or the factory
 * that makes one, may only appear where this file can follow it — the
 * initializer of a tracked binding, the right-hand side of a tracked
 * assignment, or the receiver of a `.send`. Anywhere else it is reported,
 * even if the code around it is perfectly correct, because a client handed
 * to a function parameter or pulled apart by a destructuring pattern leaves
 * the region these rules can see. "Correct but un-analysable" has to be a
 * noticed, written-down decision; it must not be a silent pass.
 *
 * THE ANALYSIS IS A PURE FUNCTION OVER (name, source) PAIRS (`analyze`
 * below), and that is not a style choice: it is what lets the rules be
 * tested against FIXTURES as well as against the repository. A guard is
 * only worth the spellings its matcher recognises, and a matcher built
 * around the literal `getS3Client().send(...)` chain recognises one. A
 * route spelled the other idiomatic way —
 *
 *     const client = getS3Client();
 *     await client.send(new GetObjectCommand(...));   // no transport branch
 *
 * — slips past such a matcher in both directions at once, silently: the
 * aliased send is not seen, so the file never enters `directS3Modules`, so
 * the ROUTE rule does not apply to it either, and no companion pin
 * notices. Hoisting the client into a local is the natural spelling the
 * moment a handler makes two sends, which both `deleteObjectBestEffort` and
 * POST /api/media already invite. So the matcher below resolves aliases
 * instead, and the "spellings that must not bypass the guard" describe
 * block at the bottom of this file runs each of them through `analyze` and
 * asserts it is CAUGHT.
 *
 * WHY THIS IS A TEST AND NOT @aws-sdk MIDDLEWARE. The alternative the bead
 * asks to be considered (`bd show ugcportal-98rb`, notes) is to install
 * `classifyTransportFailure` once as client middleware inside
 * `getS3Client()`, so every `send()` is classified whether or not its caller
 * opted in — which would satisfy K4 by construction rather than by this
 * enumeration. It was considered and not taken, for three reasons:
 *
 *  1. `ObjectStorageUnreachableError` carries an `operation` label, and the
 *     label's whole job is to say WHICH of several calls inside one
 *     try/catch failed (src/app/api/media/route.ts issues three). Middleware
 *     sees a command type, not a call site, so it can only ever report
 *     "PutObject" — and two different routes both issuing a
 *     `DeleteObjectCommand` are precisely the pair that needs telling apart.
 *  2. The classification depends on `$metadata.attempts > 1` to separate a
 *     retried transport failure from a one-shot local one (see
 *     `classifyTransportFailure`'s own doc comment). Getting that right from
 *     middleware means being certain the handler sits OUTSIDE @smithy's
 *     retry middleware in the resolved stack; a wrong `step`/`priority`
 *     classifies per-attempt errors instead of the final give-up error and
 *     silently loses the attempt count the fix turns on. The failure mode is
 *     invisible in a unit test that stubs the client.
 *  3. Blast radius: `getS3Client()` returns a module-level singleton used by
 *     the boot probe in src/instrumentation-node.ts as well as by every
 *     route, and that probe deliberately handles the RAW error (it wants its
 *     own wording, and it must also classify failures that never reached the
 *     SDK at all, like a missing S3_* variable).
 *
 * The cost of the choice taken is that K4 holds by enumeration rather than
 * by construction — which is what this file is, and why it is written to
 * fail loudly rather than vacuously.
 */

const SRC = resolve(process.cwd(), "src");

/** Generated Prisma output. Large, machine-written, and touches no S3. */
const IGNORED_DIRS = new Set(["generated"]);

/**
 * The module that defines `getS3Client` and the classification. It is the
 * thing being reused, so it is excluded from "modules that reach storage" —
 * otherwise every file importing a type from it would count as one.
 */
const S3_MODULE = "lib/s3.ts";

/** The factory, the classifier, and the error the routes branch on. */
const CLIENT_FACTORY = "getS3Client";
const CLASSIFIED_SEND = "sendWithTransportClassification";
const UNREACHABLE_ERROR = "ObjectStorageUnreachableError";
const LOG_FIELDS_HELPER = "objectStorageUnreachableLogFields";

/**
 * Files allowed to send to object storage without wrapping the call in
 * `sendWithTransportClassification`, with why.
 */
const UNWRAPPED_SEND_ALLOWED = new Map<string, string>([
  [
    "instrumentation-node.ts",
    "the boot reachability probe (ugcportal-ze1o). It calls " +
      "classifyTransportFailure itself, on the raw error, because it needs the " +
      "distinction for its own wording AND must classify failures that never " +
      "reached the SDK at all — a missing S3_* variable, which requireEnv " +
      "throws for before any send happens. Wrapping would hand it an " +
      "ObjectStorageUnreachableError for one half of that and a plain Error " +
      "for the other, which is further from what it needs, not closer.",
  ],
]);

/**
 * Route handlers allowed to reach object storage without a branch on
 * `ObjectStorageUnreachableError`, with why.
 *
 * Empty, and intended to stay that way: every route the
 * "knows which routes that rule actually applies to" test below enumerates
 * branches on the type, which is why the offender list is empty with this
 * map empty. The map exists so a future route with a genuine reason not to
 * has somewhere to say so in writing, rather than being added by deleting
 * an assertion.
 */
const ROUTE_WITHOUT_BRANCH_ALLOWED = new Map<string, string>([]);

type SourceInput = { name: string; source: string };

// ---------------------------------------------------------------------------
// The analysis. Pure: it reads nothing but the (name, source) pairs it is
// given, so the fixtures at the bottom of this file exercise exactly the
// code the repository scan runs.
// ---------------------------------------------------------------------------

function parse(input: SourceInput): ts.SourceFile {
  return ts.createSourceFile(
    input.name,
    input.source,
    ts.ScriptTarget.Latest,
    // Parent pointers are what makes the "is this call inside a
    // sendWithTransportClassification call?" walk below possible at all.
    /* setParentNodes */ true,
    input.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

/** True when some ancestor of `node` is a `sendWithTransportClassification(...)` call. */
function insideClassifiedSend(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (isCallTo(current, CLASSIFIED_SEND)) return true;
  }
  return false;
}

/**
 * Resolve an import specifier to one of the names in `known`. Deliberately
 * not `fs.existsSync`: the fixtures below are not on disk, and a resolver
 * that only answers for real files would quietly skip every fixture edge.
 */
function resolveSpecifier(
  fromName: string,
  specifier: string,
  known: Set<string>,
): string | undefined {
  const base = specifier.startsWith("@/")
    ? specifier.slice(2)
    : specifier.startsWith(".")
      ? join(dirname(fromName), specifier).split(sep).join("/")
      : undefined;
  if (base === undefined) return undefined;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

type ImportEdge = { local: string; imported: string; from: string };

type Analysis = {
  names: string[];
  /** Files with at least one call on a value that is an S3 client. */
  directS3Modules: string[];
  /** Files with at least one such call NOT inside `sendWithTransportClassification`. */
  unwrappedSendFiles: string[];
  /**
   * Files where a client, or the factory that makes one, appears somewhere
   * this analysis cannot follow it: handed to a function as an argument,
   * pulled apart by a destructuring pattern, stored in an object literal,
   * returned, or (for the factory) passed around uncalled. See
   * `isFollowableClientPosition` for the three positions that are fine.
   */
  escapedClientFiles: string[];
  /** Files constructing `new S3Client(...)` directly. */
  clientConstructorFiles: string[];
  /** Files containing a real `x instanceof ObjectStorageUnreachableError` test. */
  transportBranchFiles: string[];
  /** Files calling `objectStorageUnreachableLogFields(...)`. */
  logFieldsCallerFiles: string[];
  /** `name` or anything it imports, transitively, is in `directS3Modules`. */
  reachesS3(name: string): boolean;
};

function analyze(
  inputs: SourceInput[],
  { definingModule = S3_MODULE }: { definingModule?: string } = {},
): Analysis {
  const names = inputs.map((input) => input.name);
  const known = new Set(names);
  const asts = new Map(inputs.map((input) => [input.name, parse(input)]));

  const importEdges = new Map<string, ImportEdge[]>();
  const importedFiles = new Map<string, string[]>();
  const importedNames = new Map<string, Set<string>>();

  for (const [name, ast] of asts) {
    const edges: ImportEdge[] = [];
    const files: string[] = [];
    const locals = new Set<string>();
    walk(ast, (node) => {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) return;
      const target = resolveSpecifier(name, specifier.text, known);
      if (target === undefined) return;
      files.push(target);
      if (!ts.isImportDeclaration(node)) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          edges.push({ local: element.name.text, imported, from: target });
          locals.add(element.name.text);
        }
      }
    });
    importEdges.set(name, edges);
    importedFiles.set(name, files);
    importedNames.set(name, locals);
  }

  // Which local identifiers hold an S3 client, and which of those are
  // exported. Computed to a fixpoint so an alias of an alias, and a client
  // re-exported from another module, both resolve.
  const clientLocals = new Map<string, Set<string>>(
    names.map((name) => [name, new Set<string>()]),
  );
  const clientExports = new Map<string, Set<string>>(
    names.map((name) => [name, new Set<string>()]),
  );

  function isClientExpression(name: string, node: ts.Node): boolean {
    if (isCallTo(node, CLIENT_FACTORY)) return true;
    if (ts.isIdentifier(node)) return clientLocals.get(name)!.has(node.text);
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
      return isClientExpression(name, node.expression);
    }
    if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return isClientExpression(name, node.expression);
    }
    return false;
  }

  /**
   * The identifier being DECLARED (or imported, or re-exported) rather than
   * used: `const client = ...`, `function f(client = ...)`, `import
   * { storage }`, `export { storage }`. Tracking already covers these; they
   * are not places a client leaks out of.
   */
  function isTrackedBindingName(file: string, node: ts.Node): boolean {
    if (!ts.isIdentifier(node)) return false;
    if (!clientLocals.get(file)!.has(node.text)) return false;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
    if (ts.isParameter(parent) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.name === node) return true;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return true;
    if (ts.isExportSpecifier(parent)) return true;
    return false;
  }

  /**
   * The three positions a client may appear in and still be followable:
   *
   *  (a) the initializer of a tracked binding (`const c = getS3Client()`,
   *      `const d = c`, a parameter default) — the alias machinery above
   *      picks it up from there;
   *  (b) the right-hand side, or the assigned-to identifier, of a tracked
   *      assignment (`c = getS3Client()`);
   *  (c) the receiver of a `.send` property access — the thing these rules
   *      exist to find.
   *
   * Anywhere else, the value has left what this file can reason about.
   */
  function isAllowedClientPosition(file: string, node: ts.Node): boolean {
    const parent = node.parent;
    if (parent === undefined) return true;
    // (c)
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === "send"
    ) {
      return true;
    }
    // (a) — only when the thing being declared is itself tracked, so
    // `const { send } = getS3Client()` and `const [x] = ...` are not.
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      return ts.isIdentifier(parent.name) && clientLocals.get(file)!.has(parent.name.text);
    }
    if (ts.isParameter(parent) && parent.initializer === node) {
      return ts.isIdentifier(parent.name) && clientLocals.get(file)!.has(parent.name.text);
    }
    // (b)
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (parent.right === node || parent.left === node)
    ) {
      return ts.isIdentifier(parent.left) && clientLocals.get(file)!.has(parent.left.text);
    }
    // Transparent wrappers the client can hide behind without leaving:
    // `(c)`, `c!`, `c as S3Client`, `await c`.
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isAwaitExpression(parent)
    ) {
      return isAllowedClientPosition(file, parent);
    }
    return false;
  }

  for (let pass = 0; pass < names.length + 2; pass += 1) {
    let changed = false;
    const add = (map: Map<string, Set<string>>, file: string, id: string) => {
      const set = map.get(file)!;
      if (!set.has(id)) {
        set.add(id);
        changed = true;
      }
    };
    for (const [name, ast] of asts) {
      for (const edge of importEdges.get(name)!) {
        if (clientExports.get(edge.from)?.has(edge.imported)) {
          add(clientLocals, name, edge.local);
        }
      }
      walk(ast, (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isClientExpression(name, node.initializer)
        ) {
          add(clientLocals, name, node.name.text);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          isClientExpression(name, node.right)
        ) {
          add(clientLocals, name, node.left.text);
        }
        if (
          ts.isParameter(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isClientExpression(name, node.initializer)
        ) {
          add(clientLocals, name, node.name.text);
        }
      });
      // Anything exported by name that is known to hold a client.
      walk(ast, (node) => {
        const exportedHere = (id: string) => {
          if (clientLocals.get(name)!.has(id)) add(clientExports, name, id);
        };
        if (
          ts.isVariableStatement(node) &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exportedHere(declaration.name.text);
            }
          }
        }
        if (ts.isExportDeclaration(node) && node.exportClause) {
          if (ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) {
              exportedHere((element.propertyName ?? element.name).text);
            }
          }
        }
      });
    }
    if (!changed) break;
  }

  const directS3Modules: string[] = [];
  const unwrappedSendFiles: string[] = [];
  const escapedClientFiles: string[] = [];
  const clientConstructorFiles: string[] = [];
  const transportBranchFiles: string[] = [];
  const logFieldsCallerFiles: string[] = [];

  for (const [name, ast] of asts) {
    let sends = 0;
    let unwrapped = 0;
    let escaped = false;
    let constructs = false;
    let branches = false;
    let logs = false;

    walk(ast, (node) => {
      // Any `.send` touched on a value that is an S3 client — called or not.
      // A `const send = client.send` is not a working call either way, but it
      // is a way to move the method somewhere this walk cannot follow, so it
      // counts as an unwrapped send rather than being ignored.
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "send" &&
        isClientExpression(name, node.expression)
      ) {
        sends += 1;
        const called =
          ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!called || !insideClassifiedSend(node)) unwrapped += 1;
      }

      // The factory itself used as a VALUE rather than called: `const f =
      // getS3Client`, `register(getS3Client)`. That would hand a client to
      // somewhere this analysis cannot see.
      if (
        ts.isIdentifier(node) &&
        node.text === CLIENT_FACTORY &&
        name !== definingModule
      ) {
        const parent = node.parent;
        const isImportName =
          ts.isImportSpecifier(parent) || ts.isImportClause(parent);
        const isCallee = ts.isCallExpression(parent) && parent.expression === node;
        const isTypeQuery = ts.isTypeQueryNode(parent);
        if (!isImportName && !isCallee && !isTypeQuery) escaped = true;
      }

      // And the CLIENT used as a value, which is the same hazard one step
      // on. Tracking a client through bindings is only worth anything while
      // the client stays in a binding: `fetchIt(getS3Client(), key)` hands
      // it to a parameter this walk never resolves, and the helper's
      // `client.send(...)` is then invisible — the file does not even
      // register as S3-touching, so the route rule skips it too. Unlike the
      // factory case that spelling is working, shippable code, and
      // `deleteObjectBestEffort(mediaId, objectKey, role)` is one parameter
      // away from it.
      //
      // Phrased as an allowlist of the three positions the analysis can
      // actually follow, so a spelling nobody thought of is reported rather
      // than missed. `const { send } = getS3Client()` falls out of it for
      // free: an ObjectBindingPattern is not a tracked binding.
      if (
        !isAllowedClientPosition(name, node) &&
        isClientExpression(name, node) &&
        // The declaration site of a tracked identifier is not a use of it.
        !isTrackedBindingName(name, node)
      ) {
        escaped = true;
      }

      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "S3Client"
      ) {
        constructs = true;
      }

      // A real branch, not a mention: `instanceof` is an operator, and a
      // comment is trivia rather than a node, so a `// TODO: handle
      // ObjectStorageUnreachableError` cannot satisfy this. A
      // `source.includes("ObjectStorageUnreachableError")` check would
      // accept exactly that, which is why this is phrased on the AST.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        ts.isIdentifier(node.right) &&
        node.right.text === UNREACHABLE_ERROR
      ) {
        branches = true;
      }

      if (isCallTo(node, LOG_FIELDS_HELPER)) logs = true;
    });

    if (sends > 0 && name !== definingModule) directS3Modules.push(name);
    if (unwrapped > 0) unwrappedSendFiles.push(name);
    if (escaped) escapedClientFiles.push(name);
    if (constructs) clientConstructorFiles.push(name);
    if (branches) transportBranchFiles.push(name);
    if (logs) logFieldsCallerFiles.push(name);
  }

  function reachesS3(start: string): boolean {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (directS3Modules.includes(current)) return true;
      for (const next of importedFiles.get(current) ?? []) {
        if (!seen.has(next)) queue.push(next);
      }
    }
    return false;
  }

  return {
    names,
    directS3Modules: directS3Modules.sort(),
    unwrappedSendFiles: unwrappedSendFiles.sort(),
    escapedClientFiles: escapedClientFiles.sort(),
    clientConstructorFiles: clientConstructorFiles.sort(),
    transportBranchFiles: transportBranchFiles.sort(),
    logFieldsCallerFiles: logFieldsCallerFiles.sort(),
    reachesS3,
  };
}

// ---------------------------------------------------------------------------
// The repository scan.
// ---------------------------------------------------------------------------

function collect(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collect(join(dir, entry.name), found);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    found.push(join(dir, entry.name));
  }
  return found;
}

const repoSources: SourceInput[] = collect(SRC).map((path) => ({
  name: relative(SRC, path).split(sep).join("/"),
  source: readFileSync(path, "utf8"),
}));

const repo = analyze(repoSources);
const repoNames = new Set(repo.names);

const routeFiles = repo.names
  .filter((name) => /(^|\/)route\.tsx?$/.test(name))
  .sort();

describe("ugcportal-98rb K4: every S3 call site is transport-classified", () => {
  // Guards the scan itself. Most assertions below are of the form "this
  // computed list is empty", which a broken path or a silently-failing
  // parse would satisfy for the wrong reason.
  it("found the sources it claims to be scanning", () => {
    expect(repo.names.length).toBeGreaterThan(50);
    expect(repoNames.has(S3_MODULE)).toBe(true);
    expect(routeFiles.length).toBeGreaterThan(5);
    // The four known S3-touching routes as of ugcportal-98rb. Listed so that
    // a refactor which moves or renames one of them fails here rather than
    // quietly shrinking what the rules below apply to.
    expect(routeFiles).toEqual(
      expect.arrayContaining([
        "app/api/media/route.ts",
        "app/api/media/[id]/route.ts",
        "app/api/media/preview/[previewId]/route.ts",
        "app/api/admin/rights/decision/route.ts",
      ]),
    );
  });

  it("finds the call sites it is supposed to be checking", () => {
    // If the send matcher stopped matching — a rename of `getS3Client`, an
    // AST shape it does not handle — every "no offenders" assertion below
    // would pass with nothing examined. These are the modules that send today.
    expect(repo.directS3Modules).toEqual([
      "app/api/media/[id]/route.ts",
      "app/api/media/preview/[previewId]/route.ts",
      "app/api/media/route.ts",
      "instrumentation-node.ts",
      "lib/rights-evidence.ts",
    ]);
  });

  it("wraps every send on an S3 client in sendWithTransportClassification", () => {
    const offenders = repo.unwrappedSendFiles.filter(
      (name) => !UNWRAPPED_SEND_ALLOWED.has(name),
    );

    expect(offenders).toEqual([]);
  });

  it("never lets a client, or its factory, escape where it cannot be followed", () => {
    // The analysis follows a client through assignments, aliases and
    // re-exports. It cannot follow `register(getS3Client)`, and it cannot
    // follow `fetchIt(getS3Client(), key)` into the parameter that receives
    // it either — the factory and the client are the same hazard, so they
    // get the same rule. Nothing does either today; if something starts, it
    // has to be noticed rather than silently un-analysable, which is the
    // whole reason the other two rules can be trusted.
    expect(repo.escapedClientFiles).toEqual([]);
  });

  it("keeps no stale entry on the unwrapped-send list", () => {
    // An allowance that no longer describes anything real is worse than no
    // allowance: it reads as a reviewed decision about code that has since
    // moved or been fixed.
    for (const [name, reason] of UNWRAPPED_SEND_ALLOWED) {
      expect({ name, exists: repoNames.has(name) }).toEqual({
        name,
        exists: true,
      });
      expect({
        name,
        stillSendsUnwrapped: repo.unwrappedSendFiles.includes(name),
      }).toEqual({ name, stillSendsUnwrapped: true });
      // A one-word "legacy" is not a reason anyone can review.
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("gives every route that can reach object storage a transport branch", () => {
    // Transitive, so a route that reaches storage through a helper is
    // covered too — POST /api/admin/rights/decision reaches it only via
    // src/lib/rights-evidence.ts, and a route doing the same thing tomorrow
    // without handling the error is the case this catches.
    const offenders = routeFiles
      .filter((name) => !ROUTE_WITHOUT_BRANCH_ALLOWED.has(name))
      .filter((name) => repo.reachesS3(name))
      .filter((name) => !repo.transportBranchFiles.includes(name));

    expect(offenders).toEqual([]);
  });

  it("knows which routes that rule actually applies to", () => {
    // The companion to the assertion above: it is an "is empty" check, so
    // without this one it would also pass if `reachesS3` matched nothing.
    expect(routeFiles.filter((name) => repo.reachesS3(name))).toEqual([
      "app/api/admin/rights/decision/route.ts",
      "app/api/media/[id]/route.ts",
      "app/api/media/preview/[previewId]/route.ts",
      "app/api/media/route.ts",
    ]);
  });

  it("keeps no stale entry on the route-exception list", () => {
    for (const [name, reason] of ROUTE_WITHOUT_BRANCH_ALLOWED) {
      expect({ name, exists: repoNames.has(name) }).toEqual({
        name,
        exists: true,
      });
      expect({ name, reachesS3: repo.reachesS3(name) }).toEqual({
        name,
        reachesS3: true,
      });
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("constructs the S3 client in exactly one place", () => {
    // The rules above are all phrased in terms of `getS3Client()`. A file
    // that built its own `new S3Client(...)` would sidestep every one of
    // them while still being an S3-touching route.
    expect(repo.clientConstructorFiles).toEqual([S3_MODULE]);
  });

  it("lists every caller of objectStorageUnreachableLogFields", () => {
    // src/lib/s3.ts's doc comment for that helper points HERE rather than
    // naming its callers in prose, because prose miscounts — a hand-written
    // "three" there outlived the arrival of a fourth caller. This list
    // cannot drift: adding or removing a caller fails this assertion.
    expect(repo.logFieldsCallerFiles).toEqual([
      "app/api/admin/rights/decision/route.ts",
      "app/api/media/[id]/route.ts",
      "app/api/media/preview/[previewId]/route.ts",
      "lib/rights-evidence.ts",
    ]);
  });
});

/**
 * The rules above are only worth what their matcher recognises, so each
 * spelling it has to recognise gets a fixture here rather than an argument.
 *
 * Each fixture below is a complete, self-contained little "repository" run
 * through the same `analyze` the scan above uses. Every one of them is a
 * spelling that USED TO PASS and must now be caught — plus the positive
 * controls, because a matcher that flags everything is not a guard either.
 */
describe("ugcportal-98rb K4: spellings that must not bypass the guard", () => {
  /** The minimum stand-in for src/lib/s3.ts the analysis needs. */
  const S3_STUB: SourceInput = {
    name: S3_MODULE,
    source: `
      import { S3Client } from "@aws-sdk/client-s3";
      export function getS3Client(): S3Client { return new S3Client({}); }
      export class ObjectStorageUnreachableError extends Error {}
      export async function sendWithTransportClassification<T>(
        operation: string,
        send: () => Promise<T>,
      ): Promise<T> { return send(); }
      export function objectStorageUnreachableLogFields(e: unknown) { return { e }; }
    `,
  };

  function route(source: string, name = "app/api/scratch/route.ts") {
    return analyze([S3_STUB, { name, source }]);
  }

  it("catches a client hoisted into a local", () => {
    const result = route(`
      import { getS3Client } from "@/lib/s3";
      export async function GET() {
        const client = getS3Client();
        await client.send({} as never);
        return new Response(null);
      }
    `);
    expect(result.unwrappedSendFiles).toEqual(["app/api/scratch/route.ts"]);
    expect(result.directS3Modules).toEqual(["app/api/scratch/route.ts"]);
    // And the ROUTE rule reaches it too, which is the half that also failed
    // silently before: an unseen send meant an unseen route.
    expect(result.reachesS3("app/api/scratch/route.ts")).toBe(true);
    expect(result.transportBranchFiles).toEqual([]);
  });

  it("catches an alias of an alias", () => {
    const result = route(`
      import { getS3Client } from "@/lib/s3";
      const first = getS3Client();
      const second = first;
      export async function GET() {
        await second.send({} as never);
        return new Response(null);
      }
    `);
    expect(result.unwrappedSendFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("catches a client re-exported from another module", () => {
    const result = analyze([
      S3_STUB,
      {
        name: "lib/storage-handle.ts",
        source: `
          import { getS3Client } from "@/lib/s3";
          export const storage = getS3Client();
        `,
      },
      {
        name: "app/api/scratch/route.ts",
        source: `
          import { storage } from "@/lib/storage-handle";
          export async function GET() {
            await storage.send({} as never);
            return new Response(null);
          }
        `,
      },
    ]);
    expect(result.unwrappedSendFiles).toEqual(["app/api/scratch/route.ts"]);
    expect(result.reachesS3("app/api/scratch/route.ts")).toBe(true);
  });

  it("catches the second send in a handler that wraps only the first", () => {
    // The shape that makes hoisting attractive in the first place, and the
    // one a per-file "does this file mention the wrapper?" check would miss.
    const result = route(`
      import { getS3Client, sendWithTransportClassification } from "@/lib/s3";
      export async function DELETE() {
        const client = getS3Client();
        await sendWithTransportClassification("cleanup", () => client.send({} as never));
        await client.send({} as never);
        return new Response(null, { status: 204 });
      }
    `);
    expect(result.unwrappedSendFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("catches the method pulled off the client", () => {
    const result = route(`
      import { getS3Client } from "@/lib/s3";
      const client = getS3Client();
      const send = client.send;
      export async function GET() {
        await send({} as never);
        return new Response(null);
      }
    `);
    expect(result.unwrappedSendFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("catches the factory passed around as a value", () => {
    const result = route(`
      import { getS3Client } from "@/lib/s3";
      export const factory = getS3Client;
    `);
    expect(result.escapedClientFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("catches a client handed to a helper as a call argument", () => {
    // Working, idiomatic, shippable code, and the reason the escape rule
    // covers the client and not only the factory: the helper's parameter is
    // not a tracked binding, so its `client.send(...)` is invisible, so the
    // file never enters directS3Modules, so the route rule skips it too.
    const result = route(`
      import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
      import { getBucketName, getS3Client } from "@/lib/s3";
      async function fetchIt(client: S3Client, key: string): Promise<void> {
        await client.send(new GetObjectCommand({ Bucket: getBucketName(), Key: key }));
      }
      export async function GET(): Promise<Response> {
        await fetchIt(getS3Client(), "scratch");
        return new Response(null, { status: 204 });
      }
    `);
    expect(result.escapedClientFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("catches a client taken apart by a destructuring pattern", () => {
    // The destructuring twin of "the method pulled off the client". It
    // throws at runtime rather than shipping, but the old rule said one of
    // the pair was worth reporting and let the other through, which is the
    // kind of split that makes a guard unreliable to reason about. An
    // ObjectBindingPattern is not a tracked binding, so this falls out of
    // the allowlist rather than needing a rule of its own.
    const result = route(`
      import { getS3Client } from "@/lib/s3";
      const { send } = getS3Client();
      export async function GET() {
        await send({} as never);
        return new Response(null);
      }
    `);
    expect(result.escapedClientFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("reports an escape even when the helper that receives the client is correct", () => {
    // Deliberate, and the reason the rule is phrased as an allowlist of
    // followable POSITIONS rather than as a hunt for mistakes: this file is
    // correct — the helper wraps its send — but the analysis cannot prove
    // it, and "correct but un-analysable" has to be a written-down decision
    // on the exception list rather than a silent pass. The clean way to
    // write the same refactor is the next fixture.
    const result = route(`
      import { type S3Client } from "@aws-sdk/client-s3";
      import { getS3Client, sendWithTransportClassification } from "@/lib/s3";
      async function fetchIt(client: S3Client): Promise<void> {
        await sendWithTransportClassification("preview-fetch", () => client.send({} as never));
      }
      export async function GET() {
        await fetchIt(getS3Client());
        return new Response(null);
      }
    `);
    expect(result.escapedClientFiles).toEqual(["app/api/scratch/route.ts"]);
    // The send inside the helper IS seen and IS wrapped — the escape is the
    // only thing wrong with this file.
    expect(result.unwrappedSendFiles).toEqual([]);
  });

  it("accepts the same refactor done so the client never leaves", () => {
    // The positive control for the escape rule, and the shape the
    // repository actually uses (src/lib/rights-evidence.ts): the helper
    // takes the inputs, not the client, and reaches for the client inside
    // the wrapper. Nothing escapes, nothing is unwrapped.
    const result = route(`
      import {
        ObjectStorageUnreachableError,
        getS3Client,
        sendWithTransportClassification,
      } from "@/lib/s3";
      async function fetchIt(key: string): Promise<void> {
        await sendWithTransportClassification("preview-fetch", () =>
          getS3Client().send({ key } as never),
        );
      }
      export async function GET() {
        try {
          await fetchIt("scratch");
        } catch (error) {
          if (error instanceof ObjectStorageUnreachableError) {
            return new Response(null, { status: 503 });
          }
        }
        return new Response(null);
      }
    `);
    expect(result.escapedClientFiles).toEqual([]);
    expect(result.unwrappedSendFiles).toEqual([]);
    expect(result.directS3Modules).toEqual(["app/api/scratch/route.ts"]);
    expect(result.transportBranchFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("catches a route whose only mention of the error is a comment", () => {
    // A `source.includes("ObjectStorageUnreachableError")` rule accepts
    // this fixture. `instanceof` is an operator and a comment is trivia,
    // so the rule as written cannot.
    const result = route(`
      import { getS3Client, sendWithTransportClassification } from "@/lib/s3";
      export async function GET() {
        // TODO: handle ObjectStorageUnreachableError here one day.
        await sendWithTransportClassification("preview-fetch", () =>
          getS3Client().send({} as never),
        );
        return new Response(null);
      }
    `);
    expect(result.unwrappedSendFiles).toEqual([]);
    expect(result.reachesS3("app/api/scratch/route.ts")).toBe(true);
    // Reaches storage, mentions the name, has no branch -> an offender.
    expect(result.transportBranchFiles).toEqual([]);
  });

  it("accepts a hoisted client whose every send IS wrapped", () => {
    // The positive control for the alias work: a guard that cannot be
    // satisfied by correct code is not a guard, it is a ban.
    const result = route(`
      import {
        ObjectStorageUnreachableError,
        getS3Client,
        objectStorageUnreachableLogFields,
        sendWithTransportClassification,
      } from "@/lib/s3";
      export async function DELETE() {
        const client = getS3Client();
        try {
          await sendWithTransportClassification("cleanup", () => client.send({} as never));
          await sendWithTransportClassification("media-delete", () => client.send({} as never));
        } catch (error) {
          if (error instanceof ObjectStorageUnreachableError) {
            console.error("x", objectStorageUnreachableLogFields(error));
          }
        }
        return new Response(null, { status: 204 });
      }
    `);
    expect(result.unwrappedSendFiles).toEqual([]);
    expect(result.escapedClientFiles).toEqual([]);
    expect(result.transportBranchFiles).toEqual(["app/api/scratch/route.ts"]);
    expect(result.logFieldsCallerFiles).toEqual(["app/api/scratch/route.ts"]);
  });

  it("leaves a send on something that is not an S3 client alone", () => {
    // `xhr.send(form)` in src/app/upload/upload-transport.ts is the real
    // instance of this. A rule phrased as "every `.send(` anywhere" would
    // need that on the exception list, which would be an exception for
    // something that has nothing to do with object storage.
    const result = route(`
      export function post(xhr: XMLHttpRequest, form: FormData) {
        xhr.send(form);
      }
    `);
    expect(result.unwrappedSendFiles).toEqual([]);
    expect(result.directS3Modules).toEqual([]);
  });
});
