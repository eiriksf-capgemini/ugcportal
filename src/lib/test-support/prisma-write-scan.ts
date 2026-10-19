import ts from "typescript";

import { sourceFileOf } from "@/lib/design/scan-source";

/**
 * Test-only helper (not imported by any application code): find every place
 * a given Prisma model is WRITTEN in one source file, by parsing it. Also
 * exports bindingsNamed and parameterCallSites for similar AST-based analysis.
 *
 * MULTIPLE CALLERS OF prismaModelWritesIn. Run `git grep -n prismaModelWritesIn -- src scripts`
 * to find them all. The matcher was first written inline in
 * attestation-write-paths.test.ts and moved here when this module was
 * created (#199); every later guard imports it. A near-identical copy of an AST
 * matcher in separate test files is this repo's recurring defect family 4 in
 * its sibling-omission form: the two copies drift, one of them learns about
 * a new Prisma write method and the other does not, and the table whose
 * copy went stale quietly acquires a second writer. This module centralizes
 * the claim each test makes — "exactly one file writes this table" — and
 * removes the second copy that could drift.
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
 *     reported as `VariableDeclaration: <the declaring list>` (`let userId`,
 *     `const userId`), or, for a `catch` clause, which has no list, as
 *     `VariableDeclaration: <the declaration itself>` (`userId`).
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
    // `for (const <name> of …)`, `catch (<name>)` — the declaring list's
    // text, or the declaration's own for a `catch`, which has no list.
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

/** One call of a parameter's enclosing function, at that parameter's position. */
export type ParameterCallSite = {
  /** 1-based line of the call expression. */
  readonly line: number;
  /** The argument at the parameter's position, as source text; `""` when the call passes none. */
  readonly argument: string;
  /**
   * The initialiser of the `const` the argument names, as source text — set
   * only when the argument is a bare identifier whose declaration, resolved
   * by TypeScript's checker at the call, is a plain `const <name> = …` in
   * this file. `null` for every other argument (a property access, a
   * literal, a call, a `let`/`var`, a parameter, a destructured binding, an
   * import), with `reason` saying which.
   */
  readonly binding: string | null;
  readonly reason: string | null;
};

/** A parameter named `name`, and every call that can supply it. */
export type ParameterLink = {
  /** The parameter exactly as `bindingsNamed` reports it, e.g. `Parameter: userId: string`. */
  readonly parameter: string;
  /** The enclosing function's declared name, or `null` when it has none the scan can follow. */
  readonly function: string | null;
  /**
   * The 0-based ARGUMENT position a call supplies the parameter at: its index
   * in the parameter list, less one when the list starts with a TypeScript
   * `this` parameter, which takes no argument.
   */
  readonly position: number;
  /** Every call of that function in this file, in source order. */
  readonly calls: readonly ParameterCallSite[];
  /**
   * Why `calls` might not be every way the parameter gets its value.
   * Empty only when the function is a named, non-exported `function`
   * declaration, the parameter is not a rest parameter and has no default
   * initialiser (a second source of its value whenever a call passes
   * `undefined`), the function is referenced in this file ONLY as the
   * callee of a call, there is at least one such call, and no call spreads
   * an argument at or before the parameter's position.
   */
  readonly problems: readonly string[];
};

/**
 * ugcportal-2k2q fix round 1 (ugcportal-y1tn): for every PARAMETER named
 * `name` in a file — exactly the parameters `bindingsNamed` reports as
 * `Parameter: …`, same predicate, same text, same order — every call that
 * can supply its value, and what each call passes at that position.
 *
 * WHY THIS EXISTS. `bindingsNamed` reports a parameter as its declaration,
 * `Parameter: userId: string`, and a declaration cannot say where the value
 * came from: that is decided at the call sites. A caller asserting "this
 * name is bound from the session and from nothing else" therefore has two
 * options for a parameter — reject it, or follow it to every call and check
 * what each one passes. This does the following; the verdict stays with the
 * caller.
 *
 * WHAT COUNTS AS FOLLOWED. The enclosing function must be a named
 * `function` declaration that is not exported (an exported one has callers
 * this file cannot see), and every reference to it in the file — resolved
 * by TypeScript's checker over a single-file program, not matched by name —
 * must be the callee of a call. A reference that is anything else (passed
 * as a value, `.call`/`.bind`, `new`, re-exported) is a way to call it with
 * arguments this scan never reads, so it is reported in `problems` with its
 * line. So is a function with no call at all: an empty `calls` would make
 * "every call passes the session's id" vacuously true. So is an arrow
 * function, a function expression or a method, whose callers cannot be
 * found by name.
 *
 * WHAT COUNTS AS RESOLVED. Only a bare identifier argument whose declaration
 * is a `const` with an initialiser, in this file; `binding` is that
 * initialiser's text. A `let` or `var` can be reassigned between the
 * declaration and the call, and nothing here reads assignments, so neither
 * resolves. Nor does a property access, a literal or a call: the caller's
 * check reads a binding's initialiser, and an expression has none.
 */
export function parameterCallSites(file: string, name: string): ParameterLink[] {
  const program = ts.createProgram({
    rootNames: [file],
    options: { noLib: true, noResolve: true, types: [], allowJs: true, jsx: ts.JsxEmit.Preserve },
  });
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`parameterCallSites: could not parse ${file}`);
  const checker = program.getTypeChecker();
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  // Every identifier in the file, with the symbol it refers to.
  const references: { id: ts.Identifier; symbol: ts.Symbol | undefined }[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      let symbol: ts.Symbol | undefined;
      if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
        symbol = checker.getShorthandAssignmentValueSymbol(node.parent);
      } else if (ts.isExportSpecifier(node.parent)) {
        symbol = checker.getExportSpecifierLocalTargetSymbol(node.parent);
      } else {
        symbol = checker.getSymbolAtLocation(node);
      }
      references.push({ id: node, symbol });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const resolveArgument = (argument: ts.Expression | undefined): Pick<ParameterCallSite, "binding" | "reason"> => {
    if (argument === undefined) return { binding: null, reason: "no argument at that position" };
    if (!ts.isIdentifier(argument)) {
      return { binding: null, reason: `not an identifier: ${ts.SyntaxKind[argument.kind]}` };
    }
    const declarations = checker.getSymbolAtLocation(argument)?.declarations ?? [];
    if (declarations.length !== 1) {
      return { binding: null, reason: `${declarations.length} declarations resolved in this file` };
    }
    const [declaration] = declarations;
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined
    ) {
      return { binding: null, reason: `declared as ${ts.SyntaxKind[declaration.kind]}` };
    }
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return { binding: null, reason: "declared with let or var, which can be reassigned" };
    }
    return { binding: declaration.initializer.getText(source), reason: null };
  };

  const links: ParameterLink[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const owner = node.parent;
      // A leading TypeScript `this` parameter is erased at compile time and
      // takes no call argument, so it does not count towards the position a
      // call's arguments are read at (`f(this: void, userId)` is called as
      // `f(x)`, and `x` is `userId`).
      const first = owner.parameters[0];
      const skipsThis =
        first !== undefined && ts.isIdentifier(first.name) && first.name.text === "this" ? 1 : 0;
      const position = owner.parameters.indexOf(node) - skipsThis;
      const problems: string[] = [];
      const calls: ParameterCallSite[] = [];
      let functionName: string | null = null;

      if (node.dotDotDotToken !== undefined) problems.push("a rest parameter");
      // A default is a second source of the value, beside the argument: it
      // applies whenever a call passes `undefined` at that position, which
      // the call's argument text does not show (ugcportal-pm4t).
      if (node.initializer !== undefined) {
        problems.push(
          `a default initialiser at line ${lineOf(node.initializer)}: ${node.initializer.getText(source)}, which supplies ${name} whenever a call passes undefined`,
        );
      }
      if (!ts.isFunctionDeclaration(owner) || owner.name === undefined) {
        problems.push(
          `enclosing ${ts.SyntaxKind[owner.kind]} has no declared name the scan can follow`,
        );
      } else {
        functionName = owner.name.text;
        const modifiers = ts.canHaveModifiers(owner) ? ts.getModifiers(owner) ?? [] : [];
        if (modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          problems.push(`${functionName} is exported, so its callers are not all in this file`);
        }
        const target = checker.getSymbolAtLocation(owner.name);
        for (const { id, symbol } of references) {
          if (id === owner.name || target === undefined || symbol !== target) continue;
          const call = id.parent;
          if (!ts.isCallExpression(call) || call.expression !== id) {
            problems.push(
              `${functionName} referenced other than as a call's callee at line ${lineOf(id)}: ${id.parent.getText(source)}`,
            );
            continue;
          }
          const spread = call.arguments.findIndex((a) => ts.isSpreadElement(a));
          if (spread !== -1 && spread <= position) {
            problems.push(`${functionName} called with a spread argument at line ${lineOf(call)}`);
          }
          const argument = call.arguments[position];
          calls.push({
            line: lineOf(call),
            argument: argument?.getText(source) ?? "",
            ...resolveArgument(argument),
          });
        }
        if (calls.length === 0) {
          problems.push(`${functionName} has no call in this file, so nothing supplies ${name}`);
        }
      }

      links.push({
        parameter: `${ts.SyntaxKind[node.kind]}: ${node.getText(source)}`,
        function: functionName,
        position,
        calls,
        problems,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return links;
}
