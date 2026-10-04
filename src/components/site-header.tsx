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
 * `HEADER_HEIGHT_PX` ties this component's real rendered height to app-
 * shell.tsx's `<main>` (PR #94 review round 2, finding 3) — the skip link
 * moves focus there, and a sticky header must never cover the element focus
 * just landed on (K3). Before this, the two files each carried their OWN
 * number (this file's row heights; app-shell.tsx's `scroll-mt-24`, padded
 * well above the real height "to be safe") - two independently-reasoned
 * numbers that happened to agree, which is exactly the shape a later change
 * to either one could silently break. Now there is one: AppShell reads
 * `HEADER_HEIGHT_PX` from here and publishes it as a `--header-height` CSS
 * custom property, which <main>'s `scroll-mt-[var(--header-height)]`
 * (a literal, Tailwind-detectable arbitrary value - not a template-literal
 * interpolation of the number, which Tailwind's static source scan cannot
 * see) then reads. See app-shell.tsx's own comment for why the property has
 * to be declared on the shared ancestor rather than on this component's own
 * `<header>` element: CSS custom properties cascade to descendants, and
 * `<header>` and `<main>` are siblings, not ancestor and descendant.
 *
 * The number itself: 56px (`h-14`, the wordmark/nav row) + 28px (`h-7`, the
 * tagline row below - see that row's own comment for why it is a fixed
 * height rather than tracking the text's natural line-height) + 1px (this
 * element's own `border-b`) = 85px. e2e/header.spec.ts still measures the
 * real rendered boxes rather than trusting this arithmetic either - the
 * point of the shared variable is that there is now only one number to get
 * right, not that getting it right stops being worth checking for real.
 */
export const HEADER_HEIGHT_PX = 85;

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

          `h-7` (28px), not the text's own natural line-height plus padding
          (PR #94 review round 2, finding 3): `text-xs`'s line-height is
          16px and `sm:text-sm`'s is 20px, so the row used to be a different
          height below `sm` than at it - meaning HEADER_HEIGHT_PX below would
          have needed to be two numbers, one per breakpoint, which is exactly
          the kind of thing this component and <main>'s scroll-margin could
          drift apart on without either file's author noticing. `h-7 flex
          items-center` fixes the row at one height regardless of which text
          size is active, so this component's total rendered height - and
          therefore HEADER_HEIGHT_PX - is a single constant, true at every
          viewport this bead tests.

          `truncate` keeps this row to exactly one line even if the sentence
          grows at some future rewrite - needed for the fixed height above to
          keep meaning what it says. Even truncated, the full sentence stays
          in the DOM and the accessible name - only the visual rendering
          clips, which is what K2's "snapshot of the header strings" below
          reviews rather than a screenshot.
        */}
        <p className="flex h-7 items-center truncate text-xs text-muted-foreground sm:text-sm">
          {SITE_TAGLINE}
        </p>
      </div>
    </header>
  );
}
