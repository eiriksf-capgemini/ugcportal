import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { pinEnvironment } from "@/lib/test-support/env";

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
const { enforceLiveSessionPolicy, recordSignInIdentity } = await import(
  "@/lib/live-session"
);

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

/** The object @auth/core builds: the whole row, with the user attached. */
function callbackSession(row: SeededSession): Session {
  return {
    id: row.id,
    sessionToken: `token-for-${row.id}`,
    userId: USER_ID,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    signInProvider: row.signInProvider,
    signInEmail: row.signInEmail,
    user: { id: USER_ID, email: LISTED, role: "USER" },
  } as unknown as Session;
}

function enforce(row: SeededSession, userEmail: string | null = LISTED) {
  return enforceLiveSessionPolicy(callbackSession(row), {
    id: USER_ID,
    email: userEmail,
  });
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
    const session = callbackSession(first);

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
    const session = callbackSession(first);

    const result = await enforceLiveSessionPolicy(session, {
      id: USER_ID,
      email: LISTED,
    });

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

  it("refuses a session with no address anywhere", async () => {
    const [first] = await signedIn({
      email: null,
      sessions: [{ provider: "google", email: null }],
    });

    expect((await enforce(first, null)).user).toBeUndefined();
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

  it("keeps the rows for a session with no address anywhere", async () => {
    const [first] = await signedIn({
      email: null,
      sessions: [{ provider: "google", email: null }, { provider: "google" }],
    });

    await enforce(first, null);

    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });
});

describe("a session row that cannot be identified is refused, not mass-deleted", () => {
  it("deletes nothing when the row carries no id", async () => {
    // Prisma reads `where: { id: undefined }` as no filter at all, so this
    // is the difference between "delete this session" and "delete every
    // session on the instance".
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const [first] = await signedIn({});
    const session = callbackSession(first);
    delete (session as unknown as { id?: unknown }).id;

    const result = await enforceLiveSessionPolicy(session, {
      id: USER_ID,
      email: LISTED,
    });

    expect(result.user).toBeUndefined();
    expect(await liveSessionIds()).toEqual(["session-0", "session-1"]);
  });
});

describe("recordSignInIdentity (what makes the per-session check possible)", () => {
  it("stamps the session that has no identity yet", async () => {
    await signedIn({
      sessions: [{ provider: "google" }, { provider: null, email: null }],
    });

    await recordSignInIdentity({
      user: { id: USER_ID, email: LISTED },
      account: { provider: "facebook" },
      profile: { email: OTHER },
    });

    const rows = await prisma.session.findMany({
      where: { userId: USER_ID },
      orderBy: { id: "asc" },
      select: { id: true, signInProvider: true, signInEmail: true },
    });
    // The already-stamped session is untouched; the new one gets the
    // identity this sign-in asserted.
    expect(rows[0]).toMatchObject({
      signInProvider: "google",
      signInEmail: LISTED,
    });
    expect(rows[1]).toMatchObject({
      signInProvider: "facebook",
      signInEmail: OTHER,
    });
  });

  it("records the address the gate judged, not the one on the user row", async () => {
    // `authorisedEmail` prefers the address the provider asserted in THIS
    // exchange; that is the string the sign-in was permitted on, so it is
    // the string the session must be re-judged on.
    await signedIn({ sessions: [{ provider: null, email: null }] });

    await recordSignInIdentity({
      user: { id: USER_ID, email: LISTED },
      account: { provider: "google" },
      profile: { email: OTHER },
    });

    expect(
      (await prisma.session.findUnique({ where: { id: "session-0" } }))
        ?.signInEmail,
    ).toBe(OTHER);
  });

  it("leaves everything alone, quietly, when there is nothing to record", async () => {
    await signedIn({ sessions: [{ provider: null, email: null }] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordSignInIdentity({ user: { id: USER_ID }, account: null });
    await recordSignInIdentity({ user: { id: USER_ID } });
    // An empty string is the one that would actually REACH the column if
    // the guard only checked the type.
    await recordSignInIdentity({
      user: { id: USER_ID },
      account: { provider: "" },
    });
    await recordSignInIdentity({ user: {}, account: { provider: "google" } });
    // And nothing is LOGGED either, which is what separates "declined to
    // write" from "tried to write and the driver refused": handing Prisma a
    // non-string for a `String?` column throws, and the throw is swallowed,
    // so the column would look identical from the outside.
    await recordSignInIdentity({
      user: { id: USER_ID },
      account: { provider: 42 },
    });

    expect(
      (await prisma.session.findUnique({ where: { id: "session-0" } }))
        ?.signInProvider,
    ).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("says so when there is no unrecorded session to attribute", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await signedIn({ sessions: [{ provider: "google" }] });

    await recordSignInIdentity({
      user: { id: USER_ID },
      account: { provider: "facebook" },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "No unrecorded session row",
    );
    // And it changed nothing, rather than stamping some other device's row.
    expect(
      (await prisma.session.findUnique({ where: { id: "session-0" } }))
        ?.signInProvider,
    ).toBe("google");
  });
});
