/**
 * The one shared "does this text mention the gated analytics vendor by
 * host/env-var name" pattern (ugcportal-3wgp review round 5, LOW finding 6
 * — reuse, Family 4). Before this, analytics-host.grep.test.ts's K6 repo
 * scan and e2e/cookie-consent.spec.ts's browser-level network/script-tag
 * check each defined their own, separately maintained copy of the exact
 * same `/umami/i` — a vendor rename or an additional vendor host would have
 * needed updating two places in lockstep instead of one.
 *
 * Deliberately NOT vendor-agnostic, unlike src/lib/cookies.ts: this module
 * exists specifically to name the vendor for the K6 scan and the e2e check
 * to look for, so it is on analytics-host.grep.test.ts's own
 * ALLOWED_RELATIVE_PATHS allowlist (see that file) rather than needing to
 * avoid the word — the same exemption analytics-loader.tsx itself already
 * has, for the same reason.
 *
 * Matches "umami" case-insensitively, which also catches the two env var
 * names (NEXT_PUBLIC_UMAMI_SRC, NEXT_PUBLIC_UMAMI_WEBSITE_ID) and any
 * actual host/URL containing the word, without needing three separate
 * patterns.
 */
export const ANALYTICS_MARKER = /umami/i;
