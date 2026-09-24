"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin";
import { ADMIN_USERS_PATH } from "@/lib/routes";
import { isRole, setUserRole } from "@/lib/roles";

/**
 * Grant or revoke ADMIN (ugcportal-lu7). Re-checks admin here rather than
 * trusting the page that rendered the form — a server action is a public
 * endpoint, reachable without ever loading that page, and this one hands out
 * the role that opens every other admin surface.
 */
export async function changeUserRole(formData: FormData) {
  const session = await requireAdmin();
  if (!session) {
    throw new Error("Forbidden");
  }

  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId) {
    throw new Error("Missing user id");
  }

  const role = formData.get("role");
  if (!isRole(role)) {
    // Not a user-facing state: every value this form can submit is one of
    // the two, so anything else is a tampered request.
    throw new Error("Unknown role");
  }

  const outcome = await setUserRole({
    userId,
    role,
    actor: {
      source: "ADMIN",
      userId: session.user.id,
      email: session.user.email,
    },
  });

  revalidatePath(ADMIN_USERS_PATH);
  // Redirect either way, so a stale `?error=` from a previous attempt doesn't
  // stay pinned to the URL after a change that worked.
  redirect(
    outcome === "last_admin" || outcome === "user_not_found"
      ? `${ADMIN_USERS_PATH}?error=${outcome}`
      : ADMIN_USERS_PATH,
  );
}
