import { MEDIA_ANONYMOUS_SELECT } from "@/lib/media-access";
import { toGalleryItems, type GalleryItem, type GalleryTag } from "@/lib/gallery-items";
import { prisma } from "@/lib/prisma";
import { PUBLIC_MEDIA_SCOPE } from "@/lib/public-media";

/**
 * The portfolio page's selection mechanism (ugcportal-qnq9.7): published
 * media, tagged "portfolio" through the existing curated-tag picker
 * (src/lib/tags.ts), seeded curated by
 * prisma/migrations/20261004150000_seed_portfolio_tag. See that migration's
 * own comment for why a tag — not a schema column — is the least invasive
 * way to mark a sample, and src/lib/tags.ts for what "curated" buys: the
 * upload form's existing picker can offer "Portfolio" as a checkbox to the
 * handful of allowlisted uploaders with no new write path and no new admin
 * screen.
 */
export const PORTFOLIO_TAG_SLUG = "portfolio";

/**
 * The exact wording the bead specifies for a self-made sample with no brand
 * involved ("marked as spec work where they were not commissioned": "Spec
 * sample, not a client commission"). Exported so the render layer and its
 * tests both read this string from one place rather than retyping it.
 */
export const SPEC_SAMPLE_LABEL = "Spec sample, not a client commission";

/**
 * One portfolio piece, as the page renders it.
 *
 * Extends GalleryItem (src/lib/gallery-items.ts) rather than re-deriving the
 * same preview/caption/tag shape, so the portfolio tile can reuse
 * `galleryItemAlt` and the gallery's own containment styling (see
 * src/components/portfolio/portfolio-tile.tsx) instead of inventing a
 * parallel notion of "a published photograph".
 *
 * `isSpec`/`advertisingLabel` answer K2/K3's question — self-made concept
 * work, or a real paid/gifted job carrying the advertising label
 * ugcportal-qnq9.1 owns — and are mutually exclusive by construction at the
 * render layer (PortfolioTile renders at most one of the two markers; see
 * that component for why `advertisingLabel` always wins when both are
 * somehow present).
 *
 * KNOWN GAP, NAMED RATHER THAN HIDDEN: ugcportal-qnq9.1 (the per-item
 * advertising-disclosure record) has not landed. There is today no field
 * anywhere recording "this was a paid or gifted job" — MediaListing's
 * `sponsoredContent` boolean is a different question entirely (resale-gate
 * input, not a public disclosure; see that bead's own "out of scope" for why
 * overloading it would be wrong) and nothing else exists yet. Every piece
 * `listPortfolioPieces` returns is therefore marked `isSpec: true,
 * advertisingLabel: null` unconditionally below.
 *
 * WHAT THIS DOES NOT GUARANTEE, stated plainly rather than implied away: the
 * query has no way to tell a genuinely self-made sample from a real brand
 * deal that an uploader tagged "portfolio" by mistake, or before
 * ugcportal-qnq9.1 existed to record the real answer — there is no field to
 * check either way. That is exactly why K6 is "a manual review by Eirik of
 * every sample on the live portfolio page against the list of real
 * engagements, recorded as a note on this bead before the page goes live",
 * rather than a claim this code makes mechanically. What IS mechanical (K2,
 * K3) is that whichever marker the data says to show, the render layer shows
 * exactly one of the two and never both or neither-as-silent-commissioned —
 * see PortfolioTile. When ugcportal-qnq9.1 ships its disclosure field, this
 * mapping must read it instead of the hardcoded `true`/`null` below —
 * tracked on this bead's dependency on qnq9.1 rather than as a new bead,
 * since it is the same selection code qnq9.1 would need to change anyway.
 */
export type PortfolioPiece = GalleryItem & {
  isSpec: boolean;
  advertisingLabel: string | null;
};

/** `item.tags`, with the curation tag itself removed. See the note below. */
function visibleTags(tags: GalleryTag[]): GalleryTag[] {
  return tags.filter((tag) => tag.slug !== PORTFOLIO_TAG_SLUG);
}

/**
 * Reads every portfolio sample, oldest first.
 *
 * THE SCOPE is `PUBLIC_MEDIA_SCOPE` (src/lib/public-media.ts) — the exact
 * same publish/preview filter the public gallery feed uses, so a visitor can
 * never see a portfolio sample the gallery itself would withhold — plus
 * `kind: "IMAGE"` and the portfolio tag.
 *
 * `kind: "IMAGE"` IS THE v0.5.0 RELEASE SCOPE, not an incidental filter.
 * Eirik's 2026-10-04 scoping note on this bead: v0.5.0 ships the portfolio
 * page with PHOTO pieces only: multi-image and VIDEO pieces, and the video
 * rendering they would need (ugcportal-dzz, ugcportal-pmb), move to v0.6.0.
 * This is also the fix that keeps K4's defect (ugcportal-dzz: the gallery
 * does not branch on `kind` and renders a published VIDEO as a photograph)
 * from reaching this new surface at all this release — a VIDEO row tagged
 * "portfolio" by mistake is filtered out here, at the query, rather than
 * rendered wrong by the tile.
 *
 * A DIRECT PRISMA QUERY, NOT `listMedia` (src/lib/media-listing.ts).
 * `listMedia`'s anonymous arm is deliberately keyset-paginated and its scope
 * type has no tag filter — adding one there would mean widening a type that
 * file's own comments call out as the one place serving an anonymous
 * caller's filter is a decision, not a copy-paste. The portfolio page is a
 * small, curated, unpaginated set (today, at most the handful of samples
 * tagged "portfolio"), so paying for keyset pagination here would be
 * complexity with no reader for it. It still reuses the SAME scope constant
 * and the SAME `MEDIA_ANONYMOUS_SELECT` projection as the paginated feed, so
 * the two cannot disagree about what "published" or "public" means even
 * though the query itself is separate.
 *
 * ORDERING is oldest-first (`createdAt asc`), the opposite of the gallery's
 * newest-first feed, because a portfolio reads as a body of work assembled in
 * the order it was made — "first six pieces" (docs/ugc-research.md §5.2) —
 * rather than as a stream of recent activity.
 *
 * THE CURATION TAG ITSELF IS STRIPPED from each piece's visible tags: a
 * visitor is shown the photograph's real subjects ("food", "wine-drink") the
 * same way the gallery shows them, not the internal fact that it was
 * selected for this page.
 */
export async function listPortfolioPieces(): Promise<PortfolioPiece[]> {
  const rows = await prisma.media.findMany({
    where: {
      ...PUBLIC_MEDIA_SCOPE,
      kind: "IMAGE",
      tags: { some: { slug: PORTFOLIO_TAG_SLUG } },
    },
    select: MEDIA_ANONYMOUS_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  return toGalleryItems(rows).map((item) => ({
    ...item,
    tags: visibleTags(item.tags),
    // See the PortfolioPiece doc comment above for why these are
    // unconditional rather than read off a per-row field that does not exist
    // yet.
    isSpec: true,
    advertisingLabel: null,
  }));
}
