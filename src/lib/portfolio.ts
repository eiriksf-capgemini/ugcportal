import { PORTFOLIO_TAG_SLUG } from "@/lib/curation-tags";
import { MEDIA_ANONYMOUS_SELECT } from "@/lib/media-access";
import { toGalleryItems, type GalleryItem } from "@/lib/gallery-items";
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
 *
 * `PORTFOLIO_TAG_SLUG` itself lives in src/lib/curation-tags.ts, not here
 * (round-2 review) — see that module's own comment for why: it is read by
 * src/lib/gallery-items.ts too, which strips this slug from every tag list
 * ANY public surface renders, not only this one's query.
 *
 * KNOWN FOLLOW-UP (filed as its own bead, discovered-from this one): the
 * picker renders "Portfolio" as a plain subject checkbox indistinguishable
 * from "Food"/"Wine & drink" — fine for this bead's two uploaders today, but
 * a curation flag and a subject are different kinds of fact, and the picker
 * UI does not yet say so.
 */

/**
 * The exact wording the bead specifies for a self-made sample with no brand
 * involved ("marked as spec work where they were not commissioned": "Spec
 * sample, not a client commission"). Exported so the render layer and its
 * tests both read this string from one place rather than retyping it.
 *
 * RENDERED UNCONDITIONALLY on every piece (round-1 review, K2/K3): there is
 * no field anywhere yet recording "this was a paid or gifted job" —
 * ugcportal-qnq9.1 (the per-item advertising-disclosure record) owns that
 * and has not landed; MediaListing's `sponsoredContent` boolean is a
 * different question entirely (resale-gate input, not a public disclosure —
 * see that bead's own "out of scope" for why overloading it would be
 * wrong). A conditional spec-vs-advertising marker with only one branch
 * ever reachable was dead code with a test suite of its own; K3 (the
 * advertising-label branch) is not implemented until ugcportal-qnq9.1
 * exists to supply the real field, and must be re-added then, not before.
 *
 * K6 (never imply a brand commissioned a self-made sample) is NOT closed by
 * this code alone — nothing here can tell a genuinely self-made sample from
 * a real brand deal an uploader tagged "portfolio" by mistake, since there
 * is no field to check either way. That is exactly why K6 is "a manual
 * review by Eirik of every sample on the live portfolio page against the
 * list of real engagements, recorded as a note on this bead before the page
 * goes live" — a process gate, not a mechanical one.
 */
export const SPEC_SAMPLE_LABEL = "Spec sample, not a client commission";

/**
 * A ceiling on how many samples the portfolio page will render, whatever the
 * curated set turns out to contain: nothing here deletes a Media row or
 * un-tags one, so the curated set can only grow, and a page that renders
 * every row it is ever given has no ceiling on its own render cost.
 *
 * Twenty-four, chosen on its OWN terms (round-3 review: an earlier draft of
 * this comment claimed it was "the same figure `MAX_PICKER_TAGS` uses, for
 * the same reason" — true only by coincidence, since the two cap unrelated
 * things: `MAX_PICKER_TAGS` bounds how many DISTINCT TAGS the upload page's
 * picker offers, this bounds how many MEDIA ITEMS this page renders, and
 * deriving one from the other would wire a future change to one concern
 * into the other's render cost for no real reason). Comfortably more than
 * "the six sample pieces" §5.2 names as this product's starting content,
 * and far short of a size a grid can choke on — the justification stands
 * on its own regardless of what `MAX_PICKER_TAGS` is set to.
 */
export const MAX_PORTFOLIO_PIECES = 24;

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
 * small, curated, unpaginated set, bounded by `MAX_PORTFOLIO_PIECES` above
 * rather than paged, so paying for keyset pagination here would be
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
 * NO TAG FILTERING HAPPENS HERE ANY MORE (round-2 review). `toGalleryItems`
 * (src/lib/gallery-items.ts) now strips the portfolio curation tag from
 * EVERY row it converts, for every caller — this function's own filter
 * would have been a second copy of that rule, exactly the "keep it in one
 * place" lesson round 1 already drew, just one layer too shallow: round 1's
 * "one place" was this file, which still left the main gallery feed
 * leaking the tag on any item that happened to be both published and
 * portfolio-tagged.
 */
export async function listPortfolioPieces(): Promise<GalleryItem[]> {
  const rows = await prisma.media.findMany({
    where: {
      ...PUBLIC_MEDIA_SCOPE,
      kind: "IMAGE",
      tags: { some: { slug: PORTFOLIO_TAG_SLUG } },
    },
    select: MEDIA_ANONYMOUS_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_PORTFOLIO_PIECES,
  });

  return toGalleryItems(rows);
}
