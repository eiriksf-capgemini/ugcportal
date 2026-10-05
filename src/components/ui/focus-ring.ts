/**
 * The focus-visible ring triad this app's links share (PR #94 review round
 * 5, reuse finding 7): src/components/ui/inline-link.ts's `INLINE_LINK_CLASS`
 * and src/components/header-nav-link.ts's `HEADER_NAV_LINK_CLASS` each used
 * to carry their own literal copy of these exact three utilities. Named once
 * here, in `src/components/ui/` alongside this app's other shared style
 * primitives (button.tsx's own variant strings), rather than in either
 * caller's own file - neither is more "the" owner of a ring treatment that
 * both need.
 */
export const FOCUS_RING_CLASS =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring";
