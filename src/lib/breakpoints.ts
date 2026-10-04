/**
 * Tailwind's default `md` breakpoint (PR #94 review round 5, reuse finding
 * 3): the width src/components/mobile-nav-toggle.tsx's own `md:hidden`/
 * `hidden md:flex` pair switches on, which e2e/header.spec.ts's keyboard and
 * visibility tests also need to know about to decide which of the header's
 * two nav renderings is live at a given viewport. Declared once here rather
 * than as two independently-typed `768`s (round 4 left it that way, on the
 * reasoning that Tailwind's breakpoints live in compiled CSS and neither
 * side could import the OTHER's copy — true, but it missed the simpler fix:
 * a third place, importable by both, that is the literal breakpoint Tailwind
 * itself defaults to, not a derivation OF Tailwind's config).
 */
export const MD_BREAKPOINT_PX = 768;
