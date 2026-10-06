import type { CSSProperties, ReactNode } from "react";

import { HEADER_HEIGHT_PX, SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

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
 *   header   fixed, sticky, opaque, one row (ugcportal-14k9, one row since
 *            ugcportal-qqnt.3 dropped the header's second, tagline row; see
 *            src/components/site-header.tsx's HEADER_HEIGHT_PX and the
 *            `--header-height` note on the root div below for the number)
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
 * The header's own markup (brand mark, wordmark, nav, mobile menu, the auth
 * and upload-link slots) lives in src/components/site-header.tsx, not here
 * (ugcportal-14k9) — this file keeps owning the frame itself: the skip link,
 * the single <main> landmark, and the footer.
 *
 * DOCUMENTED DEPENDENCY (ugcportal-3wgp review round 4, finding 9; updated
 * round 5, finding 7; footer itself moved out to src/components/site-
 * footer.tsx by ugcportal-akv6): the footer renders `CookieSettingsLink`,
 * which only actually does anything with a `ConsentProvider` above it in
 * the tree. `src/app/layout.tsx` provides one for every real page; anything
 * else rendering `AppShell` directly should do the same to get a working
 * "Cookies" control. This is no longer a HARD dependency, though, the way
 * round 4 documented it: `CookieSettingsLink` now degrades gracefully
 * (renders nothing — see its own doc comment) rather than throwing when no
 * provider is present, so a caller without one (a Storybook story, an
 * isolated test, a future reuse outside the real app) gets a shell with a
 * quietly absent footer link, not a hard crash. The dependency itself is
 * unchanged — only the failure mode when it is missing — so this stays
 * documented here rather than being removed now that it no longer crashes.
 * (`app-shell.nav.test.tsx` still mocks `CookieSettingsLink` out entirely
 * rather than wrapping in a provider, same as its other two stubs, since
 * that file is about the shell's own static structure, not the consent
 * gate — not because leaving it unmocked would crash anymore.)
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    /*
      min-h-dvh, not min-h-full: a percentage min-height needs a definite
      height on the ancestor chain to resolve against, and `body` only has a
      min-height, so `min-h-full` collapsed here and left the footer floating
      in the middle of a short page.

      `--header-height` (PR #94 review round 2, finding 3) is declared HERE,
      on the root div, rather than on <SiteHeader />'s own <header> element -
      not a style choice, a CSS constraint: a custom property cascades to an
      element's DESCENDANTS, and <header>/<main> are siblings under this div,
      not ancestor and descendant. Declaring it on their nearest common
      ancestor is the only place in this tree where both can read it. The
      NUMBER itself is not re-derived here, though: it is imported straight
      from site-header.tsx's own HEADER_HEIGHT_PX (see that file's comment
      for the arithmetic), so this file does not carry a second, independent
      guess of the header's height the way `scroll-mt-24` used to.
    */
    <div
      className="flex min-h-dvh flex-col bg-background"
      style={{ "--header-height": `${HEADER_HEIGHT_PX}px` } as CSSProperties}
    >
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
        z-20: this header's own sticky tier. No longer the only one in the
        app (review round 1, ugcportal-3wgp, finding 5) — the cookie-consent
        banner (src/components/consent/cookie-banner.tsx) is the first
        overlay, at z-40, deliberately above this header. The mobile nav
        popover (src/components/mobile-nav-toggle.tsx, ugcportal-14k9) is
        the second, at a z-index higher than this header's z-20 so the panel
        does not paint under the sticky header when opened on a scrolled
        page — see that file's own comment. There is still no documented
        tier SCALE (no --z-* tokens in globals.css); whoever adds a fourth
        stacking context should introduce one rather than everyone picking
        their own bigger number.

        The header's own content (brand mark, wordmark, nav, the mobile menu,
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

        scroll-mt-[var(--header-height)], not a literal scroll-mt-24 any
        more (PR #94 review round 2, finding 3): the root div above declares
        `--header-height` from site-header.tsx's own HEADER_HEIGHT_PX, so
        this reads the SAME number the header's rows are sized from rather
        than a second, independently-reasoned Tailwind scale value that
        happened to agree with it. `[var(--header-height)]`, not a
        `${HEADER_HEIGHT_PX}px` template literal baked into the class name:
        Tailwind's source scan looks for a literal arbitrary-value string in
        the compiled output, and a template-literal interpolation does not
        produce one at the point Tailwind reads this file's text - `var(...)`
        is itself the literal, resolved later by the browser's own cascade,
        which is exactly what makes this safe to write once here rather than
        import-and-interpolate. e2e/header.spec.ts still verifies the real
        relationship directly - that the focused element's top is at or
        below the sticky header's bottom, post-skip, at each tested viewport
        - rather than trusting this arithmetic, single-sourced or not.

        outline-hidden only for this programmatic focus: a full-width ring
        round the entire content region is noise, and every control inside it
        keeps its own indicator.
      */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 scroll-mt-[var(--header-height)] flex-col outline-hidden"
      >
        {children}
      </main>

      <SiteFooter />
    </div>
  );
}
