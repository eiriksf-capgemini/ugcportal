import type { ReactNode } from "react";

import { SiteHeader } from "@/components/site-header";
import { SITE_NAME } from "@/lib/site";

/**
 * The application frame (ugcportal-axu).
 *
 * Nothing owned a shared layout before this: src/app/layout.tsx had a bare
 * right-aligned div holding the auth widget, and each page invented its own
 * <main>. Three beads (axu, ugcportal-n3c, ugcportal-71y) were each in a
 * position to invent one; establishing the surface tokens made the header and
 * its hairline a question this bead had to answer anyway, so it answers it
 * here. n3c and 71y should render *into* this, not alongside it — in
 * particular they should not add their own <main>, because this one is the
 * page's single main landmark.
 *
 * Frame budget:
 *   header   variable, sticky, opaque (ugcportal-14k9: a wordmark/nav row
 *            plus a fixed-height tagline row; see src/components/site-
 *            header.tsx and the scroll-mt-24 note on <main> below for the
 *            number this grew to)
 *   content  flex-1, page decides its own max width and padding
 *   footer   auto, hairline above
 *
 * There is no side nav. The public surface is one continuous gallery (see the
 * note on ugcportal-jsc: subject is carried by tags on items, not by section
 * pages), and the admin area is two screens. A 256px rail for two links would
 * be frame for its own sake.
 *
 * The header is deliberately opaque rather than a translucent blur over the
 * scrolling feed. Text on a blurred photograph has no defined contrast ratio,
 * so it is exactly the thing the contrast gate in src/lib/design cannot check
 * and a reader cannot rely on.
 *
 * The header's own markup (wordmark, tagline, nav, mobile menu, the auth and
 * upload-link slots) lives in src/components/site-header.tsx, not here
 * (ugcportal-14k9) — this file keeps owning the frame itself: the skip link,
 * the single <main> landmark, and the footer, so this bead's growth and
 * ugcportal-3wgp's concurrent one-line banner mount do not collide on the
 * same block of JSX.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    /*
      min-h-dvh, not min-h-full: a percentage min-height needs a definite
      height on the ancestor chain to resolve against, and `body` only has a
      min-height, so `min-h-full` collapsed here and left the footer floating
      in the middle of a short page.
    */
    <div className="flex min-h-dvh flex-col bg-background">
      {/*
        `fixed`, not `absolute`. This wrapper is not a containing block, so an
        absolutely positioned skip link resolves against the initial
        containing block - i.e. the top of the document. Shift+Tab back to it
        from halfway down a page then scrolled the whole page to the top to
        bring it into view. Viewport-relative positioning has no such failure
        mode, and needs no `relative` ancestor to be correct.
      */}
      <a
        href="#main-content"
        /*
          ugcportal-j4j finding 4: `focus-visible:not-sr-only` un-hides the
          link by resetting position/width/height/padding/margin/etc in one
          rule, `.focus-visible\:not-sr-only:focus-visible { padding: 0; ... }`.
          That selector has specificity (0,2,0) - a class plus a pseudo-class
          - which beats plain `px-3`/`py-2` at (0,1,0), so the padding
          resetting is what wins the instant the link becomes visible: it
          rendered with zero padding at exactly the moment a keyboard user
          could see it. Repeating the padding utilities under the same
          `focus-visible:` variant ties the specificity instead, and Tailwind
          emits them after `not-sr-only` (spacing utilities sort after the
          accessibility category), so source order then decides it in their
          favour. Confirmed against the compiled CSS in
          app-shell.test.tsx, not just the class list - see that file's
          comment for why the class list alone does not prove this.
        */
        className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:px-3 focus-visible:py-2"
      >
        Skip to content
      </a>

      {/*
        z-20 is the only stacking tier in the app today: this is the one
        sticky element and there are no overlays yet. Whoever adds the first
        dialog or popover should replace this with a documented tier scale
        rather than picking a bigger number.

        The header's own content (wordmark, tagline, nav, the mobile menu,
        and the UploadNavLink/AuthStatus slots this file used to render
        inline) moved to src/components/site-header.tsx wholesale, including
        the `<header>` element itself, for ugcportal-14k9 — see that file's
        docstring. The shrink/truncate tuning the wordmark and the auth
        wrapper carry (what to give way first as the row runs out of width)
        moved with it rather than being re-derived; it is unchanged.
      */}
      <SiteHeader />

      {/*
        tabIndex={-1} so the skip link actually moves focus: a plain #hash
        jump scrolls but leaves focus on the link in most engines, so the next
        Tab continues from the header the user was trying to skip.

        scroll-mt-* matches the sticky header's height. Without it the
        browser scrolls this element's top edge to viewport top, the header
        covers it, and "Skip to content" lands the reader inside their own
        content, under the header, rather than just below it - past the
        <h1> on both admin screens (ugcportal-axu), and exactly the K3
        failure ugcportal-14k9 names: a sticky header that hides the focused
        element with no working skip link.

        scroll-mt-24 (96px), not scroll-mt-14 (56px) any more (ugcportal-
        14k9): the header grew a second, tagline row (src/components/site-
        header.tsx) once the wordmark/nav row could no longer carry it. That
        row's real height is 81px below the `sm` breakpoint (h-14's 56px +
        a one-line text-xs tagline at pb-2 + the header's own 1px border)
        and 85px at `sm` and above (the tagline switches to text-sm, one
        line taller); 96px is a deliberately round, single number comfortably
        above both rather than a `scroll-mt-[81px] sm:scroll-mt-[85px]` pair
        tracking two measured pixel counts a future font or spacing tweak
        could quietly invalidate. e2e/header.spec.ts verifies the real
        relationship directly - that the focused element's top is at or below
        the sticky header's bottom, post-skip, at each tested viewport -
        rather than trusting this arithmetic.

        outline-hidden only for this programmatic focus: a full-width ring
        round the entire content region is noise, and every control inside it
        keeps its own indicator.
      */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 scroll-mt-24 flex-col outline-hidden"
      >
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
          {SITE_NAME}
        </div>
      </footer>
    </div>
  );
}
