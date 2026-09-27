import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { RIGHTS_SETTINGS_PATH } from "@/lib/routes";

import { changeUserRole } from "./actions";
import { roleOutcomeMessage } from "./outcomes";

export const metadata = {
  title: "Users and roles",
};

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

// Enough to see what just happened and who did it, without turning the
// settings screen into a log viewer.
const AUDIT_ROWS = 20;

export default async function AdminUsersPage({
  searchParams,
}: PageProps<"/admin/settings/users">) {
  // `notFound` rather than an explicit 403 page, matching the Instagram
  // settings screen: an ordinary user shouldn't learn that an admin area
  // exists here.
  const session = await requireAdmin();
  if (!session) {
    notFound();
  }

  const { error } = await searchParams;
  const [users, roleChanges] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    }),
    prisma.roleChange.findMany({
      orderBy: { createdAt: "desc" },
      take: AUDIT_ROWS,
    }),
  ]);

  const adminCount = users.filter((user) => user.role === "ADMIN").length;
  const errorMessage = roleOutcomeMessage(error);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Users and roles</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Admins can reach every admin-only screen, including{" "}
        <a
          className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          href={RIGHTS_SETTINGS_PATH}
        >
          resale rights
        </a>{" "}
        and connected Instagram accounts. A role change takes effect on the
        user&apos;s next request — they do not have to sign out and back in.
      </p>
      {/*
        The link above is not decoration. Until ugcportal-vsm the only route
        to the resale-rights screen sat on the Instagram settings page — a
        deferred feature — and there is no admin nav, so an operator who never
        connects an account had no discoverable way to reach the one screen
        that gates all selling. This screen is the one an operator visits
        regardless.
      */}

      {errorMessage ? (
        <p className="mt-6 rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <ul className="mt-8 divide-y divide-border rounded-lg border border-border">
        {users.map((user) => {
          const isAdmin = user.role === "ADMIN";
          const isLastAdmin = isAdmin && adminCount === 1;
          return (
            <li
              key={user.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {user.name ?? user.email ?? user.id}
                </p>
                <p className="text-xs text-muted-foreground">
                  {user.email ?? "no email"} ·{" "}
                  {isAdmin ? "Admin" : "User"} · joined{" "}
                  {dateTimeFormat.format(user.createdAt)}
                </p>
              </div>
              <form action={changeUserRole}>
                <input type="hidden" name="userId" value={user.id} />
                <input
                  type="hidden"
                  name="role"
                  value={isAdmin ? "USER" : "ADMIN"}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant={isAdmin ? "destructive" : "default"}
                  // The server refuses this anyway (see setUserRole); the
                  // disabled button just explains why before the round trip.
                  disabled={isLastAdmin}
                  title={
                    isLastAdmin
                      ? "The only admin can't be demoted — promote someone else first."
                      : undefined
                  }
                >
                  {isAdmin ? "Revoke admin" : "Make admin"}
                </Button>
              </form>
            </li>
          );
        })}
      </ul>

      <h2 className="mt-12 text-lg font-semibold tracking-tight">
        Role change history
      </h2>
      {roleChanges.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No role changes recorded yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          {roleChanges.map((change) => (
            <li key={change.id}>
              {dateTimeFormat.format(change.createdAt)} ·{" "}
              {change.targetEmail ?? change.targetUserId}:{" "}
              {change.previousRole} → {change.newRole} ·{" "}
              {change.source === "BOOTSTRAP"
                ? "ADMIN_BOOTSTRAP_EMAILS"
                : (change.actorEmail ?? change.actorUserId ?? "an admin")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
