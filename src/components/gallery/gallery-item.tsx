import {
  GALLERY_CAPTION_CLASS,
  GALLERY_TAG_CLASS,
  GALLERY_TAG_LIST_CLASS,
} from "@/components/gallery/containment";
import type { GalleryItem } from "@/lib/gallery-items";

/**
 * The caption and subject-tag chips under one gallery tile (ugcportal-gwr,
 * ugcportal-jsc) — a plain module with NO `"use client"`, same reasoning as
 * src/components/gallery/gallery-unavailable.tsx: neither component below
 * reads state, a ref, or a browser API, so there is no reason either one
 * needs to be a Client Component, or to ship in a client bundle at all for a
 * page that never renders the interactive `Gallery`.
 *
 * MOVED HERE FROM gallery.tsx (ugcportal-qnq9.7 round-2 review). Round 1
 * exported both functions directly from gallery.tsx so the portfolio page's
 * `PortfolioTile` (src/components/portfolio/portfolio-tile.tsx) could reuse
 * them instead of a second, near-identical copy — correct in spirit, but
 * gallery.tsx opens with `"use client"` for ITS OWN reasons (`Gallery`'s
 * state, refs, and the PhotoSwipe lightbox it drives), and importing
 * anything from a `"use client"` module pulls that module's entire client
 * bundle along with it. /about and /portfolio (src/app/about/page.tsx,
 * src/app/portfolio/page.tsx) have no business shipping PhotoSwipe,
 * `Gallery`'s pagination state, or any of gallery.tsx's other client-side
 * machinery to a visitor who never sees the interactive home-page gallery
 * at all. `gallery.tsx` now imports these two FROM here (the same direction
 * `GalleryUnavailable` already proved out), rather than the other way
 * round, so its own render is unchanged.
 */

/**
 * The caption under one tile. Mirrors `figure > img[alt] + figcaption` from
 * docs/design/forside.html's reference sketch — not a literal
 * `<figcaption>`, since the tile is not inside a `<figure>` and introducing
 * one here is a larger structural change than ugcportal-gwr's render half
 * needed, but the same idea: a short, optional, visible line of text under
 * the photograph, separate from whatever opens it (a lightbox-activating
 * `<button>` in gallery.tsx's own tile, nothing at all in
 * src/components/portfolio/portfolio-tile.tsx's `<figure>`).
 *
 * RENDERS NOTHING when there is no caption, for the same reason
 * `GalleryItemTags` renders nothing when there are no tags: an untagged,
 * uncaptioned item is the ordinary case for most of this library, and an
 * empty element would still carry this one's margin.
 *
 * Plain text, nothing else. React escapes it the same way it escapes a tag
 * name, so a caption containing `<script>` renders as those literal
 * characters rather than executing (ugcportal-gwr K2's XSS criterion) — the
 * same guarantee `GalleryItemTags` already has, for the same reason:
 * nothing on this path uses `dangerouslySetInnerHTML`.
 */
export function GalleryItemCaption({ item }: { item: GalleryItem }) {
  if (item.caption === "") return null;
  return (
    <p className={GALLERY_CAPTION_CLASS} data-gallery-caption={item.id}>
      {item.caption}
    </p>
  );
}

/**
 * The subject tags under one tile (ugcportal-jsc).
 *
 * RENDERS NOTHING AT ALL when there are none — not an empty `<ul>`, not a
 * spacer, not a dash. An untagged item is the ordinary case for everything
 * uploaded before tagging existed, and an empty element still carries this
 * list's `mt-1.5`, so the untagged tiles in a mixed grid would sit six pixels
 * higher than their neighbours for no reason a visitor could see. An empty
 * list is also announced as a list with no items, which is worse than
 * silence.
 *
 * A `<ul>`, because it is a list of labels about the item beside it, and
 * screen readers announce its length — "list, 2 items" is exactly the useful
 * thing to hear here.
 *
 * `name` goes in as text and nothing else. React escapes it, so a tag called
 * `<img onerror=…>` renders as those characters rather than as an element;
 * the characters escaping does NOT neutralise — the bidi overrides — are
 * refused at the write path (src/lib/tags.ts) and dropped again at the read
 * path (`toGalleryTags`), so there is nothing left here that needs handling.
 * Nothing on this path uses `dangerouslySetInnerHTML`, and nothing should.
 *
 * NO FILTERING OF ITS OWN: it renders `item.tags` exactly as given. The
 * portfolio curation tag (`PORTFOLIO_TAG_SLUG`, src/lib/curation-tags.ts) is
 * stripped once, upstream, in `toGalleryTags`
 * (src/lib/gallery-items.ts#toGalleryItem) — the one boundary every
 * published item's tags cross on the way to ANY public surface — rather
 * than filtered again here. See that function's own comment for why
 * round 1's portfolio-only filter left a gap round 2 closed.
 */
export function GalleryItemTags({ item }: { item: GalleryItem }) {
  if (item.tags.length === 0) return null;
  return (
    <ul className={GALLERY_TAG_LIST_CLASS}>
      {item.tags.map((tag) => (
        <li key={tag.slug} className={GALLERY_TAG_CLASS} data-gallery-tag={tag.slug}>
          {tag.name}
        </li>
      ))}
    </ul>
  );
}
