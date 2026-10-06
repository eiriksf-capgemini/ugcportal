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

/**
 * Whether `value` is a bare `local@domain.tld` address — no display name,
 * no angle brackets, no whitespace, and something that actually looks like
 * an address rather than arbitrary text. Used by
 * `checkContactEmailConfiguration` (src/instrumentation.ts) to reject a
 * `CONTACT_EMAIL` shaped like `"Jane Doe <jane@example.com>"`: this module
 * does no parsing of that shape into its address part, so a value like that
 * would be mailed to as a single, malformed address (after encoding) rather
 * than silently repaired into the one the operator meant.
 *
 * A RE-EXPORT, not a wrapper function (ugcportal-qnq9.16, item 6 of the lows
 * deferred from PR #93's round-6 review): the shape check itself is
 * `isEmailShaped` (src/lib/email-shape.ts), shared with
 * src/lib/sign-in-policy.ts's own email-shape check (round-5 review: the
 * two used to carry separately maintained, near-identical regexes — see
 * that module's own comment for the trailing-dot bug that duplication let
 * slip through unfixed in one copy after the other was fixed). A function
 * here that only called straight through to `isEmailShaped` was an extra
 * hop for a reader chasing the real logic with no behaviour of its own;
 * aliasing the export instead keeps the name this module's own callers
 * (src/instrumentation.ts, src/components/site/contact-section.tsx) and
 * src/lib/contact.test.ts already import, with nothing left to call through.
 */
export { isEmailShaped as isBareEmailAddress } from "@/lib/email-shape";

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
 * THE ADDRESS ITSELF IS ALSO ENCODED NOW (round-2 review reversed round-1's
 * choice here). Round 1 left it raw, reasoning that RFC 6068's "addr-spec"
 * never needs escaping and that some mail clients take a literal `%40`
 * instead of decoding it. That reasoning traded away a bigger safety
 * margin than it bought: `resolveContactEmail` returns WHATEVER
 * `CONTACT_EMAIL` holds once `checkContactEmailConfiguration`
 * (src/instrumentation.ts) has only WARNED about a malformed value, not
 * blocked it — so a misconfigured "Jane Doe <jane@example.com>" (display
 * name included, a genuinely easy mistake) would reach this function raw
 * and produce `mailto:Jane Doe <jane@example.com>`, a `<a href>` with an
 * unescaped space and angle brackets that is not a well-formed URI at all.
 * `encodeURIComponent` keeps the href well-formed regardless of what
 * `resolveContactEmail` was actually handed — defence in depth alongside
 * the boot check, not a replacement for it.
 */
export function contactMailtoHref(email: string, params: MailtoParams): string {
  const query = (Object.entries(params) as [keyof MailtoParams, string | undefined][])
    .filter((entry): entry is [keyof MailtoParams, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  const address = encodeURIComponent(email);
  return query === "" ? `mailto:${address}` : `mailto:${address}?${query}`;
}
