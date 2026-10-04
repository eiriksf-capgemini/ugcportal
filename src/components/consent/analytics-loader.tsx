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

/**
 * Deletes each named cookie with `deleteCookie`'s DEFAULT attributes (plain
 * `Lax`, `Secure` only inferred from the current page's own protocol).
 *
 * Review round 3, finding 3: that default is only correct by accident while
 * `ANALYTICS_COOKIE_NAMES` is empty. `src/lib/cookies.ts`'s own `deleteCookie`
 * fix (round 2, finding 5) exists precisely because a cookie written with
 * `SameSite=None`/`Secure` is NOT reliably cleared by a delete that omits
 * those same attributes — a browser can silently ignore the delete. So
 * whoever adds the first real entry to `ANALYTICS_COOKIE_NAMES` must also
 * check what `SameSite`/`Secure` the vendor's docs say IT writes, and pass
 * those same attributes through here (extending this function's signature
 * to carry per-cookie options, not just names, if they differ) — not
 * assume this function's current defaults are good enough for every future
 * vendor.
 */
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

/**
 * Runs `action` against `window.localStorage`, failing silently (never
 * throwing) however it fails.
 *
 * Review round 2, finding 7: the previous version checked
 * `typeof window.localStorage !== "undefined"` OUTSIDE its try/catch, and
 * only wrapped the subsequent `setItem`/`removeItem` call. But merely
 * ACCESSING `window.localStorage` — not just calling a method on it — can
 * itself throw a `SecurityError` synchronously in some real, current
 * contexts (a sandboxed cross-origin iframe without
 * `allow-same-origin`, some hardened/enterprise storage-partitioning
 * configurations). Since this runs inside `AnalyticsLoader`'s `useEffect`,
 * an uncaught throw there would propagate out of the effect instead of
 * failing safe the way every surrounding comment assumes. Folding the
 * access itself inside the try closes that gap.
 */
function withUmamiDisableFlag(action: (storage: Storage) => void): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    if (typeof storage === "undefined") return;
    action(storage);
  } catch {
    // Covers both: accessing window.localStorage itself throwing, and
    // setItem/removeItem throwing (private browsing in some engines,
    // quota, storage disabled entirely). Either way, nothing more to do
    // client-side — the script element is still removed from the tree
    // regardless.
  }
}

export function disableUmamiTracking(): void {
  withUmamiDisableFlag((storage) => storage.setItem(UMAMI_DISABLE_STORAGE_KEY, "1"));
}

export function enableUmamiTracking(): void {
  withUmamiDisableFlag((storage) => storage.removeItem(UMAMI_DISABLE_STORAGE_KEY));
}

export function AnalyticsLoader() {
  const { consent } = useConsent();
  const granted = consent === "granted";
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC;
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

  /*
   * Review round 4, MEDIUM finding 4 (K1 copy vs. behaviour, Family 1): the
   * banner says "Nothing optional is set until you choose" (cookie-
   * banner.tsx's own COOKIE_BANNER_COPY) — but this effect used to key off
   * `!granted`, which is ALSO true for `consent === null` (no choice made
   * yet). That wrote the `umami.disabled` localStorage flag on a visitor's
   * very first render, before they had clicked anything — "setting"
   * something optional before a choice, exactly what the banner promises
   * does not happen.
   *
   * Fixed to branch on the real three-way `consent` value instead of the
   * two-way `granted` boolean: the disable flag (and the cookie clear) now
   * only ever write on an EXPLICIT `"denied"` — which covers both a
   * genuine withdrawal (was `"granted"`, now revoked) and a visitor's
   * FIRST choice being "Only necessary" (never `"granted"` at all, but
   * still an explicit choice, not the absence of one) — and `"granted"`
   * still re-enables (so a later accept after a withdrawal isn't left
   * permanently opted out). `consent === null` now does nothing at all.
   */
  useEffect(() => {
    if (consent === "granted") {
      enableUmamiTracking();
    } else if (consent === "denied") {
      disableUmamiTracking();
      clearAnalyticsCookies();
    }
  }, [consent]);

  if (!granted || !src || !websiteId) return null;

  return (
    <Script src={src} data-website-id={websiteId} strategy="afterInteractive" />
  );
}
