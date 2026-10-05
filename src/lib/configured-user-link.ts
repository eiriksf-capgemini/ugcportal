import { AccessDenied } from "@auth/core/errors";
import type { Adapter, AdapterUser } from "next-auth/adapters";

import { CONFIGURED_USERS, type ConfiguredUser } from "@/config/users";
import type { UserUncheckedCreateInput } from "@/generated/prisma/models";
import { currentSignInIdentity } from "@/lib/live-session";
import { prisma } from "@/lib/prisma";
import { PRISMA_UNIQUE_VIOLATION, prismaErrorCode } from "@/lib/prisma-errors";
import {
  configuredUserHandle,
  findConfiguredUser,
  normalizeString,
} from "@/lib/sign-in-policy";

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
 * This module wraps steps 4 and 5 — and `linkAccount` wherever @auth/core
 * calls it, including the call that comes after neither of them. All are
 * POST-GATE: step 2 has already permitted the identity, and a refused
 * sign-in never reaches them.
 *
 * THAT OTHER `linkAccount` IS THE ONE THAT MATTERS MOST (PR #98 review,
 * medium 1). When the request already carries a session cookie, @auth/core
 * takes a different branch entirely (handle-login.js:206-212): no
 * `getUserByEmail`, no `createUser`, just
 * `linkAccount({ ...account, userId: <the SIGNED-IN user>.id })`. So if Gry
 * is signed in on this browser and Eirik then signs in with Google, Eirik's
 * Google `Account` row is attached to GRY's user — and every later sign-in
 * of his resolves, through `getUserByAccount`, to Gry. Two people, one
 * account: exactly the merge K5 forbids, arriving through the one adapter
 * method the first version of this wrapper left alone.
 *
 * IT RUNS IN BOTH DIRECTIONS, which the first version of the guard did not
 * (round 2, medium 2). "A configured identity may only be linked to its own
 * person's row" leaves the mirror image open: an identity belonging to
 * NOBODY in the array, admitted by `ALLOWED_SIGNIN_EMAILS`, signing in on
 * top of a configured person's session, and being attached to THEIR row.
 * Same outcome, same branch, opposite end. So the guard asks both
 * questions — whose identity is this, and whose row is that — and refuses
 * unless the two are the same person.
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
 * pre-existing account to the configured user is a one-off, done by
 * prisma/migrations/20261005120500_reconcile_configured_users.
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
  const linkAccount = adapter.linkAccount?.bind(adapter);
  if (!createUser || !getUserByEmail || !linkAccount) {
    // At construction, not per request — the same decision `withSessionIdentity`
    // makes for `createSession` and for the same reason: an adapter missing
    // these would silently give every configured person a second user per
    // provider, or (without `linkAccount`) leave the hijack above unguarded,
    // with nothing anywhere saying why.
    throw new Error(
      "[auth] The configured adapter has no createUser/getUserByEmail/" +
        "linkAccount, so a person's sign-in identities cannot be linked to " +
        "one user. See src/lib/configured-user-link.ts (ugcportal-t33p).",
    );
  }

  /**
   * The configured person signing in on THIS request, and the address they
   * were permitted under. Both come from the one post-gate slot.
   *
   * `findConfiguredUser` reads the REVIEWED array (`reviewConfiguredUsers`
   * in src/lib/sign-in-policy.ts), so a person or identity the boot check
   * reports as broken answers `null` here and takes the unwrapped adapter
   * path — reported and acted on are the same set, which they were not
   * before (PR #98 review, medium 2). The review is memoised on the array,
   * so it is computed once however many times this is called.
   */
  const signingIn = (): {
    person: ConfiguredUser;
    email: string;
  } | null => {
    const identity = currentSignInIdentity();
    if (!identity) {
      return null;
    }
    const person = findConfiguredUser(
      { provider: identity.signInProvider, email: identity.signInEmail },
      users,
    );
    const email = normalizeString(identity.signInEmail);
    return person && email ? { person, email } : null;
  };

  return {
    ...adapter,

    /**
     * For a configured identity asked about ITS OWN address: nobody.
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
     *
     * NARROWED TO THE SLOT'S OWN ADDRESS (PR #98 review, low 1). The first
     * version answered `null` to ANY address while a configured identity was
     * signing in. @auth/core only ever asks about `profile.email` on this
     * path, so no production call was wrong — but the method is public on
     * the adapter, and "suppress every lookup for the duration of this
     * request" is a far wider claim than the one being made, which is about
     * one address. Asked about anybody else, it answers honestly.
     */
    getUserByEmail: async (email) => {
      const signIn = signingIn();
      if (signIn && normalizeString(email) === signIn.email) {
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
      const signIn = signingIn();
      if (!signIn) {
        return createUser(data);
      }
      const { person } = signIn;
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
          // NOT A RACE, then: the only other UNIQUE column this insert
          // touches is `User.email`, so some OTHER row already holds this
          // person's address — the pre-ugcportal-t33p state the
          // reconciliation exists to clear up. Rethrowing is right (a
          // sign-in that silently did nothing would be worse), but a bare
          // P2002 from inside an adapter is unreadable, and this is a
          // LOCKOUT: that person cannot sign in until somebody acts. So say
          // which handle, which address, and what the cure is (PR #98
          // round 2, low).
          console.error(
            `[auth] Could not create the user row for configured handle ` +
              `"${handle}": another row already holds the address ` +
              `${signIn.email}. ${person.name} cannot sign in until that ` +
              "row is adopted — run " +
              "prisma/migrations/20261005120500_reconcile_configured_users " +
              "(or, for somebody added to the array since, a new " +
              "reconciliation migration; see docs/access-control.md).",
            error,
          );
          throw error;
        }
        return raced;
      }
    },

    /**
     * A configured identity's `Account` row may only ever be attached to
     * that person's own user (PR #98 review, medium 1).
     *
     * On the path this wrapper already handled, `createUser` has just
     * returned the person's row and @auth/core passes its id straight back
     * here, so this agrees and passes through. The call that needs the
     * guard is the OTHER one — the already-signed-in branch, which hands
     * over whoever owns the SESSION COOKIE on this browser and never
     * consults the identity signing in. Without this, Gry's session plus
     * Eirik's Google sign-in puts Eirik's account on Gry's user, and
     * `getUserByAccount` then resolves him to her for good.
     *
     * REFUSES RATHER THAN REDIRECTS THE WRITE. Silently re-pointing the
     * link at the right user would mean a visitor signed in as one person
     * quietly acquiring an account for another, which is a different
     * surprise rather than a smaller one; and the browser's session still
     * belongs to the first person either way. Refusing leaves every row
     * where it was and ends the attempt.
     *
     * `AccessDenied` is the refusal, and the choice is load-bearing: it is
     * `kind: "error"`, so @auth/core redirects to `pages.error` — this app's
     * own Access Denied page (src/app/auth/error/page.tsx) — with the same
     * words every other refusal gets. `AccountNotLinked`, which reads like
     * the better name, is `kind: "signIn"` and would land on @auth/core's
     * BUILT-IN sign-in page instead, since this config sets no `pages.signIn`
     * — the "sign in again" loop PR #45 deliberately replaced. Both are in
     * @auth/core's `clientErrors` set, so neither leaks anything; only one
     * goes where this app's refusals go. Pinned by a test.
     *
     * A person whose row carries no handle yet (they signed in before
     * ugcportal-t33p and nothing has adopted their row) is refused here too,
     * because nothing can prove the incoming user is theirs. Stamping the
     * handle makes the same sign-in pass — but note WHICH stamping:
     * prisma/migrations/20261005120500_reconcile_configured_users carries a
     * snapshot of the array as it stood when it was written, so re-running
     * it does nothing for anybody added since. For them it is a new
     * reconciliation migration, or the single `UPDATE` in
     * docs/access-control.md under "Adding a person who already has an
     * account".
     *
     * WRAPPING THE METHOD, not a path, is what makes this complete:
     * @auth/core calls `linkAccount` from FOUR places (handle-login.js:133
     * and :161 on the WebAuthn branches, :209 on the signed-in OAuth branch,
     * :264 on the new-user one), and every one of them goes through this.
     * A guard written into the two paths this wrapper already knew about
     * would have been the sibling-omission defect one layer along.
     *
     * `Promise<void>`, so the wrapped adapter's return value is discarded.
     * Not a swallowed result: `Adapter["linkAccount"]` is declared as
     * `Promise<void> | Awaitable<AdapterAccount | null | undefined>`, which
     * no single function can satisfy both halves of, and none of those four
     * call sites reads the value — each is a bare
     * `await linkAccount({ ... })`. Choosing `void` needs no cast.
     */
    linkAccount: async (data): Promise<void> => {
      const signIn = signingIn();
      if (!signIn) {
        // THE OTHER DIRECTION (PR #98 round 2, medium 2). The guard below
        // asks "is this identity's person the row being written to?", which
        // says nothing at all when the identity belongs to NOBODY in the
        // array — and that is the same attack from the other end. An address
        // admitted by ALLOWED_SIGNIN_EMAILS alone, signing in on top of a
        // configured person's open session, reaches
        // handle-login.js:209 with `userId` set to that person's row: the
        // stranger's `Account` is attached to it, and from then on
        // `getUserByAccount` resolves the stranger to that person — their
        // uploads, their role, their rights clearance.
        //
        // So a row that belongs to a configured person may only ever be
        // linked by one of THEIR identities. `configuredHandle` is exactly
        // "this row belongs to a configured person", which is why the check
        // is one column read and not a scan of the array.
        //
        // Everyone else is untouched: an ordinary user's row has a null
        // handle, so two allowlisted colleagues sharing a browser behave
        // exactly as Auth.js has always made them behave. Widening that is a
        // separate decision about Auth.js's own default, not this bead.
        const target = data.userId
          ? await prisma.user.findUnique({
              where: { id: data.userId },
              select: { configuredHandle: true },
            })
          : null;
        if (target?.configuredHandle) {
          console.error(
            `[auth] Refused to link a ${data.provider} account to user ` +
              `${data.userId}, which belongs to configured user ` +
              `"${target.configuredHandle}" — the identity signing in is ` +
              "not one of theirs. This is what signing in on top of " +
              "somebody else's open session looks like; nothing was " +
              "written. See src/lib/configured-user-link.ts.",
          );
          throw new AccessDenied(
            "That account cannot be added to the signed-in user.",
          );
        }
        await linkAccount(data);
        return;
      }
      const handle = configuredUserHandle(signIn.person);
      if (handle === null) {
        // Reported at boot, and the review would normally have removed this
        // person already; falling through gives the unmodified Auth.js
        // behaviour rather than failing a sign-in over a diagnostic.
        await linkAccount(data);
        return;
      }
      const owner = await findByHandle(handle);
      if (owner && owner.id === data.userId) {
        await linkAccount(data);
        return;
      }
      console.error(
        `[auth] Refused to link a ${data.provider} account for configured ` +
          `user "${signIn.person.name}" to user ${data.userId}, which is ` +
          `not their row (${owner?.id ?? "they have none yet"}). This is ` +
          "what a sign-in made while another person's session is open looks " +
          "like; nothing was written. See src/lib/configured-user-link.ts.",
      );
      throw new AccessDenied(
        "This sign-in identity belongs to a different user on this instance.",
      );
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
