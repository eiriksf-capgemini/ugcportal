import Link from "next/link";
import type { ReactNode } from "react";

import { AuthStatus } from "@/components/auth-status";
import { CookieSettingsLink } from "@/components/consent/cookie-settings-link";
import { UploadNavLink } from "@/components/upload-nav-link";
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
 *   header   56px (h-14), sticky, opaque
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
 * DOCUMENTED DEPENDENCY (ugcportal-3wgp review round 4, finding 9; updated
 * round 5, finding 7): the footer renders `CookieSettingsLink`, which only
 * actually does anything with a `ConsentProvider` above it in the tree.
 * `src/app/layout.tsx` provides one for every real page; anything else
 * rendering `AppShell` directly should do the same to get a working
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
        z-20: this header's own sticky tier. No longer the only one in the
        app (review round 1, ugcportal-3wgp, finding 5) — the cookie-consent
        banner (src/components/consent/cookie-banner.tsx) is the first
        overlay, at z-40, deliberately above this header. There is still no
        documented tier SCALE (no --z-* tokens in globals.css); whoever adds
        a third stacking context should introduce one rather than everyone
        picking their own bigger number.
      */}
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            /*
              shrink-[999] sets an explicit yield order for the header row:
              the wordmark gives way first, then the signed-in user's name,
              and the nav link and button labels never do. Flexbox distributes
              shrinkage in proportion to base-size x shrink-factor, so an
              outsized factor here means the wordmark is fully consumed before
              any pressure reaches the actions.

              min-w-12 (3rem), not min-w-0 (ugcportal-t0y round 2 finding):
              the nav slot this bead added is shrink-0, so it and its gap now
              take a fixed ~70px out of the row before any shrinkage is
              distributed at all, and at a 320px viewport with a long
              signed-in email, a shrink-[999] item with NO floor can be
              squeezed to zero width - taking the only link back to "/" with
              it. A small floor keeps a truncated sliver of the wordmark on
              screen (and clickable) in that case; it does not fully solve
              narrow-viewport layout, which is ugcportal-2al's job.
            */
            className="min-w-12 shrink-[999] truncate rounded-sm text-sm font-medium tracking-tight text-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            {SITE_NAME}
          </Link>
          {/*
            The nav slot (ugcportal-t0y). /upload is the first destination
            reachable from the app's own chrome - the three admin settings
            screens (users, rights, instagram) are real destinations too and
            still have none of their own, a gap this bead's scope does not
            cover.

            UploadNavLink is its own component (src/components/upload-nav-
            link.tsx), not inlined here, so this function can stay a plain
            synchronous one: React only starts rendering `children` once
            AppShell itself has returned, so an `await` in *this* function's
            body - the shape round 1 of this bead shipped with - would
            serialise the session lookup ahead of the page's own data
            fetching for every page, including an anonymous gallery visitor
            on "/" who will never see this link at all. Kept as a sibling
            element instead, it renders concurrently with `{children}` and
            with AuthStatus - see that component's own comment for how the
            two avoid paying for the session twice between them despite
            neither awaiting the other.

            A real <nav> landmark, not a bare <a>, so a screen reader user can
            jump to it directly; aria-label distinguishes it from a future
            second nav region rather than leaving both as an unlabelled
            "navigation" landmark. It sits in DOM order between the wordmark
            and the auth actions, so tab order reads left to right exactly as
            the row is laid out - no tabIndex tricks, and no change to the
            skip link's target or position.
          */}
          <UploadNavLink />

          {/*
            Auth is the other header action. min-w-0, and no shrink-0. The
            two together used to cancel:
            shrink-0 sized this to max-content, which made the truncate on the
            signed-in user's name inert and sent a long email off the right
            edge at 320-375px.

            Relying on the default `min-width: auto` instead does not work
            either, and the reason is worth writing down. min-width:0 on the
            name removes its *floor*; it does not cap its min-content
            contribution, and `truncate` sets white-space: nowrap, so that
            contribution is the full width of the text. The wrapper's
            automatic minimum would therefore be the whole untruncated email -
            measured at 700px for a long address - and it would refuse to
            shrink at all. Hence min-w-0 here, with the yield order set
            explicitly on the wordmark above rather than left to min-content.
          */}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <AuthStatus />
          </div>
        </div>
      </header>

      {/*
        tabIndex={-1} so the skip link actually moves focus: a plain #hash
        jump scrolls but leaves focus on the link in most engines, so the next
        Tab continues from the header the user was trying to skip.

        scroll-mt-14 matches the 56px sticky header. Without it the browser
        scrolls this element's top edge to viewport top, the header covers it,
        and "Skip to content" lands the reader 56px into their own content -
        past the <h1> on both admin screens. Keep the two in step.

        outline-hidden only for this programmatic focus: a full-width ring
        round the entire content region is noise, and every control inside it
        keeps its own indicator.
      */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 scroll-mt-14 flex-col outline-hidden"
      >
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <span>{SITE_NAME}</span>
          {/* ugcportal-3wgp K4 — reopens the cookie choice. ugcportal-akv6 owns final footer placement. */}
          <CookieSettingsLink />
        </div>
      </footer>
    </div>
  );
}
