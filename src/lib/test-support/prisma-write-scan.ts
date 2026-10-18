import ts from "typescript";

import { sourceFileOf } from "@/lib/design/scan-source";

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
 * Every declaration of `name` in a file, in exactly these five shapes — the
 * `ts.is*` tests in the visitor below, one branch each:
 *
 *  1. a plain `const/let/var <name> = …` with an initialiser
 *     (`ts.isVariableDeclaration`, identifier name, initialiser present) —
 *     reported as the initialiser's source text, e.g. `access.userId`;
 *  2. a destructured binding, `const { <name> } = …`,
 *     `const { other: <name> } = …`, `const [<name>] = …`, or the same
 *     pattern in a parameter (`ts.isBindingElement`) — reported as
 *     `BindingElement: <the enclosing declaration or parameter>`, e.g.
 *     `BindingElement: { userId } = body`;
 *  3. a parameter, `function f(<name>) {}` / `(<name>) => …`
 *     (`ts.isParameter`, identifier name) — reported as
 *     `Parameter: <the parameter>`, e.g. `Parameter: userId: string`;
 *  4. a function declaration, `function <name>() {}`
 *     (`ts.isFunctionDeclaration`) — reported as
 *     `FunctionDeclaration: <its header up to the body>`;
 *  5. a variable declared with no initialiser — `let <name>;`,
 *     `for (const <name> of …)`, `catch (<name>)`
 *     (`ts.isVariableDeclaration`, identifier name, no initialiser) —
 *     reported as `VariableDeclaration: <the declaring list or clause>`.
 *
 * Shapes 2-5 carry their kind as a prefix so none of them reads as the plain
 * initialiser a caller expects: a caller asserting
 * `toBe("access.userId")` on every entry fails on any of them. Every
 * declaration in those five shapes is returned, not the nearest one, so a
 * second `const userId = body.get("userId")` — or `const { userId } = body`
 * — added later is visible to the caller even if the write itself is
 * untouched.
 *
 * NOT read: imports (`import { <name> }`), class, enum and namespace
 * declarations, and the name of a function or class EXPRESSION. A caller
 * that needs those has to look for them itself.
 *
 * Used to prove the identifier a write names really does come from where
 * the claim says it does — "called with `session.user.id`" is a claim about
 * where a value came from, and the call site alone cannot answer it.
 */
export function bindingsNamed(file: string, name: string): string[] {
  const source = sourceFileOf(file);
  const bindings: string[] = [];
  const tagged = (node: ts.Node, declaring: string): void => {
    bindings.push(`${ts.SyntaxKind[node.kind]}: ${declaring}`);
  };
  const visit = (node: ts.Node): void => {
    // (1) `const/let/var <name> = …`
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      bindings.push(node.initializer.getText(source));
    }

    // (2) `const { <name> } = …`, `const { other: <name> } = …`,
    // `const [<name>] = …`, and the same patterns in a parameter.
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      let declaring: ts.Node = node;
      while (
        !ts.isVariableDeclaration(declaring) &&
        !ts.isParameter(declaring) &&
        declaring.parent !== undefined
      ) {
        declaring = declaring.parent;
      }
      tagged(node, declaring.getText(source));
    }

    // (3) a parameter named `<name>`.
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      tagged(node, node.getText(source));
    }

    // (4) `function <name>() {}`.
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === name
    ) {
      const text = node.getText(source);
      const header = node.body
        ? text.slice(0, node.body.getStart(source) - node.getStart(source)).trimEnd()
        : text;
      tagged(node, header);
    }

    // (5) a variable with no initialiser: `let <name>;`,
    // `for (const <name> of …)`, `catch (<name>)`.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      !node.initializer
    ) {
      const declaring = ts.isVariableDeclarationList(node.parent)
        ? node.parent
        : node;
      tagged(node, declaring.getText(source));
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}
