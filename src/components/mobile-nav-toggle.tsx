"use client";

import { Menu, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PrimaryNavLink } from "@/components/primary-nav-link";

export type NavItem = { href: string; label: string };

const MOBILE_NAV_PANEL_ID = "mobile-nav-panel";

/**
 * The collapsed, small-viewport form of the header's main navigation
 * (ugcportal-14k9 — "mobile menu"). The always-visible desktop form (the
 * `<nav>` in src/components/site-header.tsx, hidden below `md` with
 * `md:hidden` on this component's own wrapper taking over at that point) is
 * a second, separate rendering of the same `items` — not a CSS-repositioned
 * copy of this one — because collapsing the SAME markup behind `display:
 * none` at the panel's resting state would leave the full set of links in
 * the accessibility tree and the tab order even while visually hidden, which
 * is exactly the "every navigation item can be reached and activated with
 * the keyboard" guarantee K1 asks for, inverted: a keyboard user tabbing
 * through a closed menu would land on destinations with nothing on screen
 * to show for it.
 *
 * The panel only exists in the tree at all while `open` is true (`{open &&
 * ...}`, not a `hidden` class) for the same reason: nothing inside it is
 * focusable, and therefore nothing inside it is reachable by Tab, until the
 * toggle button has actually been activated — which is also what keeps a
 * narrow-viewport Playwright run's "Tab reaches every nav item" check
 * honest rather than passing by reaching links no visitor could see.
 *
 * Why this needed its own component rather than inlining a `useState` into
 * site-header.tsx: that file is a plain Server Component (no "use client"),
 * for the reason its own header-row comment states — AppShell's nav slot and
 * auth widget must stay concurrent, un-awaited siblings, and a client
 * boundary cannot contain a Server Component's own async data fetching
 * inside it. Isolating the one genuinely interactive piece here keeps
 * site-header.tsx free to stay a Server Component and still compose
 * UploadNavLink/AuthStatus as ordinary children.
 */
export function MobileNavToggle({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative md:hidden">
      {/*
        variant="outline", not "ghost" (PR #94 review round 1 finding):
        ghost's text colour is text-ink (src/components/ui/button.tsx),
        documented there as safe only inside one of the old near-black
        wells (bg-surface-*, bg-destructive-surface, ...) - never measured
        against --background, because nothing was expected to put it there.
        This button sits directly on the header's bg-background, where
        text-ink measures roughly 1.1:1 in light mode - the icon was
        functionally invisible. "outline" uses text-primary/border-primary
        instead, the exact pairing contrast.ts's "link-on-background" entry
        already covers at the stricter 4.5:1 body threshold (well above the
        3:1 a non-text UI boundary needs), because it is the same token
        AuthStatus's own sign-in buttons already render on this same
        background. mobile-nav-toggle.contrast.test.tsx pins this
        component-locally too, resolving whichever foreground token it
        actually ships against --background in both colour schemes, rather
        than only trusting the system-wide pairing to stay in sync with
        whatever variant this file happens to use.
      */}
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-expanded={open}
        aria-controls={MOBILE_NAV_PANEL_ID}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
      </Button>

      {open && (
        <nav
          id={MOBILE_NAV_PANEL_ID}
          aria-label="Main navigation"
          className="absolute top-full right-0 left-0 z-10 mt-2 min-w-40 rounded-lg border border-border bg-background p-2 shadow-md"
        >
          <ul className="flex flex-col">
            {items.map((item) => (
              <li key={item.href}>
                <PrimaryNavLink
                  href={item.href}
                  onNavigate={() => setOpen(false)}
                  className="block rounded-md px-3 py-2 hover:bg-accent hover:text-accent-foreground"
                >
                  {item.label}
                </PrimaryNavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
