import Link from "next/link";

import { cn } from "cn";

import {
  GALLERY_TILE_BASE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
} from "@/components/gallery/containment";
import {
  GalleryItemAdvertisingLabel,
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
 *
 * `href` (ugcportal-qqnt.5): optional, and used only by the front page's
 * living empty state (src/components/home/empty-state.tsx), which shows a
 * row of these same tiles as its one way to reach /portfolio. When supplied,
 * the image itself becomes the activation target — a `<Link>` carrying
 * `GALLERY_TILE_BASE_CLASS` (the identical shape/mat the plain `<figure>`
 * below has) plus the `group`/focus-ring/hover treatment `gallery.tsx`'s own
 * `<button>` tile uses, and `GALLERY_TILE_IMAGE_CLASS` (not
 * `PORTFOLIO_TILE_IMAGE_CLASS`) on the image, so the hover-scale affordance
 * and its `prefers-reduced-motion` guard are the SAME declarations the main
 * gallery already relies on, not a second copy. The accessible name goes on
 * the `<Link>` (`galleryItemAlt`, the same string the `<img alt>` would
 * otherwise carry) with the image itself `aria-hidden`, mirroring
 * gallery.tsx's own button/image split exactly, for the same reason: a
 * link's accessible name and an unhidden image inside it would otherwise
 * announce the same photograph twice. /portfolio's own call (no `href`)
 * is completely unchanged by any of this — the two branches below render
 * identically to before whenever `href` is omitted.
 */
export function PortfolioTile({
  piece,
  position,
  href,
}: {
  piece: GalleryItem;
  position: number;
  href?: string;
}) {
  return (
    <li data-portfolio-piece={piece.id}>
      {/*
        The advertising-disclosure label (ugcportal-e0jv), FIRST — same
        reasoning as gallery.tsx's own tile: Forbrukertilsynet's rule is
        that the label is visible before anything else about the item. A
        portfolio piece is curated by a tag (PORTFOLIO_TAG_SLUG), not
        exempted from being a labelled benefit — nothing stops an operator
        curating a paid/gifted piece into this page, and this component
        used to render nothing for one (see PortfolioSpecMarker's own
        former comment, which pointed at this exact bead to fix it).
      */}
      <GalleryItemAdvertisingLabel item={piece} />
      {href ? (
        <Link
          href={href}
          aria-label={galleryItemAlt(piece, position)}
          className={cn(
            GALLERY_TILE_BASE_CLASS,
            "group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={piece.previewSrc}
            alt=""
            aria-hidden="true"
            className={GALLERY_TILE_IMAGE_CLASS}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </Link>
      ) : (
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
      )}
      <GalleryItemCaption item={piece} />
      {/*
        MUTUALLY EXCLUSIVE with the advertising label above, never both
        (ugcportal-e0jv): "Spec sample, not a client commission" and
        "Advertisement / Reklame" are opposite claims about the same piece,
        and showing both would assert them simultaneously. This is the K3
        branch `SPEC_SAMPLE_LABEL`'s own comment names as not implemented
        until this bead's field existed to drive it — it exists now.
      */}
      {piece.advertisingLabel === null ? <PortfolioSpecMarker /> : null}
      <GalleryItemTags item={piece} />
    </li>
  );
}

/**
 * K2: the spec/concept marker. Rendered on every piece that carries NO
 * advertising label (see the caller's own conditional, just above its one
 * use) — it used to be unconditional, back when there was no field
 * recording a real paid/gifted job to branch on at all; see
 * `SPEC_SAMPLE_LABEL`'s own comment in src/lib/portfolio.ts for that
 * history. K3 (the advertising-label branch, ugcportal-e0jv) is implemented
 * now, as `GalleryItemAdvertisingLabel` at the top of `PortfolioTile`, not
 * as a second branch of this function — the two markers never coexist, so
 * there was no reason to fold the advertising label's own rendering (and
 * its own, differently-styled badge, see GALLERY_ADVERTISING_LABEL_CLASS)
 * into this one.
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
