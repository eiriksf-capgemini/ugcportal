import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";

/**
 * K2 (ugcportal-qnq9.16, item 2 of the lows deferred from PR #93's round-6
 * review): "the guarantee that a visitor never sees the internal 'portfolio'
 * curation tag is enforced by convention — every consumer... must remember
 * to call stripCurationTags after its own query — rather than at the Prisma
 * select/query layer... a future third consumer... that queries Media with
 * the tags relation and serializes it directly... has no compiler or test
 * signal forcing it through stripCurationTags."
 *
 * The bead's own K2 offers two ways to close this: move stripping into the
 * query select, or keep the convention and add a test enumerating every
 * consumer so a future one that forgets fails. The first is the riskier
 * change here — `MEDIA_ANONYMOUS_SELECT`'s `tags` relation is shared with
 * `MEDIA_OWNER_SELECT` (see media-access.ts's own comment on why the two
 * select the SAME tags relation), and an owner legitimately needs to see
 * and un-tag their own item's curation tag in the upload/edit picker, so
 * filtering the relation itself at the query layer would hide it from the
 * one audience that must still see it. The second is what this file does.
 *
 * `select: MEDIA_ANONYMOUS_SELECT`, literally, is the exact shape a direct
 * consumer of this projection writes (`src/lib/portfolio.ts`,
 * `src/lib/media-item.ts` today) — as opposed to going through
 * `listMedia`/`listPublicMedia` (`src/lib/media-listing.ts`,
 * `src/lib/public-media.ts`), the one shared, already-audited path that
 * strips centrally. A file matching that literal pattern is "a future
 * consumer" in the bead's own words, and must also match evidence of
 * stripping: a direct call to `stripCurationTags`, or routing the row
 * through `toGalleryItem`/`toGalleryItems` (`src/lib/gallery-items.ts`),
 * which call it internally for every row either one converts.
 */
const SELECTS_ANONYMOUS_PROJECTION = /\bselect:\s*MEDIA_ANONYMOUS_SELECT\b/;
const STRIPS_CURATION_TAGS = /\b(stripCurationTags|toGalleryItems?)\b/;

/**
 * The real scanner, exported so the mutation-check fixtures below can
 * drive it directly against synthetic files on disk rather than
 * re-implementing the match logic inline.
 */
export function findUnstrippedAnonymousSelectConsumers(
  files: readonly string[],
  root: string,
): string[] {
  const offenders: string[] = [];
  for (const absolutePath of files) {
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    const contents = stripComments(readFileSync(absolutePath, "utf8"), absolutePath);
    if (!SELECTS_ANONYMOUS_PROJECTION.test(contents)) continue;
    if (!STRIPS_CURATION_TAGS.test(contents)) offenders.push(relative);
  }
  return offenders;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe(
  "K2: every direct `select: MEDIA_ANONYMOUS_SELECT` consumer strips the curation tag",
  { timeout: 15_000 },
  () => {
    const files = walkSourceFiles(SRC_ROOT, isTestFile);

    it("finds files to scan (sanity check on the walker itself)", () => {
      expect(files.length).toBeGreaterThan(50);
    });

    it("has no consumer that selects the anonymous projection without also stripping", () => {
      const offenders = findUnstrippedAnonymousSelectConsumers(files, SRC_ROOT);

      expect(
        offenders,
        `a consumer selects MEDIA_ANONYMOUS_SELECT directly with no stripCurationTags/ ` +
          `toGalleryItem(s) in the same file, so a curation-only tag (e.g. "portfolio") ` +
          `can leak to a visitor: ${offenders.join(", ")}. Call stripCurationTags on its ` +
          `tags, or convert the row through toGalleryItem/toGalleryItems.`,
      ).toEqual([]);
    });
  },
);

describe("findUnstrippedAnonymousSelectConsumers (the real scanner, exercised over fixtures on disk)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop() as string, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "curation-strip-guard-"));
    created.push(root);
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    return root;
  }

  it("reports a file that selects the anonymous projection and never strips", () => {
    const root = fixture({
      "offender.ts":
        "const rows = await prisma.media.findMany({\n" +
        "  select: MEDIA_ANONYMOUS_SELECT,\n" +
        "});\n" +
        "return rows;\n",
    });

    const result = findUnstrippedAnonymousSelectConsumers(
      walkSourceFiles(root, () => false),
      root,
    );

    expect(result).toEqual(["offender.ts"]);
  });

  /**
   * Required mutation for the test above: same shape, plus a direct
   * `stripCurationTags` call — proving the fixture is a real positive, not
   * an artifact of how the fixture happens to be written.
   */
  it("MUTATION: adding a stripCurationTags call to the same fixture makes the scan report nothing", () => {
    const root = fixture({
      "fixed.ts":
        "const rows = await prisma.media.findMany({\n" +
        "  select: MEDIA_ANONYMOUS_SELECT,\n" +
        "});\n" +
        "return rows.map((row) => ({ ...row, tags: stripCurationTags(row.tags) }));\n",
    });

    const result = findUnstrippedAnonymousSelectConsumers(
      walkSourceFiles(root, () => false),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not report a file that routes rows through toGalleryItems instead of calling stripCurationTags directly", () => {
    const root = fixture({
      "viaGalleryItems.ts":
        "const rows = await prisma.media.findMany({\n" +
        "  select: MEDIA_ANONYMOUS_SELECT,\n" +
        "});\n" +
        "return toGalleryItems(rows);\n",
    });

    const result = findUnstrippedAnonymousSelectConsumers(
      walkSourceFiles(root, () => false),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not report a file where the select appears only inside a comment", () => {
    const root = fixture({
      "commented.ts": "// select: MEDIA_ANONYMOUS_SELECT\nexport const x = 1;\n",
    });

    const result = findUnstrippedAnonymousSelectConsumers(
      walkSourceFiles(root, () => false),
      root,
    );

    expect(result).toEqual([]);
  });

  it("does not report a file that never selects the anonymous projection at all", () => {
    const root = fixture({
      "unrelated.ts": "export const x = 1;\n",
    });

    const result = findUnstrippedAnonymousSelectConsumers(
      walkSourceFiles(root, () => false),
      root,
    );

    expect(result).toEqual([]);
  });
});
