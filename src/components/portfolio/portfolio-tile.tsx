import { GALLERY_TILE_BASE_CLASS } from "@/components/gallery/containment";
import {
  GalleryItemCaption,
  GalleryItemTags,
} from "@/components/gallery/gallery-item";
import { galleryItemAlt, type GalleryItem } from "@/lib/gallery-items";
import { SPEC_SAMPLE_LABEL } from "@/lib/portfolio";

/**
 * The image's own classes, deliberately NOT `GALLERY_TILE_IMAGE_CLASS`
 * (src/components/gallery/containment.ts). That constant's hover scale
 * (`motion-safe:group-hover: scale-[1.04]` - space inserted before the
 * utility here only, round-5 review: Tailwind's source scanner reads raw
 * file bytes, so writing the bare trigger+utility combination UNBROKEN in
 * a comment is itself a valid candidate and compiles into the real
 * production stylesheet - see globals.css's own `@source not` comment for
 * the full account) is an affordance for an element that DOES
 * something on activation — gallery.tsx's tile is a `<button>` that opens
 * the lightbox. This tile is a `<figure>`: nothing happens when you hover or
 * click it (there is no per-item page yet to expand into — ugcportal-
 * qnq9.12, a dependency of this bead, has not landed), so a hover effect
 * would be false affordance, not polish. Round-1 review flagged the
 * mismatch directly: the hover utility was present with no `group` class on
 * any ancestor to trigger it, i.e. genuinely dead CSS. Dropping the hover
 * utility (rather than adding `group` to the figure) is the fix that keeps
 * the honest behaviour: nothing to hover FOR, so nothing hovers.
 */
const PORTFOLIO_TILE_IMAGE_CLASS = "h-full w-full object-cover";

/**
 * One sample on the portfolio page (ugcportal-qnq9.7, K1/K2).
 *
 * REUSES THE GALLERY'S OWN CAPTION AND TAG RENDERING — `GalleryItemCaption`
 * and `GalleryItemTags`, from src/components/gallery/gallery-item.tsx (a
 * plain, non-`"use client"` module factored out of gallery.tsx specifically
 * for this, round-2 review — see that file's own comment for why) — rather
 * than a second, near-identical copy of each. `galleryItemAlt` is reused the
 * same way for the `<img alt>`, and the `<figure>`'s own shape/mat classes
 * are `GALLERY_TILE_BASE_CLASS` (src/components/gallery/containment.ts,
 * round-5 review — factored out of `GALLERY_TILE_CLASS` specifically so
 * this component stopped hand-copying that string).
 *
 * WHAT IT DELIBERATELY DOES NOT REUSE: `gallery.tsx`'s `<button>` wrapper
 * and the PhotoSwipe activation/measuring machinery around it, for the
 * reason `PORTFOLIO_TILE_IMAGE_CLASS` above gives — nothing on this page
 * opens a viewer yet. A `<figure>`, not a button, is the honest element.
 */
export function PortfolioTile({
  piece,
  position,
}: {
  piece: GalleryItem;
  position: number;
}) {
  return (
    <li data-portfolio-piece={piece.id}>
      <figure className={GALLERY_TILE_BASE_CLASS}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={piece.previewSrc}
          alt={galleryItemAlt(piece, position)}
          className={PORTFOLIO_TILE_IMAGE_CLASS}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      </figure>
      <GalleryItemCaption item={piece} />
      <PortfolioSpecMarker />
      <GalleryItemTags item={piece} />
    </li>
  );
}

/**
 * K2: the spec/concept marker, rendered UNCONDITIONALLY on every piece — see
 * `SPEC_SAMPLE_LABEL`'s own comment in src/lib/portfolio.ts for why. K3 (an
 * advertising-disclosure label instead, for a real paid/gifted job) is not
 * implemented here; it is ugcportal-qnq9.1's field to add, and this
 * component's own render, not before.
 */
function PortfolioSpecMarker() {
  return (
    <p
      className="mt-1.5 text-xs font-semibold tracking-wide text-foreground uppercase"
      data-portfolio-marker="spec"
    >
      {SPEC_SAMPLE_LABEL}
    </p>
  );
}
