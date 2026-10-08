import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isTestFile, walkSourceFiles } from "@/lib/design/scan-source";
import {
  type PrismaModelWrite,
  bindingsNamed,
  prismaModelWritesIn,
} from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-15r K3, as a claim about the WHOLE TREE: an attestation row is
 * written in exactly one file, and always with `session.user.id`.
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
 * Every `const/let/var userId = …` initialiser in a file, as source text.
 * Delegates to the shared scanner for the same reason the matcher above
 * does; the name is kept because it is what the cases below read.
 */
export function userIdBindingsIn(file: string): string[] {
  return bindingsNamed(file, "userId");
}

/**
 * Every module specifier a file imports, as written — `import`/`export …
 * from`, and the dynamic `import("…")` form that `await import()` in a test
 * or a lazy loader uses.
 *
 * From the AST rather than from the text, for the reason the whole file
 * gives: a string that merely LOOKS like a path (a log line, a docstring,
 * this very comment) is not an import, and a text scan cannot tell.
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
 * out — so nine test files that seed published media need a declaration
 * alongside it. `src/lib/test-support/media-fixtures.ts` is the one copy of
 * "what a published row looks like" those files share; the alternative is
 * nine copies of eleven columns, which is the sibling-omission family this
 * scan's own header names.
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

/** Both, sorted the way `scanAttestationWritePaths` returns them. */
const ALLOWED_WRITE_PATHS = [WRITE_PATH, TEST_SUPPORT_WRITE_PATH].sort();

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

describe("ugcportal-15r K3: exactly one place writes an attestation", () => {
  const found = writePaths();

  it("finds the write path at all", () => {
    // Guards every assertion below against passing because the walker or the
    // matcher broke and came back with nothing — which is how a scan like
    // this most often stops meaning anything.
    expect(found.length).toBeGreaterThan(0);
  });

  it("finds it in exactly two files: POST /api/media, and the test-support fixture", () => {
    // Two, not one, since ugcportal-3ae — and the second is pinned by name
    // rather than by a pattern, so a THIRD writer (an importer, an admin
    // screen, a bulk re-attest tool) fails here by existing, which is the
    // whole claim K3 makes.
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
    // an upload that can never be sold. The route tests assert the
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
     * is only worth asserting on if it is the session's. Every binding of
     * that name in the file is checked, not just the nearest one, so a
     * second `const userId = body.get("userId")` added later fails here
     * even if the write itself is untouched.
     */
    const bindings = userIdBindingsIn(path.join(SRC_ROOT, WRITE_PATH));

    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(binding, binding).toMatch(/session\??\.user\??\.id/);
    }
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
