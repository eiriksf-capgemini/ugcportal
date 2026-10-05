import { currentSignInIdentity } from "@/lib/live-session";
import { prisma } from "@/lib/prisma";
import { setUserRole } from "@/lib/roles";
import {
  bootstrapAdminEmails,
  isBootstrapAdminSignIn,
} from "@/lib/sign-in-policy";

/**
 * Re-exported, not defined here, since ugcportal-egp.
 *
 * The list moved to src/lib/sign-in-policy.ts because the permitted-sign-in
 * set unions it in, and that module must not import this one: this one
 * imports Prisma, and src/instrumentation.ts reads the sign-in configuration
 * at boot — including in the Edge instrumentation bundle, where the Prisma
 * client cannot be loaded at all. One definition rather than a second parser
 * for the same variable, because the two lists agreeing is what makes the
 * bootstrap a subset of the permitted set rather than a way around it.
 */
export { bootstrapAdminEmails };

/**
 * Promote a listed user to ADMIN at sign-in, once.
 *
 * This is the only path that can create an admin on an instance that has
 * none — an admin-gated promotion screen can't grant the first grant. Its
 * obvious failure mode is re-promotion: an operator who leaves the variable
 * set, demotes themselves or a colleague through the UI, and then sees the
 * demotion quietly undone at their next login. So the trail is the guard —
 * if this user's role has ever been changed deliberately (by the UI, or by an
 * earlier bootstrap), the variable no longer has a say. The env var grants
 * the first admin; it does not hold anyone at ADMIN.
 *
 * What it can't defend against: anyone who can set environment variables on
 * the deployment can name themselves here and sign in as an admin. That's
 * accepted — they can also read DATABASE_URL and write the column directly —
 * but it is the reason the variable should be emptied once bootstrap is done
 * (documented in env.example).
 */
export async function reconcileBootstrapAdmin(
  user: {
    id?: string;
    email?: string | null;
  },
  // The provider this sign-in came through (Auth.js's `account` in the
  // signIn event). A bootstrap entry bound to a provider promotes only a
  // sign-in through that provider (PR #81 round 5); absent or unknown fails
  // closed against bound entries and is ignored by unbound ones.
  account?: { provider?: unknown } | null,
): Promise<boolean> {
  // THE ADDRESS THIS SIGN-IN WAS JUDGED ON, not the one stored on the row
  // (PR #98 review, low 6). They were the same thing until ugcportal-t33p:
  // one identity, one user, one address. Now a person can hold two
  // identities on one user, and `User.email` is whichever of them signed in
  // FIRST — @auth/core never refreshes it. So an operator who bootstraps
  // somebody under their Facebook address, on a user created by their
  // earlier Google sign-in, got no promotion and no explanation.
  //
  // Not a widening: the slot's address is the one `isPermittedSignIn` just
  // permitted on THIS request, it is still matched against
  // ADMIN_BOOTSTRAP_EMAILS and still bound to the provider the entry names,
  // and the role-history guard below is untouched. Outside a wrapped
  // request there is no slot (see `currentSignInIdentity`), and an
  // unfilled slot carries `null`, so both fall back to the stored address —
  // the behaviour every caller had before.
  const email = currentSignInIdentity()?.signInEmail ?? user.email;
  if (!user.id || !email) {
    return false;
  }
  if (!isBootstrapAdminSignIn({ email, provider: account?.provider })) {
    return false;
  }

  // A benign race: two simultaneous sign-ins can both pass this check, and
  // the loser's setUserRole call simply reports "unchanged".
  const priorChanges = await prisma.roleChange.count({
    where: { targetUserId: user.id },
  });
  if (priorChanges > 0) {
    return false;
  }

  const outcome = await setUserRole({
    userId: user.id,
    role: "ADMIN",
    actor: { source: "BOOTSTRAP" },
  });
  return outcome === "updated";
}
