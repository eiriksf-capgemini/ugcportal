import Link from "next/link";

import { AuthStatus } from "@/components/auth-status";
import { MobileNavToggle, type NavItem } from "@/components/mobile-nav-toggle";
import { PrimaryNavLink } from "@/components/primary-nav-link";
import { UploadNavLink } from "@/components/upload-nav-link";
import { ABOUT_PATH } from "@/lib/routes";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

/**
 * The site header (ugcportal-14k9): wordmark, tagline, main navigation
 * (Gallery, About), and the sign-in controls. Moved out of app-shell.tsx
 * wholesale, including the `<header>` element itself, so that file can stay
 * the thin frame it already was — skip link, this component, `<main>`,
 * footer — rather than growing a second large block of markup alongside it.
 * ugcportal-3wgp's banner mount is expected to land as one more sibling line
 * in that same frame; nothing here changes the frame's shape.
 *
 * In scope per the bead: English copy only (no "For sale" — that returns
 * with the marketplace beads, see src/lib/routes.ts's ABOUT_PATH comment and
 * site.ts's SITE_TAGLINE comment for the wine-accessory wording this bead is
 * bound by), sticky header, mobile menu, sign-in controls visually secondary
 * to the tagline and nav (AuthStatus already renders `variant="outline"` —
 * see that component's own comment — so nothing here needs to re-style it
 * down).
 *
 * A plain synchronous Server Component, like AppShell itself was before this
 * bead and remains after it: UploadNavLink and AuthStatus are each already
 * async Server Components rendered as un-awaited sibling elements (see
 * app-shell.tsx's own comment on why an `await` in an ancestor would
 * serialise the session lookup ahead of the page's own data fetching), and
 * composing them here instead of in AppShell directly preserves that —
 * nothing in this file calls or awaits either.
 *
 * Two fixed, measured numbers tie this component to app-shell.tsx's <main>:
 * the row heights below (h-14 for the wordmark/nav row, a fixed-height
 * single-line tagline row) sum to the `scroll-mt-*` app-shell.tsx sets on
 * <main>, so the skip link lands a keyboard user just below this header
 * rather than partly under it (K3: a sticky header must never hide the
 * focused element). Changing either row's height here means updating that
 * scroll-mt too — e2e/header.spec.ts asserts the two stay in step by
 * measuring the real rendered boxes rather than trusting either number.
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Gallery" },
  { href: ABOUT_PATH, label: "About" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="flex h-14 items-center gap-4">
          {/*
            Same wordmark treatment app-shell.tsx shipped before this bead
            (shrink-[999]/min-w-12/truncate — see the removed block's own
            comment, preserved in git history): the wordmark still gives way
            first under width pressure, before the nav, before the auth
            actions. A plain Link, not PrimaryNavLink: the brand mark is not
            part of the nav's "which page am I on" semantics (it is also the
            Gallery destination's own href, "/", and marking both it and the
            "Gallery" nav item aria-current="page" at once would be a
            confusing double signal for no benefit), so it carries no
            aria-current.
          */}
          <Link
            href="/"
            className="min-w-12 shrink-[999] truncate rounded-sm text-sm font-medium tracking-tight text-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            {SITE_NAME}
          </Link>

          <MobileNavToggle items={NAV_ITEMS} />

          {/*
            The desktop form of the same nav MobileNavToggle renders below
            `md` — see that component's own comment for why this is a
            second, separate rendering of NAV_ITEMS rather than one markup
            block repositioned by CSS.
          */}
          <nav aria-label="Main navigation" className="hidden md:flex">
            <ul className="flex items-center gap-4 text-sm">
              {NAV_ITEMS.map((item) => (
                <li key={item.href}>
                  <PrimaryNavLink href={item.href}>{item.label}</PrimaryNavLink>
                </li>
              ))}
            </ul>
          </nav>

          <UploadNavLink />

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <AuthStatus />
          </div>
        </div>

        {/*
          The tagline, on its own fixed-height row rather than squeezed into
          the wordmark row (K1: it must stay visible, not truncated away,
          at 375px alongside two sign-in buttons and up to two nav links).
          `truncate` keeps this row's height to exactly one line in every
          case so the `scroll-mt-*` on <main> this component's own docstring
          names stays a single correct number across all three tested
          viewports, rather than one that is only right where the sentence
          happens to fit on one line. Even truncated, the full sentence stays
          in the DOM and the accessible name - only the visual rendering
          clips, which is what K2's "snapshot of the header strings" below
          reviews rather than a screenshot.
        */}
        <p className="truncate pb-2 text-xs text-muted-foreground sm:text-sm">
          {SITE_TAGLINE}
        </p>
      </div>
    </header>
  );
}
