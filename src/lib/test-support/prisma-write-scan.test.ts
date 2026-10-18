import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bindingsNamed, parameterCallSites } from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-2k2q: `bindingsNamed` against one temp-file fixture per
 * declaration shape. Each shape has its own case, and each fixture holds
 * only its own shape beside one plain initialiser, so deleting that shape's
 * branch from the visitor fails that shape's case (K2); deleting branch (3)
 * also fails `parameterCallSites`'s parity case below, which compares
 * against `bindingsNamed`'s `Parameter:` entries — the plain
 * initialiser shows the new entries arrive alongside it rather than in
 * place of it (K1). Every case asserts the WHOLE result with `toEqual`, so
 * a shape that went missing, or arrived twice, or lost its kind prefix,
 * fails.
 */

const dir = mkdtempSync(path.join(tmpdir(), "prisma-write-scan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
function fixture(contents: string): string {
  count += 1;
  const file = path.join(dir, `fixture-${count}.ts`);
  writeFileSync(file, contents, "utf8");
  return file;
}

const PLAIN = `const userId = session.user.id;\n`;

describe("bindingsNamed", () => {
  it("reports a plain const/let/var initialiser as its initialiser's text", () => {
    const file = fixture(`${PLAIN}export function f() { let userId = other(); var userId2 = 1; return userId; }\n`);

    expect(bindingsNamed(file, "userId")).toEqual(["session.user.id", "other()"]);
  });

  it("reports a destructured binding, tagged, with the declaration it comes from", () => {
    const file = fixture(
      [
        PLAIN,
        `export function a(body: any) { const { userId } = body; return userId; }`,
        `export function b(body: any) { const { other: userId } = body; return userId; }`,
        `export function c(ids: string[]) { const [userId] = ids; return userId; }`,
        `export function d({ userId }: { userId: string }) { return userId; }`,
        `export function e({ userId: other }: { userId: string }) { return other; }`,
      ].join("\n"),
    );

    expect(bindingsNamed(file, "userId")).toEqual([
      "session.user.id",
      "BindingElement: { userId } = body",
      "BindingElement: { other: userId } = body",
      "BindingElement: [userId] = ids",
      "BindingElement: { userId }: { userId: string }",
    ]);
  });

  it("reports a parameter, tagged, with the parameter's text", () => {
    const file = fixture(
      [
        PLAIN,
        `export function a(userId: string) { return userId; }`,
        `export const b = (userId) => userId;`,
      ].join("\n"),
    );

    expect(bindingsNamed(file, "userId")).toEqual([
      "session.user.id",
      "Parameter: userId: string",
      "Parameter: userId",
    ]);
  });

  it("reports a function declaration, tagged, with its header", () => {
    const file = fixture(
      [
        `export function wrapper() {`,
        `  ${PLAIN}`,
        `  return userId;`,
        `}`,
        `export function userId(): string { return "from anywhere"; }`,
      ].join("\n"),
    );

    expect(bindingsNamed(file, "userId")).toEqual([
      "session.user.id",
      "FunctionDeclaration: export function userId(): string",
    ]);
  });

  it("reports a declaration with no initialiser, tagged, with its declaring list, or the declaration itself in a catch", () => {
    const file = fixture(
      [
        PLAIN,
        `export function a() { let userId; userId = read(); return userId; }`,
        `export function b(ids: string[]) { for (const userId of ids) use(userId); }`,
        `export function c() { try { run(); } catch (userId) { use(userId); } }`,
      ].join("\n"),
    );

    expect(bindingsNamed(file, "userId")).toEqual([
      "session.user.id",
      "VariableDeclaration: let userId",
      "VariableDeclaration: const userId",
      "VariableDeclaration: userId",
    ]);
  });

  it("does not read the shapes its docstring says it does not, nor other names, nor mentions", () => {
    const file = fixture(
      [
        `import { userId } from "./elsewhere";`,
        `export class userIdHolder {}`,
        `export const f = function userId() { return 1; };`,
        `export const userIds = [1];`,
        `// const userId = body.get("userId");`,
        `export const s = "const userId = 1";`,
        `export const o = { userId: 1 };`,
        `export function g(x: { userId: string }) { return x.userId; }`,
      ].join("\n"),
    );

    expect(bindingsNamed(file, "userId")).toEqual([]);
  });
});

/**
 * ugcportal-y1tn, folded into ugcportal-2k2q: `parameterCallSites` against
 * one temp-file fixture per behaviour. Each fixture is the same shape as
 * POST /api/media — a handler binding `userId` from the session and passing
 * it to a non-exported helper whose parameter carries it — changed in one
 * way, and each case asserts the whole result with `toEqual`.
 */
describe("parameterCallSites", () => {
  const helper = `function handle(request: unknown, userId: string) { return userId; }`;
  const handler = (call: string): string =>
    [
      `export async function POST(request: unknown, body: any) {`,
      `  const session = await auth();`,
      `  const userId = session?.user?.id;`,
      `  const ownerId = body.ownerId;`,
      `  let later = session?.user?.id;`,
      `  return ${call};`,
      `}`,
    ].join("\n");

  it("follows a parameter to its one call and resolves a session-bound const there", () => {
    const file = fixture([handler("handle(request, userId)"), helper].join("\n"));

    expect(parameterCallSites(file, "userId")).toEqual([
      {
        parameter: "Parameter: userId: string",
        function: "handle",
        position: 1,
        calls: [{ line: 6, argument: "userId", binding: "session?.user?.id", reason: null }],
        problems: [],
      },
    ]);
  });

  it("reports a different identifier at that position as that identifier's own binding", () => {
    const file = fixture([handler("handle(request, ownerId)"), helper].join("\n"));

    expect(parameterCallSites(file, "userId")[0].calls).toEqual([
      { line: 6, argument: "ownerId", binding: "body.ownerId", reason: null },
    ]);
  });

  it("reports every call, so a second call passing something else is visible", () => {
    const file = fixture(
      [
        handler("handle(request, userId)"),
        `export function admin(body: any) { const actor = body.actor; return handle(body, actor); }`,
        helper,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId")[0].calls).toEqual([
      { line: 6, argument: "userId", binding: "session?.user?.id", reason: null },
      { line: 8, argument: "actor", binding: "body.actor", reason: null },
    ]);
  });

  it("reports a function with no call at all, rather than an empty list that passes vacuously", () => {
    const file = fixture([handler("null"), helper].join("\n"));

    expect(parameterCallSites(file, "userId")).toEqual([
      {
        parameter: "Parameter: userId: string",
        function: "handle",
        position: 1,
        calls: [],
        problems: ["handle has no call in this file, so nothing supplies userId"],
      },
    ]);
  });

  it("leaves unresolved anything that is not a bare identifier bound by a const", () => {
    const file = fixture(
      [
        handler("handle(request, userId)"),
        `export function others(body: any, param: string) {`,
        `  handle(body, body.ownerId);`,
        `  handle(body, "user-1");`,
        `  let later = "x";`,
        `  handle(body, later);`,
        `  handle(body, param);`,
        `  handle(body);`,
        `}`,
        helper,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId")[0].calls).toEqual([
      { line: 6, argument: "userId", binding: "session?.user?.id", reason: null },
      { line: 9, argument: "body.ownerId", binding: null, reason: "not an identifier: PropertyAccessExpression" },
      { line: 10, argument: '"user-1"', binding: null, reason: "not an identifier: StringLiteral" },
      { line: 12, argument: "later", binding: null, reason: "declared with let or var, which can be reassigned" },
      { line: 13, argument: "param", binding: null, reason: "declared as Parameter" },
      { line: 14, argument: "", binding: null, reason: "no argument at that position" },
    ]);
  });

  it("reports the ways a function can be called with arguments this scan never reads", () => {
    const file = fixture(
      [
        handler("handle(request, userId)"),
        `export const asValue = [1].map(handle as any);`,
        `export const spread = (args: [unknown, string]) => handle(...args);`,
        `export { handle };`,
        `const table = { handle };`,
        `export const viaTable = (body: any) => table.handle(body, body.actor);`,
        helper,
        `export function exported(userId: string) { return userId; }`,
        `exported("x");`,
        `export const arrow = (userId: string) => userId;`,
        `function rest(...userId: string[]) { return userId; }`,
        `rest("x");`,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId").map((link) => link.problems)).toEqual([
      [
        "handle referenced other than as a call's callee at line 8: handle as any",
        "handle called with a spread argument at line 9",
        "handle referenced other than as a call's callee at line 10: handle",
        "handle referenced other than as a call's callee at line 11: handle",
      ],
      ["exported is exported, so its callers are not all in this file"],
      ["enclosing ArrowFunction has no declared name the scan can follow"],
      ["a rest parameter"],
    ]);
  });

  it("reports a default initialiser, a second source of the value whenever a call passes undefined", () => {
    // ugcportal-pm4t: the call passes the session's `userId`, which is
    // `string | undefined`; when it is undefined the parameter takes
    // `body.actor` instead, and no call site shows that.
    const file = fixture(
      [
        handler("handle(body, userId)"),
        `function handle(body: { actor: string }, userId: string = body.actor) { return userId; }`,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId")).toEqual([
      {
        parameter: "Parameter: userId: string = body.actor",
        function: "handle",
        position: 1,
        calls: [{ line: 6, argument: "userId", binding: "session?.user?.id", reason: null }],
        problems: [
          "a default initialiser at line 8: body.actor, which supplies userId whenever a call passes undefined",
        ],
      },
    ]);
  });

  it("skips a leading `this` parameter, which takes no argument, when reading a call's argument", () => {
    const file = fixture(
      [
        handler("handle(ownerId, userId)"),
        `function handle(this: void, userId: string, ...rest: unknown[]) { return userId; }`,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId")).toEqual([
      {
        parameter: "Parameter: userId: string",
        function: "handle",
        position: 0,
        calls: [{ line: 6, argument: "ownerId", binding: "body.ownerId", reason: null }],
        problems: [],
      },
    ]);
  });

  it("counts calls by the symbol they resolve to, not by name, so a shadowing local function is not a call", () => {
    const file = fixture(
      [
        handler("handle(request, userId)"),
        `export function elsewhere(body: any) {`,
        `  function handle(_request: unknown, _actor: string) { return _actor; }`,
        `  return handle(body, body.actor);`,
        `}`,
        helper,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId")).toEqual([
      {
        parameter: "Parameter: userId: string",
        function: "handle",
        position: 1,
        calls: [{ line: 6, argument: "userId", binding: "session?.user?.id", reason: null }],
        problems: [],
      },
    ]);
  });

  it("returns exactly the parameters bindingsNamed reports, with the same text and order", () => {
    const file = fixture(
      [
        handler("handle(request, userId)"),
        helper,
        `export const arrow = (userId) => userId;`,
        `export function destructured({ userId }: { userId: string }) { return userId; }`,
      ].join("\n"),
    );

    expect(parameterCallSites(file, "userId").map((link) => link.parameter)).toEqual(
      bindingsNamed(file, "userId").filter((binding) => binding.startsWith("Parameter: ")),
    );
    expect(parameterCallSites(file, "userId").map((link) => link.parameter)).toEqual([
      "Parameter: userId: string",
      "Parameter: userId",
    ]);
  });
});
