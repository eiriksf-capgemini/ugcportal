import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * Who is making the change. `BOOTSTRAP` exists because the first admin can't
 * be granted by an admin — see reconcileBootstrapAdmin in
 * src/lib/admin-bootstrap.ts.
 */
export type RoleChangeActor =
  | { source: "BOOTSTRAP" }
  | { source: "ADMIN"; userId: string; email?: string | null };

/**
 * Why nothing happened, or that something did. Returned rather than thrown:
 * "you can't demote the last admin" is an ordinary answer to a reasonable
 * request, not an exceptional condition, and the caller renders it.
 */
export type SetUserRoleOutcome =
  | "updated"
  | "unchanged"
  | "user_not_found"
  | "last_admin";

export function isRole(value: unknown): value is Role {
  return value === "USER" || value === "ADMIN";
}

/**
 * Change a user's role and record who did it.
 *
 * THE COUNT AND THE WRITE SHARE A TRANSACTION, and what is measured about that
 * is narrower than "can't be read stale". Measured in
 * src/lib/roles.concurrency.test.ts (ugcportal-5bkn), against a real
 * file-backed SQLite database through `@prisma/adapter-libsql` and the `prisma`
 * singleton (the shape production has): two admins demoting each other through
 * two concurrent calls on that one client resolved, in all 40 rounds, to one
 * "updated" and one "last_admin" with one admin left. Run once by hand with the
 * transaction removed, that test failed with zero admins left (the mutation is
 * not kept), so on this client the transaction is what closes the lockout. What
 * is NOT measured: a second client or process on the same database file, and
 * Postgres at READ COMMITTED. Neither is claimed here, and ugcportal-lu7's note
 * that they behave differently is a claim, not a finding (that note says a
 * deferred transaction lets two concurrent demotions both read admins=2 and the
 * second write is rejected as SQLITE_BUSY_SNAPSHOT, a 500 rather than
 * "last_admin"; none of that was tested). If the app ever runs more than one
 * process against one database, re-measure before relying on this.
 *
 * The lockout this guards: two admins demoting each other at the same moment
 * would each see two admins and leave the instance with none, locked out of
 * every admin surface, with only the bootstrap env var left to recover.
 *
 * Note that the caller must already have established that it is allowed to do
 * this; nothing here checks the session (see requireAdmin in
 * src/lib/admin.ts).
 */
export async function setUserRole({
  userId,
  role,
  actor,
}: {
  userId: string;
  role: Role;
  actor: RoleChangeActor;
}): Promise<SetUserRoleOutcome> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true },
    });
    if (!target) {
      return "user_not_found";
    }
    if (target.role === role) {
      // No row written: an audit trail of no-ops is noise, and a repeated
      // form submit shouldn't look like repeated admin activity.
      return "unchanged";
    }
    if (target.role === "ADMIN") {
      const admins = await tx.user.count({ where: { role: "ADMIN" } });
      if (admins <= 1) {
        return "last_admin";
      }
    }

    await tx.user.update({ where: { id: userId }, data: { role } });
    await tx.roleChange.create({
      data: {
        targetUserId: target.id,
        targetEmail: target.email,
        previousRole: target.role,
        newRole: role,
        source: actor.source,
        actorUserId: actor.source === "ADMIN" ? actor.userId : null,
        actorEmail: actor.source === "ADMIN" ? (actor.email ?? null) : null,
      },
    });
    return "updated";
  });
}
