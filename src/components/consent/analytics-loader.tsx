"use client";

import Script from "next/script";
import { useEffect } from "react";

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
 * A repo-grep test (analytics-host.grep.test.ts) fails the build if
 * "umami" (case-insensitively) or either of these env var names appears
 * anywhere under src/ outside this file and its own test — so a script tag
 * or host string hardcoded elsewhere cannot silently bypass this gate
 * without breaking CI.
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
 * render time.
 */

/**
 * Cookies the gated script can set that withdrawal must remove (K4).
 *
 * `umami.cache`: Umami's own tracker script writes this, but only when
 * given a `data-cache` attribute (https://umami.is docs), which switches it
 * from its cookieless default to a cookie-backed cache of the visitor id
 * instead of regenerating it per page load. Cleared unconditionally on
 * every non-granted render, regardless of whether this deployment ever
 * turns that attribute on, so flipping it on later doesn't also require
 * teaching withdrawal a new cookie name.
 */
export const ANALYTICS_COOKIE_NAMES = ["umami.cache"] as const;

export function clearAnalyticsCookies(): void {
  if (typeof document === "undefined") return;
  for (const name of ANALYTICS_COOKIE_NAMES) {
    // Expires it immediately. No Max-Age=0 + SameSite mismatch risk here —
    // this intentionally does not set SameSite/Secure, which don't need to
    // match what set the cookie for the browser to honour an expiry.
    document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

export function AnalyticsLoader() {
  const { consent } = useConsent();
  const granted = consent === "granted";
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC;
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

  // Runs whenever `granted` changes, including the very first render: a
  // visitor who withdraws consent gets this on the render where `granted`
  // flips to false, and a visitor who never granted it gets an (idempotent,
  // harmless) clear on mount too, in case a cookie survived from an older
  // build that set it more readily than this one does.
  useEffect(() => {
    if (!granted) clearAnalyticsCookies();
  }, [granted]);

  if (!granted || !src || !websiteId) return null;

  return (
    <Script src={src} data-website-id={websiteId} strategy="afterInteractive" />
  );
}
