import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The committed users array is emptied here, as in
 * src/lib/sign-in-policy.test.ts: this file's `no-configuration` case needs
 * a state in which the policy cannot be evaluated at all, and the real array
 * (ugcportal-t33p) makes that state unreachable by always naming somebody.
 */
vi.mock("@/config/users", () => ({ CONFIGURED_USERS: [] }));

import { PERMITTED_EMAILS_VAR, REFUSAL_EFFECT } from "@/lib/sign-in-policy";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { pinEnvironment } from "@/lib/test-support/env";
import { callbackSession } from "@/lib/test-support/session";

/**
 * ugcportal-mzr K1/K2: revoking permission takes effect on the next request
 * that resolves the session, not at the next sign-in — and it is THE SESSION
 * that is judged and revoked, not the person (PR #91 review, round 1,
 * finding 1).
 *
 * Against a REAL database — the real migrations, the real Prisma client, the
 * real libsql driver — because the claims being made are that one row is
 * gone and another is not, and a mocked `deleteMany` can only show that a
 * function was called. The migration this bead adds is exercised here by
 * being applied: `Session.signInProvider`/`signInEmail` have to exist for
 * any of this to run.
 *
 * The two database-failure paths are NOT here: a `vi.spyOn` on a Prisma
 * delegate does not survive `restoreAllMocks` (the method is not an own
 * property, so restoring deletes it and every later test in the file loses
 * the client). They live in src/lib/live-session.failures.test.ts, which
 * mocks the module instead. Log throttling lives in
 * src/lib/live-session.logging.test.ts, which needs fresh module state.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const {
  enforceLiveSessionPolicy,
  recordedIdentity,
  rememberSignInIdentity,
  settleRevocations,
  withSessionIdentity,
  withSignInIdentity,
} = await import("@/lib/live-session");
const { PrismaAdapter } = await import("@auth/prisma-adapter");

const LISTED = "owner@example.com";
const OTHER = "owner.second@example.com";
const USER_ID = "user-live-session";

pinEnvironment({
  [PERMITTED_EMAILS_VAR]: LISTED,
  ADMIN_BOOTSTRAP_EMAILS: undefined,
});

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

type SeededSession = {
  id: string;
  signInProvider: string | null;
  signInEmail: string | null;
};

/**
 * One user holding the given sessions, as @auth/core's database strategy
 * plus `recordSignInIdentity` leave things after a sign-in.
 */
async function signedIn(options: {
  email?: string | null;
  sessions?: { provider?: string | null; email?: string | null }[];
}): Promise<SeededSession[]> {
  const {
    email = LISTED,
    sessions = [{ provider: "google", email }, { provider: "google", email }],
  } = options;
  await prisma.user.create({ data: { id: USER_ID, email } });
  const rows: SeededSession[] = [];
  for (const [index, session] of sessions.entries()) {
    rows.push(
      await prisma.session.create({
        data: {
          id: `session-${index}`,
          sessionToken: `token-${index}`,
          userId: USER_ID,
          expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          signInProvider: session.provider ?? null,
          signInEmail: session.email === undefined ? email : session.email,
        },
        select: { id: true, signInProvider: true, signInEmail: true },
      }),
    );
  }
  return rows;
}

/** The seeded row, as @auth/core hands it to the callback. */
function sessionFor(
  row: SeededSession,
  overrides: { id?: string | null } = {},
): Session {
  return callbackSession({
    id: row.id,
    sessionToken: `token-for-${row.id}`,
    userId: USER_ID,
    signInProvider: row.signInProvider,
    signInEmail: row.signInEmail,
    user: { id: USER_ID, email: LISTED },
    ...overrides,
  });
}

async function enforce(row: SeededSession, userEmail: string | null = LISTED) {
  const result = await enforceLiveSessionPolicy(sessionFor(row), {
    id: USER_ID,
    email: userEmail,
  });
  // The revocation is deliberately NOT awaited by the request (PR #91
  // review, round 2, finding 6), so these tests wait for what a request
  // does not. That the request really does not wait is asserted in
  // src/lib/live-session.failures.test.ts, where the delete can be held
  // open.
  await settleRevocations();
  return result;
}

function liveSessionIds(): Promise<string[]> {
  return prisma.session
    .findMany({ where: { userId: USER_ID }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id).sort());
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
});

describe("a session whose identity is still permitted (K2)", () => {
  it("is handed back untouched, with its rows intact", async () => {
    const [first] = await signedIn({});
    const session = sessionFor(first);

    const result = await enforceLiveSessionPolicy(session, {
      id: USER_ID,
      email: LISTED,
    });

    // The same object, not a copy: the permitted path adds nothing to what
    // the rest of the app reads.
    expect(result).toBe(session);
    expect(result.user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });

  it("is permitted through the provider its entry is bound to", async () => {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    const [first] = await signedIn({});

    expect((await enforce(first)).user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });
});

describe("a session whose permission has been revoked (K1)", () => {
  it("loses its user and its row when the address is removed", async () => {
    const [first] = await signedIn({});
    // The control: permitted a moment ago, under the configuration the
    // session was minted under.
    expect((await enforce(first)).user?.id).toBe(USER_ID);

    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const result = await enforce(first);

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-1"]);
  });

  it("keeps the `user` key, because next-auth puts the row back if it is missing", async () => {
    // THE defect this shape exists to avoid: next-auth's own wrapper around
    // this app's session callback does `return { user, ...session }`
    // (node_modules/next-auth/lib/index.js:22-32). A returned object with no
    // `user` key at all gets the full adapter User row — id included — put
    // straight back, and the refusal becomes invisible. A present-but-
    // undefined key wins the spread.
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const [first] = await signedIn({});
    const user = { id: USER_ID, email: LISTED };

    const result = await enforce(first);

    expect(Object.keys(result)).toContain("user");
    expect({ user, ...result }.user).toBeUndefined();
  });

  it("carries nothing else off the Session row either", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const [first] = await signedIn({});
    const session = sessionFor(first);

    const result = await enforceLiveSessionPolicy(session, {
      id: USER_ID,
      email: LISTED,
    });
    await settleRevocations();

    expect(result.expires).toBe(session.expires);
    expect(result).not.toHaveProperty("sessionToken");
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("signInEmail");
  });

  it("revokes when the entry is rebound to the other provider", async () => {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    const [first] = await signedIn({});
    expect((await enforce(first)).user?.id).toBe(USER_ID);

    process.env[PERMITTED_EMAILS_VAR] = `facebook:${LISTED}`;
    const result = await enforce(first);

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-1"]);
  });

  it("refuses a session with no recorded provider against a bound entry", async () => {
    // A row written before these columns existed, or one the backfill could
    // not attribute. Unrecognised fails closed.
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    const [first] = await signedIn({
      sessions: [{ provider: null }, { provider: null }],
    });

    const result = await enforce(first);

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-1"]);
  });

  it("permits the same session against an unbound entry", async () => {
    // The other half of the pair: a missing provider is only refused by an
    // entry that names one. Without this, the assertion above would be
    // satisfied by a check that refused every unrecorded session whatever
    // the configuration said.
    const [first] = await signedIn({
      sessions: [{ provider: null }, { provider: null }],
    });

    expect((await enforce(first)).user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });

  it("judges the address recorded on the session, not the one on the user row", async () => {
    // The address the provider asserted when this session was minted. They
    // differ for anyone whose provider address changed after the account was
    // linked — @auth/core never refreshes `User.email` — and the one that
    // was permitted is the one recorded here.
    process.env[PERMITTED_EMAILS_VAR] = OTHER;
    const [first] = await signedIn({
      email: LISTED,
      sessions: [{ provider: "google", email: OTHER }],
    });

    expect((await enforce(first)).user?.id).toBe(USER_ID);
  });

  it("falls back to the user row for a blank recorded address too", async () => {
    // `""` is not something this app writes — `authorisedEmail` collapses
    // blanks to null — but a direct SQL fix-up or a future backfill could,
    // and a blank treated as PRESENT lands on `no-email`, a refusal that by
    // design never deletes the row. The session would be refused forever,
    // with a perfectly good address on the user row (PR #91 review, round 2,
    // finding 5).
    const [first] = await signedIn({
      sessions: [{ provider: "google", email: "   " }],
    });

    expect((await enforce(first, LISTED)).user?.id).toBe(USER_ID);
    // And the fallback really is what answered: remove the user row's
    // address from the list and the same fixture is refused.
    process.env[PERMITTED_EMAILS_VAR] = OTHER;
    expect((await enforce(first, LISTED)).user).toBeUndefined();
  });

  it("falls back to the user row for a session minted before the column existed", async () => {
    const [first] = await signedIn({
      sessions: [{ provider: "google", email: null }],
    });

    expect((await enforce(first, LISTED)).user?.id).toBe(USER_ID);
    // And the fallback is really the fallback: a user row nobody listed is
    // refused on exactly the same fixture.
    process.env[PERMITTED_EMAILS_VAR] = OTHER;
    expect((await enforce(first, LISTED)).user).toBeUndefined();
  });

  it("revokes a backfilled session when the listed address is rebound (migration day)", async () => {
    // What the migration's own deploy note warns about. A session the
    // backfill attributed has a provider but NO recorded address, so it is
    // judged on `User.email` — the address stored when the account was
    // linked, which @auth/core never refreshes. An operator who changes
    // which address is listed on the same deploy therefore revokes those
    // sessions, including their own.
    const STORED = LISTED;
    const FRESH = OTHER;
    const [first] = await signedIn({
      email: STORED,
      sessions: [{ provider: "google", email: null }],
    });
    // Still fine while the stored address is the listed one.
    expect((await enforce(first, STORED)).user?.id).toBe(USER_ID);

    process.env[PERMITTED_EMAILS_VAR] = `google:${FRESH}`;

    expect((await enforce(first, STORED)).user).toBeUndefined();
    expect(await liveSessionIds()).toEqual([]);
  });

  it("refuses AND revokes a session with no address anywhere", async () => {
    // `no-email` deletes the row (PR #91 review, round 4 addendum, finding
    // 8). It reads like an "outage" refusal and is not one: there is no
    // address on the session and none on the user row, nothing outside the
    // row can supply one, and the gate refuses the same identity a fresh
    // sign-in. Keeping the row meant refusing it on every request until it
    // expired, for an identity that could never come back.
    const [first] = await signedIn({
      email: null,
      sessions: [
        { provider: "google", email: null },
        { provider: "google", email: null },
      ],
    });

    expect((await enforce(first, null)).user).toBeUndefined();
    // And only the one in front of it: the rule is unchanged, only the
    // classification of this reason is.
    expect(await liveSessionIds()).toEqual(["session-1"]);
  });
});

/**
 * The case the per-USER design got wrong, and the reason the identity lives
 * on the session row (PR #91 review, round 1, finding 1).
 *
 * One person, two bound entries, two devices. `ugcportal-t33p` (identity
 * linking) is about to make this the ordinary shape rather than an exotic
 * one. Recording the provider per user means device B's sign-in overwrites
 * device A's, so A — still permitted, still bound to its own provider — is
 * judged against B's provider, refused as `wrong-provider`, and (with a
 * `deleteMany` by `userId`) takes B's session down with it.
 */
describe("one person, two identities, two sessions", () => {
  async function twoDevices() {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}, facebook:${OTHER}`;
    const [google, facebook] = await signedIn({
      email: LISTED,
      sessions: [
        { provider: "google", email: LISTED },
        { provider: "facebook", email: OTHER },
      ],
    });
    return { google, facebook };
  }

  it("permits both while both entries are listed", async () => {
    const { google, facebook } = await twoDevices();

    expect((await enforce(google)).user?.id).toBe(USER_ID);
    expect((await enforce(facebook)).user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });

  it("revokes only the session whose entry was removed", async () => {
    const { google, facebook } = await twoDevices();

    // The operator drops the Google entry. The Facebook one is untouched.
    process.env[PERMITTED_EMAILS_VAR] = `facebook:${OTHER}`;

    expect((await enforce(google)).user).toBeUndefined();
    // The other device, judged on its own recorded identity, is unaffected
    // — and its row is still there, which is what a `deleteMany` by userId
    // would have destroyed.
    expect((await enforce(facebook)).user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual(["session-1"]);
  });

  it("and the reverse, so neither answer is the one it always gives", async () => {
    const { google, facebook } = await twoDevices();

    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;

    expect((await enforce(facebook)).user).toBeUndefined();
    expect((await enforce(google)).user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual(["session-0"]);
  });
});

describe("a policy that cannot be evaluated refuses without destroying rows", () => {
  it("refuses every session when nothing is configured, and keeps the rows", async () => {
    const [first] = await signedIn({});
    delete process.env[PERMITTED_EMAILS_VAR];

    const result = await enforce(first);

    // Refused — a deployment that lost its configuration permits nobody.
    expect(result.user).toBeUndefined();
    // But NOT revoked: an outage is not a decision about the list, and
    // restoring the variable has to restore the sessions rather than having
    // silently logged everyone out of every device while nobody could sign
    // in to notice.
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });

  it("is only the no-configuration case, and the other refusals say so", () => {
    // The partition, asserted against the classification itself rather than
    // described: exactly one refusal keeps the row, and the reason it does
    // is that it is the only one that is not about the session in front of
    // it. A future refusal added as "keep" without that property fails here.
    expect(
      Object.entries(REFUSAL_EFFECT)
        .filter(([, effect]) => effect === "keep")
        .map(([reason]) => reason)
        .sort(),
    ).toEqual(["no-configuration", "unverified-email"]);
  });
});

describe("a session row that cannot be identified is refused, not mass-deleted", () => {
  /** Refuse a session whose row id is whatever the caller says it is. */
  async function enforceWithId(id: string | null) {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const [first] = await signedIn({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await enforceLiveSessionPolicy(sessionFor(first, { id }), {
      id: USER_ID,
      email: LISTED,
    });
    await settleRevocations();
    return { result, error };
  }

  it("deletes nothing when the row carries no id", async () => {
    // Prisma reads `where: { id: undefined }` as no filter at all, so this
    // is the difference between "delete this session" and "delete every
    // session on the instance".
    const { result, error } = await enforceWithId(null);

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
    expect(String(error.mock.calls[0][0])).toContain(
      "could not identify its row",
    );
  });

  it("asks for that fixture as an ABSENT id, not a null one", async () => {
    // Which shape the fixture has is the whole point of the case above.
    // Prisma reads `where: { id: undefined }` as NO FILTER — every row —
    // and `where: { id: null }` as `IS NULL`, which matches nothing. Only
    // the first is the dangerous one, and only the first is what a session
    // object that lost its row id would actually look like, so that is what
    // the builder has to produce.
    const [first] = await signedIn({});

    expect("id" in sessionFor(first, { id: null })).toBe(false);
    expect("id" in sessionFor(first)).toBe(true);
  });

  it("treats a blank id the same way, rather than deleting by it", async () => {
    // The case that separates "normalise, then check" from "check for
    // null": a blank id is not a row id, and issuing `where: { id: "  " }`
    // would delete nothing while reporting nothing either — a revocation
    // that silently did not happen (PR #91 review, round 4, finding 3).
    const { result, error } = await enforceWithId("   ");

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
    expect(String(error.mock.calls[0][0])).toContain(
      "could not identify its row",
    );
  });

  it("while a real id does delete that row, so the guard is not the whole story", async () => {
    // The control: the same path, with an id that identifies something.
    const { result, error } = await enforceWithId("session-0");

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-1"]);
    expect(error).not.toHaveBeenCalled();
  });
});

/**
 * Post-cap low on PR #91 (ugcportal-0p5s): `recordedIdentity` is the one
 * place that reads a session row's own columns back out, and it ran every
 * field through `normalizeString`, which lowercases. That is right for
 * `email` (judged for permission, case-insensitively, against configured
 * addresses) and wrong for `id` (the primary key `revokeSession` deletes
 * by) — harmless only because Prisma's default `cuid()` ids happen to be
 * lowercase already.
 */
describe("the recorded id is not case-folded before the delete (ugcportal-0p5s)", () => {
  const MIXED_CASE_ID = "Session-MixedCASE";

  it("recordedIdentity keeps a mixed-case id verbatim while still folding the address", () => {
    const identity = recordedIdentity(
      sessionFor({
        id: MIXED_CASE_ID,
        signInProvider: "google",
        signInEmail: " Owner@Example.COM ",
      }),
    );

    // The needle this test would miss if the fold were still applied to
    // every field: toLowerCase() of MIXED_CASE_ID is a different string.
    expect(MIXED_CASE_ID.toLowerCase()).not.toBe(MIXED_CASE_ID);
    expect(identity.id).toBe(MIXED_CASE_ID);
    expect(identity.email).toBe("owner@example.com");
  });

  it("enforceLiveSessionPolicy's revocation deletes the exact mixed-case row, not a lower-cased lookup", async () => {
    // K3: demonstrated to fail against the pre-fix code, which folds `id`
    // through `normalizeString` before handing it to `revokeSession` — a
    // `deleteMany` keyed on the lower-cased string matches zero rows against
    // this mixed-case id on SQLite's case-sensitive default TEXT comparison,
    // so the row would survive and this assertion would see it.
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });
    await prisma.session.create({
      data: {
        id: MIXED_CASE_ID,
        sessionToken: "token-mixed-case",
        userId: USER_ID,
        expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        signInProvider: "google",
        signInEmail: LISTED,
      },
    });

    const result = await enforceLiveSessionPolicy(
      sessionFor({
        id: MIXED_CASE_ID,
        signInProvider: "google",
        signInEmail: LISTED,
      }),
      { id: USER_ID, email: LISTED },
    );
    await settleRevocations();

    expect(result.user).toBeUndefined();
    expect(
      await prisma.session.findUnique({ where: { id: MIXED_CASE_ID } }),
    ).toBeNull();
  });
});

/**
 * How the identity gets onto the row in the first place (PR #91 review,
 * round 2, finding 1).
 *
 * The real adapter, the real store, the real wrapper, and a real database —
 * because the claim is about what a concurrent INSERT writes, which is
 * precisely what a mock cannot tell you.
 */
describe("recording the identity that minted a session", () => {
  const adapter = withSessionIdentity(PrismaAdapter(prisma));
  /** What a provider id can arrive as, and what it has to be stored as. */
  const REPORTED_PROVIDER = "  GOOGLE  ";
  const CANONICAL_PROVIDER = REPORTED_PROVIDER.trim().toLowerCase();

  /**
   * One sign-in, shaped like the request Auth.js makes: the handler is
   * wrapped (so the request has its own slot), the gate's decision is
   * remembered, and only then is the session row created — with a turn of
   * the event loop in between, which is where a second sign-in gets to
   * interleave.
   */
  const handlers = withSignInIdentity({
    POST: async (signIn: {
      provider: string;
      email: string;
      token: string;
      id: string;
    }) => {
      rememberSignInIdentity({
        user: { email: signIn.email },
        account: { provider: signIn.provider },
        profile: { email: signIn.email },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await adapter.createSession?.({
        sessionToken: signIn.token,
        userId: USER_ID,
        expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
    },
  });

  function identities() {
    return prisma.session.findMany({
      where: { userId: USER_ID },
      orderBy: { sessionToken: "asc" },
      select: { sessionToken: true, signInProvider: true, signInEmail: true },
    });
  }

  it("writes the provider and the asserted address in the row's own insert", async () => {
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });

    await handlers.POST({
      provider: "google",
      // The address the GATE judged, which `authorisedEmail` takes from the
      // profile — not the one stored on the user row.
      email: OTHER,
      token: "token-google",
      id: "ignored",
    });

    await expect(identities()).resolves.toEqual([
      {
        sessionToken: "token-google",
        signInProvider: "google",
        signInEmail: OTHER,
      },
    ]);
  });

  it("stores the provider in the form the reader will recognise", async () => {
    // Canonicalised on the way in by the same `providerId` that reads it
    // back (PR #91 review, round 5). Auth.js reports the provider id a
    // configuration supplied, and a stray space or a capital would be
    // stored verbatim and then read as an unrecognised provider: a row that
    // looks attributed and behaves unattributed.
    //
    // The expectation is DERIVED from the fixture, and the fixture is
    // asserted not to be the answer already — otherwise swapping it for a
    // tidy `"google"` would leave a test that passes without canonicalising
    // anything.
    expect(REPORTED_PROVIDER).not.toBe(CANONICAL_PROVIDER);
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });

    await handlers.POST({
      provider: REPORTED_PROVIDER,
      email: LISTED,
      token: "token-shouty",
      id: "a",
    });

    await expect(identities()).resolves.toEqual([
      {
        sessionToken: "token-shouty",
        signInProvider: CANONICAL_PROVIDER,
        signInEmail: LISTED,
      },
    ]);
  });

  it("so that session is permitted by a bound entry, which the raw value was not", async () => {
    // The consequence, not just the stored string: with ` GOOGLE ` written
    // verbatim this session is refused as `wrong-provider` on its next
    // request and deleted, despite having genuinely come through Google.
    expect(REPORTED_PROVIDER).not.toBe(CANONICAL_PROVIDER);
    process.env[PERMITTED_EMAILS_VAR] = `${CANONICAL_PROVIDER}:${LISTED}`;
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });
    await handlers.POST({
      provider: REPORTED_PROVIDER,
      email: LISTED,
      token: "token-shouty",
      id: "a",
    });
    const [row] = await prisma.session.findMany({
      select: { id: true, signInProvider: true, signInEmail: true },
    });

    expect((await enforce(row)).user?.id).toBe(USER_ID);
    expect(await liveSessionIds()).toEqual([row.id]);
  });

  it("gives each of two concurrent sign-ins its own identity", async () => {
    // THE CASE THE LOOKUP GOT WRONG. Two sign-ins by one person inside the
    // same window — two tabs, or the two providers ugcportal-t33p makes
    // ordinary — used to be attributed by finding "the newest session with
    // no identity yet", which both of them match. One row got the other's
    // provider and one got none, and with a bound entry that is a permitted
    // session refused as `wrong-provider` and deleted on its next request.
    //
    // Interleaved on purpose: each handler remembers, yields, then inserts,
    // so both slots are live at once. There is no ordering here that makes
    // a shared slot look right.
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });

    await Promise.all([
      handlers.POST({
        provider: "google",
        email: LISTED,
        token: "token-a-google",
        id: "a",
      }),
      handlers.POST({
        provider: "facebook",
        email: OTHER,
        token: "token-b-facebook",
        id: "b",
      }),
    ]);

    await expect(identities()).resolves.toEqual([
      {
        sessionToken: "token-a-google",
        signInProvider: "google",
        signInEmail: LISTED,
      },
      {
        sessionToken: "token-b-facebook",
        signInProvider: "facebook",
        signInEmail: OTHER,
      },
    ]);
  });

  it("and each of those sessions is then judged on its own identity", async () => {
    // The reason the attribution matters, asserted end to end rather than
    // left to the reader: with both entries bound, both sessions are
    // permitted; drop one entry and only its own session is refused.
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}, facebook:${OTHER}`;
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });
    await Promise.all([
      handlers.POST({
        provider: "google",
        email: LISTED,
        token: "token-a-google",
        id: "a",
      }),
      handlers.POST({
        provider: "facebook",
        email: OTHER,
        token: "token-b-facebook",
        id: "b",
      }),
    ]);
    const rows = await prisma.session.findMany({
      orderBy: { sessionToken: "asc" },
      select: { id: true, signInProvider: true, signInEmail: true },
    });

    for (const row of rows) {
      expect((await enforce(row)).user?.id).toBe(USER_ID);
    }

    process.env[PERMITTED_EMAILS_VAR] = `facebook:${OTHER}`;
    expect((await enforce(rows[0])).user).toBeUndefined();
    expect((await enforce(rows[1])).user?.id).toBe(USER_ID);
  });

  it("refuses to create a session outside a wrapped request, in dev and test", async () => {
    // No store, no slot: `rememberSignInIdentity` has nowhere to write and
    // the row would be created unattributed — fail-closed, but silent, and
    // silence is how the next entry point that skips the handlers goes
    // unnoticed (PR #91 review, round 4, finding 2). Loud where a developer
    // will see it.
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });

    rememberSignInIdentity({
      user: { email: LISTED },
      account: { provider: "google" },
    });

    // Synchronously, before any row is written: the guard runs in the
    // wrapper, not inside the adapter's promise.
    expect(() =>
      adapter.createSession?.({
        sessionToken: "token-unwrapped",
        userId: USER_ID,
        expires: new Date(Date.now() + 1000),
      }),
    ).toThrow(/no sign-in identity in scope/);
    // And nothing was written, so the loud path is not also a half-done one.
    await expect(identities()).resolves.toEqual([]);
  });

  it("creates it anyway in production, loudly, rather than failing a sign-in", async () => {
    // The other half: on a live instance an unattributed session is a
    // diagnostic problem (a bound entry refuses it once) while refusing to
    // create one at all is an outage. So production logs and continues.
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });

    await adapter.createSession?.({
      sessionToken: "token-unwrapped",
      userId: USER_ID,
      expires: new Date(Date.now() + 1000),
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(
      "no sign-in identity in scope",
    );
    await expect(identities()).resolves.toEqual([
      {
        sessionToken: "token-unwrapped",
        signInProvider: null,
        signInEmail: null,
      },
    ]);
    vi.unstubAllEnvs();
  });

  it("refuses to wrap an adapter that cannot create sessions at all", () => {
    // Construction-time, so an adapter upgrade that drops or renames the
    // method is a boot failure rather than every new session silently
    // losing its identity (round 4 addendum, finding 7).
    expect(() => withSessionIdentity({} as Parameters<typeof withSessionIdentity>[0])).toThrow(
      /no createSession/,
    );
  });

  it("leaves the columns null when the sign-in asserts no usable provider", async () => {
    await prisma.user.create({ data: { id: USER_ID, email: LISTED } });

    const unwritable = withSignInIdentity({
      POST: async (provider: unknown) => {
        rememberSignInIdentity({ user: { email: LISTED }, account: { provider } });
        await adapter.createSession?.({
          sessionToken: `token-${String(provider)}`,
          userId: USER_ID,
          expires: new Date(Date.now() + 1000),
        });
      },
    });
    // `twitter` is the case the canonicalisation added: a provider id that
    // is a perfectly good string and is not one of this instance's. Stored
    // verbatim it would be read back as unrecognised anyway — so the column
    // would hold a value that means nothing to anyone, which is worse than
    // null for exactly the reason null is honest.
    for (const provider of [null, undefined, "", "   ", 42, "twitter"]) {
      await unwritable.POST(provider);
    }

    const rows = await prisma.session.findMany({
      select: { signInProvider: true },
    });
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.signInProvider === null)).toBe(true);
  });
});
