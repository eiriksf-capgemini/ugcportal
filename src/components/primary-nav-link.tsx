"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "cn";

import { HEADER_NAV_LINK_CLASS, useAriaCurrentPage } from "@/components/header-nav-link";

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
      onClick={onNavigate}
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
