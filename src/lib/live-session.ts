import type { DefaultSession, Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import {
  PERMITTED_EMAILS_VAR,
  type SignInRefusal,
  decideLiveSession,
} from "@/lib/sign-in-policy";

/**
 * Revocation, for sessions that already exist (ugcportal-mzr).
 *
 * THE DECISION THIS IMPLEMENTS, of the three the bead put up: (a) re-check
 * the sign-in policy on the path that resolves a session. Not (b) a shorter
 * `session.maxAge`, which only shrinks the window — it never closes it, and
 * every value is simultaneously too long to call revocation and too short to
 * stop signing people back in. Not (c) an admin "revoke all sessions"
 * button, which answers a different question: it is an action taken against
 * a person, where the thing that actually changed is the CONFIGURATION, and
 * it would leave the operator who edits `ALLOWED_SIGNIN_EMAILS` on a server
 * and redeploys — the only revocation path this instance has — with nothing
 * to click. (a) makes the configuration the single source of truth it
 * already claims to be in docs/access-control.md.
 *
 * THE BOUND: the next request that resolves the session. There is no
 * cache and no TTL between the configuration and the decision — the policy
 * is re-read from the environment on every call, so the window is one
 * in-flight request, not an interval anyone has to pick a number for. What
 * it does NOT bound is a request already executing when the configuration
 * changed, and on this deployment shape it cannot: changing
 * `ALLOWED_SIGNIN_EMAILS` means redeploying the server, so there is no
 * moment where an old process is still serving under the new policy.
 *
 * THE COST, per authenticated request (K2): one `decideLiveSession` call —
 * split the two env vars on commas, parse each entry, compare. No database
 * read of any kind. Every value it judges (`User.email`,
 * `User.signInProvider`) is a column of the row `getSessionAndUser` already
 * loaded in the single query `auth()` was always making, which is why
 * `signInProvider` is denormalised onto `User` at all rather than read from
 * `Account` (see the column's comment in prisma/schema.prisma). The only
 * write is on the refusal path, and it IS the revocation. It is not
 * necessarily a single statement: a page that calls `auth()` twice in one
 * render, or two requests in flight together, each run this — but the first
 * takes the rows and the rest delete nothing, and once the rows are gone
 * `getSessionAndUser` returns null and this function is not reached again.
 *
 * The refusal is also logged every time it happens, which for the
 * non-destroying refusals (below) means once per request for as long as the
 * condition lasts. That is deliberate for the condition it describes — a
 * deployment where nobody can sign in should be loud — but it is the reason
 * those refusals are the narrow set they are.
 */

/**
 * What the session callback has to judge: the adapter's `User` row.
 *
 * Typed structurally rather than as `AdapterUser` because that type comes
 * from a transitive `@auth/core` package and declares neither `role` nor
 * `signInProvider` — the same reason `toRole` in src/lib/auth.ts reads its
 * field defensively off `object`.
 */
export type LiveSessionUser = {
  id: string;
  email?: string | null;
  signInProvider?: unknown;
};

/**
 * The refusals that mean "this identity is positively not permitted any
 * more", as opposed to "the policy cannot be evaluated right now".
 *
 * Only these destroy session rows. The distinction is the difference
 * between a revocation and an outage: `no-configuration` is what a
 * deployment that lost its environment variables looks like, and
 * `no-email`/`unverified-email` describe a row, not a decision about the
 * list. Those refuse the request — fail closed, every time, that part is not
 * conditional — but they leave the rows alone, so restoring the variable
 * restores the sessions instead of having silently logged every user out of
 * every device while nobody could sign in to notice.
 */
const REVOKING_REFUSALS: readonly SignInRefusal[] = [
  "not-permitted",
  "wrong-provider",
];

/**
 * Re-check the sign-in policy for an existing session, and refuse it when
 * the identity holding it is no longer permitted.
 *
 * Returns the session untouched when it is still permitted, so the permitted
 * path adds nothing to the object the rest of the app reads.
 */
export async function enforceLiveSessionPolicy(
  session: Session,
  user: LiveSessionUser,
): Promise<Session | DefaultSession> {
  const decision = decideLiveSession({
    email: user.email,
    provider: user.signInProvider,
  });
  if (decision.permitted) {
    return session;
  }

  console.warn(
    `[auth] Refused a live session for user ${user.id}: ${decision.reason}. ` +
      `Permitted addresses come from ${PERMITTED_EMAILS_VAR} ` +
      "(plus ADMIN_BOOTSTRAP_EMAILS); see docs/access-control.md.",
  );

  if (REVOKING_REFUSALS.includes(decision.reason)) {
    // Every session this identity holds, on every device — not just the one
    // this request arrived with. A revocation that left the other cookies
    // working would be the same defect at a smaller scale.
    //
    // `deleteMany`, so a row already gone (two concurrent requests, a
    // simultaneous sign-out) is 0 rows and not a thrown P2025.
    try {
      const { count } = await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      if (count > 0) {
        console.warn(
          `[auth] Revoked ${count} session row(s) for user ${user.id}.`,
        );
      }
    } catch (error) {
      // The refusal below does NOT depend on this write. A database that
      // cannot take the delete must not be able to turn a refusal into a
      // permission — it only means the stale row survives to be refused
      // again on the next request.
      console.error(
        `[auth] Could not revoke session rows for user ${user.id}; the ` +
          "session is still refused for this request.",
        error,
      );
    }
  }

  return refusedSession(session);
}

/**
 * The session a refused request gets: no user, and nothing else from the
 * `Session` row either.
 *
 * `user: undefined` AND NOT `delete session.user`. The key has to still be
 * there. next-auth wraps this app's `session` callback and spreads its
 * answer over the adapter user it already had —
 * `return { user, ...session }` (node_modules/next-auth/lib/index.js:22-32)
 * — so a returned object with no `user` key at all gets the full `User` row
 * put straight back, `id` included, and every downstream gate
 * (`hasSignedInUser`, `session?.user?.id`) sees a signed-in administrator.
 * The refusal would be invisible: no error, no 401, and a test that drove
 * the callback directly would still pass. A present-but-undefined key wins
 * the spread, and then does not survive `JSON.stringify` of the response
 * body — so `auth()` resolves a session object with no user on it.
 *
 * `expires` only, rather than `{ ...session, user: undefined }`: the runtime
 * `session` here is the whole `Session` row the Prisma adapter read,
 * `sessionToken` included (@auth/prisma-adapter's `getSessionAndUser`
 * returns `{ user, ...session }` of the row), and a refused request has no
 * use for any of it. `expires` is kept because `DefaultSession` requires it
 * and `/api/auth/session` clients read it.
 */
function refusedSession(session: Session): DefaultSession {
  return { expires: session.expires, user: undefined };
}

/**
 * Record which provider this sign-in came through, so the per-request check
 * above can honour a provider-bound allowlist entry without a second query.
 *
 * Runs from the Auth.js `signIn` EVENT, which fires after the `signIn`
 * callback has already permitted the attempt and after the `Session` row
 * exists, but still inside the request that sets the session cookie
 * (`await events.signIn?.()` in @auth/core/lib/actions/callback/index.js,
 * before the redirect is returned). So the column is written before the
 * browser can make the request that reads it — a freshly signed-in user is
 * never judged against a provider that has not been recorded yet.
 *
 * Writes unconditionally rather than reading first to see whether it
 * changed: that read would be the extra query this design exists to avoid,
 * and sign-in is not a hot path.
 *
 * Stores whatever provider id Auth.js reported, without checking it against
 * `SIGN_IN_PROVIDERS`. An id outside that list cannot widen anything —
 * `providerId` maps it to `null` when the column is read, exactly as a
 * missing value — and storing what actually happened keeps the column
 * honest if the configured providers ever change.
 *
 * Never throws. A failure here is logged and swallowed, because this event
 * is awaited by @auth/core and a throw would turn a sign-in that was
 * already permitted into an Access Denied page. The consequence of the
 * failure is bounded and fail-closed: the column keeps its previous value
 * (or stays null), and a null provider is refused by a bound entry at the
 * next request, which costs that person another sign-in.
 */
export async function recordSignInProvider(
  user: { id?: string },
  account?: { provider?: unknown } | null,
): Promise<void> {
  const provider = account?.provider;
  if (!user.id || typeof provider !== "string" || provider === "") {
    return;
  }
  try {
    // `updateMany`, not `update`: a user row that is gone by the time this
    // runs is 0 rows rather than a thrown P2025 on an otherwise successful
    // sign-in.
    await prisma.user.updateMany({
      where: { id: user.id },
      data: { signInProvider: provider },
    });
  } catch (error) {
    console.error(
      `[auth] Could not record the sign-in provider for user ${user.id}. ` +
        "A provider-bound allowlist entry will refuse this session on the " +
        "next request until it is recorded.",
      error,
    );
  }
}
