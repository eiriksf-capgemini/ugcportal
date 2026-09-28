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
 */
export async function requireAdmin(): Promise<Session | null> {
  const session = await getSession();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return null;
  }
  return session;
}
