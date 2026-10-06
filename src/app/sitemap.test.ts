import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mediaItemPath } from "@/lib/routes";
import { seedMedia } from "@/lib/test-support/media-fixtures";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * app/sitemap.ts (ugcportal-qnq9.12, K3/K5), against a real database — same
 * reasoning as src/lib/portfolio.test.ts: the claim here is about which rows
 * a query returns and what a crawler-facing surface does or does not expose,
 * which a mocked Prisma client cannot prove.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("sitemap() must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { listPublicMedia, publicMediaListingUrl } = await import("@/lib/public-media");
const { default: sitemap } = await import("@/app/sitemap");

const UPLOADER = "uploader-qnq9-12-sitemap";

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader-qnq9-12-sitemap@example.com", role: "USER" },
  });
});

/** The item-page URLs out of a sitemap entry list, as bare previewIds. */
function itemPreviewIds(entries: { url: string }[]): string[] {
  const prefix = mediaItemPath("");
  return entries
    .filter((entry) => entry.url.includes(prefix))
    .map((entry) => entry.url.slice(entry.url.indexOf(prefix) + prefix.length));
}

describe("sitemap() (K3)", () => {
  it("lists exactly the published items the public feed would serve", async () => {
    await seedMedia(prisma, {
      id: "sm-published",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await seedMedia(prisma, {
      id: "sm-unpublished",
      userId: UPLOADER,
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      published: false,
    });
    await seedMedia(prisma, {
      id: "sm-no-preview",
      userId: UPLOADER,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      withPreview: false,
    });

    const entries = await sitemap();
    const feed = await listPublicMedia(publicMediaListingUrl());
    expect(feed.ok).toBe(true);
    const feedPreviewIds = feed.ok
      ? feed.page.items.map((item) => item.previewId).sort()
      : [];

    expect(itemPreviewIds(entries).sort()).toEqual(feedPreviewIds);
    // The specific claim the seeded rows above exist to make concrete:
    // published is in, unpublished and preview-less are both out.
    expect(itemPreviewIds(entries)).toContain("pv-sm-published");
    expect(itemPreviewIds(entries)).not.toContain("pv-sm-unpublished");
    expect(itemPreviewIds(entries)).not.toContain("pv-sm-no-preview");
  });

  // Pre-review mutation check: replacing `where: PUBLIC_MEDIA_SCOPE` with
  // `where: {}` in sitemap.ts did NOT fail the test above, because
  // `itemEntries`'s own row-shape narrow (`previewId !== null && publishedAt
  // !== null`) already excludes "sm-unpublished" and "sm-no-preview" on its
  // own — seedMedia's `withPreview: false` clears BOTH preview columns
  // together, so a preview-less row has no `previewId` either, and that
  // narrow alone was enough to hide the dropped where-clause. It does NOT
  // check `previewKey` at all (by design — see the row-shape comment in
  // sitemap.ts), so it is blind to exactly the shape PUBLIC_MEDIA_SCOPE's
  // own `previewKey: { not: null }` exists to catch: a row with a public
  // handle and a publish timestamp but no actual watermarked object behind
  // it. Written directly rather than through `seedMedia` (which keeps the
  // two preview columns in lock-step on purpose), because this is
  // specifically the inconsistent state that pairing is meant to prevent
  // ever reaching a query in the first place.
  it("excludes a row with previewId/publishedAt set but previewKey null (DB-level scope, not just the row-shape narrow)", async () => {
    await prisma.media.create({
      data: {
        id: "sm-previewkey-null",
        userId: UPLOADER,
        kind: "IMAGE",
        key: `media/${UPLOADER}/sm-previewkey-null-original.jpg`,
        previewKey: null,
        previewId: "pv-sm-previewkey-null",
        mimeType: "image/jpeg",
        sizeBytes: 4096,
        originalName: "sm-previewkey-null.jpg",
        altText: "Alt text for sm-previewkey-null",
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
        publishedAt: new Date("2026-03-01T12:00:00.000Z"),
      },
    });

    const entries = await sitemap();
    expect(itemPreviewIds(entries)).not.toContain("pv-sm-previewkey-null");
  });

  it("is absent an item once it is unpublished again", async () => {
    await seedMedia(prisma, {
      id: "sm-republished",
      userId: UPLOADER,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    await prisma.media.update({
      where: { id: "sm-republished" },
      data: { publishedAt: null },
    });

    const entries = await sitemap();
    expect(itemPreviewIds(entries)).not.toContain("pv-sm-republished");
  });

  it("is absent a deleted item", async () => {
    await seedMedia(prisma, {
      id: "sm-deleted",
      userId: UPLOADER,
      createdAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await prisma.media.delete({ where: { id: "sm-deleted" } });

    const entries = await sitemap();
    expect(itemPreviewIds(entries)).not.toContain("pv-sm-deleted");
  });

  // K5: a sitemap is read by every crawler at once, so the check here is
  // stricter than "the right ids are present" — nothing in the rendered
  // entries may carry Media.key, previewKey, or an unpublished id, under
  // any key the MetadataRoute.Sitemap shape happens to serialise.
  it("never includes Media.key, previewKey, or any unpublished row's id (K5)", async () => {
    await seedMedia(prisma, {
      id: "sm-published-k5",
      userId: UPLOADER,
      createdAt: new Date("2026-03-06T00:00:00.000Z"),
    });
    await seedMedia(prisma, {
      id: "sm-unpublished-k5",
      userId: UPLOADER,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      published: false,
    });

    const entries = await sitemap();
    const serialised = JSON.stringify(entries);

    expect(serialised).not.toContain(`media/${UPLOADER}/`);
    expect(serialised).not.toContain(`previews/${UPLOADER}/`);
    expect(serialised).not.toContain("sm-unpublished-k5");
    expect(serialised).not.toContain(UPLOADER);
  });

  it("includes the home page, About and Portfolio", async () => {
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    expect(urls.some((url) => url.endsWith("/"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/about"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/portfolio"))).toBe(true);
  });

  /**
   * The footer's own rule (`legalLinkBlocked`, src/components/site-footer.tsx)
   * applied here instead of a second copy: a legal page in draft (an unset
   * LEGAL_* variable, or unsigned-off prose) is never LINKED once
   * `NODE_ENV === "production"` — see `linkBlockedInProduction`, src/lib/
   * legal/publishable.ts, which this test exercises through the real
   * `legalReadiness(LEGAL_PAGES)` rather than a stub.
   *
   * `process.env.NODE_ENV` is mutated and restored rather than passed as a
   * parameter: `sitemap()` has no `env` parameter (unlike `legalReadiness`/
   * `assertPublishable` themselves) because Next's own sitemap file
   * convention takes no arguments this app controls — so the real global is
   * what this integration point actually reads, and is what the test has to
   * drive. LEGAL_CONTROLLER_NAME and its three siblings are already unset in
   * this process (vitest.setup.ts does not set them), so toggling
   * `NODE_ENV` to `"production"` is sufficient to put both legal pages into
   * the blocked state without also managing four more variables.
   *
   * `vi.stubEnv`/`vi.unstubAllEnvs`, not a direct `process.env.NODE_ENV =`
   * assignment — same convention as src/instrumentation.test.ts. `NODE_ENV`
   * is typed read-only on `ProcessEnv` (`tsc` rejects a bare assignment to
   * it), and `vi.stubEnv` is the vitest-provided way around that which also
   * restores the original value reliably.
   */
  it("excludes /privacy and /licence once NODE_ENV is production and they are still a draft", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const entries = await sitemap();
      const urls = entries.map((entry) => entry.url);
      expect(urls.some((url) => url.endsWith("/privacy"))).toBe(false);
      expect(urls.some((url) => url.endsWith("/licence"))).toBe(false);
      // The rest of the sitemap is unaffected by the same toggle.
      expect(urls.some((url) => url.endsWith("/"))).toBe(true);
      expect(urls.some((url) => url.endsWith("/about"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * K3's second half: a type-level check that this file builds its scope from
 * src/lib/media-listing.ts's anonymous scope (via PUBLIC_MEDIA_SCOPE,
 * src/lib/public-media.ts) rather than inlining `publishedAt: { not: null }`
 * a second time. A grep over the committed source, not over compiled output:
 * the claim is about what this file's own text says, which a runtime
 * assertion on the query result cannot distinguish from "a second filter
 * that happens to agree today".
 */
describe("app/sitemap.ts source (K3)", () => {
  it("imports PUBLIC_MEDIA_SCOPE and does not inline its own publishedAt filter", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { stripComments } = await import("@/lib/design/scan-source");
    const path = fileURLToPath(new URL("./sitemap.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    // Comments stripped before matching (same convention as
    // src/components/consent/analytics-host.grep.test.ts and
    // src/lib/design/dual-meaning-usage.test.ts): this file's own doc
    // comment explains, in prose, that it does NOT inline
    // `publishedAt: { not: null }` — which otherwise makes this exact check
    // trip on itself, a false positive with no live code behind it.
    const live = stripComments(source, path);
    expect(live).toContain("PUBLIC_MEDIA_SCOPE");
    expect(live).not.toMatch(/publishedAt\s*:\s*{\s*not\s*:\s*null\s*}/);
  });
});
