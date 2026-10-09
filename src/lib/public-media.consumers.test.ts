import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTestFile,
  sourceFileOf,
  walkSourceFiles,
} from "@/lib/design/scan-source";

/**
 * ugcportal-3ae K3, as a claim about the WHOLE TREE: every anonymous reader
 * of `PUBLIC_MEDIA_SCOPE` is covered by a test that proves the rights filter
 * actually holds for it.
 *
 * WHY THIS FILE EXISTS AT ALL, stated as the failure rather than the rule.
 * The bead's own first draft of K3 named THREE anonymous surfaces. There
 * were five at the time, served by four query sites, and the two the draft
 * missed were
 * `src/app/sitemap.ts` — which hands item URLs to search engines — and
 * `src/lib/media-item.ts`. An implementer writing exactly the three tests
 * that draft named would have shipped an uncleared photograph of an
 * identifiable person into Google's index and passed review.
 *
 * So the list is not maintained by reading the bead. It is derived from the
 * source, by the scan below, and compared against an explicit map. A NEW
 * reader that REACHES FOR THE SCOPE CONSTANT — by named import or by
 * namespace import, both proved against a fixture at the bottom of this
 * file — fails this file by existing, and the only way to make it pass is
 * to name the tests that cover it.
 *
 * WHAT IT DOES NOT SEE, stated here rather than left for somebody to find
 * out, AND WHAT THAT HAS ALREADY COST (ugcportal-3ae, ugcportal-nffp).
 * This scan answers "who uses the constant", so it is blind to a reader
 * that never mentions it: an
 * anonymous query that hand-writes `where: { publishedAt: { not: null } }`
 * instead of spreading the scope is not in the set the map is compared
 * against, and `toEqual` therefore still passes. That is not theoretical:
 * GET /api/media/preview/[previewId] — the route that serves the actual
 * bytes — was exactly that shape until ugcportal-nffp, and so sat outside
 * this map while serving uncleared and lapsed photographs at a URL the
 * sitemap had published. It spreads the scope now and is in the map below;
 * the scanner gap itself is unchanged and is still 7egi's. Nothing else
 * catches that shape either — `MediaAnonymousScope` in
 * src/lib/media-listing.ts only binds a query that routes through
 * `listMedia`. That gap is real and is filed as ugcportal-7egi; it is NOT
 * closed by this file, and no comment here should be read as saying it is.
 *
 * WHAT "COVERED" MEANS, and why it is more than a filename. Each covering
 * test file must contain a `describe` or `it` whose TITLE carries the bead
 * id for the question it answers — a title, read off the AST, not a
 * comment and not a string anywhere in the file. SINCE ugcportal-nffp
 * THERE ARE TWO SUCH QUESTIONS per reader, and a reader is covered only
 * when both are answered: does the rights filter REACH this reader
 * (ugcportal-3ae), and is it RE-EVALUATED so that a clearance lapsing
 * after publication removes the row (ugcportal-nffp). See `ScopeCoverage`
 * below for why the first does not imply the second.
 *
 * A title is a weak proof on its own (a title is cheap), and it is
 * deliberately paired with the strong ones next door:
 * src/lib/publishability.scope-agreement.test.ts runs the predicate and the
 * query filter over the same rows in a real database and compares them row
 * by row, and src/lib/public-media.lapse.test.ts drives all six readers
 * against one live row through a lapse and back. This file answers "is
 * every reader reached", those answer "does the filter say the right
 * thing" and "does it still say it tomorrow".
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
  const source = sourceFileOf(file);
  const namespaces = namespaceImportNames(source);

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
    /*
     * …EXCEPT through a NAMESPACE IMPORT, which the rule above would reject
     * for exactly the reason it exists. `import * as publicMedia from
     * "@/lib/public-media"` … `where: publicMedia.PUBLIC_MEDIA_SCOPE` puts
     * the only occurrence of the name in property-access position, so the
     * first branch — written to reject `config.PUBLIC_MEDIA_SCOPE` on an
     * unrelated object — rejected a real reader too. Review round 1 of
     * ugcportal-3ae proved that gap by writing such a reader into the tree
     * and watching this file stay green; "the scanner itself" below now
     * drives the same shape against a fixture.
     *
     * The namespace objects are collected from the file's own imports
     * rather than matching any `<anything>.PUBLIC_MEDIA_SCOPE`, which keeps
     * the original exclusion intact: `config.PUBLIC_MEDIA_SCOPE` is still
     * not a reference, because nothing imported `config` as a namespace.
     */
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === SCOPE &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The local names bound by `import * as X from "…"` in one parsed file. */
function namespaceImportNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    }
  }
  return names;
}

/**
 * TWO QUESTIONS PER READER, NOT ONE (ugcportal-nffp).
 *
 * `filter` names the test proving the rights filter REACHES this reader —
 * ugcportal-3ae's question, which is about a row that was already in the
 * refused state when it was seeded.
 *
 * `lapse` names the test proving the filter is RE-EVALUATED, so a clearance
 * that stops holding after publication removes the row from this reader
 * too — ugcportal-nffp's question. The two are not the same, and a reader
 * can pass the first while failing the second: "seed it broken, assert it
 * is hidden" is satisfied just as well by a materialised `isPublic` column
 * written at publish time, which would go on serving an uncleared
 * photograph for as long as nobody wrote to the row again.
 */
type ScopeCoverage = {
  readonly filter: readonly string[];
  readonly lapse: readonly string[];
};

/**
 * Every reader, and the test files that answer both questions for it.
 *
 * The four query sites and the five surfaces behind them, re-derived from
 * the source at ba9991f rather than copied from the bead:
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
 *
 * A FIFTH query site joined them at ugcportal-yzo7:
 *
 *   lib/sellable-media.ts `getPublicOffer` — the price block on
 *                         /media/[previewId]. A SECOND read of the same
 *                         item, not a widening of `getPublicMediaItem`'s:
 *                         it projects the sale gate's own select, which
 *                         reads `Media.userId` and the uploader's standing
 *                         review, and those must never join the anonymous
 *                         projection. It reaches for this scope because an
 *                         item that is not public cannot carry a public
 *                         price — so the publish gate applies to the offer
 *                         exactly as it applies to the photograph.
 *
 * A SIXTH JOINED AT ugcportal-nffp, and it is the one that carries the
 * photograph itself:
 *
 *   app/api/media/preview/[previewId]/route.ts
 *                         GET /api/media/preview/[previewId] — the only
 *                         route in the app that serves media BYTES. Until
 *                         that bead it hand-wrote its own
 *                         `{ previewId, previewKey, publishedAt }` filter
 *                         and consulted no gate at all, so an uncleared or
 *                         lapsed photograph left all five readers above and
 *                         stayed downloadable at the stable URL the sitemap
 *                         had already handed to crawlers. It was absent
 *                         from this map rather than failing it, because it
 *                         never named the constant — the blind spot the
 *                         header above describes and ugcportal-7egi owns.
 *                         The fix was to make it name the constant.
 */
const SCOPE_CONSUMERS: Readonly<Record<string, ScopeCoverage>> = {
  "app/api/media/preview/[previewId]/route.ts": {
    filter: ["app/api/media/preview/[previewId]/route.test.ts"],
    lapse: ["lib/public-media.lapse.test.ts"],
  },
  "app/sitemap.ts": {
    filter: ["app/sitemap.test.ts"],
    lapse: ["lib/public-media.lapse.test.ts"],
  },
  "lib/media-item.ts": {
    filter: ["lib/media-item.test.ts"],
    lapse: ["lib/public-media.lapse.test.ts"],
  },
  "lib/portfolio.ts": {
    filter: ["lib/portfolio.test.ts"],
    lapse: ["lib/public-media.lapse.test.ts"],
  },
  "lib/public-media.ts": {
    filter: ["app/page.test.tsx"],
    lapse: ["lib/public-media.lapse.test.ts"],
  },
  "lib/sellable-media.ts": {
    filter: ["lib/sellable-media.test.ts"],
    lapse: ["lib/public-media.lapse.test.ts"],
  },
};

/**
 * The bead id a covering test's own title has to carry, per question.
 *
 * ONE `lapse` FILE COVERS ALL SIX, which is deliberate rather than lazy:
 * that file drives every reader against ONE seeded row through one helper,
 * so a fix that reaches the listings and not the bytes — the exact shape
 * this bead found — cannot leave five of six columns green and be called
 * done.
 */
const COVERAGE_MARKERS: Readonly<Record<keyof ScopeCoverage, string>> = {
  filter: "ugcportal-3ae",
  lapse: "ugcportal-nffp",
};

/** Titles of every `describe`/`it` in a file, read off the AST. */
export function suiteTitlesIn(file: string): string[] {
  const source = sourceFileOf(file);
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

describe("every anonymous reader of PUBLIC_MEDIA_SCOPE is covered, for the filter and for its lapse (ugcportal-3ae K3, ugcportal-nffp K3)", () => {
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

  for (const [consumer, coverage] of Object.entries(SCOPE_CONSUMERS)) {
    for (const question of ["filter", "lapse"] as const) {
      const marker = COVERAGE_MARKERS[question];
      it(`${consumer} is covered for ${question} by a test naming ${marker}`, () => {
        const coveringTests = coverage[question];
        expect(coveringTests.length).toBeGreaterThan(0);
        for (const relative of coveringTests) {
          const file = path.join(SRC_ROOT, relative);
          const titles = suiteTitlesIn(file);
          // Non-empty first: a path typo, or a file that stopped being a
          // test, would otherwise read as "no title matched" either way.
          expect(titles.length, relative).toBeGreaterThan(0);
          expect(
            titles.some((title) => title.includes(marker)),
            `${relative} has no describe/it naming ${marker}`,
          ).toBe(true);
        }
      });
    }
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

  it("FAILS on a reader the map does not name — the mutation this guard exists for", () => {
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

  it("FAILS on a reader that reaches the scope through a NAMESPACE import", () => {
    /*
     * The mutation for review round 1's finding 3, run rather than
     * described. Before this, `referencesScope` rejected every identifier
     * in property-access position — which was right for
     * `config.PUBLIC_MEDIA_SCOPE` and wrong for a real reader written
     * `import * as publicMedia from "@/lib/public-media"`, whose only
     * occurrence of the name is in exactly that position. Such a reader
     * passed the suite 11/11 while being a genuine fifth consumer.
     */
    const root = tree({
      "lib/public-media.ts": `export const ${SCOPE} = {};`,
      "app/api/public/feed-v3/route.ts": [
        'import * as publicMedia from "@/lib/public-media";',
        `export const GET = () => prisma.media.findMany({ where: publicMedia.${SCOPE} });`,
      ].join("\n"),
    });

    expect(scanScopeConsumers(root)).toEqual([
      "app/api/public/feed-v3/route.ts",
      "lib/public-media.ts",
    ]);
  });

  it("still ignores the same member access on something NOT imported as a namespace", () => {
    /*
     * The other direction of the same fix, and the reason the namespace
     * names are collected from the file's own imports rather than matching
     * any `<anything>.PUBLIC_MEDIA_SCOPE`. A config object that happens to
     * carry a key of this name is not a reader, and a scan that counted it
     * would put files on the map that use nothing.
     *
     * A namespace import of a DIFFERENT module reading this member would
     * be reported — deliberately, since that is some module exporting a
     * constant of this name and the map failing loudly is the right
     * direction for it.
     */
    const root = tree({
      "lib/named.ts": [
        `import { config } from "@/lib/config";`,
        `export const x = config.${SCOPE};`,
      ].join("\n"),
      "lib/bare.ts": `export const y = settings.rights.${SCOPE};`,
      "lib/other-member.ts": [
        'import * as publicMedia from "@/lib/public-media";',
        "export const z = publicMedia.PUBLIC_MEDIA_COLUMN_SCOPE;",
      ].join("\n"),
    });

    expect(scanScopeConsumers(root)).toEqual([]);
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
