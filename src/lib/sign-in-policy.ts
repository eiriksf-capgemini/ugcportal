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
 * (ugcportal-1551), unioned since ugcportal-t33p with every identity in the
 * committed users array (src/config/users.ts) — is PROVISIONAL, and is not
 * a claim that an allowlist is the right mechanism.
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

import {
  CONFIGURED_USERS,
  type ConfiguredIdentity,
  type ConfiguredUser,
} from "@/config/users";
import { isEmailShaped as isEmailShapedBase } from "@/lib/email-shape";

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
 *
 * THIS LIST IS THE SOURCE the configured providers are built from, not a
 * copy of them: src/lib/sign-in-providers.ts maps each id here to its
 * Auth.js provider factory under a `satisfies Record<SignInProvider, ...>`
 * check, so adding a provider there without adding its id here (or the
 * reverse) fails to compile. It lives in THIS module rather than next to the
 * factories because src/instrumentation.ts imports this file in the Edge
 * instrumentation bundle and must not pull in the provider modules or the
 * Prisma client. The test in src/lib/auth.test.ts that compares the ids with
 * `authConfig.providers` remains, as the check that the Auth.js id each
 * factory reports really is the key it was built from. (PR #81 rounds 1 and
 * 3, finding 3.)
 */
export const SIGN_IN_PROVIDERS = ["google", "facebook"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

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
 * Does a parsed entry's binding admit THIS identity's asserted provider?
 * `null` on the entry (unbound) matches any provider, including none; a
 * bound provider matches only itself. The caller still has to check the
 * ADDRESS half — this is only ever the second half of "does this entry match
 * this address and provider".
 *
 * The ONE definition of that half, shared since ugcportal-qlfo (PR #81 round
 * 6 cap, low 1) by `evaluateSignIn` (the gate, judging `ALLOWED_SIGNIN_EMAILS`
 * plus the committed users array) and `isBootstrapAdminSignIn` (the
 * first-admin promotion, judging `ADMIN_BOOTSTRAP_EMAILS`). Before this it was
 * written out twice, and nothing stopped the two copies drifting apart on
 * exactly the rule PR #81 added — which would mean the gate and the
 * promotion disagreeing about who a bound entry matches.
 */
function entryMatchesProvider(
  entry: { provider: SignInProvider | null },
  provider: SignInProvider | null,
): boolean {
  return entry.provider === null || entry.provider === provider;
}

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
 *
 * WHITESPACE AROUND THE SEPARATOR (`google : x@y.com`, `google: x@y.com`,
 * `google :x@y.com`) IS ACCEPTED AND TRIMMED, not malformed — a DECISION,
 * not an accident of `.trim()` being there (ugcportal-qlfo item 2, which
 * considered the other answer and rejected it). The module's general stance
 * is that a deviation is reported rather than silently repaired (see the
 * unknown-prefix and doubled-prefix cases below), and padded colon spacing
 * looked like a candidate for the same treatment. It is not, because
 * `reviewConfiguredUsers` below already depends on the opposite answer for a
 * real fix: PR #98 round 2 found that TWO spellings of the same identity —
 * one with, one without, space after the colon — were being treated as the
 * SAME entry by the duplicate check (which used this parser's trimmed,
 * canonical form as its key) but as DIFFERENT entries by the filter that
 * acted on it (which compared untrimmed strings), so a duplicate the review
 * reported as removed was quietly kept and signed in anyway. Making colon
 * spacing malformed here would not restore that defect, but it would
 * contradict `reviewConfiguredUsers`'s own comment on the fix, and the
 * committed users array (src/config/users.ts) and the env vars share this
 * one parser specifically so operator typos in either are judged the same
 * way — rejecting them here while that comment still describes trimming as
 * the intended behaviour is the inconsistency this module exists to avoid.
 * So: accepted, and trimmed, on purpose.
 *
 * Exported since ugcportal-t33p, because the committed users array
 * (src/config/users.ts) is written in the SAME syntax — and whether
 * `google:Eirik@Example.com ` and `google:eirik@example.com` are one identity
 * has to be decided in one place, or the gate and the linking can disagree
 * about who just signed in. `reviewConfiguredUsers` below is the caller that
 * matters: it parses every identity in the array through this, once, and the
 * canonical string it builds is what everything downstream compares. Outside
 * this module the only caller is
 * src/lib/configured-user-reconciliation-migration.test.ts, which checks that
 * the identities hand-written into a reconciliation migration are the ones
 * this parser would produce.
 */
export function parsePermittedEntry(entry: string): PermittedEntry | null {
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
 * The bare shape check itself — one `@`, something either side, a dot in
 * the domain, no trailing dot — now lives in src/lib/email-shape.ts,
 * shared with src/lib/contact.ts's `isBareEmailAddress` (round-5 review:
 * the two used to carry separately maintained, near-identical regexes).
 * This function layers this module's OWN two exclusions on top of that
 * shared shape, because both are specific to parsing a permitted-sign-in-
 * email list and have no business in the shared check:
 *
 * `*` is excluded explicitly rather than left to the shape check, because
 * `*@example.com` IS email-shaped and is the single most likely way an
 * operator would try to write "anyone at this domain". There is no wildcard
 * here on purpose: a domain rule is one of the mechanisms Eirik has not
 * chosen, and half-implementing it as a wildcard would silently be that
 * choice. It is rejected loudly instead.
 *
 * `:` is excluded for the same reason in the other direction: it is the
 * provider-prefix separator (see parsePermittedEntry), so once the
 * prefix has been split off, an address that still contains one — `google:facebook:a@b.com`,
 * `google:a@b.com:` — is a doubled or trailing prefix, not a mailbox. Left
 * in, it would be counted as a permitted address that no provider can ever
 * assert: the silently-permits-nobody state this module exists to report
 * (PR #81 round 3). Neither configured provider issues addresses containing
 * a colon, so nothing real is excluded.
 */
function isEmailShaped(value: string): boolean {
  if (value.includes("*") || value.includes(":")) {
    return false;
  }
  return isEmailShapedBase(value);
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
 *
 * Exported since ugcportal-mzr, because src/lib/live-session.ts reads the
 * same kind of value — columns written from these ones — off a session row,
 * and had grown its own near-copy of this (PR #91 review, round 4, finding
 * 3). "Blank counts as absent" has to mean the same thing on both sides of
 * that write or the fallbacks stop lining up.
 */
export function normalizeString(value: unknown): string | null {
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
  return splitList(raw).map((entry) => parsePermittedEntry(entry)?.email ?? entry);
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
 *
 * ADMIN_BOOTSTRAP_EMAILS IS SPLIT AND PARSED HERE, INDEPENDENTLY of
 * `permittedIdentities` (below) parsing the same raw string again as part of
 * its own combined pass — two passes over the same short list, once per
 * sign-in. Sized for ugcportal-qlfo item 4 and left as two passes rather than
 * shared: the cost is a handful of string-split and regex operations over a
 * list that, per `permittedIdentities`'s own comment, "changes about once a
 * year," on the sign-in path rather than a per-request one. Sharing one
 * memoised parse between the two would mean threading pre-parsed entries
 * through `permittedIdentities`'s single combined pass — kept single on
 * purpose (see that function's own "ONE pass that builds everything" comment,
 * PR #91 review round 3 finding 1 — a DIFFERENT single-pass decision than
 * `reviewConfiguredUsers`'s, which is about its own, separate loop) — which is
 * more surface on an authorisation path than this negligible cost justifies.
 * Recorded here rather than fixed.
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
    const parsed = parsePermittedEntry(entry);
    return (
      parsed !== null &&
      parsed.email === email &&
      entryMatchesProvider(parsed, provider)
    );
  });
}

/* -------------------------------------------------------------------------
 * The committed users array (ugcportal-t33p).
 *
 * THIS LIVES HERE, in the module that decides who may sign in, and it did
 * not at first — it was src/lib/configured-users.ts, which imported this one
 * for the parser. PR #98 review found why that cannot stand: an array entry
 * the review calls broken (an identity listed under two people, two names
 * that slug to one handle) must not be PERMITTED either, or it is reported
 * at boot and admitted at sign-in anyway. That makes `permittedIdentities`
 * depend on the review and the review depend on the parser, which is a
 * cycle for as long as the two live in different modules. Merged rather than
 * split with a lazy import, because "who may sign in" and "which identities
 * are the same person" are now one question with one answer.
 *
 * Still no Prisma and no provider modules here: src/instrumentation.ts reads
 * all of this at boot, including in the Edge bundle. The half that writes to
 * the database is src/lib/configured-user-link.ts.
 * ---------------------------------------------------------------------- */

/**
 * One identity from the array, parsed: the provider id and the normalised
 * address. Both halves are mandatory — an entry that does not yield both is
 * not an identity, it is a configuration mistake, and `reviewConfiguredUsers`
 * both reports it and removes it.
 */
export type ConfiguredIdentityRef = {
  provider: SignInProvider;
  email: string;
};

/**
 * Letters the handle has an opinion about, because the operator is Norwegian
 * and `Bjørn` would otherwise lose a letter. Mapped explicitly rather than
 * through `normalize("NFKD")`, which decomposes `å` but leaves `ø` and `æ`
 * alone, so the result would be inconsistent between letters a reader thinks
 * of as one family.
 *
 * Deliberately NOT exhaustive over the world's alphabets, and that is safe
 * because of the companion check: a letter this map does not know is
 * REPORTED (`Łukasz` would silently become `ukasz`), not quietly dropped.
 * Extending this map is the fix, and the boot message says so.
 */
const TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  ["æ", "ae"],
  ["ø", "o"],
  ["å", "a"],
  ["ä", "a"],
  ["ö", "o"],
  ["ü", "u"],
  ["é", "e"],
  ["è", "e"],
  ["ß", "ss"],
]);

/**
 * The stable handle for one configured person: the key their single `User`
 * row is found by (`User.configuredHandle`).
 *
 * DERIVED FROM `name`, AND THAT IS THE WHOLE DESIGN DECISION. The handle has
 * to be stable across adding and reordering a person's identities — that is
 * the edit this feature exists to make safe — so it cannot come from the
 * identities. `name` is the only other thing the array knows about a person.
 *
 * The cost, stated so nobody has to discover it: RENAMING a person changes
 * their handle, and the next sign-in then finds no row and creates a second,
 * empty user. It is not detectable at boot (no database in the Edge bundle),
 * so it is documented instead, with the one-line `UPDATE` that makes a
 * rename safe, under "Renaming a person" in docs/access-control.md.
 *
 * `null` for a name that yields no handle at all. Not an empty string: a
 * blank handle is a value `User.configuredHandle`'s UNIQUE index accepts
 * once, which would silently adopt the first such person and fail for the
 * second.
 */
export function configuredUserHandle(user: ConfiguredUser): string | null {
  const slug = [...user.name.toLowerCase()]
    .map((character) => TRANSLITERATIONS.get(character) ?? character)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Every letter or digit in this name that the handle would SILENTLY DROP
 * (PR #98 review, low 2).
 *
 * `Łukasz` becomes `ukasz`: a stable, unique, perfectly functional handle
 * for a person whose name it has quietly mangled, and — worse — one that
 * collides with a different person actually called `Ukasz`. The dropped
 * characters are letters and digits only: a space, a hyphen, an apostrophe
 * or a full stop becomes a separator by design, and reporting those would
 * train the operator to ignore this check.
 */
function droppedFromHandle(name: string): string[] {
  const dropped: string[] = [];
  for (const character of name.toLowerCase()) {
    if (TRANSLITERATIONS.has(character) || /[a-z0-9]/.test(character)) {
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(character)) {
      dropped.push(character);
    }
  }
  return dropped;
}

/**
 * The identities of one configured person, parsed; unusable ones dropped.
 *
 * An entry whose provider half is missing is dropped too, even though
 * `ConfiguredIdentity` has no unbound form: the type constrains what can be
 * WRITTEN, and this is what the runtime relies on. An unbound identity would
 * match an address through either provider, which is the K5 failure ("two
 * different people merged because they share an e-mail") one edit away.
 */
export function configuredIdentities(
  user: ConfiguredUser,
): ConfiguredIdentityRef[] {
  const parsed: ConfiguredIdentityRef[] = [];
  for (const identity of user.identities) {
    const entry = parsePermittedEntry(identity.trim().toLowerCase());
    if (entry === null || entry.provider === null) {
      continue;
    }
    parsed.push({ provider: entry.provider, email: entry.email });
  }
  return parsed;
}

/**
 * What the array says, and what is wrong with it.
 *
 * `sound` IS THE ARRAY AS FAR AS THE REST OF THIS APP IS CONCERNED. Every
 * user and every identity named in `problems` has been removed from it, so a
 * reported mistake cannot also be acted on — which was the defect PR #98
 * review found: `problems` was printed at boot and the raw array was used
 * anyway, so an identity listed under two people still signed in as the
 * first of them, and two names slugging to one handle still landed on one
 * row.
 */
export type ConfiguredUsersReview = {
  sound: readonly ConfiguredUser[];
  problems: string[];
};

/**
 * Review the array: report every mistake, and remove whatever it names.
 *
 * REMOVAL IS FAIL-CLOSED IN BOTH DIRECTIONS, which is the point. A removed
 * identity is not permitted by the array (so, unless an env var names it
 * too, that identity cannot sign in at all) and it links nothing (so it
 * cannot land on somebody else's user). An operator who mistypes is locked
 * out of the thing they mistyped rather than quietly given the wrong
 * answer — and told, at boot, in one line naming the file.
 *
 * A user is removed WHOLE when the problem is about them (no identities, no
 * usable handle, a handle that drops a letter, a handle another person also
 * has). One identity is removed when the problem is about it (malformed,
 * unknown provider, claimed by more than one person — in which case it is
 * removed from EVERY claimant, because which of them meant it is exactly
 * what nobody can tell).
 *
 * Memoised on the array's identity, for the same reason and with the same
 * caveat as `permittedIdentities`: it runs on the sign-in path and on every
 * authenticated request, and nothing mutates the array in place.
 */
export function reviewConfiguredUsers(
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): ConfiguredUsersReview {
  const cached = cachedReview;
  if (cached && cached.users === users) {
    return cached.value;
  }

  const problems: string[] = [];
  /** Indices of the users removed whole. */
  const unsoundUsers = new Set<number>();
  /**
   * Canonical `provider:address` keys removed from everybody. ONE key
   * space — see `parsed` below for the round-2 defect that came of having
   * two.
   */
  const unsoundIdentities = new Set<ConfiguredIdentity>();
  /** Which users claim each identity, by index, for the duplicate check. */
  const claimants = new Map<ConfiguredIdentity, Set<number>>();
  /**
   * Which users claim each ADDRESS, ignoring the provider.
   *
   * A second index over the same entries, and not redundant with the one
   * above, because the DATABASE has an opinion the array does not: `User.
   * email` is UNIQUE on the address alone (prisma/schema.prisma). Two
   * different people listed under one address are therefore two rows that
   * cannot both exist, however different their providers are.
   */
  const addressClaimants = new Map<string, Set<number>>();
  /** Which users derive each handle, for the collision check. */
  const handles = new Map<string, number[]>();

  /**
   * EVERY IDENTITY, PARSED ONCE, UP FRONT — and the fix for PR #98 round 2,
   * medium 1.
   *
   * There used to be two key spaces in one set. The duplicate check keyed on
   * the PARSED pair (`parsePermittedEntry` trims around the colon, so
   * `"google: x@y.com"` parses to `google:x@y.com` — a DELIBERATE decision,
   * re-examined and kept by ugcportal-qlfo item 2, precisely because this is
   * the fix that decision would otherwise undo), while the filter at the
   * bottom asked `unsoundIdentities.has(identity.trim().toLowerCase())` —
   * which for that entry is `"google: x@y.com"`, inner space and all. The
   * two never matched, so an identity listed under two people was reported
   * as a duplicate and then kept by whichever of them wrote the spacing the
   * filter could not recognise. `findConfiguredUser` returned that person,
   * and the address was permitted: reported and acted on had come apart
   * again, one layer down from where round 1 put them together.
   *
   * So the parse happens once, here, and the canonical `provider:address`
   * string it produces is the ONLY key anything downstream uses — the
   * duplicate map, the unsound set, the filter, and the identities handed
   * out in `sound`. An entry that does not parse has no key at all, which
   * is what removes it: there is no second spelling for the filter to miss.
   */
  const parsed = users.map((user) =>
    user.identities.map((raw) => {
      const entry = parsePermittedEntry(raw.trim().toLowerCase());
      const usable = entry !== null && entry.provider !== null;
      return {
        raw,
        key: usable
          ? (`${entry.provider}:${entry.email}` as ConfiguredIdentity)
          : null,
        // The address on its own, because `User.email` is UNIQUE on exactly
        // that and not on the pair — see the cross-person check below.
        email: usable ? entry.email : null,
      };
    }),
  );

  users.forEach((user, index) => {
    const label = user.name.trim().length > 0 ? user.name : "(unnamed user)";

    if (user.identities.length === 0) {
      unsoundUsers.add(index);
      problems.push(
        `[auth] Configured user "${label}" has no identities, so nobody can ` +
          "sign in as them and no User row will ever be linked to them. " +
          `Give them at least one ${PROVIDER_PREFIX_HINT} identity in ` +
          "src/config/users.ts, or remove the entry.",
      );
    }

    const handle = configuredUserHandle(user);
    if (handle === null) {
      unsoundUsers.add(index);
      problems.push(
        `[auth] Configured user "${label}" has a name that yields no usable ` +
          "handle (it contains no letters or digits), so their identities " +
          "cannot be linked to a single User row. Until it is fixed they " +
          "are ignored entirely and cannot sign in through the array. See " +
          "src/config/users.ts.",
      );
    } else {
      handles.set(handle, [...(handles.get(handle) ?? []), index]);
      const dropped = droppedFromHandle(user.name);
      if (dropped.length > 0) {
        unsoundUsers.add(index);
        problems.push(
          `[auth] Configured user "${label}" has a name whose handle would ` +
            `silently drop ${dropped.map((c) => `"${c}"`).join(", ")} ` +
            `(it becomes "${handle}"), which both mangles their name and ` +
            "risks colliding with somebody else's. Until it is fixed they " +
            "are ignored entirely and cannot sign in through the array. Add " +
            "the letter to TRANSLITERATIONS in src/lib/sign-in-policy.ts, or " +
            "use an ASCII name in src/config/users.ts.",
        );
      }
    }

    for (const entry of parsed[index]) {
      // `key` and `email` are set together or not at all; both are named so
      // the compiler narrows both, rather than being told to trust one from
      // the other.
      if (entry.key === null || entry.email === null) {
        problems.push(describeUnusableIdentity(label, entry.raw));
        continue;
      }
      const claimed = claimants.get(entry.key);
      if (claimed) {
        claimed.add(index);
      } else {
        claimants.set(entry.key, new Set([index]));
      }
      const byAddress = addressClaimants.get(entry.email);
      if (byAddress) {
        byAddress.add(index);
      } else {
        addressClaimants.set(entry.email, new Set([index]));
      }
    }
  });

  for (const [identity, indices] of claimants) {
    if (indices.size > 1) {
      unsoundIdentities.add(identity);
      const names = [...indices].map((index) => users[index].name);
      problems.push(
        `[auth] The identity ${identity} is listed under more than one ` +
          `configured user (${names.join(", ")}), and nothing can tell which ` +
          "of them meant it, so it is ignored for all of them and cannot " +
          "sign in through the array. Remove the duplicate in " +
          "src/config/users.ts.",
      );
    }
  }

  /**
   * ONE ADDRESS, TWO PEOPLE (PR #98 round 3).
   *
   * The check above is per (provider, address) pair, which is the right
   * grain for "who is this sign-in" and the wrong one for what the database
   * will accept. `User.email` is UNIQUE on the ADDRESS, so
   * `google:shared@example.com` under Ada and `facebook:shared@example.com`
   * under Bob are two perfectly distinct identities and two rows that cannot
   * both exist. Nothing reported it: whoever signed in second got a P2002
   * out of `createUser`, no handle row to fall back to, and a lockout —
   * carrying a log line that told the operator to adopt the row that already
   * held the address, which would have stamped Bob's handle onto ADA's user.
   * Two humans, one account, arrived at by following the instructions.
   *
   * SO: both lose it. Each can still be admitted by an env entry, where
   * Auth.js's own behaviour for two people sharing an address applies
   * unchanged — which is to say the second of them still cannot have a row,
   * but that is the database's rule rather than this feature silently
   * merging them.
   *
   * THE MIRROR CASE IS DELIBERATELY FINE and must stay so: ONE person with
   * the same address at both providers is one row, which is the whole point
   * of the feature. That is why this groups by user index — two entries, one
   * claimant, no problem.
   *
   * Conservative on purpose where the two checks overlap: if the duplicate
   * check above already removed every identity carrying this address, it has
   * said the same thing better, so nothing is added here. Otherwise every
   * identity on the address goes, including one that might have survived the
   * removals above — fewer identities is the safe direction, and reasoning
   * about which survivors are still safe would mean iterating to a fixpoint.
   */
  for (const [address, indices] of addressClaimants) {
    if (indices.size <= 1) {
      continue;
    }
    const carrying = parsed
      .flat()
      .filter((entry) => entry.email === address && entry.key !== null)
      .map((entry) => entry.key as ConfiguredIdentity);
    if (carrying.every((key) => unsoundIdentities.has(key))) {
      continue;
    }
    for (const key of carrying) {
      unsoundIdentities.add(key);
    }
    const names = [...indices].map((index) => users[index].name);
    problems.push(
      `[auth] The address ${address} is listed under more than one ` +
        `configured user (${names.join(", ")}); one e-mail address can ` +
        "belong to one account, because User.email is UNIQUE, so the second " +
        "of them to sign in could never get a row. Every identity carrying " +
        "that address is ignored and cannot sign in through the array. Give " +
        "them an address each in src/config/users.ts. (The same address at " +
        "BOTH providers for ONE person is fine, and is the point of the " +
        "array.)",
    );
  }

  for (const [handle, indices] of handles) {
    if (indices.length > 1) {
      const names = indices.map((index) => users[index].name);
      for (const index of indices) {
        unsoundUsers.add(index);
      }
      problems.push(
        `[auth] More than one configured user has the handle "${handle}" ` +
          `(${names.join(", ")}). The handle is UNIQUE on User, so they ` +
          "would compete for one row; all of them are ignored and cannot " +
          "sign in through the array until they have distinguishable names " +
          "in src/config/users.ts.",
      );
    }
  }

  const sound: ConfiguredUser[] = [];
  users.forEach((user, index) => {
    if (unsoundUsers.has(index)) {
      return;
    }
    // CANONICAL KEYS, not the raw strings the operator typed. An entry with
    // no key did not parse and is gone by construction; the rest are handed
    // on in the one spelling every later comparison uses, so `"google:
    // x@y.com"` cannot survive as a second name for an identity that was
    // removed. Deduplicated because one person may write the same identity
    // twice (which is harmless, and not a problem worth reporting) and two
    // copies of it in `sound` would be two of everything downstream.
    const identities = [
      ...new Set(
        parsed[index]
          .map((entry) => entry.key)
          .filter(
            (key): key is ConfiguredIdentity =>
              key !== null && !unsoundIdentities.has(key),
          ),
      ),
    ];
    // A user with nothing left permits and links nothing; dropping them here
    // keeps every later loop over `sound` free of entries that cannot match.
    if (identities.length > 0) {
      sound.push({ name: user.name, identities });
    }
  });

  const value: ConfiguredUsersReview = Object.freeze({
    sound: Object.freeze(sound) as readonly ConfiguredUser[],
    problems: Object.freeze(problems) as string[],
  });
  cachedReview = { users, value };
  return value;
}

let cachedReview: {
  users: readonly ConfiguredUser[];
  value: ConfiguredUsersReview;
} | null = null;

/** Everything wrong with the array, as lines an operator can act on. */
export function configuredUserProblems(
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): string[] {
  return reviewConfiguredUsers(users).problems;
}

/**
 * Why one identity string is unusable, told apart rather than lumped
 * together: an unknown provider and a malformed address are two different
 * typos with two different fixes, and "it is ignored" is useless to an
 * operator who cannot see which half is wrong.
 */
function describeUnusableIdentity(name: string, identity: string): string {
  const normalized = identity.trim().toLowerCase();
  const colon = normalized.indexOf(":");
  const prefix = colon === -1 ? "" : normalized.slice(0, colon).trim();
  if (colon === -1 || providerId(prefix) === null) {
    return (
      `[auth] Configured user "${name}" has the identity "${identity}", ` +
      `which names no known provider. Each identity must begin with ` +
      `${PROVIDER_PREFIX_HINT}. It permits nobody and links nothing. ` +
      "See src/config/users.ts."
    );
  }
  return (
    `[auth] Configured user "${name}" has the identity "${identity}", whose ` +
    "address is not one exact email address (wildcards, blanks and a second " +
    "provider prefix are all rejected). It permits nobody and links " +
    "nothing. See src/config/users.ts."
  );
}

/**
 * Which configured person, if any, THIS (provider, address) pair is.
 *
 * EXACT ON BOTH HALVES (ugcportal-t33p K5). Not the domain, not the local
 * part, not the provider alone, and not the address alone — the two
 * together, each normalised the way the gate normalises them (`providerId`
 * and `normalizeString`, so the string the gate permitted is the string
 * matched here). An address listed under `google:` is not this person when
 * Facebook asserts it.
 *
 * ALWAYS OVER THE REVIEWED ARRAY, never the raw one: that is the single
 * place soundness is enforced, so there is no caller that can forget it
 * (PR #98 review, medium 2). `reviewConfiguredUsers` is memoised on the
 * array, so this costs one map lookup after the first call.
 *
 * Linear over a handful of people, deliberately. It runs a few times per
 * SIGN-IN — once in each wrapped adapter method that needs it — never per
 * request, and an index built at module load would be a second
 * representation of the array to keep in step with the first.
 */
export function findConfiguredUser(
  identity: { provider?: unknown; email?: unknown },
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): ConfiguredUser | null {
  const provider = providerId(identity.provider);
  const email = normalizeString(identity.email);
  if (provider === null || email === null) {
    return null;
  }
  for (const user of reviewConfiguredUsers(users).sound) {
    for (const candidate of configuredIdentities(user)) {
      if (candidate.provider === provider && candidate.email === email) {
        return user;
      }
    }
  }
  return null;
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
   * Whether ANY source contributed a non-blank entry at all — either
   * variable, or the committed users array.
   *
   * Distinguishes "the operator has not configured this yet" from "the
   * operator configured it and you are not on it" — the same refusal to the
   * visitor, two very different server-log lines.
   *
   * SINCE ugcportal-t33p THE ARRAY COUNTS TOO, and an instance whose users
   * array lists usable people IS configured whatever its environment says.
   * So on this repository, where src/config/users.ts is committed and
   * sound, this is normally true and `no-configuration` is normally out of
   * reach — which means a lost `ALLOWED_SIGNIN_EMAILS` revokes the sessions
   * of anyone who was permitted ONLY by that variable, rather than being
   * treated as the outage `REFUSAL_EFFECT` classifies `"keep"`.
   *
   * NORMALLY, NOT ALWAYS, and the difference is load-bearing (PR #98 round
   * 4, low 1): what is counted is the REVIEWED array, so an array that is
   * populated but wholly unsound — every person named in a boot problem,
   * which is the state `reviewConfiguredUsers` is for — contributes nothing
   * here. That instance is `configured: false`, gets the "NOBODY can sign
   * in" boot warning, and answers `no-configuration`, exactly as an empty
   * one does. Several tests depend on reaching that state; none of this is
   * hypothetical.
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
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): PermittedIdentities {
  const raw = env[PERMITTED_EMAILS_VAR];
  // Parsed again below, independently of `isBootstrapAdminSignIn`'s own read
  // of the same variable — see that function's doc comment for why this
  // duplicate parse (ugcportal-qlfo item 4) was sized and left alone rather
  // than shared.
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
  //
  // `users` joins the key by IDENTITY, not by value (ugcportal-t33p). In
  // production it is the one module-level constant in src/config/users.ts,
  // so the memo still hits on every request; a test that injects its own
  // array gets a miss and a fresh parse, which is the answer it asked for.
  // Comparing the arrays element-by-element instead would cost more than the
  // parse it saves.
  //
  // What this does NOT survive is somebody mutating that array IN PLACE: the
  // reference would be unchanged and the stale parse would be reused. The
  // `readonly` on `CONFIGURED_USERS` is a compile-time constraint, not a
  // runtime freeze, so this is a convention rather than a guarantee. Nothing
  // mutates it — the array is edited in the source and the process is
  // restarted, which is the same way `ALLOWED_SIGNIN_EMAILS` changes.
  const cached = cachedIdentities;
  if (
    cached &&
    cached.raw === raw &&
    cached.rawBootstrap === rawBootstrap &&
    cached.users === users
  ) {
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
    // The committed users array (ugcportal-t33p, K3). Its identities are
    // already written in this module's own `provider:address` syntax, so
    // they go through the SAME `splitList` + `parsePermittedEntry` pipeline
    // as the two variables above rather than a second parser: an identity
    // the gate would call malformed must be malformed here too, or an
    // operator could add a person who is linked but cannot sign in.
    //
    // Joined on commas and re-split, rather than spread directly, for the
    // same reason — one normalisation (trim, lowercase, drop blanks) for
    // every source. The array is operator data too, and nothing stops
    // somebody writing two addresses in one entry.
    //
    // THE REVIEWED ARRAY, not the raw one (PR #98 review, medium 2). An
    // identity the review rejects must not be permitted either, or the boot
    // check reports it and the gate admits it anyway. A consequence worth
    // stating: a rejected identity now needs an explicit ALLOWED_SIGNIN_EMAILS
    // entry to sign in at all. A second consequence, which is what makes the
    // malformed reporting honest: every entry that reaches `malformed` below
    // came from one of the two ENVIRONMENT VARIABLES, because the array's own
    // unusable entries were removed here and are reported — naming their own
    // file — by `configuredUserProblems` instead (PR #98 review, low 3).
    //
    // UNIONED, not substituted: `ALLOWED_SIGNIN_EMAILS` keeps working for
    // somebody who is not (yet) a person in the array, and a person in the
    // array needs no env var. Being listed here is itself the grant, the
    // same relation ADMIN_BOOTSTRAP_EMAILS has. It does NOT widen anything
    // else: every identity here is provider-BOUND by construction (there is
    // no unbound form of `ConfiguredIdentity`), so the same address through
    // the other provider is still refused with `wrong-provider`.
    ...splitList(
      reviewConfiguredUsers(users)
        .sound.flatMap((user) => user.identities)
        .join(","),
    ),
  ];

  // ONE pass that builds everything (PR #91 review, round 3, finding 1).
  //
  // `seen` is the de-duplication: first occurrence wins, keyed by the
  // (provider, address) tuple — the same first-wins idiom appendGalleryItems
  // (gallery-items.ts) and parseTagNames (tags.ts) now share as `dedupeBy`
  // (src/lib/dedupe.ts, ugcportal-oejb). NOT adopted here (K3 of that bead):
  // this loop builds `byEmail` — grouping every surviving entry by address,
  // not just keeping one per key — and collects `malformed` in the same
  // pass, over the SAME entries `seen` is deduping; `dedupeBy` only ever
  // returns a deduped array, so using it here would mean a second pass over
  // its result (to group by email and refind which entries never parsed) or
  // handing it a callback it does not take, either of which is more
  // machinery on an authorisation path than the one loop below. The key is
  // the JSON of the pair, not a hand-joined string, so it needs no separator
  // argument: `null` and every address serialise distinctly whatever
  // characters they contain (PR #81 round 4).
  //
  // `byEmail` is the index every decision looks entries up by, and it is
  // also where the distinct addresses come from: a Map iterates in insertion
  // order, so its keys ARE the first-seen address order a second pass used
  // to recompute.
  const seen = new Set<string>();
  const byEmail = new Map<string, PermittedEntry[]>();
  const malformed = new Set<string>();
  for (const entry of entries) {
    const usable = parsePermittedEntry(entry);
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
  cachedIdentities = { raw, rawBootstrap, users, value };
  return value;
}

/** The answer for an address nobody listed. One array, never written to. */
const NO_ENTRIES: readonly PermittedEntry[] = Object.freeze([]);

/**
 * The one parse kept across calls, keyed by everything it was made from.
 * Module-level, with no TTL to tune.
 *
 * Two of the three key parts are the raw strings themselves, so for those
 * the key IS the input and there is no way for the entry to go stale. The
 * third, `users`, is the ARRAY'S IDENTITY rather than its contents — see
 * `permittedIdentities` for why, and for the one thing that would defeat it
 * (mutating that array in place, which nothing does).
 */
let cachedIdentities: {
  raw: string | undefined;
  rawBootstrap: string | undefined;
  users: readonly ConfiguredUser[];
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
 * `"revoke"` means the answer is about THIS session and will not change on
 * its own, so the row is deleted (src/lib/live-session.ts). `"keep"` means
 * the policy could not be evaluated at all. Both refuse the request — fail
 * closed, every time, that part is not conditional — and the difference is
 * only what happens to the row.
 *
 * `no-configuration` is the whole of `"keep"`, and it is there because it
 * is an OUTAGE, not a decision: a deployment that lost its environment
 * variables refuses everybody, and deleting on it would log every user out
 * of every device at the moment nobody can sign in to notice. Restoring the
 * variable has to restore the sessions.
 *
 * `no-email` revokes, which is worth stating since it reads like the same
 * kind of thing (PR #91 review, round 4 addendum, finding 8). It is not: it
 * means this session has no address recorded AND the user row has none
 * either, so there is nothing to judge and nothing outside the row that can
 * change that. Classifying it `"keep"` left such a session refused on every
 * request forever and never deleted — a row that can only be removed by
 * expiring, for an identity that cannot sign in again either (the gate
 * refuses `no-email` too). Deleting it is the same decision the gate
 * already made, applied to the session that decision outlived.
 *
 * `unverified-email` cannot reach a live session at all — `decideLiveSession`
 * never returns it, having no profile to read the claim from. It is
 * classified `"keep"` because that is what an unreachable branch should be:
 * the conservative answer, chosen by nobody's hand being forced.
 */
export const REFUSAL_EFFECT = {
  "no-configuration": "keep",
  "no-email": "revoke",
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
 * stale, which since ugcportal-t33p matters for DISPLAY and audit only — the
 * header, `RoleChange.actorEmail`, the uploader label — and is recorded in
 * docs/access-control.md. It used also to decide the first-admin bootstrap;
 * `reconcileBootstrapAdmin` now reads the address THIS sign-in was permitted
 * under, out of the request's identity slot, which is this function's own
 * answer (PR #98 round 1, low 6). One address decides both.
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
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): SignInDecision {
  return evaluateSignIn(attempt, env, users).decision;
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
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): SignInDecision {
  return evaluateSignIn(
    {
      user: { email: identity.email },
      account: { provider: identity.provider },
    },
    env,
    users,
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
  users: readonly ConfiguredUser[],
): SignInEvaluation {
  const email = authorisedEmail(attempt);
  const provider = signInProvider(attempt);
  const identities = permittedIdentities(env, users);
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
  // matching the first of them. `entryMatchesProvider` is the one definition
  // of this rule, shared with `isBootstrapAdminSignIn` (ugcportal-qlfo item
  // 1), so the gate and the bootstrap promotion cannot silently disagree
  // about which entries match.
  const permitted = listed.some((entry) =>
    entryMatchesProvider(entry, provider),
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

/**
 * A configured provider id, or `null` for anything else. Fails closed.
 *
 * Exported since ugcportal-mzr: this is the one definition of "which
 * provider is this", and src/lib/live-session.ts now uses it on BOTH sides
 * of the `Session.signInProvider` column — to canonicalise what a sign-in
 * writes there, and (through `decideLiveSession`) to read it back on every
 * later request (PR #91 review, round 5). A write path with its own idea of
 * a valid provider is the "compares the wrong two things" family waiting to
 * happen: ` GOOGLE ` stored verbatim is a value the reader maps to `null`,
 * so the row looks attributed and behaves unattributed.
 */
export function providerId(value: unknown): SignInProvider | null {
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
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): boolean {
  const { decision, email, provider, identities } = evaluateSignIn(
    attempt,
    env,
    users,
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
