import Link from "next/link";
import type { ReactNode } from "react";

import { AuthStatus } from "@/components/auth-status";
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
        className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50"
      >
        Skip to content
      </a>

      {/*
        z-20 is the only stacking tier in the app today: this is the one
        sticky element and there are no overlays yet. Whoever adds the first
        dialog or popover should replace this with a documented tier scale
        rather than picking a bigger number.
      */}
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="min-w-0 truncate rounded-sm text-sm font-medium tracking-tight text-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            {SITE_NAME}
          </Link>
          {/*
            Auth is the only header action today. Nav links belong here, to
            the left of this, once there is more than one destination.
          */}
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
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
        <div className="mx-auto w-full max-w-6xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
          {SITE_NAME}
        </div>
      </footer>
    </div>
  );
}
