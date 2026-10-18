import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bindingsNamed } from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-2k2q: `bindingsNamed` against one temp-file fixture per
 * declaration shape. Each shape has its own case, and each fixture holds
 * only its own shape beside one plain initialiser, so deleting that shape's
 * branch from the visitor fails that case and no other (K2) — the plain
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

  it("reports a declaration with no initialiser, tagged, with its declaring list or clause", () => {
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
