"use client";

import { useOptionalConsent } from "./consent-context";

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
 *
 * Round 5, LOW finding 7: renders nothing, rather than throwing, when
 * mounted outside a `ConsentProvider` — uses `useOptionalConsent()`
 * (consent-context.tsx), not the throwing `useConsent()` every OTHER
 * consumer still uses. app-shell.tsx's own doc comment documents AppShell's
 * dependency on a real `ConsentProvider` for this link to actually DO
 * anything — that documented dependency stays true and stays documented;
 * what changes here is only the FAILURE MODE when it is missing (a quietly
 * absent footer link instead of a hard crash), which is a strictly better
 * default for exactly the cases app-shell.tsx's own comment names (a
 * Storybook story, an isolated test, a future reuse outside the real app)
 * without requiring every one of them to remember to wrap a provider just
 * to render the shell at all.
 */
export function CookieSettingsLink() {
  const consent = useOptionalConsent();
  if (consent === null) return null;
  const { reopen } = consent;
  return (
    <button
      type="button"
      onClick={reopen}
      // Round 5, finding 3: cookie-banner.tsx's focus-restoration effect
      // looks this up fresh (by this stable attribute, not by holding a
      // ref to this component) as its first fallback target when the
      // captured invoker is attached but did not actually take focus.
      // A plain, stable data attribute rather than an id: this component
      // is explicitly documented above as something the footer bead
      // (ugcportal-akv6) may move or re-mount, and an id is a single
      // global namespace a future second mount point could collide with.
      data-cookie-settings-trigger=""
      className="rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      Cookies
    </button>
  );
}
