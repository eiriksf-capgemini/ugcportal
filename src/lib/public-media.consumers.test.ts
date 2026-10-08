import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isTestFile, scriptKindFor, walkSourceFiles } from "@/lib/design/scan-source";

/**
 * ugcportal-3ae K3, as a claim about the WHOLE TREE: every anonymous reader
 * of `PUBLIC_MEDIA_SCOPE` is covered by a test that proves the rights filter
 * actually holds for it.
 *
 * WHY THIS FILE EXISTS AT ALL, stated as the failure rather than the rule.
 * The bead's own first draft of K3 named THREE anonymous surfaces. There are
 * five, served by four query sites, and the two the draft missed were
 * `src/app/sitemap.ts` — which hands item URLs to search engines — and
 * `src/lib/media-item.ts`. An implementer writing exactly the three tests
 * that draft named would have shipped an uncleared photograph of an
 * identifiable person into Google's index and passed review.
 *
 * So the list is not maintained by reading the bead. It is derived from the
 * source, by the scan below, and compared against an explicit map. A sixth
 * reader added next year fails this file by existing, and the only way to
 * make it pass is to name the test that covers it.
 *
 * WHAT "COVERED" MEANS, and why it is more than a filename. Each covering
 * test file must contain a `describe` or `it` whose TITLE carries this
 * bead's id — a title, read off the AST, not a comment and not a string
 * anywhere in the file. That is a weak proof on its own (a title is
 * cheap), and it is deliberately paired with the strong one next door:
 * src/lib/publishability.scope-agreement.test.ts runs the predicate and the
 * query filter over the same rows in a real database and compares them row
 * by row. This file answers "is every reader reached", that one answers
 * "does the filter say the right thing".
 *
 * `@/lib/public-media` is imported for the structural assertions at the
 * bottom; mocking auth is the same module-graph workaround every other
 * reader of that module's tests performs.
 */

vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the anonymous scope must not consult the session");
  },
}));

const { PUBLIC_MEDIA_SCOPE, PUBLIC_MEDIA_COLUMN_SCOPE } = await import(
  "@/lib/public-media"
);
const { PUBLIC_MEDIA_RIGHTS_SCOPE } = await import("@/lib/publishability");

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCOPE = "PUBLIC_MEDIA_SCOPE";

/**
 * Every non-test file that REFERENCES `PUBLIC_MEDIA_SCOPE` as an
 * identifier, relative to `src/` with POSIX separators.
 *
 * AN AST WALK, NOT A GREP, for the reason the attestation write-path scan
 * next door gives at length: four of this repo's own files mention this
 * constant only in prose, and a `source.includes(…)` scan would report all
 * of them — at which point the map below becomes an allowlist of files that
 * talk about the scope, and stops meaning anything about files that USE it.
 * A comment is not a node and a string literal is not an identifier.
 *
 * Exported so the fixture cases at the bottom can drive it over a temp
 * directory: the scanner is tested, not merely used.
 */
export function scanScopeConsumers(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => referencesScope(file))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

function referencesScope(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file),
  );

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // A property named `PUBLIC_MEDIA_SCOPE` on some unrelated object is not
    // a reference to this constant; an identifier in expression position is.
    if (
      ts.isIdentifier(node) &&
      node.text === SCOPE &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Every reader, and the test file that proves the rights filter reaches the
 * surface it serves.
 *
 * The four query sites and the five surfaces behind them, re-derived from
 * the source at 168ebc9 rather than copied from the bead:
 *
 *   lib/public-media.ts   `listPublicMedia` — TWO surfaces, one query: the
 *                         paginated GET /api/public/media, and the
 *                         server-rendered home page (src/app/page.tsx).
 *                         Both are asserted, separately, in page.test.tsx:
 *                         a fix that reaches the rendered HTML and not the
 *                         raw JSON is a leak to a direct API consumer, and
 *                         this repo has shipped that shape before.
 *   lib/portfolio.ts      `listPortfolioPieces` — /portfolio.
 *   app/sitemap.ts        the item entries in /sitemap.xml.
 *   lib/media-item.ts     `getPublicMediaItem` — /media/[previewId].
 */
const SCOPE_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  "lib/public-media.ts": ["app/page.test.tsx"],
  "lib/portfolio.ts": ["lib/portfolio.test.ts"],
  "app/sitemap.ts": ["app/sitemap.test.ts"],
  "lib/media-item.ts": ["lib/media-item.test.ts"],
};

/** The bead id a covering test's own title has to carry. */
const COVERAGE_MARKER = "ugcportal-3ae";

/** Titles of every `describe`/`it` in a file, read off the AST. */
export function suiteTitlesIn(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file),
  );

  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression)
          ? node.expression.expression.text
          : null;
      const [first] = node.arguments;
      if (
        (callee === "describe" || callee === "it" || callee === "test") &&
        first &&
        ts.isStringLiteralLike(first)
      ) {
        titles.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

/**
 * ONE WALK OF `src/`, shared by every case below — required by
 * scripts/tree-walk-timeout-guard.test.mjs and for its reason
 * (ugcportal-9faa): a per-test whole-tree walk is what pushes a suite past
 * vitest's default timeout under load, and the failure then looks like a
 * flake rather than a cost somebody chose.
 */
let cachedConsumers: string[] | undefined;

function consumers(): string[] {
  return (cachedConsumers ??= scanScopeConsumers(SRC_ROOT));
}

describe("every anonymous reader of PUBLIC_MEDIA_SCOPE is covered (ugcportal-3ae K3)", () => {
  it("finds readers at all", () => {
    // Guards every assertion below against passing because the walker or
    // the matcher broke and came back with nothing.
    expect(consumers().length).toBeGreaterThan(0);
  });

  it("finds exactly the readers the map names — a new one fails here", () => {
    /*
     * THIS is the guard the bead asks for. The map below it is the only
     * place a reader may be declared covered, and the only way to add one
     * is to say which test covers it. Deleting a reader fails too, which is
     * the cheaper direction to notice.
     */
    expect(consumers()).toEqual(Object.keys(SCOPE_CONSUMERS).sort());
  });

  for (const [consumer, coveringTests] of Object.entries(SCOPE_CONSUMERS)) {
    it(`${consumer} is covered by a test naming this bead`, () => {
      expect(coveringTests.length).toBeGreaterThan(0);
      for (const relative of coveringTests) {
        const file = path.join(SRC_ROOT, relative);
        const titles = suiteTitlesIn(file);
        // Non-empty first: a path typo, or a file that stopped being a
        // test, would otherwise read as "no title matched" either way.
        expect(titles.length, relative).toBeGreaterThan(0);
        expect(
          titles.some((title) => title.includes(COVERAGE_MARKER)),
          `${relative} has no describe/it naming ${COVERAGE_MARKER}`,
        ).toBe(true);
      }
    });
  }
});

describe("the shape of the scope itself", () => {
  it("is exactly the column half plus the rights half", () => {
    expect(Object.keys(PUBLIC_MEDIA_SCOPE).sort()).toEqual(
      [
        ...Object.keys(PUBLIC_MEDIA_COLUMN_SCOPE),
        ...Object.keys(PUBLIC_MEDIA_RIGHTS_SCOPE),
      ].sort(),
    );
  });

  it("keeps no top-level OR, which `listMedia` would silently overwrite", () => {
    /*
     * `listMedia` merges the scope with its keyset predicate as
     * `{ ...scope, ...keyset }`, and `keysetAfter` returns `{ OR: [...] }`.
     * A top-level `OR` on the scope would therefore survive page one and
     * vanish from page two onwards — the rights filter dropped for every
     * paginated request, with the first page looking perfectly correct.
     * The disjunction lives nested inside `AND` for exactly this reason.
     */
    expect(PUBLIC_MEDIA_SCOPE).not.toHaveProperty("OR");
    expect(PUBLIC_MEDIA_RIGHTS_SCOPE).not.toHaveProperty("OR");
  });
});

describe("the scanner itself, against a fixture tree", () => {
  const roots: string[] = [];

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "scope-consumers-"));
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

  it("FAILS on a sixth reader — the mutation this guard exists for", () => {
    /*
     * Run, not described. A scan that could not see a newly added reader
     * would make the enumeration above decoration, and the sitemap is the
     * proof that "somebody will remember" is not a control.
     */
    const root = tree({
      "lib/public-media.ts": `export const ${SCOPE} = {};`,
      "app/api/public/feed-v2/route.ts": [
        `import { ${SCOPE} } from "@/lib/public-media";`,
        `export const GET = () => prisma.media.findMany({ where: ${SCOPE} });`,
      ].join("\n"),
    });

    expect(scanScopeConsumers(root)).toEqual([
      "app/api/public/feed-v2/route.ts",
      "lib/public-media.ts",
    ]);
  });

  it("does NOT report a file that only mentions the constant in prose or a string", () => {
    // Four files in this repo do exactly this today. A text scan would
    // have had to allowlist each of them, and an allowlist is where a scan
    // like this stops meaning what it says.
    const root = tree({
      "lib/prose.ts": [
        `// The scope is ${SCOPE}; see src/lib/public-media.ts.`,
        `/* A reader that dropped ${SCOPE} would leak. */`,
        `export const NOTE = "${SCOPE}";`,
      ].join("\n"),
      "lib/property.ts": `export const x = config.${SCOPE};`,
      "lib/other.test.ts": `import { ${SCOPE} } from "@/lib/public-media";`,
    });

    expect(scanScopeConsumers(root)).toEqual([]);
  });

  it("reads suite titles from calls, not from comments or free strings", () => {
    const root = tree({
      "a.test.ts": [
        'describe("outer ugcportal-3ae", () => {',
        '  it("inner", () => {});',
        "});",
        '// describe("commented ugcportal-3ae", () => {});',
        'const NOT_A_TITLE = "ugcportal-3ae";',
      ].join("\n"),
    });

    expect(suiteTitlesIn(path.join(root, "a.test.ts"))).toEqual([
      "outer ugcportal-3ae",
      "inner",
    ]);
  });
});
