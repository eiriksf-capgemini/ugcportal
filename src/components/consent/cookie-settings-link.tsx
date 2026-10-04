"use client";

import { useConsent } from "./consent-context";

/**
 * The "change or withdraw your choice" control (ugcportal-3wgp K4) — as easy
 * to reach as giving consent in the first place: one click reopens the exact
 * same banner the visitor saw on their first visit, and the two buttons work
 * identically either way (AnalyticsLoader reacts to `consent` changing, not
 * to how the banner was opened).
 *
 * The footer bead (ugcportal-akv6) owns where this ultimately lives and
 * what else sits near it; mounted directly in src/components/app-shell.tsx's
 * existing footer for now, minimally, since that bead hasn't landed yet.
 * Exported as a standalone component precisely so that bead can move it
 * without touching this one.
 *
 * A real <button>, not a <Link>: it does not navigate anywhere, it reopens
 * in-place UI, which is what a button announces to a screen reader and a
 * link does not.
 */
export function CookieSettingsLink() {
  const { reopen } = useConsent();
  return (
    <button
      type="button"
      onClick={reopen}
      className="rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      Cookies
    </button>
  );
}
