/**
 * The shared styling for a footer control — a plain nav `<a>`, or a
 * `<button>` that only needs to look like one (CookieSettingsLink):
 * muted by default, underlined on hover/focus. One constant
 * (ugcportal-akv6, PR #96 round 1 review), not the same string written out
 * in both src/components/site-footer.tsx and src/components/consent/
 * cookie-settings-link.tsx — the same reasoning as INLINE_LINK_CLASS
 * (src/components/ui/inline-link.ts) for an inline text link.
 *
 * Renders on --background, the page canvas — both current callers sit
 * directly in the footer, which has no --card/--popover/--muted/etc. fill
 * behind it (see src/lib/design/dual-meaning-usage.test.ts).
 */
export const FOOTER_LINK_CLASS =
  "rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
