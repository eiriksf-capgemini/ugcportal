"use client";

import { Popover } from "@base-ui/react/popover";
import { Menu, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PrimaryNavLink } from "@/components/primary-nav-link";

export type NavItem = { href: string; label: string };

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
 * Built on `@base-ui/react/popover` (PR #94 review round 3 medium finding),
 * not the hand-rolled `{open && <nav>...}` toggle this shipped with: that
 * version opened and closed on click, but nothing dismissed it on Escape or
 * on a pointer-down outside it, and nothing returned focus to the toggle
 * button when it closed — a keyboard or screen-reader visitor who opened it
 * had no way to leave it except Tab-ing all the way through its contents.
 * Popover is the right primitive for exactly this shape (a disclosure
 * anchored to a trigger button) and ships all three for free: Escape and
 * outside-press both dismiss it by default, and `finalFocus` (its own
 * default) returns focus to the trigger that opened it. `Collapsible`
 * (this package's other obvious candidate) was considered and rejected —
 * confirmed by reading its source, not assumed: it has no dismissal model
 * at all (no Escape handling, no outside-press detection anywhere in
 * `@base-ui/react/collapsible`), because a plain expand/collapse disclosure
 * is a different interaction pattern than an overlay popup.
 *
 * Still fully controlled (`open`/`onOpenChange`, not `defaultOpen`): a nav
 * item's own click needs to close the panel too (see `onNavigate` below),
 * and owning the state here rather than letting Popover manage it
 * internally means that close path and Popover's own dismissal paths
 * (Escape, outside-press) all funnel through the same `setOpen`, rather
 * than this component needing to reconcile two independent sources of
 * truth about whether the panel is open.
 *
 * `Popover.Close` (a built-in button that closes the popover on click) was
 * deliberately NOT used to wrap the nav links: it renders via `useButton`,
 * which is written for a focusable, button-ROLE target, not for composing
 * onto a semantic `<a>` — this package's own `render` prop lets any element
 * be substituted, but verified here that the substitution is only safe when
 * the thing underneath already behaves like a button. Passing `onNavigate`
 * through to `PrimaryNavLink` and closing from there keeps the nav items
 * exactly the plain links they already were everywhere else in this header.
 *
 * `Popover.Popup` defaults to `role="dialog"` with `aria-labelledby`/
 * `aria-describedby` wired to a `Popover.Title`/`Popover.Description` this
 * component doesn't render — wrong semantics for a navigation menu, not a
 * dialog. `render={<nav />}` swaps the rendered tag, and the explicit
 * `role="navigation"`/`aria-label` below override Popup's own defaults:
 * confirmed from `@base-ui/react`'s own `mergeProps` docstring that props
 * merge "Object.assign style, rightmost wins", and this component's own
 * props are the rightmost entry in Popup's internal merge order.
 */
export function MobileNavToggle({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="relative md:hidden">
        <Popover.Trigger
          render={(triggerProps, state) => (
            <Button {...triggerProps} type="button" variant="outline" size="icon">
              {state.open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
              <span className="sr-only">{state.open ? "Close menu" : "Open menu"}</span>
            </Button>
          )}
        />

        <Popover.Portal>
          <Popover.Positioner align="end" sideOffset={8} className="z-10">
            <Popover.Popup
              role="navigation"
              aria-label="Main navigation"
              render={<nav />}
              className="min-w-40 rounded-lg border border-border bg-background p-2 shadow-md"
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
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
