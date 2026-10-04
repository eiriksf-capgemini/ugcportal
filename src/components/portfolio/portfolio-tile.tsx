import {
  GALLERY_CAPTION_CLASS,
  GALLERY_TAG_CLASS,
  GALLERY_TAG_LIST_CLASS,
  GALLERY_TILE_ASPECT_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
} from "@/components/gallery/containment";
import { galleryItemAlt } from "@/lib/gallery-items";
import {
  PORTFOLIO_TAG_SLUG,
  SPEC_SAMPLE_LABEL,
  type PortfolioPiece,
} from "@/lib/portfolio";

/**
 * One sample on the portfolio page (ugcportal-qnq9.7, K1/K2/K3).
 *
 * REUSES THE GALLERY TILE'S STYLING AND ALT-TEXT LOGIC rather than inventing
 * a parallel visual language — `GALLERY_TILE_ASPECT_CLASS`,
 * `GALLERY_TILE_IMAGE_CLASS`, `GALLERY_CAPTION_CLASS` and the tag chip classes
 * are the exact constants src/components/gallery/gallery.tsx builds its own
 * tile from (src/components/gallery/containment.ts), and `galleryItemAlt` is
 * the same function that decides the gallery's `<img alt>`.
 *
 * WHAT IT DELIBERATELY DOES NOT REUSE: `gallery.tsx`'s `<button>` wrapper,
 * `GALLERY_TILE_CLASS`'s `cursor-zoom-in`, and the PhotoSwipe
 * activation/measuring machinery around it. That whole apparatus exists to
 * open a lightbox slide, and nothing on the portfolio page opens one — there
 * is no per-item page yet for a piece to link to or expand into
 * (ugcportal-qnq9.12, a dependency of this bead, has not landed) and
 * `gallery.tsx` is a `"use client"` component whose state (measured sizes,
 * viewer-activation gating) has no reader here. A `<figure>`, not a button,
 * is therefore the honest element: nothing happens when you activate it,
 * because nothing SHOULD yet. Extracting `gallery.tsx`'s tile into a shared
 * component both pages import was considered and set aside as a larger,
 * riskier refactor of tested, interaction-heavy code than this bead's render
 * half needs — flagged in the PR description for a reviewer to weigh in on,
 * not decided unilaterally by omission.
 */
export function PortfolioTile({
  piece,
  position,
}: {
  piece: PortfolioPiece;
  position: number;
}) {
  return (
    <li data-portfolio-piece={piece.id}>
      <figure
        className={`relative block w-full overflow-hidden rounded-md bg-surface-1 ${GALLERY_TILE_ASPECT_CLASS}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={piece.previewSrc}
          alt={galleryItemAlt(piece, position)}
          className={GALLERY_TILE_IMAGE_CLASS}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      </figure>
      <PortfolioCaption piece={piece} />
      <PortfolioMarker piece={piece} />
      <PortfolioTags piece={piece} />
    </li>
  );
}

/**
 * The one-line caption §5.3 asks for ("each with a one-line caption giving
 * format and length") — the uploader's own `caption` text, same field and
 * same sanitisation the gallery tile renders (ugcportal-gwr), with no second
 * "portfolio caption" field invented beside it. Curating the exact one-liner
 * (format and length, e.g. "Flat-lay photo set, 6 images") is the
 * uploader/admin's job when tagging a piece "portfolio" through the upload
 * form's picker — not something this component can enforce, since it is
 * exactly the same free-text field the gallery already shows.
 */
function PortfolioCaption({ piece }: { piece: PortfolioPiece }) {
  if (piece.caption === "") return null;
  return (
    <p className={GALLERY_CAPTION_CLASS} data-portfolio-caption={piece.id}>
      {piece.caption}
    </p>
  );
}

/**
 * K2/K3: the spec/concept marker, or the advertising-disclosure label — NEVER
 * both, and never neither silently meaning "commissioned". The two branches
 * below are an if/else, not two independent conditions, so the mutual
 * exclusivity is structural rather than a property of today's data: whichever
 * one of `advertisingLabel`/`isSpec` a future caller sets, at most one marker
 * can ever reach the DOM.
 *
 * `advertisingLabel` takes priority. A real paid/gifted job (once
 * ugcportal-qnq9.1 exists to record one) is the stronger legal fact — §2 step
 * 4 and §3.7 make a false "no brand involved" claim the one this whole bead
 * exists to prevent — so if a future bug ever set both fields on one piece,
 * showing the advertising label is the fail-safe direction: a sample that was
 * actually a paid job would still be labelled as paid, where defaulting to
 * the spec marker in that same bug would hide it.
 */
function PortfolioMarker({ piece }: { piece: PortfolioPiece }) {
  if (piece.advertisingLabel !== null && piece.advertisingLabel !== "") {
    return (
      <p
        className="mt-1.5 text-xs font-semibold tracking-wide text-foreground uppercase"
        data-portfolio-marker="advertisement"
      >
        {piece.advertisingLabel}
      </p>
    );
  }

  if (piece.isSpec) {
    return (
      <p
        className="mt-1.5 text-xs font-semibold tracking-wide text-foreground uppercase"
        data-portfolio-marker="spec"
      >
        {SPEC_SAMPLE_LABEL}
      </p>
    );
  }

  return null;
}

/**
 * The subject tags under one piece, identical in markup and styling to the
 * gallery's own `GalleryItemTags` (src/components/gallery/gallery.tsx).
 *
 * `listPortfolioPieces`/`visibleTags` (src/lib/portfolio.ts) already strips
 * the curation tag itself before a piece reaches this component — this
 * filter is a second, defence-in-depth check rather than the real fix,
 * cheap enough to keep so this component renders the same promise on its own
 * (never show the internal curation label as if it were a subject) rather
 * than trusting its one caller to have done so.
 */
function PortfolioTags({ piece }: { piece: PortfolioPiece }) {
  const tags = piece.tags.filter((tag) => tag.slug !== PORTFOLIO_TAG_SLUG);
  if (tags.length === 0) return null;
  return (
    <ul className={GALLERY_TAG_LIST_CLASS}>
      {tags.map((tag) => (
        <li key={tag.slug} className={GALLERY_TAG_CLASS} data-gallery-tag={tag.slug}>
          {tag.name}
        </li>
      ))}
    </ul>
  );
}
