/**
 * The visitor's cookie-consent choice (ugcportal-3wgp).
 *
 * Norway's ekomloven § 3-15 (in force since 2025-01-01) requires GDPR-
 * standard active consent — freely given, specific, informed, unambiguous,
 * by clear affirmative action — before any non-essential storage or
 * tracking. "No choice yet" therefore must not be treated as consent: every
 * reader of this module gets `null` until the visitor has actually clicked
 * one of the banner's two buttons, and the two real choices ("granted" /
 * "denied") are both written by an explicit act, never inferred or defaulted.
 *
 * Stored first-party, in a cookie rather than localStorage, so the initial
 * server render (src/app/layout.tsx, via src/lib/consent.server.ts) can see
 * the same choice the browser already has before paint — the alternative
 * (client-only localStorage) would mean a fresh full page load always
 * renders the banner for a first instant regardless of any earlier choice.
 * The cookie itself is strictly necessary — it stores only the visitor's
 * consent preference, nothing tracking-related — so writing it needs no
 * consent of its own.
 *
 * This module is imported by both server and client code (see
 * consent.server.ts for the server-only half) and must stay free of any
 * knowledge of which analytics or tracking vendor is gated: src/components/
 * consent/analytics-loader.tsx is the one place that belongs, and a
 * repo-grep test (analytics-host.grep.test.ts) fails the build if that
 * knowledge leaks out here instead.
 *
 * The actual cookie mechanics (read/write, encoding, SameSite/Secure) live
 * in src/lib/cookies.ts (review round 1, finding 6) — this module owns only
 * the consent-specific name, lifetime and value validation.
 */
import { getCookie, setCookie } from "./cookies";

export type ConsentChoice = "granted" | "denied";

export const CONSENT_COOKIE_NAME = "ugc_cookie_consent";

// One year, the common ceiling guidance cites for a consent cookie's own
// lifetime (it is not itself a tracking cookie, so nothing in ekomloven
// caps it shorter — but an unbounded one would mean a choice made once
// binds a visitor forever with no prompt to reconsider).
const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Validates a raw stored value into a real choice, or `null` for anything
 * else — including absent, empty, or a value this code never wrote. No
 * fallback to either real choice: an unrecognised value must read exactly
 * like "no choice yet", the same safe default a first visit gets, not
 * silently become granted or denied.
 */
export function parseConsentChoice(
  raw: string | null | undefined,
): ConsentChoice | null {
  return raw === "granted" || raw === "denied" ? raw : null;
}

/**
 * Reads the visitor's stored choice from the first-party cookie. Browser-
 * only: returns `null` (same as "no choice yet") when called during SSR,
 * which matters because this module has no server-only import (unlike
 * consent.server.ts) and so could otherwise be called from a server
 * component by mistake and silently always report "no choice".
 */
export function readStoredConsent(): ConsentChoice | null {
  return parseConsentChoice(getCookie(CONSENT_COOKIE_NAME));
}

/**
 * Persists a real choice as the first-party cookie. There is deliberately no
 * way to write `null` here — withdrawing consent is "only necessary" (an
 * explicit `denied`), never a reset back to "no choice", so the banner does
 * not reappear on the visitor's next visit (K3).
 */
export function writeStoredConsent(value: ConsentChoice): void {
  setCookie(CONSENT_COOKIE_NAME, value, {
    maxAgeSeconds: CONSENT_COOKIE_MAX_AGE_SECONDS,
  });
}
