import type { SignInProvider } from "@/lib/sign-in-policy";

/**
 * The people who may use this instance, and which SSO identities belong to
 * each of them (ugcportal-t33p).
 *
 * WHY THIS IS A COMMITTED TYPESCRIPT MODULE rather than an environment
 * variable or a database table. It is operator data — it changes when a
 * person is added, which is roughly never — and the repository is private,
 * so the addresses are no more exposed here than they are in a deployment's
 * environment. Committing it buys three things an env var cannot: the
 * provider ids are checked by the COMPILER (see `ConfiguredIdentity`), the
 * array is reviewable in a diff, and "who is Eirik" has a single answer that
 * cannot differ between two deployments of the same commit.
 *
 * WHAT IT DOES, in one line each:
 *
 *  - every identity listed here is PERMITTED to sign in, in addition to
 *    `ALLOWED_SIGNIN_EMAILS` and `ADMIN_BOOTSTRAP_EMAILS` — adding a person
 *    here is the one step that admits them (`permittedIdentities` in
 *    src/lib/sign-in-policy.ts);
 *  - all of one person's identities LINK to one `User` row, so they share an
 *    id, a role and an upload history (src/lib/configured-user-link.ts);
 *  - the row is found by a handle derived from `name`
 *    (`configuredUserHandle` in src/lib/configured-users.ts), never by email.
 *
 * `name` IS THEREFORE A KEY, not merely a label. Renaming a person here
 * changes their handle, and the next sign-in would create a second, empty
 * user rather than finding the existing one. See "Renaming a person" in
 * docs/access-control.md for the one `UPDATE` that makes a rename safe.
 *
 * Out of scope for this module: roles (nobody is made an admin by being
 * listed here — that is still `ADMIN_BOOTSTRAP_EMAILS` and the admin UI),
 * and any public display of `name` (ugcportal-137).
 */

/**
 * One identity: the provider it arrives through, then the address that
 * provider asserts, in the same `provider:address` syntax
 * `ALLOWED_SIGNIN_EMAILS` accepts (ugcportal-1551).
 *
 * The template-literal type over the `SignInProvider` union is what makes
 * the prefix a COMPILE-TIME check: `"gogle:a@b.com"` or `"twitter:a@b.com"`
 * does not typecheck, where in the env var the same typo is only reported at
 * boot. Add a provider to `SIGN_IN_PROVIDERS` and this type widens with it,
 * because it is derived from that one list rather than repeating it.
 *
 * The ADDRESS half is `string` and so is not checked by the compiler —
 * `"google:"` and `"google:*@example.com"` both typecheck. They are caught
 * at boot instead, by `checkConfiguredUsers` in src/instrumentation.ts,
 * which reports a malformed identity the same way the env-var parser reports
 * a malformed entry. Being unbound is impossible here by construction: there
 * is no form of this type without a provider prefix.
 */
export type ConfiguredIdentity = `${SignInProvider}:${string}`;

export type ConfiguredUser = {
  /**
   * The person's name, and the source of their stable handle. See the note
   * above: changing it is a database edit, not just an edit here.
   */
  readonly name: string;
  /**
   * Every identity that is this person. Order is not significant; nothing
   * derives from it.
   */
  readonly identities: readonly ConfiguredIdentity[];
};

/**
 * Annotated rather than `as const satisfies`, deliberately: the annotation
 * is what makes an entry with a bad provider prefix a type error at the
 * literal that contains it, and nothing in this app needs the literal types
 * of the names or addresses.
 */
export const CONFIGURED_USERS: readonly ConfiguredUser[] = [
  {
    name: "Eirik",
    identities: [
      "google:eiriksanderfjeld@gmail.com",
      "facebook:eirik@sander-fjeld.com",
    ],
  },
  {
    name: "Gry",
    identities: ["facebook:gry@sander-fjeld.no"],
  },
  {
    name: "August",
    identities: ["google:augustsanderfjeld@gmail.com"],
  },
];
