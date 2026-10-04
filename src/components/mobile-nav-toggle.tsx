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
      <Button
        type="button"
        variant="ghost"
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
