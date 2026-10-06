import Link from "next/link";

import { cn } from "cn";

import { AuthStatus } from "@/components/auth-status";
import { MobileNavToggle, type NavItem } from "@/components/mobile-nav-toggle";
import { PrimaryNavLink } from "@/components/primary-nav-link";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { SIX_XL_CONTAINER_CLASS } from "@/components/site/page-shell";
import { UploadNavLink } from "@/components/upload-nav-link";
import { ABOUT_PATH } from "@/lib/routes";
import { SITE_NAME } from "@/lib/site";

/**
 * The site header (ugcportal-14k9, one-row layout by ugcportal-qqnt.3):
 * brand mark, wordmark, main navigation (Gallery, About), and the sign-in
 * control. Moved out of app-shell.tsx wholesale, including the `<header>`
 * element itself, so that file can stay the thin frame it already was — skip
 * link, this component, `<main>`, footer — rather than growing a second
 * large block of markup alongside it. ugcportal-3wgp's banner mount is
 * expected to land as one more sibling line in that same frame; nothing here
 * changes the frame's shape.
 *
 * In scope per the original bead: English copy only (no "For sale" — that
 * returns with the marketplace beads, see src/lib/routes.ts's ABOUT_PATH
 * comment and site.ts's SITE_TAGLINE comment for the wine-accessory wording
 * this bead is bound by), sticky header, mobile menu.
 *
 * ONE ROW, NOT TWO (ugcportal-qqnt.3): this used to carry a second,
 * fixed-height tagline row below the wordmark/nav row, repeating almost
 * verbatim what the hero already said one scroll below it — and the
 * wordmark rendered at the exact same size and weight as the nav links next
 * to it, so nothing on the page told a visitor whose site this was. The
 * tagline row is gone (SITE_TAGLINE now lives on the footer — see that
 * module's own comment on site.ts — not deleted), and the wordmark gained a
 * small petrol brand mark (docs/design/forside.html's `.brand-mark`, a
 * 28px petrol square - src/components/site-header.height.test.ts compiles
 * `size-7` and checks that number directly) plus its own `font-heading`/
 * `text-lg`/`font-medium`
 * treatment — larger than the nav links' `text-sm` (K1) — so the one
 * remaining row reads brand-first rather than as a flat list of
 * equally-weighted strings. The sign-in side also collapsed from two
 * always-visible outline buttons to one `SignInMenu` disclosure — see
 * auth-status.tsx's own comment for why.
 *
 * A plain `Link`, not `PrimaryNavLink`: the brand mark is not part of the
 * nav's "which page am I on" semantics (it is also the Gallery destination's
 * own href, "/", and marking both it and the "Gallery" nav item
 * aria-current="page" at once would be a confusing double signal for no
 * benefit), so it carries no aria-current. It no longer shares
 * HEADER_NAV_LINK_CLASS with the nav links either (round ugcportal-qqnt.3):
 * that class's `text-sm font-medium` is exactly the size/weight K1 asks the
 * wordmark to outrank, so reusing it here would have fought the bead's own
 * acceptance criterion. `FOCUS_RING_CLASS` (the same three focus-visible
 * utilities HEADER_NAV_LINK_CLASS itself is built from, src/components/ui/
 * focus-ring.ts) keeps the keyboard-focus treatment identical to every
 * other header link despite that split.
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
 * The number itself (PR #94 review round 5, finding 4; reduced to two terms
 * by ugcportal-qqnt.3 once the tagline row was removed): two named
 * constants, each mirroring the ONE Tailwind utility it stands for, summed -
 * not a single pre-added number a reader has to trust matches the markup
 * below. `WORDMARK_ROW_PX` is `h-14` (this row); `BORDER_PX` is this
 * element's own `border-b`. Naming each one after its class means a future
 * change to `h-14`/the border width has exactly one matching arithmetic
 * input to update, in the same place, rather than a single opaque total
 * someone has to re-derive from the markup. K1 asks for a one-row header no
 * taller than 64px; `h-14` (56px) plus the 1px border comes to 57px, inside
 * that budget with no further tuning needed.
 * src/components/site-header.height.test.ts compiles the real utility
 * classes site-header.tsx actually ships against the real, vendored
 * Tailwind and checks each named constant against its real compiled value,
 * not just the total; e2e/header.spec.ts separately measures the real
 * rendered header box rather than trusting this arithmetic either way - the
 * point of the shared variable is that there is only one number to get
 * right, not that getting it right stops being worth checking for real.
 */
export const WORDMARK_ROW_PX = 56; // h-14
export const BORDER_PX = 1; // border-b
export const HEADER_HEIGHT_PX = WORDMARK_ROW_PX + BORDER_PX;

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Gallery" },
  { href: ABOUT_PATH, label: "About" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      {/*
        SIX_XL_CONTAINER_CLASS (PR #94 review round 5, reuse finding 6), not
        the same "mx-auto w-full max-w-6xl px-4 sm:px-6" re-spelled a second
        time: src/components/site/page-shell.tsx already names this exact
        string for its own WIDE variant. Not that variant itself, though -
        it also carries `flex-1 py-12`, which this precisely-sized header
        (see HEADER_HEIGHT_PX above) cannot absorb without breaking its own
        arithmetic - see that constant's own comment for why it was split
        out as its own export instead.
      */}
      <div className={SIX_XL_CONTAINER_CLASS}>
        <div className="flex h-14 items-center gap-4">
          {/*
            Brand mark + wordmark, one unit (ugcportal-qqnt.3): the mark is a
            decorative `aria-hidden` square (docs/design/forside.html's
            `.brand-mark`, 28px/`size-7`, petrol fill via the same
            `bg-primary` token the solid button variant uses) - it carries no
            independent meaning a screen reader needs, the Link's own
            accessible name ("UGC Portal") already says where it goes.
            `shrink-0` on the mark so it is the wordmark's TEXT that gives
            way first under width pressure (the same "wordmark still shrinks
            before the nav, before the auth actions" behaviour app-shell.tsx
            shipped before this bead, preserved on the text span via
            `min-w-0 truncate` rather than on the whole link via `min-w-12`
            now that the link also has to make room for the mark).
          */}
          <Link
            href="/"
            className={cn(
              "flex min-w-12 shrink-[999] items-center gap-2 rounded-sm font-heading text-lg font-medium tracking-tight text-foreground hover:text-primary",
              FOCUS_RING_CLASS,
            )}
          >
            <span aria-hidden="true" className="size-7 shrink-0 rounded-md bg-primary" />
            <span className="min-w-0 truncate">{SITE_NAME}</span>
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
      </div>
    </header>
  );
}
