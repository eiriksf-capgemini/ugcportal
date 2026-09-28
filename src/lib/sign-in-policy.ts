/**
 * Who may have an account on this instance (ugcportal-egp).
 *
 * THIS MODULE IS THE SEAM. `decideSignIn` is the single place that answers
 * "may this identity use this instance at all?"; `isPermittedSignIn` is the
 * thin wrapper around it that adds the server-side log line and the boolean
 * Auth.js wants, and `src/lib/auth.ts`'s `signIn` callback is that wrapper's
 * only production caller. Replacing the *rule*
 * — an invite table, a domain match, a manual approval queue — means
 * rewriting `permittedIdentities` and, if the new rule needs more than an
 * email, widening `decideSignIn`'s input. Nothing else should grow its own
 * opinion about who is allowed in; see docs/access-control.md for the
 * decision this implements and the one it deliberately does not make.
 *
 * WHY IT EXISTS: before this there was no `signIn` callback at all — the
 * first-admin bootstrap ran as an Auth.js *event*, and nothing occupied the
 * callback. @auth/core's `defaultCallbacks.signIn` (lib/init.js) returns
 * `true`, so the effective rule was "permit everyone". With Google and
 * Facebook configured, and every gate downstream (`POST /api/media`,
 * `/upload`, publish) asking only whether the caller was signed in, any
 * Google or Facebook account on the internet could sign in, upload, and
 * publish to the public gallery.
 *
 * The rule below — a configured list of permitted email addresses — is
 * PROVISIONAL, and is not a claim that an allowlist is the right mechanism.
 * What is not provisional is the default: with no configuration present,
 * every sign-in is refused. That is the property the defect lacked, and it
 * holds under every mechanism that might replace this one.
 *
 * ON READING THE CONFIGURATION: deliberately not `requireEnv` (src/lib/s3.ts,
 * src/lib/instagram.ts). `requireEnv` throws on a missing value, which is
 * right for a credential that makes a feature impossible — an S3 request
 * without a bucket name has nothing to do but fail. It is wrong here twice
 * over. Throwing inside the `signIn` callback is caught by Auth.js and turned
 * into the same `AccessDenied` as an ordinary refusal, so an operator who
 * forgot the variable would get "Access Denied" and no explanation. And an
 * unset variable is a *configuration* state this module has a defined, safe
 * answer for — refuse everybody — rather than an impossible one. So it is
 * read, not required, and the state is said out loud at boot instead, by
 * `checkSignInConfiguration` in src/instrumentation.ts.
 */

/**
 * The permitted-address list. Comma-separated, compared case-insensitively.
 */
export const PERMITTED_EMAILS_VAR = "ALLOWED_SIGNIN_EMAILS";

/**
 * Narrower than `NodeJS.ProcessEnv` on purpose: only ALLOWED_SIGNIN_EMAILS
 * and ADMIN_BOOTSTRAP_EMAILS are read, and this project's `ProcessEnv`
 * requires NODE_ENV, so the wider type would make every caller — every test
 * especially — construct or cast a whole environment to state two variables.
 * `process.env` satisfies this.
 */
export type SignInEnv = Readonly<Record<string, string | undefined>>;

/**
 * Shape-only, not RFC 5322: one `@`, something either side, and a dot in the
 * domain. Its job is to catch the entries that would otherwise fail silently
 * and confusingly — a bare username, a typo'd separator (`a@b.com;c@d.com`
 * is one entry, not two, because only commas split), a `*` someone wrote
 * expecting a wildcard. A stricter regex would reject valid addresses and
 * lock people out; a looser one would let `*` sit in the list looking like it
 * worked. Whitespace is excluded so a quoted `"a b"@c.com` is rejected rather
 * than half-normalised.
 */
const EMAIL_SHAPE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function isEmailShaped(value: string): boolean {
  // `*` is excluded explicitly rather than left to the shape check, because
  // `*@example.com` IS email-shaped and is the single most likely way an
  // operator would try to write "anyone at this domain". There is no wildcard
  // here on purpose: a domain rule is one of the mechanisms Eirik has not
  // chosen, and half-implementing it as a wildcard would silently be that
  // choice. It is rejected loudly instead.
  if (value.includes("*")) {
    return false;
  }
  return EMAIL_SHAPE.test(value);
}

/**
 * Trim, lowercase, and reduce absent-or-empty to `null`.
 *
 * `user.email` is optional on the Auth.js user object, and an absent email
 * must not be able to match anything, so absent, empty and whitespace-only
 * all collapse to the same value and `decideSignIn` refuses on it before any
 * comparison happens. Two independent guards stand between an absent email
 * and an empty list entry: that refusal, and `splitList` dropping blank
 * entries.
 *
 * `null` rather than `""` because `string[].includes(null)` does not compile,
 * so a future caller that skips the refusal gets a type error instead of a
 * silent empty-string comparison.
 *
 * Lowercasing the local part is not correct in general (RFC 5321 leaves it to
 * the receiving host) but it is correct for the providers configured here:
 * Google and Facebook both hand back a single canonical lowercase address,
 * and an operator who types `First@Example.com` into the env var means the
 * same person.
 */
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Emails listed in ADMIN_BOOTSTRAP_EMAILS, normalised for comparison
 * (ugcportal-lu7). Also re-exported from src/lib/admin-bootstrap.ts, which is
 * where it used to live and where its consumer is.
 *
 * It lives HERE rather than there because the permitted-sign-in set unions it
 * in, and this module must not import that one: admin-bootstrap.ts imports
 * Prisma, and src/instrumentation.ts reads the sign-in configuration at boot,
 * including in the Edge instrumentation bundle where the Prisma client cannot
 * be loaded.
 *
 * Matching on the email rather than a user id is what makes the bootstrap
 * usable on a fresh deployment: the operator has no id to name until someone
 * has signed in, and by then they'd need a way to look it up. The cost is
 * that this trusts the email the OAuth provider asserts — fine for Google and
 * Facebook, which verify it, but it means an address that can be registered
 * at a provider by someone else should never be listed here.
 */
export function bootstrapAdminEmails(
  raw: string | undefined = process.env.ADMIN_BOOTSTRAP_EMAILS,
): string[] {
  return splitList(raw);
}

export type PermittedIdentities = {
  /** Email-shaped, normalised, de-duplicated. Empty means nobody. */
  emails: string[];
  /** Entries that were present but not usable, for the operator's benefit. */
  malformed: string[];
  /**
   * Whether either variable was set to anything non-blank at all.
   *
   * Distinguishes "the operator has not configured this yet" from "the
   * operator configured it and you are not on it" — the same refusal to the
   * visitor, two very different server-log lines.
   */
  configured: boolean;
};

/**
 * The permitted set, from configuration.
 *
 * Pure: it takes the environment and logs nothing, so the decision can be
 * tested without capturing console output, and the logging lives at the one
 * edge that has a request to attach it to.
 *
 * ADMIN_BOOTSTRAP_EMAILS is folded in, and that is the whole answer to how
 * this composes with the first-admin bootstrap (ugcportal-lu7) — see
 * docs/access-control.md. The union makes the bootstrap list a subset of the
 * permitted set by construction, which cuts both ways and is the point:
 *
 *  - a fresh deployment that sets only ADMIN_BOOTSTRAP_EMAILS still works,
 *    so the bead that shipped the bootstrap is not broken by this one; and
 *  - the bootstrap cannot admit anyone the allowlist would refuse, because
 *    being on it is itself a grant. There is no "the database is empty, so
 *    let this person in" branch anywhere in this path — `reconcileBootstrapAdmin`
 *    never asks whether the database is empty, only whether THIS user is
 *    listed and has no role history — so there is no empty-database window
 *    to arrange or race.
 */
export function permittedIdentities(
  env: SignInEnv = process.env,
): PermittedIdentities {
  const entries = [
    ...splitList(env[PERMITTED_EMAILS_VAR]),
    // Already trimmed and lowercased by bootstrapAdminEmails; re-running the
    // shape check on them is not redundant, because a malformed entry there
    // would otherwise just never match and never be mentioned.
    ...bootstrapAdminEmails(env.ADMIN_BOOTSTRAP_EMAILS),
  ];

  const emails: string[] = [];
  const malformed: string[] = [];
  for (const entry of entries) {
    const target = isEmailShaped(entry) ? emails : malformed;
    if (!target.includes(entry)) {
      target.push(entry);
    }
  }

  return { emails, malformed, configured: entries.length > 0 };
}

/**
 * Why a sign-in was refused. Server-side only: every one of these reaches the
 * visitor as the same `AccessDenied` and the same page, so which of them it
 * was is never disclosed. (Someone who controls an address can always learn
 * whether that address is permitted by trying it — that is inherent to any
 * allowlist-shaped rule. What stays hidden is everything about the others.)
 */
export type SignInRefusal =
  | "no-configuration"
  | "no-email"
  | "unverified-email"
  | "email-mismatch"
  | "not-permitted";

export type SignInDecision =
  | { permitted: true; email: string }
  | { permitted: false; reason: SignInRefusal };

/**
 * What Auth.js hands the `signIn` callback, narrowed to what this decision
 * reads. `profile` is the provider's own parsed profile for THIS sign-in;
 * `user` is the adapter's row when the account is already linked and the
 * provider-derived user when it is not (see handleAuthorized in
 * @auth/core/lib/actions/callback).
 */
export type SignInAttempt = {
  user: { email?: string | null };
  profile?: { email?: unknown; email_verified?: unknown } | null;
};

/**
 * `false` only when the provider positively says the address is unverified.
 *
 * Google sends the OIDC `email_verified` claim; Facebook's Graph profile has
 * no equivalent field, so absence cannot mean "unverified" without refusing
 * every Facebook sign-in. Absence therefore means "not asserted" and the
 * address is taken at the provider's word — which is the same trust
 * ADMIN_BOOTSTRAP_EMAILS already documents relying on.
 *
 * The string forms are handled because `email_verified` arrives as whatever
 * JSON the provider sent; some OIDC implementations send `"false"`.
 */
function assertedUnverified(claim: unknown): boolean {
  return claim === false || claim === "false";
}

/**
 * Permit or refuse one sign-in attempt.
 *
 * The address compared against the list is `user.email`, because that is the
 * address the adapter will persist and every downstream gate will see. But it
 * is only trusted once the provider's own profile agrees with it: a profile
 * that asserts `email_verified: false`, or that names a different address
 * than the one being authorised, is refused rather than reconciled. Without
 * that the verification signal would be about one address while the
 * authorisation decision was about another.
 *
 * The mismatch branch is fail-closed, and it can fire on a legitimate
 * change: someone whose Google address changes arrives with a profile email
 * that no longer matches their stored one, and is refused until the operator
 * adds the new address. That is the right side to fail on for a private
 * instance, and the log line names the reason.
 */
export function decideSignIn(
  attempt: SignInAttempt,
  env: SignInEnv = process.env,
): SignInDecision {
  const email = normalizeEmail(attempt.user.email);
  if (!email) {
    return { permitted: false, reason: "no-email" };
  }
  if (assertedUnverified(attempt.profile?.email_verified)) {
    return { permitted: false, reason: "unverified-email" };
  }
  const asserted = normalizeEmail(attempt.profile?.email);
  if (asserted && asserted !== email) {
    return { permitted: false, reason: "email-mismatch" };
  }

  const identities = permittedIdentities(env);
  if (!identities.configured) {
    return { permitted: false, reason: "no-configuration" };
  }
  if (!identities.emails.includes(email)) {
    return { permitted: false, reason: "not-permitted" };
  }
  return { permitted: true, email };
}

/**
 * The domain, for logs. A refused sign-in is worth recording — it is how an
 * operator debugs their own lockout — but the full address of someone who
 * tried to sign in is personal data this instance has no reason to keep in a
 * log file, so only the part that answers "did I get the domain wrong?"
 * survives.
 */
function emailDomain(email: string | null | undefined): string {
  if (typeof email !== "string") {
    return "(none)";
  }
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at) : "(malformed)";
}

/**
 * The boolean Auth.js wants, plus the log line the operator needs.
 *
 * Every refusal is logged, because the failure this module is most likely to
 * cause is an operator locking themselves out, and "Access Denied" with
 * nothing on the server side is the confusing dead end.
 */
export function isPermittedSignIn(
  attempt: SignInAttempt,
  env: SignInEnv = process.env,
): boolean {
  const decision = decideSignIn(attempt, env);
  if (decision.permitted) {
    return true;
  }

  const domain = emailDomain(normalizeEmail(attempt.user.email));
  if (decision.reason === "no-configuration") {
    console.error(
      `[auth] Refused a sign-in from ${domain}: neither ${PERMITTED_EMAILS_VAR} ` +
        "nor ADMIN_BOOTSTRAP_EMAILS is set, so nobody may sign in to this " +
        "instance. See docs/access-control.md and env.example.",
    );
    return false;
  }

  // Unusable entries are named on every refusal, not only at boot: an
  // operator who typed `*@example.com` and got "Access Denied" is looking at
  // the log for THIS attempt, and a list that silently permits nobody is the
  // failure mode this reporting exists for.
  const { malformed } = permittedIdentities(env);
  const malformedNote =
    malformed.length > 0
      ? ` Ignoring ${malformed.length} unusable entr${
          malformed.length === 1 ? "y" : "ies"
        } (${malformed.join(", ")}) — an exact address is required and ` +
        "wildcards are not supported."
      : "";
  console.warn(
    `[auth] Refused a sign-in from ${domain}: ${decision.reason}. ` +
      `Permitted addresses come from ${PERMITTED_EMAILS_VAR} ` +
      `(plus ADMIN_BOOTSTRAP_EMAILS); see docs/access-control.md.${malformedNote}`,
  );
  return false;
}
