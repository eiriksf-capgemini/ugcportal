import type { Session } from "next-auth";

import { auth } from "@/lib/auth";

/**
 * The single admin gate. Returns the session only for a signed-in ADMIN;
 * `null` covers both "not signed in" and "signed in but not an admin",
 * because callers should answer both with the same response rather than
 * telling an ordinary user that an admin-only route exists.
 */
export async function requireAdmin(): Promise<Session | null> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return null;
  }
  return session;
}
