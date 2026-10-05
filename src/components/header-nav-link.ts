"use client";

import { usePathname } from "next/navigation";

import { cn } from "cn";

import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

/**
 * Shared behaviour for the header's nav-style links (ugcportal-14k9 PR #94
 * review round 1, low finding 4): src/components/upload-link.tsx and
 * src/components/primary-nav-link.tsx each need the exact same `aria-
 * current` derivation off `usePathname()` — see upload-link.tsx's own
 * comment for why this has to be a Client Component hook rather than a
 * server-computed answer (a persistent root layout does not re-render on
 * client-side navigation, so a server-side answer freezes at whatever it
 * was on the last full page load) — and the same base link styling. Before
 * this file existed the two had already diverged once in spirit (the base
 * class string was copy-pasted verbatim between them), which is exactly the
 * shape review-standards' family 4 (sibling-omission) warns about: a future
 * fix to one copy with no reason to touch the other.
 *
 * `HEADER_NAV_LINK_CLASS` is the shared part only. PrimaryNavLink still adds
 * its own `aria-[current=page]:*` treatment on top (via `cn()`) because
 * UploadLink's current-page copy ("Upload" is always the only upload
 * destination) never needed a visually distinct current-page state the way
 * a multi-item nav does; that highlighting is PrimaryNavLink-specific, not
 * duplicated, so it is not pulled in here.
 *
 * `FOCUS_RING_CLASS` (round 5, reuse finding 7): the trailing three
 * `focus-visible:*` utilities were ALSO duplicated, verbatim, in
 * src/components/ui/inline-link.ts's `INLINE_LINK_CLASS` - pulled out to its
 * own shared constant rather than fixed in only one of the two.
 */
export const HEADER_NAV_LINK_CLASS = cn(
  "rounded-sm text-sm font-medium text-foreground transition-colors hover:text-primary",
  FOCUS_RING_CLASS,
);

/**
 * `"page"` when `href` is the current route, `undefined` otherwise —
 * deliberately not a bare boolean: `aria-current="false"` is its own
 * present, ARIA-legal token distinct from the attribute's absence, and
 * React renders exactly that string for a bare `false` prop value
 * (confirmed against real markup in upload-link.test.tsx, not assumed).
 */
export function useAriaCurrentPage(href: string): "page" | undefined {
  const pathname = usePathname();
  return pathname === href ? "page" : undefined;
}
