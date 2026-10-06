import { cache } from "react";

import { galleryItemAlt, toGalleryItem, type GalleryItem } from "@/lib/gallery-items";
import { MEDIA_ANONYMOUS_SELECT } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { PUBLIC_MEDIA_SCOPE } from "@/lib/public-media";

/**
 * The per-item page's own read (ugcportal-qnq9.12, K1/K2/K5): one published
 * row, looked up by its opaque public handle.
 *
 * A DIRECT PRISMA QUERY, NOT `listMedia` (src/lib/media-listing.ts) — the
 * same choice `listPortfolioPieces` (src/lib/portfolio.ts) already made, and
 * for the same reason: `listMedia`'s anonymous arm is keyset-paginated and
 * built for a scrolling feed, and this is a single-row lookup by handle, not
 * a page of recent rows. What is NOT separate is the FILTER: this reuses
 * `PUBLIC_MEDIA_SCOPE` (src/lib/public-media.ts) whole, the exact scope the
 * public feed and the portfolio page already share, rather than writing a
 * second `publishedAt: { not: null }` here — which is the one line K3's
 * sibling bead (ugcportal-qnq9.12's own sitemap half) and this file must not
 * each spell independently. `previewId` narrows the match to one row; the
 * scope's own `previewId: { not: null }` is harmless to leave in place
 * (it only restates what an equality match on a real id already implies),
 * but is kept rather than hand-picked apart so there is exactly one copy of
 * "what is public" in this file, not a partial one.
 *
 * Projected through `MEDIA_ANONYMOUS_SELECT` — never the owner's wider
 * select — so `Media.key` (the unwatermarked original), `previewKey` (the
 * storage path that embeds the uploader's id) and `userId` itself are never
 * even read, let alone serialised (K5). `toGalleryItem` is the same mapping
 * boundary the gallery feed and the portfolio page already cross, so this
 * page sanitises alt text/caption and strips the curation-only tag exactly
 * as every other public surface does, rather than trusting the row raw.
 *
 * `cache()`d (review precedent: src/lib/session-or-anonymous.ts) because
 * both `generateMetadata` and the page component below read the SAME row for
 * the SAME request — Next resolves metadata and the page tree separately,
 * and without this the item would be queried twice per visit for no reason.
 */
export const getPublicMediaItem = cache(
  async (previewId: string): Promise<GalleryItem | null> => {
    const trimmed = previewId.trim();
    if (trimmed === "") return null;

    const row = await prisma.media.findFirst({
      where: { ...PUBLIC_MEDIA_SCOPE, previewId: trimmed },
      select: MEDIA_ANONYMOUS_SELECT,
    });
    if (!row) return null;

    return toGalleryItem(row);
  },
);

/**
 * The page's descriptive title (K1): the uploader's own alt text, falling
 * back to `galleryItemAlt`'s own placeholder in the one case alt text is
 * empty despite the row being published — which K1 of ugcportal-gwr means
 * should never happen (alt text is required to publish), but this page does
 * not trust that invariant blindly any more than `toGalleryItem` itself does.
 *
 * Reuses `galleryItemAlt` rather than inventing a second fallback string:
 * that function already produces something that is never the filename and
 * never a bare index on its own (its placeholder names a position AND a
 * publication date, e.g. "Photograph 1, published 4 March 2026" — a
 * descriptive phrase, not a number alone). `position` is fixed at 0: this
 * page renders exactly one item, so there is no sibling in the same batch for
 * a position to disambiguate against.
 */
export function mediaItemTitle(item: GalleryItem): string {
  return galleryItemAlt(item, 0);
}

/**
 * The page's "short text" (K1; docs/ugc-research.md §5.5: "A short text with
 * each gallery item, because search engines can't 'see' photos").
 *
 * The uploader's caption, when there is one — it is the visible sentence they
 * chose to say about this photograph, and is a better page description than a
 * repeated alt text. Falls back to the same title text otherwise, so the page
 * always has real, visible body copy rather than an empty paragraph: this
 * page's whole reason to exist is to give a photograph words a crawler can
 * read, and that must hold even for the (ordinary, pre-ugcportal-gwr) rows
 * that have alt text but no caption.
 */
export function mediaItemShortText(item: GalleryItem): string {
  return item.caption !== "" ? item.caption : mediaItemTitle(item);
}
