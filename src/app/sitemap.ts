import type { MetadataRoute } from "next";

import { LEGAL_PAGES } from "@/lib/legal/pages";
import { legalReadiness, linkBlockedInProduction } from "@/lib/legal/publishable";
import { siteOrigin } from "@/lib/origin";
import { prisma } from "@/lib/prisma";
import { PUBLIC_MEDIA_SCOPE } from "@/lib/public-media";
import { ABOUT_PATH, PORTFOLIO_PATH, mediaItemPath } from "@/lib/routes";
import { DEFAULT_THROTTLE_INTERVAL_MS, createThrottledLog } from "@/lib/throttled-log";

/**
 * app/sitemap.ts (ugcportal-qnq9.12, K3): Next's built-in sitemap convention
 * — this file, under this exact name, is enough for Next to serve it at
 * `/sitemap.xml` with the right content type. No hand-rolled XML.
 *
 * THE ITEM ENTRIES ARE BUILT FROM `PUBLIC_MEDIA_SCOPE`
 * (src/lib/public-media.ts) — the SAME published/preview filter the public
 * feed (GET /api/public/media) and the portfolio page already share — not
 * from a second `publishedAt: { not: null }` written out here. That constant
 * is typed as `MediaAnonymousScope` (src/lib/media-listing.ts), the one place
 * "what is public" is allowed to be decided; this file consumes it rather
 * than restating it, which is what K3 asks for directly.
 *
 * NO PAGINATION: Next's sitemap convention supports splitting across
 * multiple files past roughly 50,000 URLs (`generateSitemaps`), which this
 * site is nowhere near. The `take` below is a defensive ceiling at Google's
 * own documented per-sitemap limit, not a product decision — if this site
 * ever approaches it, that is the signal to build the split, not to raise
 * the number.
 */
export const MAX_SITEMAP_ITEM_ENTRIES = 50_000;

/**
 * Review round 1, finding 2 (LOW, CONFIRMED): hitting the cap above silently
 * and permanently drops the oldest published items from the sitemap — they
 * stay live, 200-rendering pages, just no longer discoverable through this
 * one surface — with nothing anywhere saying the cap was ever reached. This
 * is the signal this file's own comment above promised ("if this site ever
 * approaches it, that is the signal to build the split") but never actually
 * emitted. Throttled via `createThrottledLog` (src/lib/throttled-log.ts) —
 * same convention as `src/lib/public-media.ts`'s `LISTING_FAILURE_LOG_
 * INTERVAL_MS` — rather than a bare `console.warn` per request, since every
 * request to `/sitemap.xml` would re-trigger it for as long as the cap stays
 * hit. No `flush`: unlike a capacity shed this is a sustained condition, not
 * a burst with a tail worth guaranteeing — the first request after a quiet
 * period always warns, which is enough to notice.
 */
const SITEMAP_CAP_LOG_INTERVAL_MS = DEFAULT_THROTTLE_INTERVAL_MS;

const sitemapCapLog = createThrottledLog({ intervalMs: SITEMAP_CAP_LOG_INTERVAL_MS });

/**
 * Test-only: the throttle above is module-level state, so a test file that
 * triggers this warning more than once needs to reset it between tests —
 * same reset-export pattern `resetObjectStorageUnreachableLogThrottles`
 * (src/app/api/media/route.ts) already uses.
 */
export function resetSitemapCapLogThrottle(): void {
  sitemapCapLog.reset();
}

/**
 * Never prerendered: this reads live, published Media rows (the same reason
 * src/app/page.tsx and src/app/portfolio/page.tsx carry the identical
 * export) — a statically generated sitemap would keep listing an item after
 * its owner unpublished it, and `next build` has no reason to have a
 * database to query in the first place.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();

  // Review round 1, finding 1: `siteOrigin()` now returns `null` in
  // production when AUTH_URL is unset or malformed, rather than falling
  // back to `http://localhost:3000` — a wrong URL on a surface built to be
  // read by every crawler at once. An EMPTY sitemap is the fail-safe answer
  // here (one of the two the finding names): nothing is actually wrong with
  // any Media row, so this is not the same as the DB-failure path elsewhere
  // in this app, but there is no safe URL to publish either, and
  // `checkSiteOriginConfigured` (src/lib/origin.ts, wired into
  // src/instrumentation-node.ts) is what actually reports the cause — this
  // file does not duplicate that warning.
  if (origin === null) {
    return [];
  }

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${origin}/`, changeFrequency: "daily" },
    { url: `${origin}${ABOUT_PATH}` },
    { url: `${origin}${PORTFOLIO_PATH}` },
    // The privacy statement and the licence text (ugcportal-qnq9.4) are only
    // listed once they are safe to LINK, by the same rule the footer already
    // applies (src/components/site-footer.tsx's own `legalLinkBlocked`): a
    // sitemap entry is a link, and a crawler is exactly the audience that
    // should not be handed a draft page with an unset controller name.
    ...LEGAL_PAGES.filter(
      (page) => !linkBlockedInProduction(legalReadiness([page])),
    ).map((page) => ({ url: `${origin}${page.path}` })),
  ];

  const rows = await prisma.media.findMany({
    where: PUBLIC_MEDIA_SCOPE,
    select: { previewId: true, publishedAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_SITEMAP_ITEM_ENTRIES,
  });

  if (rows.length === MAX_SITEMAP_ITEM_ENTRIES) {
    sitemapCapLog.log((suppressed) => {
      console.warn("[sitemap] published item count has reached the cap; oldest items are being dropped", {
        cap: MAX_SITEMAP_ITEM_ENTRIES,
        ...(suppressed > 0 ? { suppressed } : {}),
      });
    });
  }

  const itemEntries: MetadataRoute.Sitemap = rows
    // The scope's own `previewId`/`publishedAt`-not-null filters already
    // guarantee this; narrowed again here so the mapped type below is
    // `string`/`Date`, not `string | null`/`Date | null` — the same
    // "re-check what the where-clause already promises" habit
    // src/lib/media-listing.ts's own `hasCompletePreview` follows, rather
    // than a non-null assertion that would silently stop meaning anything
    // the day this query's shape changes.
    .filter(
      (row): row is { previewId: string; publishedAt: Date } =>
        row.previewId !== null && row.publishedAt !== null,
    )
    .map((row) => ({
      url: `${origin}${mediaItemPath(row.previewId)}`,
      lastModified: row.publishedAt,
    }));

  return [...staticEntries, ...itemEntries];
}
