"use client";

import Script from "next/script";
import { useEffect } from "react";

import { deleteCookie } from "@/lib/cookies";

import { useConsent } from "./consent-context";

/**
 * THE ONLY PLACE a tracking script may mount (ugcportal-3wgp, K2/K6).
 *
 * Umami (ugcportal-8at/ugcportal-9w0) is the first and, today, the only
 * intended consumer: both env vars below are unset in every environment that
 * exists right now, so this renders nothing anywhere until that deployment
 * sets them. A future affiliate or tracking script must plug in here too —
 * by adding another env-gated <Script> alongside this one, behind the same
 * `consent === "granted"` check — rather than calling next/script from its
 * own page or component, which would bypass the gate entirely.
 *
 * Enforcement is two-layered (review round 1, finding 2 — a bypass must be
 * caught by MECHANISM, not by vendor name):
 *   1. eslint.config.mjs bans importing `next/script` and any JSX
 *      `<script src>` everywhere under src/ EXCEPT this file, via the same
 *      `no-restricted-syntax` pattern already used for the hex-colour
 *      guardrail. A `<Script src="https://plausible.io/...">` dropped into
 *      any page fails `npm run lint`/CI regardless of what host it names.
 *   2. analytics-host.grep.test.ts additionally greps for the literal
 *      "umami" (host-name needle, belt-and-braces) so a vendor name string
 *      hardcoded anywhere else is also caught, independent of whether it
 *      goes through next/script at all (e.g. a raw `fetch()` beacon).
 *
 * Single-vendor registry (review round 1, finding 7 — altitude, deferred):
 * this file is hard-wired to Umami's two env vars and one `<Script>`. A
 * `GATED_SCRIPTS: { src, attrs }[]` mapped over once would scale to a second
 * vendor without another engineer re-deriving the gate by hand, but there is
 * exactly one (inactive) consumer today and no second one to design against
 * yet. Deliberately left as a follow-up for ugcportal-9w0 (which activates
 * the first consumer) rather than built speculatively now — noted here so
 * it isn't lost, not treated as resolved.
 *
 * Reads `process.env.NEXT_PUBLIC_*` inside the function body, as a literal
 * `process.env.NEXT_PUBLIC_UMAMI_SRC` member expression, rather than at
 * module scope or through a named constant holding the var name — both
 * tempting, both wrong. Next.js's build-time inliner only replaces that
 * EXACT static `process.env.NEXT_PUBLIC_X` syntax wherever it textually
 * appears in client code (not only at module scope, so reading it here
 * costs nothing in production); a computed lookup like
 * `process.env[SOME_CONST]` is not statically analysable and is never
 * replaced, so in the actual browser bundle it would silently read
 * `undefined` forever — the gate would fail safe (nothing loads) but
 * ugcportal-9w0 would have no way to find out why its env vars don't work.
 * Reading it in the function body (rather than module scope) still means a
 * test can simply set `process.env.NEXT_PUBLIC_UMAMI_SRC` before rendering —
 * no module-cache reset dance required, because nothing is read until
 * render time. If a future `GATED_SCRIPTS` registry (above) is ever built,
 * it must be a registry of *reads* (literal expressions), not of var names,
 * for the same reason.
 */

/**
 * Cookies a gated script can set that withdrawal must remove (K4).
 *
 * Empty today: checked directly against upstream `umami-software/umami`
 * (`src/tracker/index.ts`, the published tracker source) — it writes no
 * cookie and no persistent `localStorage` entry at all. Its `cache` value
 * (what an earlier version of this file called `umami.cache`, believing it
 * to be a cookie set via a `data-cache` attribute — neither exists) is an
 * in-memory closure variable synced per-request via the `x-umami-cache`
 * request/response header, never persisted client-side. Umami is, today,
 * genuinely cookieless. This stays as an empty, documented no-op rather
 * than being deleted outright: if a future vendor plugged in here (see the
 * registry note above) and that vendor's docs name a cookie it sets, add it
 * here and `clearAnalyticsCookies()` already does the rest.
 */
export const ANALYTICS_COOKIE_NAMES: readonly string[] = [];

export function clearAnalyticsCookies(
  names: readonly string[] = ANALYTICS_COOKIE_NAMES,
): void {
  for (const name of names) deleteCookie(name);
}

/**
 * The actual "stop a tracker that already loaded" mechanism (review round 1,
 * finding 1, MEDIUM). `next/script`'s own `<Script>` has no unmount cleanup
 * — removing it from React's tree (returning `null` below) only stops a
 * *future* mount; it does nothing to a script that already ran. Confirmed
 * against the real Umami tracker source: every tracked call (`track`,
 * automatic pageviews, SPA route-change hooks) runs through a single
 * `trackingDisabled()` gate that checks
 * `localStorage.getItem('umami.disabled')` on every invocation, not just at
 * load — so setting this flag stops an already-running tracker's NEXT call,
 * which is the strongest a client-side signal can do without a full reload.
 *
 * No reload-on-withdrawal fallback: the instruction this responds to was
 * "set the vendor's documented runtime opt-out, and reload only if the
 * vendor has none" — Umami has one, confirmed above, so a reload (which
 * would be jarring UX on every "Only necessary" click) is not needed for
 * the one real vendor this gate has today. A future vendor with no runtime
 * opt-out would need that fallback; left for whoever adds that vendor
 * (same deferral as the registry note above), since building it now would
 * be speculative against a vendor that doesn't exist yet.
 */
const UMAMI_DISABLE_STORAGE_KEY = "umami.disabled";

function isLocalStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function disableUmamiTracking(): void {
  if (!isLocalStorageAvailable()) return;
  try {
    window.localStorage.setItem(UMAMI_DISABLE_STORAGE_KEY, "1");
  } catch {
    // localStorage can throw (private browsing in some engines, quota,
    // storage disabled entirely) — nothing more to do client-side; the
    // script element is still removed from the tree either way.
  }
}

export function enableUmamiTracking(): void {
  if (!isLocalStorageAvailable()) return;
  try {
    window.localStorage.removeItem(UMAMI_DISABLE_STORAGE_KEY);
  } catch {
    // see disableUmamiTracking
  }
}

export function AnalyticsLoader() {
  const { consent } = useConsent();
  const granted = consent === "granted";
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC;
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

  // Runs whenever `granted` changes, including the very first render: a
  // visitor who withdraws consent gets the disable signal set and cookies
  // cleared on the render where `granted` flips to false, and a visitor who
  // never granted it gets the same (idempotent, harmless) treatment on
  // mount — including re-enabling on a later grant, so a visitor who denied
  // then later accepts via "Cookies" is not left permanently opted out by a
  // flag from their earlier choice.
  useEffect(() => {
    if (granted) {
      enableUmamiTracking();
    } else {
      disableUmamiTracking();
      clearAnalyticsCookies();
    }
  }, [granted]);

  if (!granted || !src || !websiteId) return null;

  return (
    <Script src={src} data-website-id={websiteId} strategy="afterInteractive" />
  );
}
