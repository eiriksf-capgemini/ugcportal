import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isTestFile, walkSourceFiles } from "@/lib/design/scan-source";
import {
  type PrismaModelWrite,
  prismaModelWritesIn,
} from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-qfy9 K2, as a claim about the WHOLE TREE: a
 * MediaRightsClearance row is written in exactly one file, and that file
 * writes it with a `create`.
 *
 * WHY THE TREE AND NOT JUST THE WRITE PATH'S OWN TESTS.
 * curation-clearance-write.test.ts proves the one writer there is refuses a
 * duplicate and keeps the first admin's justification. It cannot prove it is
 * the only writer — and the way K2 stops holding is not that somebody
 * deletes `recordLayerClearance`, it is that somebody adds a SECOND writer
 * (an importer, a bulk re-clear tool, a "revise this clearance" screen, a
 * migration script) whose review has no reason to think about layer
 * independence. This repo's recurring defect family 4: a rule enforced at
 * one of N call sites. A second writer fails this file by existing.
 *
 * AND WHY `create` IS ASSERTED ON THE NODE. The behavioural test next door
 * asserts a second call is refused and the first row is unchanged, which an
 * `upsert` fails. This asserts the SHAPE that produces it, because the two
 * fail in different ways: an `upsert` added here under a `where` that can
 * never match would pass the behavioural test on today's fixtures and still
 * be a silent overwrite waiting for the first revision. The unique index on
 * `(listingId, layer)` is the state-level guarantee; this is the
 * call-level one.
 *
 * TEST FILES ARE EXCLUDED, with the same reasoning
 * attestation-write-paths.test.ts and alcohol-commerce.write-paths.test.ts
 * both give: seeding a clearance is the ordinary vocabulary of a fixture —
 * curation-clearance-write.test.ts has to insert one by hand to show the
 * unique index rejecting — and a rule requiring every such test to go
 * through the write path would be a rule about tests rather than about
 * write paths. What that exclusion costs is paid for at the bottom of this
 * file, where the scanner is driven over a real temp directory.
 *
 * The matcher is shared with the attestation scan
 * (src/lib/test-support/prisma-write-scan.ts): one AST walk, two tables.
 * `walkSourceFiles` is still called here, so
 * scripts/tree-walk-timeout-guard.test.mjs can see that this file walks the
 * tree and hold it to the cached-helper mitigation below.
 */

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The relation a nested write would go through: MediaListing's
 * `layerClearances`. Prisma's `data: { layerClearances: { create: … } }`
 * writes a clearance without ever naming the model, which is the shape a
 * second author adding "triage and clear in one go" would reach for first.
 *
 * MEDIA_GATE_SELECT and the curation page both name this relation in a
 * `select`, so the matcher has to tell a projection from a write — it does,
 * and there is a case for it below.
 */
const RELATION_FIELD = "layerClearances";

function clearanceWritesIn(file: string): PrismaModelWrite[] {
  return prismaModelWritesIn(file, {
    model: "mediaRightsClearance",
    relationField: RELATION_FIELD,
  });
}

/** Files, relative to `root` with POSIX separators, that write a clearance. */
export function scanClearanceWritePaths(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => clearanceWritesIn(file).length > 0)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

/** The one file allowed to write one, and why: it is the chokepoint. */
const WRITE_PATH = "lib/curation-clearance-write.ts";

/**
 * ONE WALK OF `src/`, AND ONE PARSE OF THE WRITE PATH, shared by every case
 * below. Required by scripts/tree-walk-timeout-guard.test.mjs and for its
 * reason (ugcportal-9faa): a per-test whole-tree walk is what pushes a
 * suite past vitest's default per-test timeout under load, and the failure
 * then looks like a flake rather than like a cost somebody chose.
 */
let cachedWritePaths: string[] | undefined;
let cachedChokepointWrites: PrismaModelWrite[] | undefined;

function writePaths(): string[] {
  return (cachedWritePaths ??= scanClearanceWritePaths(SRC_ROOT));
}

function chokepointWrites(): PrismaModelWrite[] {
  return (cachedChokepointWrites ??= clearanceWritesIn(
    path.join(SRC_ROOT, WRITE_PATH),
  ));
}

describe("ugcportal-qfy9 K2: exactly one place writes a clearance", () => {
  const found = writePaths();

  it("finds the write path at all", () => {
    // Guards every assertion below against passing because the walker or
    // the matcher broke and came back with nothing — which is how a scan
    // like this most often stops meaning anything.
    expect(found.length).toBeGreaterThan(0);
  });

  it("finds it in exactly one file, and that file is the chokepoint", () => {
    expect(found).toEqual([WRITE_PATH]);
  });

  it("writes exactly one clearance there, through an explicit create", () => {
    const writes = chokepointWrites();

    expect(writes).toHaveLength(1);
    // The assertion K2 turns on. An `upsert` here replaces one admin's
    // justification with another's, silently, and the unique index never
    // fires — the guardrail becomes a no-op that still looks green.
    expect(writes[0].method).toBe("create");
    expect(writes[0].nested).toBe(false);
    // Inside the transaction's client, not the module-level `prisma`: the
    // actor's current role and the absence of an existing row are both read
    // in the same transaction as the write they govern.
    expect(writes[0].callee).toBe("tx.mediaRightsClearance.create");
  });

  it("names one layer and the acting admin on that create", () => {
    const [write] = chokepointWrites();

    // The argument text, not the whole file: a file that mentions
    // `clearedByUserId` in a docstring would satisfy a file-level check and
    // write anything it liked here.
    expect(write.argument).toMatch(/clearedByUserId:\s*actorUserId\b/);
    expect(write.argument).toMatch(/\blayer,/);
    // `createMany` with an array of layers is what "clear everything still
    // blocking" would look like, and it is already excluded by the method
    // assertion above; this adds that the single create takes one `layer`
    // binding rather than a list.
    expect(write.argument).not.toMatch(/layer:\s*\[/);
  });
});

describe("the scanner itself, against a fixture tree", () => {
  const roots: string[] = [];

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "clearance-scan-"));
    roots.push(root);
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("FAILS on a second call site — the fixture mutation K2 asks for", () => {
    /*
      The mutation, run rather than described. A scan that could not see a
      second writer would report one file here, and every assertion above
      would be decoration.
    */
    const root = tree({
      "write.ts":
        "await tx.mediaRightsClearance.create({ data: { layer, clearedByUserId: actorUserId } });",
      "scratch/bulk-clear.ts":
        "await prisma.mediaRightsClearance.createMany({ data: layers.map((layer) => ({ layer })) });",
    });

    expect(scanClearanceWritePaths(root)).toEqual([
      "scratch/bulk-clear.ts",
      "write.ts",
    ]);
  });

  it("sees a nested `layerClearances: { create: … }` as a write path too", () => {
    // The shape a "triage and clear in one submit" screen would reach for,
    // and the one a model-name-only matcher would miss entirely.
    const root = tree({
      "nested.ts":
        "await tx.mediaListing.upsert({ create: { layerClearances: { create: { layer: 'MUSIC' } } } });",
    });

    expect(scanClearanceWritePaths(root)).toEqual(["nested.ts"]);
  });

  it("sees an upsert and an update, not only a create", () => {
    // The two methods that would turn K2's guardrail into a no-op.
    const root = tree({
      "upsert.ts":
        "await prisma.mediaRightsClearance.upsert({ where: {}, create: {}, update: {} });",
      "update.ts":
        "await prisma.mediaRightsClearance.updateMany({ data: { reason } });",
    });

    expect(scanClearanceWritePaths(root)).toEqual(["update.ts", "upsert.ts"]);
  });

  it("does NOT match a file that only mentions the call in a comment", () => {
    const root = tree({
      "docs-only.ts": [
        "// The one place this is written is prisma.mediaRightsClearance.create,",
        "// in recordLayerClearance. See layerClearances: { create: ... } for the",
        "// nested form it deliberately does not use.",
        "/* tx.mediaRightsClearance.upsert({ data: {} }) would be a second one. */",
        "export const NOTE = 1;",
      ].join("\n"),
    });

    expect(scanClearanceWritePaths(root)).toEqual([]);
  });

  it("does NOT match the call name inside a string literal", () => {
    const root = tree({
      "strings.ts": [
        'export const MESSAGE = "prisma.mediaRightsClearance.create failed";',
        "export const OTHER = `tx.mediaRightsClearance.upsert({ data: {} })`;",
        'console.error("layerClearances: { create: ... } is not used here");',
      ].join("\n"),
    });

    expect(scanClearanceWritePaths(root)).toEqual([]);
  });

  it("does NOT match a read of the same model", () => {
    // `findUnique` is how the write path checks for an existing row, and
    // `count` is how a test checks there is one. A matcher that counted
    // reads would push every future reader onto an allowlist.
    const root = tree({
      "reader.ts": [
        "const row = await tx.mediaRightsClearance.findUnique({ where: { listingId_layer: {} } });",
        "const rows = await prisma.mediaRightsClearance.findMany();",
        "const n = await prisma.mediaRightsClearance.count();",
      ].join("\n"),
    });

    expect(scanClearanceWritePaths(root)).toEqual([]);
  });

  it("does NOT match a `select: { layerClearances: { … } }` projection", () => {
    /*
      THE FALSE POSITIVE THAT WOULD HAVE BROKEN THIS SCAN. Both
      MEDIA_GATE_SELECT (src/lib/resale-rights.ts) and the curation page's
      UPLOAD_SELECT name `layerClearances` in a `select`. A nested-write
      matcher keyed on the property name alone would report them as write
      paths, the enumeration above would have been written with them
      allowlisted, and the allowlist is where a scan quietly comes to permit
      the thing it exists to forbid.
    */
    const root = tree({
      "select.ts":
        "export const S = { layerClearances: { select: { layer: true, reason: true, clearedBy: { select: { role: true } } } } };",
    });

    expect(scanClearanceWritePaths(root)).toEqual([]);
  });

  it("skips test files, so a fixture may insert one by hand", () => {
    // curation-clearance-write.test.ts has to, in order to watch the unique
    // index reject a duplicate.
    const root = tree({
      "seed.test.ts":
        "await prisma.mediaRightsClearance.create({ data: { layer: 'MUSIC' } });",
    });

    expect(scanClearanceWritePaths(root)).toEqual([]);
  });

  it("reads the actor out of the argument, not out of the file", () => {
    // "names the acting admin" is a claim about the CALL. A file that
    // mentions the column somewhere else must not satisfy it.
    const root = tree({
      "elsewhere.ts": [
        "const clearedByUserId = formData.get('clearedByUserId');",
        "await tx.mediaRightsClearance.create({ data: { layer } });",
      ].join("\n"),
    });

    const [write] = clearanceWritesIn(path.join(root, "elsewhere.ts"));
    expect(write.argument).not.toMatch(/clearedByUserId:\s*actorUserId\b/);
  });
});
