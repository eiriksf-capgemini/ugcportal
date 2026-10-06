import Link from "next/link";

import { cn } from "cn";

import {
  GALLERY_GRID_CLASS,
  GALLERY_STATE_CONTAINER_CLASS,
} from "@/components/gallery/containment";
import { PortfolioTile } from "@/components/portfolio/portfolio-tile";
import { SECTION_TITLE_CLASS } from "@/components/type-scale";
import { buttonVariants } from "@/components/ui/button";
import type { GalleryItem } from "@/lib/gallery-items";
import { PORTFOLIO_PATH } from "@/lib/routes";

/**
 * Up to this many portfolio pieces show in the empty state's tile row
 * (ugcportal-qqnt.5 K1) — a sample, not the whole portfolio: the full,
 * captioned set is one click away at /portfolio, and a row this wide
 * already fills the first viewport at 1440x900 without scrolling (this
 * bead's own K1).
 */
const MAX_EMPTY_STATE_PORTFOLIO_TILES = 6;

/**
 * The front page's "living empty state" (ugcportal-6dvg K1/K2, reworked by
 * ugcportal-qqnt.5): what src/app/page.tsx renders INSTEAD of `<Gallery>`
 * the moment it already knows, server-side, that the gallery is genuinely
 * empty — the SAME EXPRESSION `<Gallery>`'s own internal `GalleryEmpty`
 * (src/components/gallery/gallery.tsx) uses, both now via the shared
 * `isGenuinelyEmptyPage` (src/lib/gallery-items.ts; ugcportal-3wcd
 * consolidated gallery.tsx's own inline copy onto it), computed once in
 * page.tsx rather than re-derived here. NOT a guarantee the two decisions
 * can never disagree (round-2 review, low finding): page.tsx's call uses
 * the LISTING's raw `result.page` values, while `<Gallery>` evaluates the
 * same expression over `toGalleryItems(...)`-filtered items and its own
 * `initialHasMore && initialCursor !== null` — see page.tsx's own comment
 * on `isGenuinelyEmpty` for exactly where those two can part ways. That
 * gap is about the two callers' INPUTS, not the implementation, and is out
 * of ugcportal-3wcd's scope to close.
 *
 * A SEPARATE module, for exactly the reason GalleryUnavailable
 * (src/components/gallery/gallery-unavailable.tsx) already is one rather
 * than a second branch inside gallery.tsx's own "use client" file: this is
 * reachable only from src/app/page.tsx, a Server Component, as an
 * ALTERNATIVE to `<Gallery>` entirely — the two are never both on screen —
 * so it ships zero client bytes. `GalleryEmpty` itself is untouched and
 * stays reachable on its own terms (gallery.test.tsx renders `<Gallery>` in
 * isolation with no items, a real, still-tested case). `GalleryUnavailable`
 * is untouched too (ugcportal-qqnt.5's own out-of-scope note): the listing
 * FAILING is a different state from the listing succeeding with nothing in
 * it, and only the latter is this component's.
 *
 * `pieces` (ugcportal-qqnt.5): the curated portfolio sample
 * (src/lib/portfolio.ts's `listPortfolioPieces`, the same IMAGE-only,
 * public-preview-guarded query /portfolio itself reads), resolved by
 * src/app/page.tsx and passed in already-settled — the SAME pattern that
 * page's own `signedIn` prop to `<Hero>` uses, and for the identical
 * reason: `renderToStaticMarkup` cannot await a nested async Server
 * Component reached mid-render (src/components/upload-nav-link.tsx's own
 * comment, point 2), and every test of this component (this file's own,
 * and front-page-strings.test.tsx's) renders it synchronously. Keeping
 * `EmptyState` a plain, synchronous function — not an `async` Server
 * Component of its own — is what keeps that possible, and is also why the
 * query for `pieces` is NOT made here: Home() runs `listPortfolioPieces()`
 * once per render (the hero needs the same pieces on every branch,
 * ugcportal-qqnt.4) and hands this component the already-resolved array.
 *
 * THE SAME COMPONENT, not a new one (ugcportal-qqnt.5's own instruction):
 * every tile is a `<PortfolioTile>` (src/components/portfolio/
 * portfolio-tile.tsx), the identical component /portfolio renders its own
 * samples with, given an `href` so the image itself becomes the one way
 * this row reaches /portfolio (see that component's own comment on the
 * `href` prop for the accessible-name and motion-reduction reasoning).
 *
 * The heading and body copy are GalleryEmpty's own, byte-for-byte: both
 * describe the identical, true state ("the listing was read successfully
 * and came back with nothing"), so there is no reason for the two to say it
 * differently, and keeping the exact words is what lets
 * src/app/page.test.tsx's existing K1 assertions
 * (`toContain("Nothing is published yet.")`,
 * `toContain('data-gallery-state="empty"')`) keep passing unchanged even
 * though they now exercise this component rather than GalleryEmpty. The
 * SUPPORTING line below it is new (ugcportal-qqnt.5 K2): one short
 * sentence, no em-dash, replacing the previous two-sentence paragraph —
 * the portfolio tile row below is now the thing that fills the page, not a
 * second sentence of copy.
 *
 * An `<h2>`, not an `<h1>` (ugcportal-qqnt.1): src/components/home/hero.tsx's
 * title is now the page's one real `<h1>` on every branch Home() can render,
 * so this heading — and GalleryEmpty's own copy of it, and
 * GalleryUnavailable's — step down to SECTION_TITLE_CLASS
 * (src/components/type-scale.ts) instead of each supplying its own `<h1>`.
 * The tile row's own "From the portfolio" title (ugcportal-qqnt.5 K1) is a
 * SECOND `<h2>`, not a skipped level — axe's `heading-order` rule
 * (e2e/front-page.spec.ts) still passes, and `page.tags.test.tsx`'s own
 * total-heading-count assertion is about the PUBLISHED-gallery branch, which
 * this component never renders alongside.
 */
export function EmptyState({ pieces }: { pieces: GalleryItem[] }) {
  const featured = pieces.slice(0, MAX_EMPTY_STATE_PORTFOLIO_TILES);

  return (
    <div
      className={cn(GALLERY_STATE_CONTAINER_CLASS, "justify-start py-12 sm:py-16")}
      data-gallery-state="empty"
      data-home-empty-state
    >
      <h2 className={cn("max-w-2xl text-foreground", SECTION_TITLE_CLASS)}>
        Nothing is published yet.
      </h2>
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Photographs appear here as soon as they are published.
      </p>
      {/*
        buttonVariants, not a hand-rolled className (ugcportal-qqnt.2):
        `outline` — not `outline-neutral` — because this component renders
        on --background (the paper canvas: GALLERY_STATE_CONTAINER_CLASS
        sets no background of its own), the same surface
        src/components/auth-status.tsx's own `variant="outline"` sign-in
        controls render on. The hover-lift stays layered on top via `cn()`:
        it is this call site's own polish, not part of the shared system.

        THE ONE CALL TO ACTION ON `buttonVariants` (ugcportal-qqnt.5): this
        link is the single button-styled control in this component, on
        every branch — the portfolio tile row below is a second, non-button
        way to reach the same place (the photographs themselves are the
        affordance), not a second button competing with this one. No
        call-site override of the focus-visible outline is needed any more
        (ugcportal-oavb): `buttonVariants`' own base now draws a real
        outline on `focus-visible` under `forced-colors: active`, for every
        caller, not only this one.

        `whitespace-normal h-auto min-h-9 py-2`, overriding `buttonVariants`'
        own `whitespace-nowrap h-9` (CONFIRMED medium, found by the e2e
        horizontal-scroll check at 320px, not by any class-name comparison):
        every other buttonVariants caller on this page is a short label
        ("Sign in to upload", "Sign in with Google"), so a fixed single-line
        height never mattered before. This link's own sentence-length copy
        ("See what is already finished, in the portfolio") does not fit one
        line at 320px, and `buttonVariants`' base class forces
        `whitespace-nowrap` — which does not clip text, it makes the
        CONTAINER grow past the viewport instead, exactly the overflow
        e2e/header.spec.ts's own `hasHorizontalScroll` check (2px tolerance)
        exists to catch. `max-w-full` alongside `w-fit`: fit-content sizing
        still picks the single-line width where it fits (390px and up, see
        the PR's own screenshots), and only clamps at the viewport's own
        width where it does not.
      */}
      <Link
        href={PORTFOLIO_PATH}
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          "mt-6 h-auto min-h-9 w-fit max-w-full py-2 whitespace-normal motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:translate-none",
        )}
      >
        See what is already finished, in the portfolio
      </Link>

      {/*
        K2: zero portfolio pieces falls back to the copy and the one
        secondary link above, with no empty tile row — nothing below this
        point renders at all rather than an empty "From the portfolio"
        heading over an empty `<ul>`.
      */}
      {featured.length > 0 ? (
        <>
          <h2 className={cn("mt-10 text-foreground", SECTION_TITLE_CLASS)}>
            From the portfolio
          </h2>
          <ul className={cn("mt-4", GALLERY_GRID_CLASS)}>
            {featured.map((piece, index) => (
              <PortfolioTile
                key={piece.id}
                piece={piece}
                position={index}
                href={PORTFOLIO_PATH}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
