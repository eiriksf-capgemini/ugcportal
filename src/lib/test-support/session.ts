import type { Session } from "next-auth";

/**
 * Test-only helper (not imported by any application code): the object
 * @auth/core hands this app's `session` callback.
 *
 * One builder, because four test files had grown their own and the fields
 * had started to drift — one carried `sessionToken`, another did not, a
 * third invented its own `expires` (PR #91 review, round 4, finding 4). The
 * drift matters more than the duplication: what this object IS, at runtime,
 * is the whole `Session` ROW with the user attached —
 * `session: { ...session, user }` in @auth/core/lib/actions/session.js, over
 * @auth/prisma-adapter's `getSessionAndUser`, which returns
 * `{ user, ...row }`. Every column of that row is therefore reachable from
 * the callback, which is the entire reason `Session.signInProvider` and
 * `Session.signInEmail` can be read for free. A fixture that quietly omits
 * a column is a fixture testing a session shape production never produces.
 *
 * The cast is unavoidable and is the point: next-auth's `Session` type
 * declares none of the row's own columns, so the type cannot describe the
 * value the library actually passes.
 */
export function callbackSession(
  overrides: {
    id?: string | null;
    sessionToken?: string;
    userId?: string;
    expires?: Date | string;
    signInProvider?: string | null;
    signInEmail?: string | null;
    user?: Record<string, unknown>;
  } = {},
): Session {
  const userId = overrides.userId ?? "user-1";
  const row = {
    id: "session-1",
    sessionToken: "session-token-1",
    userId,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    signInProvider: "google",
    signInEmail: "owner@example.com",
    ...overrides,
    user: {
      id: userId,
      email: "owner@example.com",
      role: "USER",
      ...overrides.user,
    },
  };
  // `id: null` is how a caller asks for the one shape that matters and
  // cannot be spelled by omission: a session object with no row id at all,
  // which `revokeSession` must refuse to turn into an unfiltered delete.
  if (row.id === null) {
    delete (row as { id?: unknown }).id;
  }
  return row as unknown as Session;
}
