/**
 * The contact address the About and Portfolio pages' mailto form sends to
 * (ugcportal-qnq9.7), and the one small guard that stops a real production
 * deploy shipping the placeholder silently.
 *
 * Eirik supplies the real address later, through the `CONTACT_EMAIL`
 * environment variable (see env.example). Until then every environment
 * — local dev, `npx vitest run`, and `npm run build`'s own production-mode
 * compile — falls back to {@link CONTACT_EMAIL_PLACEHOLDER}, an address on
 * the `.invalid` TLD (reserved by RFC 2606 for exactly this: guaranteed never
 * to be a real, deliverable domain, so it cannot be mistaken for a working
 * inbox if it ever did leak).
 *
 * THE GUARD, AND WHY IT IS A REQUEST-TIME CHECK, NOT A MODULE-TOP-LEVEL ONE.
 * `ugcportal-akv6`'s footer bead describes the sibling pattern this one
 * follows: "a footer link pointing at a page carrying a draft marker when
 * NODE_ENV is production" must never happen, "verified by ... a test that
 * reads a 'DRAFT' marker from page metadata and fails the production build
 * when one is linked." Neither akv6 nor ugcportal-qnq9.4 (the bead that would
 * otherwise be the one real precedent to copy code from) has landed yet, so
 * this is a small, self-contained implementation of the same idea rather
 * than a port of theirs.
 *
 * The obvious first draft — throw at module scope whenever
 * `NODE_ENV === "production"` and no real address is configured — does not
 * work here, and the reason is `next build` itself. Next always compiles in
 * production mode, including in this repo's own CI and its pre-push hook
 * (scripts/with-local-ca.mjs next build), and neither sets `CONTACT_EMAIL`.
 * A module-level throw would fail every ordinary build of this repo, not
 * only a real deploy that forgot to configure the address — indistinguishable
 * from the very failure it exists to catch. `resolveContactEmail` is
 * therefore called from INSIDE the page component's render, each of which
 * carries `export const dynamic = "force-dynamic"` (src/app/about/page.tsx,
 * src/app/portfolio/page.tsx) for exactly this reason — the same reason
 * src/app/page.tsx gives for its own `dynamic` export. That keeps the check
 * off the build's critical path entirely: it only ever runs against a real
 * incoming request, in a real running server, where `CONTACT_EMAIL` is
 * either genuinely set or genuinely missing.
 */
export const CONTACT_EMAIL_PLACEHOLDER = "REPLACE-BEFORE-LAUNCH@example.invalid";

export type ContactEmailEnv = {
  NODE_ENV?: string;
  CONTACT_EMAIL?: string;
};

/**
 * Resolves the address to show and mail to, or throws if this is a real
 * production request with nothing configured.
 *
 * Takes its environment as a parameter (defaulting to `process.env`) so the
 * unit tests exercise the real decision rather than a copy of it, without
 * mutating the process-wide `process.env` object a parallel test run also
 * reads.
 *
 * An empty or whitespace-only `CONTACT_EMAIL` counts as "not configured" —
 * env.example ships several real variables as blank lines the same way
 * (`AUTH_GOOGLE_ID=`), and treating that as "a value exists" here would let a
 * `.env` copied without every field filled in silently carry the placeholder
 * into what looks like a configured deployment.
 */
export function resolveContactEmail(
  env: ContactEmailEnv = process.env,
): string {
  const configured = env.CONTACT_EMAIL?.trim();
  if (configured) return configured;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "CONTACT_EMAIL is not set. Set the real contact address before this " +
        "page is served in production — the placeholder must never reach a " +
        "visitor.",
    );
  }

  return CONTACT_EMAIL_PLACEHOLDER;
}

/**
 * A `mailto:` target carrying a subject line, for the plain `<a>` fallback
 * next to the form (see ContactSection). No body is pre-filled: unlike a
 * subject, free text here would be the mail client's job to let the visitor
 * write, not this site's to template.
 *
 * The address itself is NOT percent-encoded, deliberately — only the query
 * string is. `mailto:` addresses are RFC 6068's "addr-spec" (the same ASCII
 * local-part/domain grammar email addresses always are), not a path or query
 * component, and several real mail clients take `%40` literally instead of
 * decoding it back to `@`. There is nothing in an address this function is
 * ever handed (CONTACT_EMAIL_PLACEHOLDER, or Eirik's real configured one)
 * that needs escaping in the first place.
 */
export function contactMailtoHref(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}
