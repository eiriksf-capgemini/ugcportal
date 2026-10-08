import { readFileSync } from "node:fs";

import ts from "typescript";

import { scriptKindFor } from "@/lib/design/scan-source";

/**
 * Test-only helper (not imported by any application code): find every place
 * a given Prisma model is WRITTEN in one source file, by parsing it.
 *
 * ONE SCANNER, TWO CALLERS. `src/lib/attestation-write-paths.test.ts`
 * (ugcportal-15r K3) and `src/lib/curation-clearance-write-paths.test.ts`
 * (ugcportal-qfy9 K2) both make the same kind of claim about the whole
 * tree — "exactly one file writes this table" — and before this module the
 * first of them carried the matcher inline. A near-identical copy of an AST
 * matcher in a second test file is this repo's recurring defect family 4 in
 * its sibling-omission form: the two copies drift, one of them learns about
 * a new Prisma write method and the other does not, and the table whose
 * copy went stale quietly acquires a second writer.
 *
 * WHY IT PARSES RATHER THAN GREPS. A scan built on
 * `source.includes("prisma.mediaAttestation.create")` passes on a file that
 * merely MENTIONS the string — in a comment, in a log message, in a test
 * name, in a docstring like this one. Stripping comments closes half of it
 * and leaves the string-literal half open. So this walks TypeScript's own
 * AST and matches a CALL EXPRESSION whose callee is a property access
 * ending in a write method on a member named after the model. A comment is
 * not a node; a string literal is not a call.
 *
 * Prisma's NESTED-WRITE form is covered too — `data: { attestation: {
 * create: … } }` writes the same row without ever naming the model, and is
 * the shape a second author is most likely to reach for. It is a different
 * kind of node, so it gets its own matcher, and it is only looked for when
 * the caller names the relation field it would go through.
 *
 * A PLAIN MODULE RATHER THAN ONE TEST FILE EXPORTING TO ANOTHER, even
 * though only tests use it: importing a helper out of a vitest suite makes
 * vitest collect and run that suite as a side effect of the import.
 */

/** Prisma client methods that create or replace a row. */
export const PRISMA_WRITE_METHODS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "upsert",
  "update",
  "updateMany",
]);

/** Prisma's nested-write operations on a relation. */
export const PRISMA_NESTED_WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "connectOrCreate",
  "upsert",
  "update",
  "updateMany",
]);

export type PrismaModelWrite = {
  /** `tx.mediaAttestation.create` / `prisma.mediaRightsClearance.upsert` / … */
  readonly callee: string;
  /** The method name at the end of it, or the nested operation. */
  readonly method: string;
  /** The call's first argument, as source text. Empty for a nested write. */
  readonly argument: string;
  /** True when this is Prisma's nested `<relation>: { create: … }` form. */
  readonly nested: boolean;
};

export type PrismaModelWriteOptions = {
  /** The Prisma client property, e.g. `mediaRightsClearance`. */
  readonly model: string;
  /**
   * The relation field a nested write would go through, e.g. `attestation`.
   * Omitted when the model has no relation field a parent write could reach
   * it by, in which case no nested write is looked for at all — matching on
   * a name the caller did not give would report ordinary `select`
   * projections as writes.
   */
  readonly relationField?: string;
};

function sourceFileOf(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file),
  );
}

/** Every write of `model` in one file, as AST matches. */
export function prismaModelWritesIn(
  file: string,
  { model, relationField }: PrismaModelWriteOptions,
): PrismaModelWrite[] {
  const source = sourceFileOf(file);
  const writes: PrismaModelWrite[] = [];

  const visit = (node: ts.Node): void => {
    // (1) `<anything>.<model>.<writeMethod>(…)`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      PRISMA_WRITE_METHODS.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === model
    ) {
      writes.push({
        callee: node.expression.getText(source),
        method: node.expression.name.text,
        argument: node.arguments[0]?.getText(source) ?? "",
        nested: false,
      });
    }

    // (2) Prisma's nested write: an object property named after the
    // relation whose value is an object literal carrying a write
    // operation. This sets the same row without naming the model, so a
    // matcher that only looked for (1) would call it "not a write path".
    //
    // A `select: { … }` projection under the same relation name is NOT a
    // write and must not match — `MEDIA_GATE_SELECT` names every relation
    // this repo reads — which is why the inner property name has to be one
    // of Prisma's write operations rather than anything at all.
    if (
      relationField !== undefined &&
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === relationField &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        const name =
          property.name &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : "";
        if (PRISMA_NESTED_WRITE_OPERATIONS.has(name)) {
          writes.push({
            callee: `${relationField}: { ${name} }`,
            method: name,
            argument: node.initializer.getText(source),
            nested: true,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return writes;
}

/**
 * Every `const/let/var <name> = …` initialiser in a file, as source text.
 *
 * Used to prove the identifier a write names really does come from where
 * the claim says it does — "called with `session.user.id`" is a claim about
 * where a value came from, and the call site alone cannot answer it. EVERY
 * binding of the name is returned, not the nearest one, so a second
 * `const userId = body.get("userId")` added later is visible to the caller
 * even if the write itself is untouched.
 */
export function bindingsNamed(file: string, name: string): string[] {
  const source = sourceFileOf(file);
  const bindings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      bindings.push(node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}
