import type { DefaultSession, Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import {
  PERMITTED_EMAILS_VAR,
  type SignInAttempt,
  type SignInRefusal,
  authorisedEmail,
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
 * THE UNIT IS ONE SESSION, not one person (PR #91 review, round 1, finding
 * 1). Each session carries the identity that minted it — `signInProvider`
 * and `signInEmail` on its own row — and is judged on that. The same user's
 * other sessions are judged, separately and identically, on their own next
 * request. This matters as soon as one person can hold sessions from two
 * identities, which is exactly what `ugcportal-t33p` is about to make
 * ordinary: judging every session by one per-user column lets a sign-in on
 * one device get a still-permitted session on another device refused and
 * deleted.
 *
 * THE BOUND: the next request that resolves the session. There is no
 * cache between the configuration and the decision — the policy is re-read
 * from the environment on every call (`permittedIdentities` memoises on the
 * raw strings, so a changed variable is a changed answer immediately) — so
 * the window is one in-flight request, not an interval anyone has to pick a
 * number for. What it does NOT bound is a request already executing when the
 * configuration changed, and on this deployment shape it cannot: changing
 * `ALLOWED_SIGNIN_EMAILS` means restarting the server, so there is no moment
 * where an old process is still serving under the new policy.
 *
 * THE COST, per authenticated request (K2): one `decideLiveSession` call,
 * over a permitted set parsed once per distinct configuration string. No
 * database read of any kind. Every value it judges is a column of the one
 * row `getSessionAndUser` already loaded in the single query `auth()` was
 * always making. The only write is on the refusal path, and it IS the
 * revocation; it deletes one row, the session in front of it.
 *
 * Two requests in flight together can both reach that delete — the first
 * takes the row and the second deletes nothing — and once the row is gone
 * `getSessionAndUser` returns null, so this function is not reached again
 * for that session at all.
 */

/**
 * What the session callback has to judge, beyond the session row itself:
 * the adapter's `User`.
 *
 * Typed structurally rather than as `AdapterUser` because that type comes
 * from a transitive `@auth/core` package — the same reason `toRole` in
 * src/lib/auth.ts reads its field defensively off `object`. `email` is the
 * fallback for a session minted before `Session.signInEmail` existed.
 */
export type LiveSessionUser = {
  id: string;
  email?: string | null;
};

/**
 * The refusals that mean "this identity is positively not permitted any
 * more", as opposed to "the policy cannot be evaluated right now".
 *
 * Only these destroy the session row. The distinction is the difference
 * between a revocation and an outage: `no-configuration` is what a
 * deployment that lost its environment variables looks like, and `no-email`
 * describes a row, not a decision about the list. Those refuse the request —
 * fail closed, every time, that part is not conditional — but they leave the
 * row alone, so restoring the variable restores the sessions instead of
 * having silently logged every user out of every device while nobody could
 * sign in to notice.
 *
 * `unverified-email` is absent because `decideLiveSession` cannot return it
 * (see its own comment: no request carries a provider profile to assert a
 * claim with). It is listed in `SignInRefusal` because the sign-in gate can
 * return it, and this array is typed against that union so that a refusal
 * added later has to be classified here rather than defaulting silently —
 * it defaults to the safe side, refusing without deleting, but the doc test
 * in src/lib/access-control-doc.test.ts makes the choice visible.
 */
const REVOKING_REFUSALS: readonly SignInRefusal[] = [
  "not-permitted",
  "wrong-provider",
];

/**
 * Shortest interval between live-session refusal log lines, per channel.
 *
 * Throttled for the same reason `listPublicMedia`'s failure log is
 * (src/lib/public-media.ts), and the reason is sharper here: the refusals
 * that do NOT delete the row recur on every authenticated request for as
 * long as the condition lasts, so a deployment that lost
 * `ALLOWED_SIGNIN_EMAILS` would write one line per request per signed-in
 * visitor, for as long as nobody noticed — which is precisely the situation
 * where the log needs to stay readable. The first line after a quiet period
 * always logs, so the transition into refusing is never delayed, and the
 * lines in between are counted and folded into the next one.
 */
export const LIVE_SESSION_LOG_INTERVAL_MS = 10_000;

type LogThrottle = { lastAt: number; suppressed: number };

/** Separate counters per channel, so a flood of one cannot hide the other. */
const refusalLog: LogThrottle = { lastAt: 0, suppressed: 0 };
const revocationFailureLog: LogThrottle = { lastAt: 0, suppressed: 0 };

/**
 * How many lines this one swallowed, or `null` to stay quiet.
 *
 * `lastAt !== 0` matches the guard `logFailedPublicListing` and
 * `logShedUpload` both carry, and is there for the same reason: without it
 * the first call after process start computes `now - 0`, which only clears
 * the window by the accident of what year it is. A clock near the epoch
 * (fake timers, a container before NTP) would read as "still inside the
 * window" and swallow the one line this throttle most needs to let through.
 */
function dueToLog(throttle: LogThrottle): number | null {
  const now = Date.now();
  if (
    throttle.lastAt !== 0 &&
    now - throttle.lastAt < LIVE_SESSION_LOG_INTERVAL_MS
  ) {
    throttle.suppressed += 1;
    return null;
  }
  const suppressed = throttle.suppressed;
  throttle.lastAt = now;
  throttle.suppressed = 0;
  return suppressed;
}

/** Present only when this line's own window actually swallowed others. */
function suppressedNote(suppressed: number): string {
  return suppressed > 0 ? ` (${suppressed} similar line(s) suppressed)` : "";
}

/**
 * The identity recorded on the session row when it was minted.
 *
 * Read off `session` defensively, for the same reason `toRole` reads `role`
 * off the user: at runtime this object is the whole `Session` row spread
 * with the user attached (`session: { ...session, user }` in
 * @auth/core/lib/actions/session.js, over @auth/prisma-adapter's
 * `getSessionAndUser`), but next-auth's `Session` type declares none of the
 * row's own columns.
 */
function recordedIdentity(session: Session): {
  id: unknown;
  provider: unknown;
  email: unknown;
} {
  const row = session as unknown as {
    id?: unknown;
    signInProvider?: unknown;
    signInEmail?: unknown;
  };
  return {
    id: row.id,
    provider: row.signInProvider,
    email: row.signInEmail,
  };
}

/**
 * Re-check the sign-in policy for an existing session, and refuse it when
 * the identity that minted it is no longer permitted.
 *
 * Returns the session untouched when it is still permitted, so the permitted
 * path adds nothing to the object the rest of the app reads.
 */
export async function enforceLiveSessionPolicy(
  session: Session,
  user: LiveSessionUser,
): Promise<Session | DefaultSession> {
  const recorded = recordedIdentity(session);
  const decision = decideLiveSession({
    // The address the PROVIDER ASSERTED for this session, falling back to
    // the stored one for a session minted before that column existed —
    // which is the address this check judged before it did. Not a widening:
    // `authorisedEmail` prefers the asserted address at sign-in too, so the
    // session is judged on the string the gate permitted rather than on a
    // `User.email` that @auth/core never refreshes.
    email: typeof recorded.email === "string" ? recorded.email : user.email,
    provider: recorded.provider,
  });
  if (decision.permitted) {
    return session;
  }

  const suppressed = dueToLog(refusalLog);
  if (suppressed !== null) {
    console.warn(
      `[auth] Refused a live session for user ${user.id}: ${decision.reason}. ` +
        `Permitted addresses come from ${PERMITTED_EMAILS_VAR} ` +
        `(plus ADMIN_BOOTSTRAP_EMAILS); see docs/access-control.md.` +
        suppressedNote(suppressed),
    );
  }

  if (REVOKING_REFUSALS.includes(decision.reason)) {
    await revokeSession(recorded.id, user.id);
  }

  return refusedSession(session);
}

/**
 * Delete the one session row this request arrived with.
 *
 * NOT `deleteMany({ where: { userId } })`. Revoking every session a person
 * holds is a decision about the PERSON, and what the policy just answered is
 * a question about one session's identity; the others are refused on their
 * own next request if they deserve to be (PR #91 review, round 1, finding 1).
 *
 * The id guard is not defensive clutter: Prisma treats
 * `where: { id: undefined }` as no filter at all, so a session object
 * without the row's `id` — a different adapter, a future @auth/core that
 * stops spreading the row — would turn this into `DELETE FROM Session` for
 * every user on the instance. It fails closed instead: no id, no delete, and
 * the request is still refused by the caller either way.
 */
async function revokeSession(id: unknown, userId: string): Promise<void> {
  if (typeof id !== "string" || id === "") {
    console.error(
      `[auth] Refused a live session for user ${userId} but could not ` +
        "identify its row, so nothing was deleted. The session is still " +
        "refused, on this request and every later one.",
    );
    return;
  }
  try {
    // `deleteMany`, so a row already gone (two concurrent requests, a
    // simultaneous sign-out) is 0 rows and not a thrown P2025.
    const { count } = await prisma.session.deleteMany({ where: { id } });
    if (count > 0) {
      console.warn(`[auth] Revoked session ${id} for user ${userId}.`);
    }
  } catch (error) {
    // The refusal does NOT depend on this write. A database that cannot take
    // the delete must not be able to turn a refusal into a permission — it
    // only means the stale row survives to be refused again on the next
    // request, which is also why this log is throttled.
    const suppressed = dueToLog(revocationFailureLog);
    if (suppressed !== null) {
      console.error(
        `[auth] Could not revoke session ${id} for user ${userId}; the ` +
          "session is still refused for this request." +
          suppressedNote(suppressed),
        error,
      );
    }
  }
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
 * `sessionToken` included, and a refused request has no use for any of it.
 * `expires` is kept because `DefaultSession` requires it and
 * `/api/auth/session` clients read it.
 */
function refusedSession(session: Session): DefaultSession {
  return { expires: session.expires, user: undefined };
}

/**
 * Record, on the session this sign-in just minted, which identity minted it
 * — so the per-request check above can judge a provider-bound allowlist
 * entry without a second query.
 *
 * Runs from the Auth.js `signIn` EVENT, which fires after the `signIn`
 * callback has already permitted the attempt and after the `Session` row
 * exists, but still inside the request that sets the session cookie
 * (`await events.signIn?.()` in @auth/core/lib/actions/callback/index.js,
 * before the redirect is returned). So the columns are written before the
 * browser can make the request that reads them — a freshly signed-in user is
 * never judged against an identity that has not been recorded yet.
 *
 * WHICH ROW, and the race. The event is not told the session token, so the
 * row is found rather than named: the user's newest session that has no
 * identity recorded yet. In the ordinary case exactly one row matches — the
 * one just created — because every other session of theirs was stamped at
 * its own sign-in. The exception is a session that predates these columns
 * (the migration backfills only the unambiguous ones), and the window is
 * this single `await`: if such a row exists AND its `expires` is later than
 * the new session's, this stamps the old row instead and the new session
 * keeps a null identity. The consequence is bounded and fail-closed — the
 * new session is refused by a bound entry on its next request, and the
 * person signs in again — and it cannot outlive the legacy rows.
 *
 * The address recorded is `authorisedEmail`'s, i.e. the one the gate just
 * judged, not `user.email`: those differ for anyone whose provider address
 * has changed, and recording the address that was actually permitted is the
 * whole point of recording one.
 *
 * Never throws. A failure here is logged and swallowed, because this event
 * is awaited by @auth/core and a throw would turn a sign-in that was already
 * permitted into an Access Denied page. The consequence of the failure is
 * fail-closed in the same bounded way: the session keeps a null identity,
 * which a bound entry refuses on the next request.
 */
export async function recordSignInIdentity(
  attempt: SignInAttempt & { user: { id?: string } },
): Promise<void> {
  const provider = attempt.account?.provider;
  const email = authorisedEmail(attempt);
  const userId = attempt.user.id;
  if (!userId || typeof provider !== "string" || provider === "") {
    return;
  }
  try {
    const [newest] = await prisma.session.findMany({
      where: { userId, signInProvider: null },
      orderBy: { expires: "desc" },
      take: 1,
      select: { id: true },
    });
    if (!newest) {
      // Not an error worth shouting about on its own — but it means the
      // session this sign-in minted will be judged as having no recorded
      // identity, so a bound entry will refuse it once and the next sign-in
      // will try again.
      console.warn(
        `[auth] No unrecorded session row to attribute for user ${userId}; ` +
          "a provider-bound allowlist entry will refuse this session on its " +
          "next request.",
      );
      return;
    }
    // Stores whatever provider id Auth.js reported, without checking it
    // against SIGN_IN_PROVIDERS. An id outside that list cannot widen
    // anything — `providerId` maps it to `null` when the column is read,
    // exactly as a missing value — and storing what actually happened keeps
    // the column honest if the configured providers ever change.
    await prisma.session.updateMany({
      where: { id: newest.id },
      data: { signInProvider: provider, signInEmail: email },
    });
  } catch (error) {
    console.error(
      `[auth] Could not record the sign-in identity for user ${userId}. ` +
        "A provider-bound allowlist entry will refuse this session on its " +
        "next request until it is recorded.",
      error,
    );
  }
}
