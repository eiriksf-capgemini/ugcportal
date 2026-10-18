import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ugcportal-qf9v K3: a mutating route handler under src/app/api that does not
 * call `isSameOriginRequest`, now or when the next one is added, must never
 * happen. src/lib/origin.ts calls that check the second lock; without this
 * scan it covered the three admin routes and the ten owner-facing ones relied
 * on the SameSite cookie alone.
 *
 * The enumeration comes from the file system (every route.ts under
 * src/app/api) and the handlers from each file's own exports, so a new route
 * or a new method on an old one is held to the rule without anyone adding it
 * to a list. The rule is per HANDLER, not per file: a file that locks its
 * POST and forgets its DELETE is named for the DELETE. A mutating export in a
 * shape this scan cannot follow (`export const POST = ...`, a re-export, a
 * destructured `export const { GET, POST } = ...`, `export * from "..."`) is
 * reported too, since "cannot analyse" must not read as "passes". A route that
 * is exempt is named in UNANALYSABLE_EXEMPT with its reason, in this file.
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * Routes whose unanalysable mutating export is accepted, keyed by repo-relative
 * path. The reason is part of the entry so an exemption cannot be silent.
 */
const UNANALYSABLE_EXEMPT: Record<string, string> = {
  "src/app/api/auth/[...nextauth]/route.ts":
    "Auth.js handlers (`export const { GET, POST } = handlers`) carry their own CSRF token",
};

const API_ROOT = resolve(__dirname, "..", "app", "api");

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...routeFiles(full));
    } else if (entry.name === "route.ts") {
      found.push(full);
    }
  }
  return found.sort();
}

function callsLock(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "isSameOriginRequest"
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Every mutating export of one source file, with whether it locks. */
export function mutatingHandlers(
  name: string,
  source: string,
): { handler: string; locked: boolean }[] {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out: { handler: string; locked: boolean }[] = [];
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of ast.statements) {
    if (ts.isFunctionDeclaration(stmt) && exported(stmt) && stmt.name) {
      if (MUTATING.has(stmt.name.text)) {
        out.push({ handler: stmt.name.text, locked: callsLock(stmt) });
      }
    } else if (ts.isVariableStatement(stmt) && exported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && MUTATING.has(d.name.text)) {
          // Not a function declaration: not followed, so reported.
          out.push({ handler: `${d.name.text} (unanalysable form)`, locked: false });
        } else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          // `export const { GET, POST } = handlers`: names bound from elsewhere.
          for (const el of d.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && MUTATING.has(el.name.text)) {
              out.push({ handler: `${el.name.text} (unanalysable form)`, locked: false });
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.exportClause) {
      // `export * from "..."`: which names it brings in is not followed.
      out.push({ handler: "export * (unanalysable form)", locked: false });
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const e of stmt.exportClause.elements) {
          if (MUTATING.has(e.name.text)) {
            out.push({ handler: `${e.name.text} (unanalysable form)`, locked: false });
          }
        }
      }
    }
  }
  return out;
}

function unlocked(
  files: { name: string; source: string }[],
  exempt: Record<string, string> = {},
): string[] {
  return files.flatMap(({ name, source }) =>
    mutatingHandlers(name, source)
      .filter((h) => !h.locked && !(h.handler.endsWith("(unanalysable form)") && name in exempt))
      .map((h) => `${h.handler} in ${name}`),
  );
}

describe("every mutating route handler applies the same-origin second lock (ugcportal-qf9v K3)", () => {
  const files = routeFiles(API_ROOT).map((full) => ({
    name: relative(resolve(API_ROOT, "..", "..", ".."), full).split(sep).join("/"),
    source: readFileSync(full, "utf8"),
  }));

  it("examines the route files it should (guards against matching nothing)", () => {
    // 10 route.ts files held mutating handlers when this was written; the
    // lower bound only has to prove the walk found the tree, not pin a count.
    expect(files.length).toBeGreaterThanOrEqual(13);
    const handlers = files.flatMap((f) => mutatingHandlers(f.name, f.source));
    expect(handlers.length).toBeGreaterThanOrEqual(13);
  });

  it("names no handler that lacks isSameOriginRequest", () => {
    expect(unlocked(files, UNANALYSABLE_EXEMPT)).toEqual([]);
  });

  it("keeps every exemption pointing at a route that still has an unanalysable export", () => {
    for (const name of Object.keys(UNANALYSABLE_EXEMPT)) {
      const f = files.find((x) => x.name === name);
      expect(f, name).toBeDefined();
      expect(unlocked([f!]), name).not.toEqual([]);
    }
  });

  describe("fixtures: the scan fails the way it should", () => {
    it("names the handler, not the file, when only one of two is locked", () => {
      const source = `
        import { isSameOriginRequest } from "@/lib/origin";
        export async function POST(request: Request) {
          if (!isSameOriginRequest(request)) return new Response(null, { status: 403 });
          return new Response(null);
        }
        export async function DELETE(request: Request) { return new Response(null); }
        export async function GET() { return new Response(null); }
      `;
      expect(unlocked([{ name: "fixture/route.ts", source }])).toEqual([
        "DELETE in fixture/route.ts",
      ]);
    });

    it("does not count an import or a mention as a call", () => {
      const source = `
        import { isSameOriginRequest } from "@/lib/origin";
        // isSameOriginRequest(request)
        export async function PUT() { return new Response(null); }
      `;
      expect(unlocked([{ name: "fixture/route.ts", source }])).toEqual([
        "PUT in fixture/route.ts",
      ]);
    });

    it("reports a mutating export it cannot follow", () => {
      const source = `
        export const PATCH = async () => new Response(null);
        export { handler as POST };
      `;
      expect(unlocked([{ name: "fixture/route.ts", source }])).toEqual([
        "PATCH (unanalysable form) in fixture/route.ts",
        "POST (unanalysable form) in fixture/route.ts",
      ]);
    });

    it("reports a destructured export and a star export", () => {
      const source = `
        export const { GET, POST } = handlers;
        export * from "./other";
      `;
      expect(unlocked([{ name: "fixture/route.ts", source }])).toEqual([
        "POST (unanalysable form) in fixture/route.ts",
        "export * (unanalysable form) in fixture/route.ts",
      ]);
    });

    it("lets a named exemption pass an unanalysable export, and only that file", () => {
      const source = `export const { GET, POST } = handlers;`;
      const exempt = { "fixture/route.ts": "carries its own CSRF token" };
      expect(unlocked([{ name: "fixture/route.ts", source }], exempt)).toEqual([]);
      expect(unlocked([{ name: "fixture/other.ts", source }], exempt)).toEqual([
        "POST (unanalysable form) in fixture/other.ts",
      ]);
    });
  });
});
