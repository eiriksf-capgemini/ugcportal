/**
 * Who may have an account on this instance (ugcportal-egp).
 *
 * THIS MODULE IS THE SEAM. `decideSignIn` is the single place that answers
 * "may this identity use this instance at all?"; `isPermittedSignIn` is the
 * thin wrapper around it that adds the server-side log line and the boolean
 * Auth.js wants, and `src/lib/auth.ts`'s `signIn` callback is that wrapper's
 * only production caller.
 *
 * Replacing the *rule* — an invite table, a domain match, a manual approval
 * queue — means rewriting three functions here: `permittedIdentities` (what
 * the permitted set is), `authorisedEmail` (which of the identity's
 * addresses is judged) and `decideSignIn` (the decision). A rule needing
 * more than an email also widens `SignInAttempt`; one needing a database
 * also makes `decideSignIn` async and the callback await it. Nothing else
 * should grow its own opinion about who is allowed in; see
 * docs/access-control.md for the decision this implements and the one it
 * deliberately does not make.
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
 * The rule below — a configured list of permitted email addresses, each
 * optionally bound to the one provider it may arrive through
 * (ugcportal-1551) — is PROVISIONAL, and is not a claim that an allowlist
 * is the right mechanism.
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
 * The provider ids an entry may be bound to (ugcportal-1551). These are
 * Auth.js provider ids — `account.provider` in the `signIn` callback — and
 * MUST match the providers configured in src/lib/auth.ts; a test there
 * asserts the two lists agree, so adding a provider without listing it here
 * fails a test rather than silently making `newprovider:addr` malformed.
 */
export const SIGN_IN_PROVIDERS = ["google", "facebook"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/**
 * This list is the SOURCE the configured providers are built from, not a
 * copy of them: src/lib/sign-in-providers.ts maps each id here to its
 * Auth.js provider factory under a `satisfies Record<SignInProvider, ...>`
 * check, so adding a provider there without adding its id here (or the
 * reverse) fails to compile. It lives in this module rather than next to the
 * factories because src/instrumentation.ts imports this file in the Edge
 * instrumentation bundle and must not pull in the provider modules or the
 * Prisma client. The test in src/lib/auth.test.ts that compares the ids with
 * `authConfig.providers` remains, as the check that the Auth.js id each
 * factory reports really is the key it was built from. (PR #81 rounds 1 and
 * 3, finding 3.)
 */

/**
 * How an operator is told to write a bound entry, in every message that
 * reports an unusable one — one string so the boot warning and the
 * per-refusal log line cannot drift apart.
 */
export const PROVIDER_PREFIX_HINT = SIGN_IN_PROVIDERS.map(
  (provider) => `${provider}:`,
).join(" or ");

function isSignInProvider(value: string): value is SignInProvider {
  return (SIGN_IN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * One usable allowlist entry. `provider: null` is the original, unbound
 * meaning — the address is permitted whichever configured provider vouches
 * for it. A bound entry (`google:addr`) permits the address only when THAT
 * provider is the one asserting it.
 */
export type PermittedEntry = {
  email: string;
  provider: SignInProvider | null;
};

/**
 * Parse one trimmed, lowercased entry. `null` means unusable.
 *
 * The separator is the first `:`. A colon can in principle appear in an
 * email's quoted local part, but neither configured provider issues such
 * addresses, and reading `google:x@y.com` as a mailbox called `google:x`
 * is the silent failure this parser exists to prevent — before this, that
 * entry WAS email-shaped and simply never matched anybody.
 *
 * An unknown prefix (`twitter:x@y.com`, or a typo like `gogle:`) is
 * malformed, not "unbound": treating it as a plain address would be
 * another entry that silently permits nobody, and treating it as unbound
 * would permit the address on providers the operator did not name.
 */
function parseEntry(entry: string): PermittedEntry | null {
  const colon = entry.indexOf(":");
  if (colon === -1) {
    return isEmailShaped(entry) ? { email: entry, provider: null } : null;
  }
  const prefix = entry.slice(0, colon).trim();
  const email = entry.slice(colon + 1).trim();
  if (!isSignInProvider(prefix) || !isEmailShaped(email)) {
    return null;
  }
  return { email, provider: prefix };
}

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
  //
  // `:` is excluded for the same reason in the other direction: it is the
  // provider-prefix separator (see parseEntry), so once the prefix has been
  // split off, an address that still contains one — `google:facebook:a@b.com`,
  // `google:a@b.com:` — is a doubled or trailing prefix, not a mailbox. Left
  // in, it would be counted as a permitted address that no provider can ever
  // assert: the silently-permits-nobody state this module exists to report
  // (PR #81 round 3). Neither configured provider issues addresses containing
  // a colon, so nothing real is excluded.
  if (value.includes("*") || value.includes(":")) {
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
  return normalizeString(value);
}

/**
 * The one definition of "comparable form" for an untrusted optional string
 * from Auth.js or configuration: trim, lowercase, and collapse absent,
 * non-string and blank to `null`. Shared by the address and the provider id
 * (PR #81 round 4) so a future change — Unicode case folding, say — happens
 * once.
 */
function normalizeString(value: unknown): string | null {
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
 * It lives HERE rather than there for two reasons. The permitted-sign-in set
 * reads the same variable, and one `splitList` shared by both is what keeps
 * the two from disagreeing about where an entry begins and ends — rather than
 * two parsers happening to agree. (Not a subset relation: an entry that fails
 * the shape check is in this list and not in the permitted one. It grants
 * nothing either way — the gate refuses it, so the promotion downstream of
 * the gate is never reached.) And this module
 * must not import that one: admin-bootstrap.ts imports Prisma, and
 * src/instrumentation.ts reads the sign-in configuration at boot, including in
 * the Edge instrumentation bundle where the Prisma client cannot be loaded.
 *
 * Note the default parameter. `permittedIdentities` deliberately does NOT call
 * this function, precisely because the default silently reads the ambient
 * `process.env` when a caller passes an env object without the key.
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
  // Addresses only, for reporting. The promotion decision does NOT use this
  // — it uses `isBootstrapAdminSignIn`, which honours a bound entry's
  // provider (PR #81 round 5). An unusable entry is returned as written; it
  // never matches a real address, so it still grants nothing.
  return splitList(raw).map((entry) => parseEntry(entry)?.email ?? entry);
}

/**
 * Whether THIS sign-in — address and provider together — is named for the
 * first-admin bootstrap (ugcportal-lu7).
 *
 * The binding is honoured here as well as at the gate (PR #81 round 5). It
 * has to be: the gate judges the union of both lists, so an operator who
 * writes `ALLOWED_SIGNIN_EMAILS=admin@x.com` and
 * `ADMIN_BOOTSTRAP_EMAILS=google:admin@x.com` has let the address in through
 * either provider while asking that only Google-asserted sign-ins be
 * promoted. Matching the bare address at promotion would hand ADMIN to the
 * Facebook sign-in — the binding defeated at the one place it mattered most.
 *
 * `raw` is a parameter, not read from an injected env object, because the
 * only caller is src/lib/admin-bootstrap.ts and its tests, which set the
 * variable on process.env.
 */
export function isBootstrapAdminSignIn(
  identity: { email: unknown; provider?: unknown },
  raw: string | undefined = process.env.ADMIN_BOOTSTRAP_EMAILS,
): boolean {
  const email = normalizeString(identity.email);
  if (!email) {
    return false;
  }
  const provider = providerId(identity.provider);
  return splitList(raw).some((entry) => {
    const parsed = parseEntry(entry);
    return (
      parsed !== null &&
      parsed.email === email &&
      (parsed.provider === null || parsed.provider === provider)
    );
  });
}

export type PermittedIdentities = {
  /**
   * The distinct permitted addresses, in first-seen order, FOR REPORTING —
   * the boot warning and the per-refusal log line. Not the thing to decide
   * on, because a listed address may be bound to a provider: the decision
   * goes through `entriesFor`.
   *
   * There is no flat `entries` array beside this any more (PR #91 review,
   * round 3, finding 2). It was the only other way to reach the parsed
   * entries, nothing read it once `entriesFor` existed, and a second public
   * view of the same data is a second thing to keep frozen and in step.
   */
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
  /**
   * The entries for one address, in first-seen order. Empty for an address
   * nobody listed.
   *
   * A lookup, not a scan (PR #91 review, round 2, finding 8). The decision
   * below runs on every authenticated request since ugcportal-mzr, and it
   * only ever wants the entries for ONE address; filtering the whole list
   * each time made the per-request cost scale with how many people the
   * operator has listed, when the parse had already visited every entry and
   * could index them for free.
   *
   * A function over a closed-over `Map` rather than an exposed `Map` field,
   * because this object is memoised and shared: `Object.freeze` does not
   * stop `map.set`, so a reachable Map would be a hole in exactly the
   * protection the freeze exists for.
   */
  entriesFor(email: string): readonly PermittedEntry[];
};

/**
 * The permitted set, from configuration.
 *
 * Pure: it logs nothing, so the decision can be tested without capturing
 * console output, and the logging lives at the one edge that has a request to
 * attach it to. It also reads BOTH variables out of the `env` it was handed
 * and neither out of the ambient `process.env` — see the note on `splitList`
 * below for the way that was quietly untrue at first.
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
  const raw = env[PERMITTED_EMAILS_VAR];
  const rawBootstrap = env.ADMIN_BOOTSTRAP_EMAILS;
  // Memoised on the two raw strings, because this now runs on EVERY
  // authenticated request (`decideLiveSession`, ugcportal-mzr) and not only
  // at sign-in, while the configuration changes about once a year.
  //
  // Keyed on the strings themselves rather than on the `env` object: the
  // parse is a pure function of exactly these two values — nothing else is
  // read — so two different env objects carrying the same two strings must
  // produce the same answer, and a single mutated `process.env` carrying
  // different ones must not reuse it. An env-object identity key would get
  // the second case wrong, which is the case that matters: a stale permitted
  // set is a revocation that does not happen.
  const cached = cachedIdentities;
  if (cached && cached.raw === raw && cached.rawBootstrap === rawBootstrap) {
    return cached.value;
  }
  const entries = [
    ...splitList(raw),
    // `splitList` directly, NOT `bootstrapAdminEmails(env.ADMIN_BOOTSTRAP_EMAILS)`
    // — that function has a default parameter reading `process.env`, so passing
    // the key of an env object that does not have it passes `undefined`, which
    // *triggers* the default and reads the ambient environment instead. The
    // result was a permitted set containing addresses the injected `env` never
    // mentioned: a gate granting from a source its caller believed it had
    // overridden (PR #45 review, round 1). Both lists are parsed by the same
    // `splitList`, so they still cannot drift.
    ...splitList(rawBootstrap),
  ];

  // ONE pass that builds everything (PR #91 review, round 3, finding 1).
  //
  // `seen` is the de-duplication: first occurrence wins, keyed by the
  // (provider, address) tuple — the same Set/Map idiom as appendGalleryItems
  // (gallery-items.ts) and parseTagNames (tags.ts), so "unique by what" is
  // stated by the key rather than by a comparison. The key is the JSON of
  // the pair, not a hand-joined string, so it needs no separator argument:
  // `null` and every address serialise distinctly whatever characters they
  // contain (PR #81 round 4).
  //
  // `byEmail` is the index every decision looks entries up by, and it is
  // also where the distinct addresses come from: a Map iterates in insertion
  // order, so its keys ARE the first-seen address order a second pass used
  // to recompute.
  const seen = new Set<string>();
  const byEmail = new Map<string, PermittedEntry[]>();
  const malformed = new Set<string>();
  for (const entry of entries) {
    const usable = parseEntry(entry);
    if (!usable) {
      malformed.add(entry);
      continue;
    }
    const key = JSON.stringify([usable.provider, usable.email]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const forEmail = byEmail.get(usable.email);
    if (forEmail) {
      forEmail.push(usable);
    } else {
      byEmail.set(usable.email, [usable]);
    }
  }
  const emails = Array.from(byEmail.keys());

  // Frozen before it is shared. The memo above hands the same object to
  // every caller, so a caller that mutated `emails` would be editing the
  // permitted set for every later request in the process; freezing turns
  // that from a silent, process-wide authorisation change into a throw (or,
  // in sloppy mode, a no-op). The entries themselves are reachable only
  // through `entriesFor`, which closes over `byEmail` rather than exposing
  // it — `Object.freeze` does not stop `Map.set`.
  const value: PermittedIdentities = Object.freeze({
    emails: Object.freeze(emails) as string[],
    malformed: Object.freeze(Array.from(malformed)) as string[],
    configured: entries.length > 0,
    entriesFor: (email: string) => byEmail.get(email) ?? NO_ENTRIES,
  });
  cachedIdentities = { raw, rawBootstrap, value };
  return value;
}

/** The answer for an address nobody listed. One array, never written to. */
const NO_ENTRIES: readonly PermittedEntry[] = Object.freeze([]);

/**
 * The one parse kept across calls, keyed by the exact strings it was made
 * from. Module-level and never invalidated by anything but a changed string:
 * there is no TTL to tune and no way for it to go stale, because the key IS
 * the input.
 */
let cachedIdentities: {
  raw: string | undefined;
  rawBootstrap: string | undefined;
  value: PermittedIdentities;
} | null = null;

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
  | "not-permitted"
  /** Listed, but only for a provider other than the one asserting it. */
  | "wrong-provider";

/**
 * What each refusal means for a session that ALREADY EXISTS: is it a
 * decision about the list, or a failure to evaluate the list at all?
 *
 * Lives here, beside the refusals themselves, rather than next to the code
 * that acts on it (PR #91 review, round 3, finding 3). Adding a refusal and
 * classifying it are then one edit in one file, and the `satisfies` below
 * makes the second half compulsory: a sixth variant that nobody classifies
 * is a compile error rather than a silent default.
 *
 * `"revoke"` means the identity is positively not permitted any more, so
 * the session row is deleted (src/lib/live-session.ts). `"keep"` means the
 * request is refused — fail closed, every time, that part is not
 * conditional — but the row survives. The difference is a revocation versus
 * an outage: `no-configuration` is what a deployment that lost its
 * environment variables looks like, and `no-email` describes a row rather
 * than a decision about the list. Deleting on those would log every user
 * out of every device at the moment nobody can sign in to notice.
 *
 * `unverified-email` cannot reach a live session at all — `decideLiveSession`
 * never returns it, having no profile to read the claim from — and is
 * classified with the others of its kind for the day that changes.
 */
export const REFUSAL_EFFECT = {
  "no-configuration": "keep",
  "no-email": "keep",
  "unverified-email": "keep",
  "not-permitted": "revoke",
  "wrong-provider": "revoke",
} satisfies Record<SignInRefusal, "revoke" | "keep">;

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
  /**
   * Which provider this sign-in came through — `account.provider` is the
   * provider id (`"google"`, `"facebook"`). Only consulted for a bound
   * entry. Auth.js builds an `account` for every flow it has (OAuth, email
   * and credentials alike — lib/actions/callback/index.js), but its type
   * admits `null`, and a provider id outside SIGN_IN_PROVIDERS is treated
   * the same as none: either can satisfy only an unbound entry.
   */
  account?: { provider?: unknown } | null;
  profile?: {
    email?: unknown;
    email_verified?: unknown;
    // The index signature mirrors @auth/core's own `Profile` (types.d.ts:158).
    // Without it this type is stricter than the thing it models, and a
    // realistic fixture — a Facebook profile carrying `name` and `id` and no
    // `email` — would not typecheck, which pushes tests towards unrealistic
    // ones.
    [claim: string]: unknown;
  } | null;
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
 * WHICH address this sign-in is judged on.
 *
 * The one the provider vouched for in THIS exchange, falling back to the one
 * the adapter has persisted only when the provider asserts none (Facebook's
 * Graph profile omits `email` when the app was not granted it).
 *
 * The two can differ, and the case is not exotic: `@auth/core` links an
 * account by `providerAccountId` — the provider's stable subject — not by
 * email (`getUserByAccount` in lib/actions/callback/index.js:55-61), and it
 * never refreshes `User.email` for an already-linked OAuth account
 * (`handleLoginOrRegister` returns `userByAccount` untouched,
 * lib/actions/callback/handle-login.js:121-127; the only `updateUser` on that
 * path is the email-provider branch). So anyone who changes their Google
 * address arrives, forever after, with a stale row and a fresh profile.
 *
 * Preferring the fresh one is a decision, not an ordering accident:
 *
 *  - the identity has not changed. The subject is the same; the email is an
 *    attribute of it, and the stale row is a cache of that attribute;
 *  - `profile.email` is not a weaker source. It is fetched server-side from
 *    the provider in the same exchange that produced `email_verified`, and
 *    for a new user the adapter derives `user.email` from exactly this value.
 *    It is the same source, fresher;
 *  - it keeps verification and authorisation about the SAME string, which is
 *    the property the old `email-mismatch` branch existed to protect — and it
 *    gets it by construction instead of by refusing;
 *  - every refusal it can produce is recoverable from configuration. The
 *    branch it replaces was not: it returned before the permitted set was
 *    ever consulted, so adding the new address did nothing, and with the row
 *    never refreshing, the only fix was editing the database. On a
 *    single-operator instance that was a permanent self-lockout of the only
 *    operator, triggered by something outside their control (PR #45 review,
 *    round 2).
 *
 * What it does NOT do is write the fresh address back. `User.email` stays
 * stale, which matters in exactly one place — `reconcileBootstrapAdmin`
 * matches the persisted address — and is recorded in docs/access-control.md.
 */
export function authorisedEmail(attempt: SignInAttempt): string | null {
  return (
    normalizeEmail(attempt.profile?.email) ?? normalizeEmail(attempt.user.email)
  );
}

/**
 * Permit or refuse one sign-in attempt.
 *
 * Reads as the order it decides in: is there an address at all, does the
 * provider stand behind it, is anything configured, is it on the list.
 *
 * A VIEW, not a layer: this and `isPermittedSignIn` are two thin projections
 * of `evaluateSignIn`, and neither calls the other. Production reaches only
 * `isPermittedSignIn`; this one exists so the decision can be asserted on
 * directly, without capturing log output. A change meant for production
 * belongs in `evaluateSignIn`, where both will see it (PR #81 round 4).
 */
export function decideSignIn(
  attempt: SignInAttempt,
  env: SignInEnv = process.env,
): SignInDecision {
  return evaluateSignIn(attempt, env).decision;
}

/**
 * The identity that minted a session that ALREADY EXISTS: the address the
 * provider asserted for it and the provider it came through
 * (`Session.signInEmail` / `Session.signInProvider`). Both are columns of
 * the session row the adapter already loads, which is what keeps the
 * re-check below free of extra queries — and what makes it a question about
 * THIS session rather than about everything its owner has ever done.
 */
export type LiveSessionIdentity = {
  email?: string | null;
  /**
   * `Session.signInProvider`. `unknown`, and not `SignInProvider`, because
   * it is whatever the column holds: null for a session minted before the
   * column existed, or one the migration's backfill could not attribute.
   * `providerId` maps anything unrecognised to `null`, which fails closed
   * against a bound entry.
   */
  provider?: unknown;
};

/**
 * Is the identity holding an already-issued session STILL permitted
 * (ugcportal-mzr)?
 *
 * The same decision as `decideSignIn`, over the same `evaluateSignIn`, asked
 * at a different moment — which is the entire point. Before this, the policy
 * was consulted once, at the door: `@auth/core` calls `callbacks.signIn` only
 * on a sign-in, so removing someone from `ALLOWED_SIGNIN_EMAILS` stopped them
 * signing in AGAIN and did nothing to the 30-day database session they were
 * already holding. Asking the same question of a live session is what makes
 * revocation a thing an operator can actually do.
 *
 * Deliberately NOT a second rule. Everything `decideSignIn` decides —
 * closed by default, the union with ADMIN_BOOTSTRAP_EMAILS, provider
 * binding, malformed entries permitting nobody — applies here unchanged,
 * because both are projections of `evaluateSignIn`. A rule that applied at
 * sign-in but not per request (or the reverse) would be the same defect
 * ugcportal-egp was, one layer along.
 *
 * Two differences from a sign-in attempt, both forced by what a request has
 * to work with, and both narrowing rather than widening:
 *
 *  - there is no fresh `profile`. The address judged is the one recorded on
 *    the session when it was minted — which IS the address the gate judged
 *    at sign-in, because `recordSignInIdentity` records `authorisedEmail`'s
 *    answer. For a session minted before that column existed, the caller
 *    falls back to the stored `User.email`, which is what this check judged
 *    before the column existed; for anyone who has since changed their
 *    provider address that is the stale one, so listing only the new address
 *    revokes the old session and the next sign-in, judged on the fresh
 *    address, mints a new one. Self-healing, in the safe direction;
 *  - `email_verified` is not re-asserted on a request, so it is not re-read,
 *    and THIS FUNCTION CANNOT RETURN `unverified-email`: that branch needs a
 *    `profile` claim, and no caller here has one (PR #91 review, round 1,
 *    finding 4). The claim was checked at sign-in against the address the
 *    provider vouched for, and this function can only refuse identities that
 *    one permitted. The refusal stays in `SignInRefusal` because the gate
 *    can still return it; src/lib/live-session.ts says the same thing where
 *    it classifies which refusals destroy a row.
 *
 * The `email` on a permitted answer is inert here: `SignInDecision` is the
 * shared shape, and this function's only caller reads `permitted` and
 * `reason` and nothing else. It is carried rather than stripped because a
 * narrower return type at this one boundary would be a second decision type
 * to keep in step with the first, for no caller's benefit.
 */
export function decideLiveSession(
  identity: LiveSessionIdentity,
  env: SignInEnv = process.env,
): SignInDecision {
  return evaluateSignIn(
    {
      user: { email: identity.email },
      account: { provider: identity.provider },
    },
    env,
  ).decision;
}

/**
 * Everything one sign-in attempt resolves to: the decision, plus the three
 * values the log line needs — the address judged, the provider asserted and
 * the parsed configuration. Computed once here so that `decideSignIn` and
 * `isPermittedSignIn` do not each re-parse the configuration and re-read the
 * provider (PR #81 round 1, findings 1 and 5). The configuration is parsed
 * even when the decision is made before it is consulted, because the
 * per-refusal log names unusable entries on EVERY refusal, including the
 * no-email one.
 */
type SignInEvaluation = {
  decision: SignInDecision;
  email: string | null;
  provider: SignInProvider | null;
  identities: PermittedIdentities;
};

function evaluateSignIn(
  attempt: SignInAttempt,
  env: SignInEnv,
): SignInEvaluation {
  const email = authorisedEmail(attempt);
  const provider = signInProvider(attempt);
  const identities = permittedIdentities(env);
  const refuse = (reason: SignInRefusal): SignInEvaluation => ({
    decision: { permitted: false, reason },
    email,
    provider,
    identities,
  });

  if (!email) {
    return refuse("no-email");
  }
  // Safe to read as being about `email` above: when the provider asserts an
  // address, that is the address chosen, so the claim and the subject of the
  // decision are the same string. When it asserts none it asserts no
  // verification either, and the persisted address stands on the same footing
  // as it did the day the provider supplied it.
  if (assertedUnverified(attempt.profile?.email_verified)) {
    return refuse("unverified-email");
  }
  if (!identities.configured) {
    return refuse("no-configuration");
  }
  const listed = identities.entriesFor(email);
  if (listed.length === 0) {
    return refuse("not-permitted");
  }
  // An unbound entry permits the address from any configured provider; a
  // bound one only from the provider it names. A missing or unrecognised
  // provider is `null`, which fails closed against bound entries rather than
  // matching the first of them.
  const permitted = listed.some(
    (entry) => entry.provider === null || entry.provider === provider,
  );
  if (!permitted) {
    return refuse("wrong-provider");
  }
  return { decision: { permitted: true, email }, email, provider, identities };
}

/** The provider id asserted by this attempt, or `null` when there is none. */
function signInProvider(attempt: SignInAttempt): SignInProvider | null {
  return providerId(attempt.account?.provider);
}

/** A configured provider id, or `null` for anything else. Fails closed. */
function providerId(value: unknown): SignInProvider | null {
  const normalized = normalizeString(value);
  return normalized !== null && isSignInProvider(normalized) ? normalized : null;
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
  const { decision, email, provider, identities } = evaluateSignIn(
    attempt,
    env,
  );
  if (decision.permitted) {
    return true;
  }

  // The address the decision was actually about, not `user.email` — those
  // differ for anyone whose provider address has changed, and a log line
  // naming a domain the gate did not judge is worse than no log line.
  const domain = emailDomain(email);
  // The provider is not personal data and is exactly what an operator who
  // bound an address to the wrong provider needs to see.
  const via = ` via ${provider ?? "an unrecognised provider"}`;
  if (decision.reason === "no-configuration") {
    console.error(
      `[auth] Refused a sign-in from ${domain}${via}: neither ${PERMITTED_EMAILS_VAR} ` +
        "nor ADMIN_BOOTSTRAP_EMAILS is set, so nobody may sign in to this " +
        "instance. See docs/access-control.md and env.example.",
    );
    return false;
  }

  // Unusable entries are named on every refusal, not only at boot: an
  // operator who typed `*@example.com` and got "Access Denied" is looking at
  // the log for THIS attempt, and a list that silently permits nobody is the
  // failure mode this reporting exists for.
  const { malformed } = identities;
  const malformedNote =
    malformed.length > 0
      ? ` Ignoring ${malformed.length} unusable entr${
          malformed.length === 1 ? "y" : "ies"
        } (${malformed.join(", ")}) — an exact address is required, ` +
        `optionally prefixed with ${PROVIDER_PREFIX_HINT}, ` +
        "and wildcards are not supported."
      : "";
  console.warn(
    `[auth] Refused a sign-in from ${domain}${via}: ${decision.reason}. ` +
      `Permitted addresses come from ${PERMITTED_EMAILS_VAR} ` +
      `(plus ADMIN_BOOTSTRAP_EMAILS); see docs/access-control.md.${malformedNote}`,
  );
  return false;
}
