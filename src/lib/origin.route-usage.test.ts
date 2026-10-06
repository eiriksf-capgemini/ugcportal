import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";

/**
 * Review round 2, MEDIUM finding (family 4, sibling-omission): `robots.ts`
 * read the same env-derived `siteOrigin()` (src/lib/origin.ts) as
 * `sitemap.ts` and `media/[previewId]/page.tsx`, but was missing the
 * `export const dynamic = "force-dynamic"` both of those siblings already
 * carry. Without it, Next has no `headers()`/`cookies()`-shaped signal that
 * the route needs a per-request render — `siteOrigin()` only reads
 * `process.env` — so it silently PRERENDERS the route at `next build` time
 * instead, baking in whatever `AUTH_URL` happened to be at build time
 * forever. Confirmed as a real, always-happens defect in this repo's own
 * Dockerfile (round 2 review, reproduced again for this fix): the builder
 * stage runs `npm run build` under `NODE_ENV=production` with `AUTH_URL`
 * unset, so `/robots.txt` baked with no `Sitemap:` line — and
 * `checkSiteOriginConfigured`'s boot warning runs at container RUNTIME,
 * where `AUTH_URL` is correctly set, so it never fires for this gap. See
 * src/app/robots.ts's own doc comment for the full account.
 *
 * This is the guard that makes the fix hold for every caller, not just the
 * three known today: any file under src/app that imports `siteOrigin` from
 * `@/lib/origin` must also export `dynamic = "force-dynamic"` from the SAME
 * file — a fourth route calling `siteOrigin()` without this export fails
 * here, rather than silently repeating the exact defect `robots.ts` just
 * shipped with.
 */

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "app",
);

/** Whole-word, so `siteOriginSomethingElse` (hypothetically) does not match. */
const SITE_ORIGIN_IMPORT_PATTERN =
  /import\s*\{[^}]*\bsiteOrigin\b[^}]*\}\s*from\s*["']@\/lib\/origin["']/;

const FORCE_DYNAMIC_PATTERN = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/;

/**
 * The real scanner, exported so the fixture-mutation describe block below
 * can drive it against a synthetic directory on disk rather than
 * re-implementing its filter inline (same precedent as
 * `findAnalyticsMarkerOffenders` in analytics-host.grep.test.ts).
 *
 * `files` is an already-walked list (round-1-review-finding-10-shaped
 * efficiency, same reasoning as that file's own comment): the real-tree
 * test below walks `APP_ROOT` once and shares it with the sanity check.
 */
export function findRouteModulesMissingForceDynamic(
  files: readonly string[],
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const live = stripComments(raw, file);
    if (!SITE_ORIGIN_IMPORT_PATTERN.test(live)) continue;
    if (!FORCE_DYNAMIC_PATTERN.test(live)) {
      offenders.push(file);
    }
  }
  return offenders;
}

// ugcportal-9faa: walks and TypeScript-parses (via stripComments) every
// file under src/app/ — smaller than the full src/ tree the siblings named
// in that bead scan, and measured well under the 5s default even at load
// average ~150-165, but still real tree-wide work; an explicit timeout
// keeps it that way rather than silently inheriting the default as the
// tree grows.
describe("every route module that calls siteOrigin() exports dynamic = \"force-dynamic\" (review round 2)", { timeout: 15_000 }, () => {
  const files = walkSourceFiles(APP_ROOT, isTestFile);

  it("finds files to scan (sanity check on the walker itself)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("finds at least the three known siteOrigin() callers", () => {
    const callers = files.filter((file) =>
      SITE_ORIGIN_IMPORT_PATTERN.test(stripComments(readFileSync(file, "utf8"), file)),
    );
    const relative = callers.map((file) => path.relative(APP_ROOT, file).split(path.sep).join("/"));
    expect(relative.sort()).toEqual(
      ["media/[previewId]/page.tsx", "robots.ts", "sitemap.ts"].sort(),
    );
  });

  it("reports no offenders in the real tree", () => {
    const offenders = findRouteModulesMissingForceDynamic(files);
    const relative = offenders.map((file) => path.relative(APP_ROOT, file));
    expect(
      relative,
      `every file importing siteOrigin() from @/lib/origin must also export ` +
        `"dynamic = \\"force-dynamic\\"" in the same file, or Next prerenders it ` +
        `statically and bakes in build-time env forever: ${relative.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * Fixture-mutation check, over a real synthetic directory on disk — same
 * convention as analytics-host.grep.test.ts's own
 * `findAnalyticsMarkerOffenders` fixture suite, so the scanner itself (not
 * just the real tree it happens to see today) is proven to catch the exact
 * shape of defect this guard exists for.
 */
describe("findRouteModulesMissingForceDynamic (the real scanner, exercised over a real fixture on disk)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "origin-route-usage-"));
    created.push(root);
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return root;
  }

  it("reports a real offender: a route that imports siteOrigin but has no force-dynamic export", () => {
    const root = fixture({
      "offender.ts": [
        'import { siteOrigin } from "@/lib/origin";',
        "",
        "export default function offender() {",
        "  return siteOrigin();",
        "}",
      ].join("\n"),
    });

    const result = findRouteModulesMissingForceDynamic(walkSourceFiles(root, isTestFile));
    expect(result).toEqual([path.join(root, "offender.ts")]);
  });

  it("MUTATION: adding the force-dynamic export to the same fixture makes the scan report nothing", () => {
    const root = fixture({
      "fixed.ts": [
        'import { siteOrigin } from "@/lib/origin";',
        "",
        'export const dynamic = "force-dynamic";',
        "",
        "export default function fixed() {",
        "  return siteOrigin();",
        "}",
      ].join("\n"),
    });

    const result = findRouteModulesMissingForceDynamic(walkSourceFiles(root, isTestFile));
    expect(result).toEqual([]);
  });

  it("ignores a file that does not import siteOrigin at all, even with no force-dynamic export", () => {
    const root = fixture({
      "unrelated.ts": "export default function unrelated() {\n  return 1;\n}",
    });

    const result = findRouteModulesMissingForceDynamic(walkSourceFiles(root, isTestFile));
    expect(result).toEqual([]);
  });

  it("does not match a mention of siteOrigin only inside a comment", () => {
    const root = fixture({
      "comment-only.ts": [
        "// this file used to call siteOrigin() but no longer does",
        "export default function commentOnly() {",
        "  return 1;",
        "}",
      ].join("\n"),
    });

    const result = findRouteModulesMissingForceDynamic(walkSourceFiles(root, isTestFile));
    expect(result).toEqual([]);
  });

  it("MUTATION CHECK: the same file with a live siteOrigin import alongside the comment IS reported", () => {
    const root = fixture({
      "comment-and-live.ts": [
        "// this file used to call siteOrigin() but no longer does",
        'import { siteOrigin } from "@/lib/origin";',
        "export default function commentAndLive() {",
        "  return siteOrigin();",
        "}",
      ].join("\n"),
    });

    const result = findRouteModulesMissingForceDynamic(walkSourceFiles(root, isTestFile));
    expect(result).toEqual([path.join(root, "comment-and-live.ts")]);
  });
});
