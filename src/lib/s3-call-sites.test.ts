import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
 * remembers. Two rules, each with its own named, commented exception list —
 * adding to one of those lists is the deliberate act this file exists to
 * force, and a list entry that no longer matches anything fails too, so the
 * lists cannot quietly rot into permission for whatever happens to be there.
 *
 * WHY THIS IS A TEST AND NOT @aws-sdk MIDDLEWARE. The alternative the bead
 * asks to be considered (`bd show ugcportal-98rb`, notes) is to
 * install `classifyTransportFailure` once as client middleware inside
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

/** The module that defines the classification; it is the thing being reused. */
const S3_MODULE = "lib/s3.ts";

/**
 * Files allowed to call `getS3Client().send(...)` without wrapping it in
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
 * Route handlers allowed to reach object storage without naming
 * `ObjectStorageUnreachableError`, with why.
 *
 * Empty, and intended to stay that way: every route the
 * "gives every route that can reach object storage a transport branch" test
 * below enumerates handles the type, which is why that test's offender list
 * is empty with this map empty. The map exists so a future route with a
 * genuine reason not to has somewhere to say so in writing, rather than
 * being added by deleting an assertion.
 */
const ROUTE_WITHOUT_BRANCH_ALLOWED = new Map<string, string>([]);

type SourceFile = { name: string; path: string; source: string };

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

/** Repo-relative-to-src, with forward slashes on every platform. */
function nameOf(path: string): string {
  return relative(SRC, path).split(sep).join("/");
}

const files: SourceFile[] = collect(SRC).map((path) => ({
  name: nameOf(path),
  path,
  source: readFileSync(path, "utf8"),
}));

const byName = new Map(files.map((file) => [file.name, file]));

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    // Parent pointers are what makes the "is this call inside a
    // sendWithTransportClassification call?" walk below possible at all.
    /* setParentNodes */ true,
    file.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** `getS3Client()` — the one way this codebase gets an S3 client. */
function isGetS3ClientCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "getS3Client"
  );
}

/** Every `getS3Client().send(...)` in one file. */
function s3SendCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    if (callee.name.text !== "send") return;
    if (!isGetS3ClientCall(callee.expression)) return;
    calls.push(node);
  });
  return calls;
}

/** True when some ancestor of `node` is a `sendWithTransportClassification(...)` call. */
function insideClassifiedSend(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "sendWithTransportClassification"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Module specifiers this file imports, resolved to repo files. Both `@/…`
 * (the tsconfig alias for src/) and relative specifiers, because a future
 * route is free to use either.
 */
function importedFiles(file: SourceFile, sourceFile: ts.SourceFile): string[] {
  const resolved: string[] = [];
  walk(sourceFile, (node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : undefined;
    if (!specifier || !ts.isStringLiteral(specifier)) return;
    const text = specifier.text;
    const base = text.startsWith("@/")
      ? join(SRC, text.slice(2))
      : text.startsWith(".")
        ? resolve(dirname(file.path), text)
        : undefined;
    if (!base) return;
    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        resolved.push(nameOf(candidate));
        return;
      }
    }
  });
  return resolved;
}

/** Parsed once: every file is walked by more than one assertion below. */
const parsed = new Map(files.map((file) => [file.name, parse(file)]));

function ast(name: string): ts.SourceFile {
  const sourceFile = parsed.get(name);
  if (!sourceFile) throw new Error(`No parsed source for ${name}`);
  return sourceFile;
}

/** Files that talk to object storage directly. */
const directS3Modules = files
  .filter((file) => s3SendCalls(ast(file.name)).length > 0)
  .map((file) => file.name);

/** Each file mapped to the files it imports, for the transitive walk below. */
const importGraph = new Map(
  files.map((file) => [file.name, importedFiles(file, ast(file.name))]),
);

/** True when `name`, or anything it imports transitively, sends to S3. */
function reachesS3(name: string): boolean {
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (directS3Modules.includes(current)) return true;
    for (const next of importGraph.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

const routeFiles = files
  .map((file) => file.name)
  .filter((name) => /(^|\/)route\.tsx?$/.test(name));

describe("ugcportal-98rb K4: every S3 call site is transport-classified", () => {
  // Guards the scan itself. Every assertion below is of the form "this
  // computed list is empty", which a broken path or a silently-failing
  // parse would satisfy for the wrong reason.
  it("found the sources it claims to be scanning", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(byName.has(S3_MODULE)).toBe(true);
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
    // If `s3SendCalls` stopped matching — a rename of `getS3Client`, an AST
    // shape it does not handle — every "no offenders" assertion below would
    // pass with nothing examined. These are the modules that send today.
    expect([...directS3Modules].sort()).toEqual([
      "app/api/media/[id]/route.ts",
      "app/api/media/preview/[previewId]/route.ts",
      "app/api/media/route.ts",
      "instrumentation-node.ts",
      "lib/rights-evidence.ts",
    ]);
  });

  it("wraps every getS3Client().send() in sendWithTransportClassification", () => {
    const offenders = files
      .filter((file) => !UNWRAPPED_SEND_ALLOWED.has(file.name))
      .filter((file) =>
        s3SendCalls(ast(file.name)).some((call) => !insideClassifiedSend(call)),
      )
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it("keeps no stale entry on the unwrapped-send list", () => {
    // An allowance that no longer describes anything real is worse than no
    // allowance: it reads as a reviewed decision about code that has since
    // moved or been fixed.
    for (const [name, reason] of UNWRAPPED_SEND_ALLOWED) {
      expect({ name, exists: byName.has(name) }).toEqual({
        name,
        exists: true,
      });
      expect({
        name,
        stillSendsUnwrapped: s3SendCalls(ast(name)).some(
          (call) => !insideClassifiedSend(call),
        ),
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
      .filter((name) => reachesS3(name))
      .filter((name) => !byName.get(name)!.source.includes("ObjectStorageUnreachableError"))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("knows which routes that rule actually applies to", () => {
    // The companion to the assertion above: it is an "is empty" check, so
    // without this one it would also pass if `reachesS3` matched nothing.
    expect(routeFiles.filter((name) => reachesS3(name)).sort()).toEqual([
      "app/api/admin/rights/decision/route.ts",
      "app/api/media/[id]/route.ts",
      "app/api/media/preview/[previewId]/route.ts",
      "app/api/media/route.ts",
    ]);
  });

  it("keeps no stale entry on the route-exception list", () => {
    for (const [name, reason] of ROUTE_WITHOUT_BRANCH_ALLOWED) {
      expect({ name, exists: byName.has(name) }).toEqual({
        name,
        exists: true,
      });
      expect({ name, reachesS3: reachesS3(name) }).toEqual({
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
    const builders = files
      .filter((file) => {
        let found = false;
        walk(ast(file.name), (node) => {
          if (
            ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "S3Client"
          ) {
            found = true;
          }
        });
        return found;
      })
      .map((file) => file.name);

    expect(builders).toEqual([S3_MODULE]);
  });
});
