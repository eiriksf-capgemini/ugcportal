import { AsyncLocalStorage } from "node:async_hooks";

import type { Adapter } from "next-auth/adapters";
import type { DefaultSession, Session } from "next-auth";

import type { SessionUncheckedCreateInput } from "@/generated/prisma/models";
import { prisma } from "@/lib/prisma";
import {
  PERMITTED_EMAILS_VAR,
  REFUSAL_EFFECT,
  type SignInAttempt,
  authorisedEmail,
  decideLiveSession,
  normalizeString,
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
 * over a permitted set parsed once per distinct configuration string and
 * indexed by address. No database read of any kind. Every value it judges is
 * a column of the one row `getSessionAndUser` already loaded in the single
 * query `auth()` was always making. The only write is on the refusal path,
 * it IS the revocation, it deletes one row — the session in front of it —
 * and the response does not wait for it.
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
 * Whether a refusal deletes the session row is `REFUSAL_EFFECT`, defined
 * beside `SignInRefusal` itself in src/lib/sign-in-policy.ts (PR #91
 * review, round 3, finding 3) — adding a refusal and saying what it does to
 * a live session are one edit, in one file, and the `satisfies` there makes
 * the second half compulsory. This module acts on the answer; it does not
 * own it.
 *
 * src/lib/access-control-doc.test.ts imports the same map and asserts the
 * runbook in docs/access-control.md names exactly the revoking ones.
 */

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
 *
 * THIS IS THE THIRD COPY of that algorithm — `watermark.ts` and
 * `public-media.ts` have the other two — and it is deliberately still a
 * copy. `ugcportal-z3lo` owns extracting the shared helper and already
 * records why the first two were not merged (watermark's has a proactive
 * flush timer the others deliberately lack); PR #85 adds
 * `src/lib/throttled-log.ts` and is not merged yet. Taking the extraction
 * here would either pre-empt that design or build a fourth variant for it
 * to reconcile. The generalisation this copy does have — a `LogThrottle`
 * record plus a `dueToLog` function, two independent channels — is the
 * shape that bead should adopt (PR #91 review, round 2, finding 11).
 */
export const LIVE_SESSION_LOG_INTERVAL_MS = 10_000;

type LogThrottle = { lastAt: number; suppressed: Map<string, number> };

/** Separate counters per channel, so a flood of one cannot hide the other. */
const refusalLog: LogThrottle = { lastAt: 0, suppressed: new Map() };
const revocationFailureLog: LogThrottle = { lastAt: 0, suppressed: new Map() };

/**
 * What this line swallowed, by kind, or `null` to stay quiet.
 *
 * Counted PER KIND rather than as one number (PR #91 review, round 3,
 * finding 5): a bulk revocation otherwise reports one line and folds every
 * other reason into an anonymous total, which is the opposite of what the
 * operator who just edited the allowlist needs to see. The kind is the
 * refusal reason, so the key space is the `SignInRefusal` vocabulary and
 * cannot grow with traffic. Deliberately NOT keyed by user: that is
 * unbounded, and a visitor who can be refused is a visitor who can make the
 * map grow.
 *
 * `lastAt !== 0` matches the guard `logFailedPublicListing` and
 * `logShedUpload` both carry, and is there for the same reason: without it
 * the first call after process start computes `now - 0`, which only clears
 * the window by the accident of what year it is. A clock near the epoch
 * (fake timers, a container before NTP) would read as "still inside the
 * window" and swallow the one line this throttle most needs to let through.
 */
function dueToLog(
  throttle: LogThrottle,
  kind: string,
): Map<string, number> | null {
  const now = Date.now();
  if (
    throttle.lastAt !== 0 &&
    now - throttle.lastAt < LIVE_SESSION_LOG_INTERVAL_MS
  ) {
    throttle.suppressed.set(kind, (throttle.suppressed.get(kind) ?? 0) + 1);
    return null;
  }
  const suppressed = new Map(throttle.suppressed);
  throttle.lastAt = now;
  throttle.suppressed.clear();
  return suppressed;
}

/**
 * Present only when this line's own window actually swallowed others, and
 * then naming what they were: `(3 similar line(s) suppressed:
 * not-permitted x2, wrong-provider x1)`.
 */
function suppressedNote(suppressed: Map<string, number>): string {
  if (suppressed.size === 0) {
    return "";
  }
  let total = 0;
  const byKind: string[] = [];
  for (const [kind, count] of suppressed) {
    total += count;
    byKind.push(`${kind} x${count}`);
  }
  return ` (${total} similar line(s) suppressed: ${byKind.join(", ")})`;
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
  id: string | null;
  provider: unknown;
  email: string | null;
} {
  const row = session as unknown as {
    id?: unknown;
    signInProvider?: unknown;
    signInEmail?: unknown;
  };
  // NORMALISED HERE, ONCE (PR #91 review, round 4, finding 3), with the
  // policy's own `normalizeString` rather than a local near-copy of it:
  // absent, non-string and blank all become `null`, so every reader below
  // has one thing to check instead of its own idea of "usable".
  //
  // Blank mattering is not hypothetical bookkeeping. Nothing this app
  // writes can produce `""` — `authorisedEmail` collapses blanks to `null`
  // before the identity is persisted — but a direct SQL fix-up or a future
  // backfill could, and a `""` address treated as present would skip the
  // fallback to `User.email` and judge the session on nothing.
  //
  // `provider` stays raw: `providerId` inside the policy is the one place
  // allowed to decide what a provider value means, and it normalises with
  // the same function on the way.
  return {
    id: normalizeString(row.id),
    provider: row.signInProvider,
    email: normalizeString(row.signInEmail),
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
    email: recorded.email ?? user.email,
    provider: recorded.provider,
  });
  if (decision.permitted) {
    return session;
  }

  const suppressed = dueToLog(refusalLog, decision.reason);
  if (suppressed !== null) {
    console.warn(
      `[auth] Refused a live session for user ${user.id}: ${decision.reason}. ` +
        `Permitted addresses come from ${PERMITTED_EMAILS_VAR} ` +
        `(plus ADMIN_BOOTSTRAP_EMAILS); see docs/access-control.md.` +
        suppressedNote(suppressed),
    );
  }

  if (REFUSAL_EFFECT[decision.reason] === "revoke") {
    // NOT awaited (PR #91 review, round 2, finding 6). The refusal below is
    // a pure transform of data already in hand and does not depend on the
    // delete — `revokeSession` says so itself — so making every request
    // from a just-revoked identity wait out a `DELETE` round trip would be
    // paying latency for nothing, at exactly the moment refusals are most
    // numerous. `revokeSession` never rejects, so the floating promise
    // cannot become an unhandled rejection.
    //
    // If the process is torn down before it lands (this instance runs a
    // long-lived Node server, so that means a restart mid-request), the row
    // survives and the next request refuses it again and retries the
    // delete. That is the same recovery as a failed delete, which is why
    // the refusal is never allowed to depend on either.
    track(revokeSession(recorded.id, user.id));
  }

  return refusedSession(session);
}

/**
 * A TEST SEAM, AND NOTHING ELSE (PR #91 review, round 4, findings 5 and 6).
 *
 * `enforceLiveSessionPolicy` deliberately does not await the delete, so a
 * test that asserts the row is gone needs something to wait on; this is
 * that and only that. No production path calls `settleRevocations`, and the
 * set is not a shutdown drain — this app has no shutdown hook, and claiming
 * one would be describing something that does not exist. If a drain is ever
 * wanted, it is a new decision about what to do with an in-flight delete,
 * not an existing feature of this variable.
 *
 * The alternative was `vi.waitFor` on a spy in every test that revokes.
 * Kept this way because the real-database tests assert on rows rather than
 * on calls, and polling a database for an answer that is already
 * deterministic trades a precise failure (a diff) for a vague one (a
 * timeout). Entries remove themselves.
 */
const inFlightRevocations = new Set<Promise<void>>();

function track(revocation: Promise<void>): void {
  inFlightRevocations.add(revocation);
  void revocation.finally(() => inFlightRevocations.delete(revocation));
}

/** Settle every revocation started so far. See above: tests only. */
export function settleRevocations(): Promise<unknown> {
  return Promise.all([...inFlightRevocations]);
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
 * the request is still refused by the caller either way. The id arrives
 * already normalised (`recordedIdentity`), so `null` is the only shape of
 * "no usable id" this has to know about.
 *
 * Never rejects. The caller does not await it, and an unhandled rejection
 * would take the process down over a failed delete.
 */
async function revokeSession(id: string | null, userId: string): Promise<void> {
  if (id === null) {
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
    // One kind on this channel — the counts still read the same way, and a
    // second failure mode later gets its own name for free.
    const suppressed = dueToLog(revocationFailureLog, "delete-failed");
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
 * body — so `auth()` resolves a session object with no user on it. That
 * possibility is why `Session["user"]` is declared optional in
 * src/lib/auth.ts (round 2, finding 2).
 *
 * That merge is a specific line in a beta dependency, and it is PINNED:
 * src/lib/next-auth-session-merge.test.ts asserts the installed next-auth
 * still merges this way, asserts package.json names an exact version rather
 * than a range, and records why the behaviour cannot simply be executed
 * under vitest (round 4, finding 1). If this shape ever has to change, that
 * file says what else moves with it.
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
 * The identity a sign-in asserted, carried from the `signIn` callback to
 * the `createSession` that same request is about to make.
 *
 * WHY A STORE AND NOT A LOOKUP. The columns have to be written on the
 * session row this sign-in creates, and the Auth.js `signIn` EVENT — the
 * obvious place for a write — is never told which row that is. The first
 * version of this therefore guessed: "the user's newest session with no
 * identity recorded yet". Two sign-ins by the same person inside the same
 * window (two tabs, or the two providers `ugcportal-t33p` is about to make
 * ordinary) both see two unstamped rows, can both pick the same one, and
 * the last write wins — one session labelled with the other's provider, the
 * other left unlabelled. With a bound entry that is a permitted session
 * refused as `wrong-provider` and deleted on its next request (PR #91
 * review, round 2, finding 1).
 *
 * There is no lookup that fixes this, because the ambiguity is real: the
 * rows are indistinguishable. So the identity travels with the request
 * instead of being inferred from the database, and lands in the SAME INSERT
 * that creates the row — after which there is no window, no second write,
 * and no heuristic.
 */
type SignInIdentity = Required<
  Pick<SessionUncheckedCreateInput, "signInProvider" | "signInEmail">
>;

const signInIdentity = new AsyncLocalStorage<SignInIdentity>();

/**
 * Give every Auth.js request its own identity slot.
 *
 * Wraps the route handlers rather than calling `enterWith` from the
 * callback: `AsyncLocalStorage.run` propagates strictly downwards into
 * everything the request does, which is exactly the relationship between
 * the handler and the callbacks it drives. `enterWith` would depend on a
 * store set inside an awaited callee being visible to its caller's
 * continuation, which is not a property Node guarantees.
 *
 * The slot is mutable and starts empty: it is filled by
 * `rememberSignInIdentity` only for requests that are actually a sign-in,
 * and read by the adapter below only when it creates a session. Any other
 * request carries an empty slot and writes nothing.
 */
export function withSignInIdentity<
  Handlers extends Record<string, (...args: never[]) => unknown>,
>(handlers: Handlers): Handlers {
  const wrapped: Record<string, unknown> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    wrapped[method] = (...args: never[]) =>
      signInIdentity.run({ signInProvider: null, signInEmail: null }, () =>
        handler(...args),
      );
  }
  return wrapped as Handlers;
}

/**
 * Record what this sign-in asserted, for the session it is about to create.
 *
 * Called from `callbacks.signIn` once the gate has permitted the attempt,
 * which is the last point before `handleLoginOrRegister` that still has the
 * provider and the profile in hand. Writes nothing to the database; the
 * insert that follows picks it up.
 *
 * The address is `authorisedEmail`'s, i.e. the one the gate just judged,
 * not `user.email`: those differ for anyone whose provider address has
 * changed, and recording the address that was actually permitted is the
 * whole point of recording one.
 *
 * A no-op outside a wrapped request (no store), which is what keeps this
 * safe to call from anywhere: the columns stay null, and a null identity
 * fails closed against a bound entry.
 */
export function rememberSignInIdentity(attempt: SignInAttempt): void {
  const slot = signInIdentity.getStore();
  if (!slot) {
    return;
  }
  const provider = attempt.account?.provider;
  // Stores whatever provider id Auth.js reported, without checking it
  // against SIGN_IN_PROVIDERS. An id outside that list cannot widen
  // anything — `providerId` maps it to `null` when the column is read,
  // exactly as a missing value — and storing what actually happened keeps
  // the column honest if the configured providers ever change.
  slot.signInProvider =
    typeof provider === "string" && provider !== "" ? provider : null;
  slot.signInEmail = authorisedEmail(attempt);
}

/**
 * The Prisma adapter, with the sign-in identity written into the same
 * `INSERT` that creates the session.
 *
 * One statement, so there is no window in which a row exists without its
 * identity and nothing to pick the right row out of several. The extra keys
 * reach the database because @auth/prisma-adapter's `createSession` is
 * `p.session.create(stripUndefined(data))` (node_modules/@auth/prisma-adapter/
 * index.js) — it passes the object it is given straight through — and the
 * cast is only about `createSession`'s declared parameter, which names the
 * three columns @auth/core knows about. The column NAMES are still checked,
 * because `SignInIdentity` is DERIVED from Prisma's own generated create
 * input — rename a column in the schema and this stops compiling.
 */
export function withSessionIdentity(adapter: Adapter): Adapter {
  const createSession = adapter.createSession?.bind(adapter);
  if (!createSession) {
    // At construction, so an adapter that cannot create sessions is a boot
    // failure and not a silent pass-through (PR #91 review, round 4
    // addendum, finding 7). Returning the adapter unchanged would have left
    // every new session unattributed — and therefore self-revoking under a
    // bound entry on its next request — with nothing anywhere saying why.
    // The database session strategy cannot work without this method in any
    // case, so there is no configuration this refuses that would otherwise
    // have run.
    throw new Error(
      "[auth] The configured adapter has no createSession, so the sign-in " +
        "identity cannot be recorded on the session it creates. See " +
        "src/lib/live-session.ts (ugcportal-mzr).",
    );
  }
  return {
    ...adapter,
    createSession: (data) => {
      const identity = signInIdentity.getStore();
      if (!identity) {
        // A session being created outside a wrapped request: either a new
        // entry point that does not go through this app's `handlers`, or
        // the wrapper lost somewhere. The row is written either way, with
        // null columns — which fails closed, so this is a diagnostic
        // problem rather than a security one — but silence is how the next
        // such path goes unnoticed (round 4, finding 2).
        //
        // Loud in development and tests, where it is a bug somebody is
        // about to introduce; a log in production, where refusing to create
        // the session would turn a diagnostic into an outage.
        const message =
          "[auth] A session was created with no sign-in identity in scope. " +
          "Every sign-in must go through the handlers exported by " +
          "src/lib/auth.ts, which carry it; this session will be refused " +
          "by any provider-bound allowlist entry on its next request.";
        if (process.env.NODE_ENV !== "production") {
          throw new Error(message);
        }
        console.error(message);
      }
      return createSession({ ...data, ...identity } as typeof data);
    },
  };
}
