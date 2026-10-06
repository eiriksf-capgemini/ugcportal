import type { MetadataRoute } from "next";

import { LEGAL_PAGES } from "@/lib/legal/pages";
import { legalReadiness, linkBlockedInProduction } from "@/lib/legal/publishable";
import { siteOrigin } from "@/lib/origin";
import { prisma } from "@/lib/prisma";
import { PUBLIC_MEDIA_SCOPE } from "@/lib/public-media";
import { ABOUT_PATH, PORTFOLIO_PATH, mediaItemPath } from "@/lib/routes";

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
const MAX_SITEMAP_ITEM_ENTRIES = 50_000;

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
