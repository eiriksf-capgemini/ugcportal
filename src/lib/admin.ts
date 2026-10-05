import type { Session } from "next-auth";

import { getSession } from "@/lib/auth";

/**
 * The single admin gate. Returns the session only for a signed-in ADMIN;
 * `null` covers both "not signed in" and "signed in but not an admin",
 * because callers should answer both with the same response rather than
 * telling an ordinary user that an admin-only route exists.
 *
 * Calls `getSession()` rather than a plain `auth()` (ugcportal-t0y round 2
 * finding), so the three `src/app/admin/settings/{users,rights,instagram}/
 * page.tsx` renders that call this get the same `cache()`-memoized
 * deduplication the header's `UploadNavLink`/`AuthStatus` already do. This
 * function is also called from route handlers and server actions (every
 * src/app/api/admin/ route, and the admin settings actions.ts files), which
 * are not part of a React render — `cache()` has no render to key its
 * memoization against there, so it falls through to an ordinary, uncached
 * call, identical to calling `auth()` directly. Safe either way, not just
 * cheaper in the render case.
 *
 * Returns `AdminSession`, not `Session`: since ugcportal-mzr `Session["user"]`
 * is optional, because a revoked identity resolves to a session with no user
 * on it. This gate has already established there IS one, so saying so in the
 * type is what lets its callers — `actions.ts` and every src/app/api/admin/
 * route — keep writing `session.user.id` without re-proving it, and what
 * stops a caller that skipped the gate from compiling (PR #91 review, round
 * 2, finding 2).
 */
export type AdminSession = Session & { user: NonNullable<Session["user"]> };

export async function requireAdmin(): Promise<AdminSession | null> {
  /*
    The raw getSession(), not src/lib/session-or-anonymous.ts's shared
    fail-safe (ugcportal-8df3). That helper exists for the shell's
    DECORATIVE widgets (AuthStatus, UploadNavLink, the home page's hero),
    where a failed session read degrading to "signed out" is exactly the
    state an anonymous visitor can reach on purpose. This is a GATE: folding
    "the database didn't answer" into "not an admin" here would make a
    connectivity blip indistinguishable from a legitimate refusal, and a
    caller cannot tell the two apart from `null` alone. Left unguarded, a
    rejection propagates out of this function instead - the request errors
    rather than quietly resolving to "no, you may not" OR "yes, carry on",
    which is what failing CLOSED means for a gate: refuse to answer rather
    than risk answering wrong.
  */
  const session = await getSession();
  const user = session?.user;
  if (!session || !user?.id || user.role !== "ADMIN") {
    return null;
  }
  // Rebuilt rather than returned as-is: narrowing `session.user` above does
  // not narrow the type of `session` itself, and this is the one place that
  // has proved the user is there, so it is the one place that should have
  // to say so.
  return { ...session, user };
}
