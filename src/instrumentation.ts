/**
 * Next's boot hook. Runs once per server start, before any request.
 *
 * Used here for configuration warnings that would otherwise only surface as
 * a quiet difference in how data is stored — the kind nobody discovers until
 * an audit — or, for the sign-in gate below, as an unexplained refusal.
 */
import { CONTACT_EMAIL_PLACEHOLDER, isBareEmailAddress } from "@/lib/contact";
import {
  PERMITTED_EMAILS_VAR,
  PROVIDER_PREFIX_HINT,
  type SignInEnv,
  permittedIdentities,
} from "@/lib/sign-in-policy";

/**
 * Resale-rights evidence (ugcportal-0ss) is contracts and personal data:
 * signed instruments, model releases, filled-in checklists. It should be
 * encrypted at rest.
 *
 * The request-level header is off by default because the dev MinIO has no
 * KMS and rejects it (see src/lib/rights-evidence.ts), so a deployment
 * provisioned from env.example would silently store this in the clear. This
 * says so, loudly, once, at startup.
 *
 * A warning rather than a refusal to boot: bucket-level default encryption
 * satisfies the same requirement without the header, and taking a
 * correctly-configured deployment offline over an unset variable would be
 * the wrong trade. `S3_EVIDENCE_ENCRYPTED_AT_BUCKET` is how an operator
 * declares that, and silences this.
 */
export function checkEvidenceEncryption(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== "production") {
    return null;
  }
  if (
    env.S3_EVIDENCE_SSE === "AES256" ||
    env.S3_EVIDENCE_ENCRYPTED_AT_BUCKET === "true"
  ) {
    return null;
  }
  return (
    "[resale-rights] Evidence objects under rights-evidence/ will be stored " +
    "WITHOUT server-side encryption. These are contracts and personal data " +
    "(signed instruments, model releases). Set S3_EVIDENCE_SSE=AES256, or " +
    "enable default encryption on the bucket and set " +
    "S3_EVIDENCE_ENCRYPTED_AT_BUCKET=true to record that. See env.example."
  );
}

/**
 * Who may sign in (ugcportal-egp).
 *
 * The gate in src/lib/sign-in-policy.ts is closed by default: with no
 * configuration, every sign-in is refused. That is the correct default and
 * the wrong thing to be quiet about — an operator who deploys without
 * setting the variable would otherwise discover it as an unexplained "Access
 * Denied" on their own first sign-in, with the server saying nothing until
 * they tried. So both configuration states that permit nobody are announced
 * before the first request:
 *
 *  - nothing set at all, which refuses everybody; and
 *  - entries set but none of them usable, which also refuses everybody while
 *    looking configured. That one is the more dangerous of the two, because
 *    `*@example.com` reads like it works.
 *
 * A warning rather than a refusal to boot, for the same reason as the
 * encryption check above: the app is useful to a signed-out visitor — the
 * public gallery is the point — and taking the whole site offline because
 * nobody can sign in would be a worse failure than the one it reports.
 *
 * Unconditional, not production-only: a fresh local checkout is exactly
 * where someone hits this first, and env.example ships the variable empty.
 */
export function checkSignInConfiguration(
  env: SignInEnv = process.env,
): string | null {
  const { emails, malformed, configured } = permittedIdentities(env);

  if (malformed.length > 0) {
    return (
      `[auth] ${malformed.length} entr${malformed.length === 1 ? "y" : "ies"} ` +
      `in ${PERMITTED_EMAILS_VAR}/ADMIN_BOOTSTRAP_EMAILS ` +
      `cannot be used and ${malformed.length === 1 ? "was" : "were"} ignored: ` +
      `${malformed.join(", ")}. Each entry must be one exact email address, ` +
      `optionally prefixed with ${PROVIDER_PREFIX_HINT} ` +
      "to bind it to that provider; wildcards and domain patterns are not supported. " +
      `${emails.length === 0 ? "NOBODY can sign in to this instance." : `${emails.length} address(es) remain permitted.`} ` +
      "See docs/access-control.md."
    );
  }

  if (!configured) {
    return (
      "[auth] NOBODY can sign in to this instance: neither " +
      `${PERMITTED_EMAILS_VAR} nor ADMIN_BOOTSTRAP_EMAILS is set, and ` +
      "sign-in is refused by default (ugcportal-egp). Set " +
      `${PERMITTED_EMAILS_VAR} to a comma-separated list of the email ` +
      "addresses allowed to sign in and upload. See docs/access-control.md " +
      "and env.example."
    );
  }

  return null;
}

/**
 * The contact address the About and Portfolio pages' mailto form sends to
 * (ugcportal-qnq9.7). `resolveContactEmail` (src/lib/contact.ts) falls back
 * to a clearly-fake placeholder whenever `CONTACT_EMAIL` is unset — fine in
 * every environment except production, where a visitor would otherwise mail
 * an address nobody reads. Same shape as the two checks above: a warning
 * rather than a refusal to boot, because the rest of the site is useful
 * without a working contact form.
 *
 * TWO DIFFERENT PROBLEMS, two different conditions for warning about them
 * (round-2 review added the second). "Unset" is fine everywhere except
 * production — dev and CI never configure it, same reasoning as the
 * evidence-encryption check above. A MALFORMED value — `CONTACT_EMAIL` set
 * to something other than a bare address, e.g. "Jane Doe
 * <jane@example.com>" — is worth flagging in every environment, the same
 * way the sign-in check below is unconditional: it is a real configuration
 * mistake the moment it is made, not merely "not got round to yet", and
 * `contactMailtoHref` (src/lib/contact.ts) does no parsing of that shape —
 * it would build a mailto href against the whole malformed string.
 */
export function checkContactEmailConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.CONTACT_EMAIL?.trim();

  if (configured && !isBareEmailAddress(configured)) {
    return (
      `[contact] CONTACT_EMAIL is set to "${configured}", which is not a ` +
      'bare email address (it contains whitespace or an angle bracket — ' +
      '"Jane Doe <jane@example.com>" rather than "jane@example.com"). ' +
      "Nothing parses a display name out of it before building a mailto: " +
      "link. Set it to the address alone. See env.example."
    );
  }

  if (env.NODE_ENV !== "production") {
    return null;
  }
  if (configured) {
    return null;
  }
  return (
    "[contact] CONTACT_EMAIL is not set. The About and Portfolio pages' " +
    `contact form will show the placeholder address (${CONTACT_EMAIL_PLACEHOLDER}) ` +
    "to every visitor until it is. See env.example."
  );
}

export async function register(): Promise<void> {
  for (const warning of [
    checkEvidenceEncryption(),
    checkSignInConfiguration(),
    checkContactEmailConfiguration(),
  ]) {
    if (warning) {
      console.error(warning);
    }
  }
}
