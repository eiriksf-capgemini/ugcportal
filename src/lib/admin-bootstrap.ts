import { prisma } from "@/lib/prisma";
import { setUserRole } from "@/lib/roles";

/**
 * Emails listed in ADMIN_BOOTSTRAP_EMAILS, normalised for comparison.
 *
 * Matching on the email rather than a user id is what makes this usable on a
 * fresh deployment: the operator has no id to name until someone has signed
 * in, and by then they'd need a way to look it up. The cost is that this
 * trusts the email the OAuth provider asserts — fine for Google and Facebook,
 * which verify it, but it means an address that can be registered at a
 * provider by someone else should never be listed here.
 */
export function bootstrapAdminEmails(
  raw: string | undefined = process.env.ADMIN_BOOTSTRAP_EMAILS,
): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

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
export async function reconcileBootstrapAdmin(user: {
  id?: string;
  email?: string | null;
}): Promise<boolean> {
  if (!user.id || !user.email) {
    return false;
  }
  if (!bootstrapAdminEmails().includes(user.email.toLowerCase())) {
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
