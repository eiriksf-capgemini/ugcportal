import type { Adapter, AdapterUser } from "next-auth/adapters";

import { CONFIGURED_USERS, type ConfiguredUser } from "@/config/users";
import type { UserUncheckedCreateInput } from "@/generated/prisma/models";
import { configuredUserHandle, findConfiguredUser } from "@/lib/configured-users";
import { currentSignInIdentity } from "@/lib/live-session";
import { prisma } from "@/lib/prisma";
import { PRISMA_UNIQUE_VIOLATION, prismaErrorCode } from "@/lib/prisma-errors";

/**
 * One person, several sign-in identities (ugcportal-t33p).
 *
 * WHERE THIS SITS IN THE FLOW, because that is the whole design and it is
 * not obvious from the outside. @auth/core's OAuth callback does this, in
 * this order (`handleOAuth`, then `handleAuthorized`, then
 * `handleLoginOrRegister` in node_modules/@auth/core/lib/actions/callback/):
 *
 *   1. exchange the code, build `user`, `account` and `profile`;
 *   2. **`callbacks.signIn`** — THE GATE (src/lib/sign-in-policy.ts). A
 *      refusal throws `AccessDenied` here and nothing below ever runs;
 *   3. `adapter.getUserByAccount({ provider, providerAccountId })`;
 *   4. `adapter.getUserByEmail(profile.email)` — only if (3) found nobody;
 *   5. `adapter.createUser(...)` then `adapter.linkAccount(...)` — only if
 *      (4) found nobody;
 *   6. `adapter.createSession(...)`;
 *   7. **`events.signIn`** — where the first-admin bootstrap runs.
 *
 * This module wraps steps 4 and 5. They are POST-GATE: step 2 has already
 * permitted the identity, and a refused sign-in never reaches them.
 *
 * ON K5's EXACT WORDING, which asks that linking "runs from the same
 * post-gate path as the bootstrap event (events.signIn)". It cannot run from
 * `events.signIn` itself, and no implementation could: that event fires at
 * step 7, four steps after the `User` and `Account` rows have already been
 * written, so by the time it runs the linking decision has been made and
 * acted on by somebody. Linking is therefore placed where the rows are
 * actually created — the adapter — and the two properties K5 is protecting
 * are kept and tested directly instead of inferred from the location:
 *
 *   * POST-GATE: the (provider, address) pair this module matches on comes
 *     from the AsyncLocalStorage slot filled by `rememberSignInIdentity`,
 *     which `callbacks.signIn` calls only after `isPermittedSignIn` returns
 *     true. No slot, no linking — the unwrapped adapter runs unchanged.
 *   * UNREACHABLE FROM `callbacks.signIn`: nothing here is called by the
 *     gate, and the gate writes nothing. Driving the callback on its own
 *     creates no `User` and no `Account` row at all.
 *
 * Both are asserted in src/lib/configured-user-link.test.ts rather than left
 * as prose.
 *
 * WHAT IS NOT WRAPPED, and why. `getUserByAccount` (step 3) is left alone:
 * an Account row that already exists already points at a user, and that
 * pointer is the authoritative answer to "whose account is this". Rewriting
 * it here would mean re-deciding ownership on every sign-in; moving a
 * pre-existing account to the configured user is a one-off, done by the
 * reconciliation in src/lib/configured-user-reconciliation.ts.
 */

/**
 * `User.configuredHandle`, derived from Prisma's own generated create input
 * rather than written as a string literal, so renaming the column in
 * prisma/schema.prisma stops this compiling. Same reason — and the same
 * idiom — as `SignInIdentity` in src/lib/live-session.ts.
 */
type ConfiguredHandle = Required<Pick<UserUncheckedCreateInput, "configuredHandle">>;

/**
 * The Prisma adapter, with a configured person's identities resolved to one
 * `User` row.
 *
 * `users` is a parameter so the behaviour can be driven against a fixture
 * array; production passes nothing and gets the committed one.
 */
export function withConfiguredUserLinking(
  adapter: Adapter,
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): Adapter {
  const createUser = adapter.createUser?.bind(adapter);
  const getUserByEmail = adapter.getUserByEmail?.bind(adapter);
  if (!createUser || !getUserByEmail) {
    // At construction, not per request — the same decision `withSessionIdentity`
    // makes for `createSession` and for the same reason: an adapter missing
    // these would silently give every configured person a second user per
    // provider, which is the defect this wrapper exists to remove, with
    // nothing anywhere saying why.
    throw new Error(
      "[auth] The configured adapter has no createUser/getUserByEmail, so a " +
        "person's sign-in identities cannot be linked to one user. See " +
        "src/lib/configured-user-link.ts (ugcportal-t33p).",
    );
  }

  /** The configured person signing in on THIS request, if any. */
  const signingIn = (): ConfiguredUser | null => {
    const identity = currentSignInIdentity();
    if (!identity) {
      return null;
    }
    return findConfiguredUser(
      { provider: identity.signInProvider, email: identity.signInEmail },
      users,
    );
  };

  return {
    ...adapter,

    /**
     * For a configured identity: nobody, always.
     *
     * NOT a shortcut, and not "there happens to be no row" — it is the
     * statement that a configured person's row is never found by address.
     * @auth/core asks this (step 4) to decide whether some OTHER account
     * already owns this email, and answers a hit by throwing
     * `OAuthAccountNotLinked` rather than linking, because it does not know
     * whether the two identities are the same human.
     *
     * For an identity in the array, the operator has said they are — in
     * committed, reviewed code, bound to one exact provider. That is the
     * same assertion `allowDangerousEmailAccountLinking` makes, narrowed
     * from "trust this provider's addresses in general" to "these four
     * pairs". Returning `null` hands the decision to `createUser` below,
     * which resolves by handle.
     *
     * The case that makes this load-bearing rather than tidy: one person
     * whose Google and Facebook accounts carry the SAME address. Their
     * second sign-in finds no Account row (step 3 — different provider) and
     * then finds their own User row by email (step 4), and without this
     * @auth/core would refuse the sign-in it just permitted, with
     * `OAuthAccountNotLinked`, forever.
     *
     * An identity not in the array is unaffected: the lookup runs, the throw
     * stands, and the protection @auth/core ships with is exactly where it
     * was.
     */
    getUserByEmail: async (email) => {
      if (signingIn()) {
        return null;
      }
      return getUserByEmail(email);
    },

    /**
     * For a configured identity: their one `User` row, created on first
     * sign-in and found by handle every time after.
     *
     * @auth/core calls this believing it is making a new user, and then
     * calls `linkAccount({ ...account, userId: user.id })` with whatever
     * comes back — which is exactly the hook needed, because the row this
     * returns is the row the new Account is attached to. Returning an
     * existing user is therefore how the second identity lands on the first
     * identity's user. (`events.createUser` fires either way; this config
     * registers no such event, and a future one would have to read
     * `isNewUser` from somewhere other than the fact that it fired.)
     *
     * The name is taken from the array, once, at creation. Not refreshed on
     * later sign-ins: a write on every first-link of every identity, to keep
     * a display value in step, is a cost paid forever for an edit that
     * happens about never — and docs/access-control.md documents the rename
     * procedure, which has to touch the row anyway.
     */
    createUser: async (data) => {
      const person = signingIn();
      if (!person) {
        return createUser(data);
      }
      const handle = configuredUserHandle(person);
      if (handle === null) {
        // Reported at boot by `configuredUserProblems`; here it can only
        // mean the array was edited to an unusable name after boot. Falling
        // through gives this person the ordinary per-identity user rather
        // than failing their sign-in — the pre-ugcportal-t33p behaviour,
        // which is degraded but not broken.
        return createUser(data);
      }

      const existing = await findByHandle(handle);
      if (existing) {
        return existing;
      }

      try {
        return await createUser({
          ...data,
          name: person.name,
          configuredHandle: handle,
        } as typeof data & ConfiguredHandle);
      } catch (error) {
        // Two sign-ins by the same person at the same moment (two tabs, or
        // the two providers this bead makes ordinary) can both find no row
        // and both insert. `configuredHandle` is UNIQUE, so the loser gets
        // P2002 and the winner's row is the right answer for both.
        //
        // Narrow on purpose: a P2002 from `User.email` — a DIFFERENT person's
        // row already holding this address, which the reconciliation exists
        // to clear up — finds no handle row on the re-read and is rethrown
        // rather than swallowed into a sign-in that silently did nothing.
        if (prismaErrorCode(error) !== PRISMA_UNIQUE_VIOLATION) {
          throw error;
        }
        const raced = await findByHandle(handle);
        if (!raced) {
          throw error;
        }
        return raced;
      }
    },
  };
}

/**
 * The person's row, by handle — the one lookup this feature performs, and
 * the reason `User.configuredHandle` is a column rather than something
 * derived.
 *
 * Cast to `AdapterUser` on the way out because the two types disagree about
 * one field and only one: Prisma's `User.email` is `string | null`, and
 * @auth/core's `AdapterUser` declares `email: string`. Widening `AdapterUser`
 * is not an option — it comes from a transitive `@auth/core` package, the
 * same reason `toRole` in src/lib/auth.ts reads its field off `object`.
 *
 * WHO ACTUALLY READS `email` OFF THIS, since the cast is a promise the
 * database does not keep. @auth/core takes `.id` from it (`linkAccount`,
 * `createSession`) and hands the object on to `events.signIn`, where this
 * app's `reconcileBootstrapAdmin` reads `.email` — and that function opens
 * with `if (!user.id || !user.email) return false`, so a null address is a
 * promotion that does not happen rather than a crash. Which is also the
 * right answer: a row with no address matches no bootstrap entry.
 */
async function findByHandle(handle: string): Promise<AdapterUser | null> {
  const row = await prisma.user.findUnique({ where: { configuredHandle: handle } });
  return (row as AdapterUser | null) ?? null;
}
