import type { Metadata } from "next";

/**
 * Search Console and Pinterest site verification (ugcportal-qnq9.12, K4).
 *
 * BOTH BY META TAG, NEVER BY SCRIPT. Google and Pinterest each offer more
 * than one verification method, and both also offer one that is a `<script>`
 * tag or an analytics-style snippet — exactly the thing K4 says must be
 * rejected: "no third-party script runs and no non-essential storage is
 * written" before consent (ugcportal-3wgp). A meta tag is inert: the browser
 * parses it and does nothing else, requests nothing, and stores nothing. The
 * codebase's own existing defences against an uninvited script —
 * eslint.config.mjs's ban on `next/script`/raw `<script src>` outside
 * src/components/consent/analytics-loader.tsx, and that file's own grep test
 * — apply to this feature exactly as they apply to anything else; nothing
 * here asks for an exception to either.
 *
 * Read from the environment, like every other piece of deployment-specific
 * configuration in this repo (src/lib/legal/contact.ts, src/lib/s3.ts) — a
 * verification code is issued per-domain by Google/Pinterest and is not a
 * fact about the source tree. UNLIKE the legal pages' LEGAL_* variables,
 * leaving either of these unset is not a draft state to warn about or block
 * production for: verification is additive (a page is just as correct
 * without it, only not yet claimed with one or both platforms), so an unset
 * variable means the corresponding `<meta>` tag is simply absent rather than
 * rendering a placeholder a search engine or Pinterest would treat as a
 * literal (and wrong) verification code.
 *
 * Returns `undefined` — not `{}` — when neither variable is set, so
 * `metadata.verification` is omitted entirely rather than present-and-empty;
 * Next's metadata merging treats an explicit empty object differently from a
 * key a layout never set at all.
 */
export function siteVerification(
  env: NodeJS.ProcessEnv = process.env,
): Metadata["verification"] | undefined {
  const google = env.GOOGLE_SITE_VERIFICATION?.trim();
  const pinterest = env.PINTEREST_SITE_VERIFICATION?.trim();

  if (!google && !pinterest) return undefined;

  const verification: NonNullable<Metadata["verification"]> = {};
  if (google) {
    verification.google = google;
  }
  if (pinterest) {
    // Pinterest's own documented meta tag name for domain verification
    // ("Claim your website", docs/ugc-research.md §5.4) — not one of
    // Next's named `verification` shortcuts (`google`/`yahoo`/`yandex`/
    // `me`/`other`), so it goes through `other`, which Next renders as a
    // plain `<meta name="…" content="…">` the same as the named ones.
    verification.other = { "p:domain_verify": pinterest };
  }
  return verification;
}
