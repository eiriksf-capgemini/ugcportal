/**
 * The contact address the About and Portfolio pages' mailto form sends to
 * (ugcportal-qnq9.7), and the string-building for its `mailto:` links.
 *
 * Eirik supplies the real address later, through the `CONTACT_EMAIL`
 * environment variable (see env.example). Until then every environment
 * falls back to {@link CONTACT_EMAIL_PLACEHOLDER}, an address on the
 * `.invalid` TLD (reserved by RFC 2606 for exactly this: guaranteed never to
 * be a real, deliverable domain, so it cannot be mistaken for a working
 * inbox if it ever did leak).
 *
 * THE STARTUP GUARD THAT GOES WITH THIS lives in src/instrumentation.ts
 * (`checkContactEmailConfiguration`), not here — round-1 review moved it
 * there to match this repo's other configuration checks (the evidence-
 * encryption and sign-in checks in that same file): a loud warning at boot
 * when CONTACT_EMAIL is unset in production, rather than this module
 * throwing on first render. That also means neither page that uses this
 * module has to be `force-dynamic` purely to keep a throw off `next build`'s
 * critical path; src/app/about/page.tsx is static again because of it.
 */
export const CONTACT_EMAIL_PLACEHOLDER = "REPLACE-BEFORE-LAUNCH@example.invalid";

/**
 * Resolves the address to show and mail to. Reads `process.env` directly —
 * there is no parameter to inject a fake environment through any more
 * (round-1 review): the tests stub `process.env.CONTACT_EMAIL` with
 * `vi.stubEnv`/`vi.unstubAllEnvs` instead, which exercises the exact same
 * read this function performs rather than a parallel code path built only
 * for tests to call.
 *
 * An empty or whitespace-only `CONTACT_EMAIL` counts as "not configured" —
 * env.example ships several real variables as blank lines the same way
 * (`AUTH_GOOGLE_ID=`), and treating that as "a value exists" here would let a
 * `.env` copied without every field filled in silently carry the placeholder
 * into what looks like a configured deployment.
 */
export function resolveContactEmail(): string {
  const configured = process.env.CONTACT_EMAIL?.trim();
  return configured ? configured : CONTACT_EMAIL_PLACEHOLDER;
}

/** The named `mailto:` query parameters this site ever builds. */
export type MailtoParams = { subject?: string; body?: string };

/**
 * A `mailto:` target, encoding each present parameter with
 * `encodeURIComponent` — the fix for round-1 review's medium finding.
 *
 * NOT `URLSearchParams` and NOT a `<form method="get" action="mailto:...">`,
 * and the reason is the same for both: `application/x-www-form-urlencoded`
 * — what a browser builds for a GET-method form submission, and what
 * `URLSearchParams#toString()` also produces — encodes a space as `+`.
 * `mailto:` is RFC 6068's own URI scheme, not a web form target, and a mail
 * client reading one does not apply form-urlencoded decoding to its query
 * string: `+` arrives as a literal plus sign. A real mail client showed
 * "Hello+from+your+portfolio+page" as the subject line, verbatim, with the
 * GET-form version of this page. `encodeURIComponent` encodes a space as
 * `%20`, which RFC 6068 compliant mailto handling does decode correctly.
 *
 * The address itself is NOT percent-encoded, deliberately. `mailto:`
 * addresses are RFC 6068's "addr-spec" (the same ASCII local-part/domain
 * grammar email addresses always are), not a path or query component, and
 * several real mail clients take `%40` literally instead of decoding it
 * back to `@`. There is nothing in an address this function is ever handed
 * (CONTACT_EMAIL_PLACEHOLDER, or Eirik's real configured one) that needs
 * escaping in the first place.
 */
export function contactMailtoHref(email: string, params: MailtoParams): string {
  const query = (Object.entries(params) as [keyof MailtoParams, string | undefined][])
    .filter((entry): entry is [keyof MailtoParams, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  return query === "" ? `mailto:${email}` : `mailto:${email}?${query}`;
}
