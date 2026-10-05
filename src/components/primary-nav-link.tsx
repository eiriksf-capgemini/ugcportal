"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { cn } from "cn";

import { HEADER_NAV_LINK_CLASS, useAriaCurrentPage } from "@/components/header-nav-link";

/**
 * True for a click that will navigate in THIS tab, right now, with nothing
 * else about to intercept it (PR #94 review round 6, finding 4). A nav item
 * inside the mobile panel closes the panel via `onNavigate` on click - but a
 * Cmd/Ctrl-click, a middle-click, or a Shift/Alt-click each open the
 * destination in a new tab or window instead, leaving the visitor still on
 * THIS page; closing the panel for one of those is closing it out from
 * under someone who never left. `event.button !== 0` excludes a
 * middle-click (which also opens a new tab in most browsers) and a
 * right-click (which opens a context menu, not a navigation).
 * `event.defaultPrevented` excludes a click some OTHER handler already
 * decided should not navigate at all.
 */
function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * One link in the header's main navigation (Gallery, About — ugcportal-14k9).
 *
 * A Client Component, not a plain server-rendered `<a>`, for the same reason
 * src/components/upload-link.tsx is one: `aria-current="page"` needs
 * `usePathname()` to stay correct across client-side navigation. The root
 * layout (and this header inside it) persists across a soft navigation and
 * does not re-render on its own, so a server-computed "is this the current
 * page" would freeze at whatever it was on the last full page load — see
 * upload-link.tsx's own comment for the two concrete ways that went wrong
 * (a request-scoped proxy header that both misidentified the page after a
 * client-side nav AND silently truncated large upload bodies). Reusing that
 * component outright does not fit: it is hard-wired to UPLOAD_PATH and to
 * "Upload" as its label, where this one needs an arbitrary href/label pair
 * for two different destinations, rendered from two different parents (the
 * always-visible desktop nav and the collapsible mobile panel).
 *
 * `onNavigate` is used by the mobile panel (src/components/mobile-nav-
 * toggle.tsx) to close itself the moment a link is actually activated —
 * optional and unused by the desktop nav, which has no panel to close.
 * Only called for a plain left click (`isPlainLeftClick` above, PR #94
 * review round 6 finding 4) - a Cmd/Ctrl/Shift/Alt-click or a middle-click
 * opens the destination in a new tab and leaves this one open, and closing
 * the panel out from under a visitor who never navigated away is exactly
 * the kind of "it closed and I don't know why" bug a modifier-click is
 * supposed to be invisible to the page handling it.
 *
 * The `aria-current` derivation and the base link class are shared with
 * src/components/upload-link.tsx via src/components/header-nav-link.ts
 * (ugcportal-14k9 PR #94 review round 1, low finding 4) rather than each
 * hand-spelling its own copy — see that file's own comment. The
 * `aria-[current=page]:*` highlighting below is added on top, not shared:
 * UploadLink has no equivalent need for it (see header-nav-link.ts).
 */
export function PrimaryNavLink({
  href,
  children,
  onNavigate,
  className,
}: {
  href: string;
  children: ReactNode;
  onNavigate?: () => void;
  className?: string;
}) {
  const ariaCurrent = useAriaCurrentPage(href);

  return (
    <Link
      href={href}
      aria-current={ariaCurrent}
      onClick={(event) => {
        if (onNavigate && isPlainLeftClick(event)) {
          onNavigate();
        }
      }}
      className={cn(
        HEADER_NAV_LINK_CLASS,
        "aria-[current=page]:text-primary aria-[current=page]:underline aria-[current=page]:underline-offset-4",
        className,
      )}
    >
      {children}
    </Link>
  );
}
