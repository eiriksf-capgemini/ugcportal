import Link from "next/link";

import { cn } from "cn";

import { GALLERY_STATE_CONTAINER_CLASS } from "@/components/gallery/containment";
import { SECTION_TITLE_CLASS } from "@/components/type-scale";
import { buttonVariants } from "@/components/ui/button";
import { PORTFOLIO_PATH } from "@/lib/routes";

/**
 * Scoped forced-colors focus-outline override (round-4 fix, ugcportal-qqnt.2)
 * — same fix, and the same reasoning for `outline-solid` over bare `outline`,
 * as src/components/home/hero.tsx's own `FORCED_COLORS_FOCUS_OUTLINE`
 * (see that file's comment for the full derivation and the Playwright
 * `forcedColors: "active"` verification). `buttonVariants`' shared base is
 * unfixed on purpose: see ugcportal-oavb.
 */
const FORCED_COLORS_FOCUS_OUTLINE =
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent";

/**
 * The front page's "living empty state" (ugcportal-6dvg K1/K2): what
 * src/app/page.tsx renders INSTEAD of `<Gallery>` the moment it already
 * knows, server-side, that the gallery is genuinely empty — the SAME
 * EXPRESSION `<Gallery>`'s own internal `GalleryEmpty`
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
 * isolation with no items, a real, still-tested case — this bead was told
 * not to change grid logic, and does not).
 *
 * The heading and body copy are GalleryEmpty's own, byte-for-byte: both
 * describe the identical, true state ("the listing was read successfully
 * and came back with nothing"), so there is no reason for the two to say it
 * differently, and keeping the exact words is what lets
 * src/app/page.test.tsx's existing K1 assertions
 * (`toContain("Nothing is published yet.")`,
 * `toContain('data-gallery-state="empty"')`) keep passing unchanged even
 * though they now exercise this component rather than GalleryEmpty.
 *
 * An `<h2>`, not an `<h1>` (ugcportal-qqnt.1): src/components/home/hero.tsx's
 * title is now the page's one real `<h1>` on every branch Home() can render,
 * so this heading — and GalleryEmpty's own copy of it, and
 * GalleryUnavailable's — step down to SECTION_TITLE_CLASS
 * (src/components/type-scale.ts) instead of each supplying its own `<h1>`.
 * Before this bead the hero rendered no heading element at all, which is why
 * an earlier version of this comment required THIS to be the real `<h1>`;
 * axe's `page-has-heading-one` rule (e2e/petrol-theme.spec.ts) still passes,
 * because something on the page still supplies a real `<h1>` — now the hero,
 * not this component.
 *
 * What is actually NEW here, the "living" half of the bead: an action. A
 * gallery with nothing in it yet is not a dead end — the portfolio
 * (src/app/portfolio/page.tsx, ugcportal-qnq9.7) already has finished,
 * curated work to look at while the first uploads arrive.
 */
export function EmptyState() {
  return (
    <div
      className={GALLERY_STATE_CONTAINER_CLASS}
      data-gallery-state="empty"
      data-home-empty-state
    >
      <h2 className={cn("max-w-2xl text-foreground", SECTION_TITLE_CLASS)}>
        Nothing is published yet.
      </h2>
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Photographs appear here as soon as they are published. Nothing is
        hidden from you — the gallery is genuinely empty.
      </p>
      {/*
        `motion-reduce:translate-none`, not `-transform-none` (round-3
        review finding, caught while verifying a related low finding):
        Tailwind v4's `translate-y-*` utilities (including `hover:
        -translate-y-0.5` below) compile to the standalone CSS `translate`
        property, not `transform` — confirmed empirically by compiling
        globals.css and reading the generated rule
        (`.hover\:-translate-y-0\.5:hover { translate: ...; }`). An earlier
        `motion-reduce:transform-none` here was accordingly a no-op: it set
        a property nothing else on this element ever touches, so it
        provided no actual belt-and-braces protection — `motion-safe:`
        gating the hover utility in the first place was doing all the real
        work.

        `translate-none` STILL never wins anything (round-4 review, low
        finding — the previous sentence here overclaimed that it does):
        `motion-safe:hover:-translate-y-0.5` and `motion-reduce:
        translate-none` compile into two MUTUALLY EXCLUSIVE media queries
        (`no-preference` vs `reduce`), so the hover rule this override would
        need to beat never coexists with it in the first place — whichever
        one applies, the other's rule does not exist at all. Kept anyway as
        a documented, deliberately inert belt-and-braces entry (matching
        the correct CSS property this time, unlike the `-transform-none` it
        replaced), not because it changes what is rendered.
      */}
      {/*
        buttonVariants, not a hand-rolled className (ugcportal-qqnt.2):
        `outline` — not `outline-neutral` — because this component renders
        on --background (the paper canvas: GALLERY_STATE_CONTAINER_CLASS
        sets no background of its own), the same surface
        src/components/auth-status.tsx's own `variant="outline"` sign-in
        controls render on. The hover-lift stays layered on top via `cn()`:
        it is this call site's own polish, not part of the shared system.

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

        Horizontal padding changes too (round-2 review, LOW, CONFIRMED):
        `size="lg"` gives `px-2.5`, not the `px-3` the hand-rolled className
        this replaces used — the same value every other `size="lg"` caller
        gets, not something specific to this call site.

        Focus-visible outline under forced colors (round-4 fix,
        ugcportal-qqnt.2): `FORCED_COLORS_FOCUS_OUTLINE` restores a real
        outline on THIS control only — buttonVariants' shared
        `outline-none`-plus-ring base still drops focus under forced-colors
        for every other caller; that systemic fix is ugcportal-oavb, not
        this bead.
      */}
      <Link
        href={PORTFOLIO_PATH}
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          "mt-6 h-auto min-h-9 w-fit max-w-full py-2 whitespace-normal motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:translate-none",
          FORCED_COLORS_FOCUS_OUTLINE,
        )}
      >
        See what is already finished, in the portfolio
      </Link>
    </div>
  );
}
