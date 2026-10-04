"use client";

import { Popover } from "@base-ui/react/popover";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import { PrimaryNavLink } from "@/components/primary-nav-link";
import { Button } from "@/components/ui/button";
import { MD_BREAKPOINT_PX } from "@/lib/breakpoints";

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
 *
 * `Popover.Trigger` has the matching default on the OTHER side of the same
 * mistake (PR #94 review round 4, finding 3): it sets `aria-haspopup="dialog"`
 * to agree with Popup's own now-overridden default. Rather than relabel it
 * to another ARIA token that is just as wrong (`"menu"` would claim actual
 * menu/menuitem keyboard semantics — arrow-key roving focus — this disclosure
 * does not implement; the nav items are plain links), it is removed
 * entirely below. WAI-ARIA's own disclosure pattern uses `aria-expanded` and
 * `aria-controls` alone, with no `aria-haspopup` at all, for exactly this
 * shape: a button that reveals plain content, not a menu/listbox/tree/grid/
 * dialog widget.
 *
 * The panel renders above this header's own sticky z-20 (PR #94 review
 * round 4, finding 1): `z-30` on the positioner, not the `z-10` this shipped
 * with, which let the panel paint UNDER the sticky header once the page was
 * scrolled far enough for the header to be "stuck" in front of it. z-30 is
 * still below the cookie-consent banner's z-40 (src/components/consent/
 * cookie-banner.tsx) — see app-shell.tsx's own stacking-tier comment.
 *
 * Also dismisses on a `matchMedia` change past `md` (PR #94 review round 4,
 * finding 2): widening the viewport from under `md` to at or above it, with
 * the panel open, swaps which of this component's two renderings of
 * `items` is visible — this one hides, the always-visible desktop `<nav>`
 * in site-header.tsx takes over — and without this, BOTH would carry the
 * landmark name "Main navigation" at once for as long as this one stayed
 * open, which is two landmarks with the same accessible name coexisting in
 * the tree. Closing this one the moment the breakpoint crosses keeps there
 * being exactly one.
 *
 * Mounting: this component (and therefore a live `Popover.Root`) renders
 * on every page load regardless of viewport, including at desktop widths
 * where its own trigger is always `md:hidden` and never interacted with.
 * Left as-is deliberately — the alternative, mounting it only below `md`,
 * needs either a CSS-media-query-aware conditional render (a `useEffect`
 * reading `matchMedia` just to decide whether to render at all, doing at
 * mount time the same width check the dismiss-on-resize effect above
 * already does at runtime) or a server-side viewport guess, neither of
 * which this component's idle cost at desktop widths (an unopened popover
 * with no DOCUMENT-LEVEL listeners attached while closed - the trigger
 * button itself always carries Base UI's own click/keydown handlers
 * regardless of `open`, same as any other button; it is only the
 * dismiss-on-resize effect's `matchMedia` listener, and Popover's own
 * Escape/outside-press listeners, that come and go with `open`) justifies
 * building.
 */
export function MobileNavToggle({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);

  /*
   * Dismiss on growing past `md` (PR #94 review round 4, finding 2) - see
   * this component's own docstring for why two coexisting "Main navigation"
   * landmarks is the failure this prevents. Only attached while `open`:
   * nothing needs to listen for a breakpoint change while there is nothing
   * open to dismiss, consistent with this component's existing "nothing
   * exists while closed" shape elsewhere (the panel itself, `{open && ...}`
   * in earlier revisions, now `Popover`'s own mount-on-open).
   */
  useEffect(() => {
    if (!open) return;
    const mediaQuery = window.matchMedia(`(min-width: ${MD_BREAKPOINT_PX}px)`);
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [open]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="relative md:hidden">
        <Popover.Trigger
          render={(triggerProps, state) => {
            // Computed once (PR #94 review round 5, reuse finding 5), not
            // the same `state.open` ternary spelled twice: the icon and the
            // label must never disagree about which state they're
            // describing, and a single shared read of `state.open` is what
            // makes that structurally true rather than merely true today.
            const Icon = state.open ? X : Menu;
            const label = state.open ? "Close menu" : "Open menu";
            return (
              <Button
                {...triggerProps}
                // Removes Popover's own default "dialog" - see this file's
                // docstring for why no aria-haspopup value is the right one,
                // not a relabelled one.
                aria-haspopup={undefined}
                type="button"
                variant="outline"
                size="icon"
              >
                <Icon aria-hidden="true" />
                <span className="sr-only">{label}</span>
              </Button>
            );
          }}
        />

        <Popover.Portal>
          <Popover.Positioner align="end" sideOffset={8} className="z-30">
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
