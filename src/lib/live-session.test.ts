import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-mzr K1/K2: revoking permission takes effect on the next request
 * that resolves the session, not at the next sign-in.
 *
 * Against a REAL database — the real migrations, the real Prisma client, the
 * real libsql driver — because the claim being made is that the Session rows
 * are gone, and a mocked `deleteMany` can only show that a function was
 * called. The migration this bead adds is also exercised here by being
 * applied: `signInProvider` has to exist as a column for any of this to run.
 *
 * The two database-failure paths are NOT here: a `vi.spyOn` on a Prisma
 * delegate does not survive `restoreAllMocks` (the method is not an own
 * property, so restoring deletes it and every later test in the file loses
 * the client). They live in src/lib/live-session.failures.test.ts, which
 * mocks the module instead.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { enforceLiveSessionPolicy, recordSignInProvider } = await import(
  "@/lib/live-session"
);
const { PERMITTED_EMAILS_VAR } = await import("@/lib/sign-in-policy");

const LISTED = "owner@example.com";
const USER_ID = "user-live-session";

const originalAllowlist = process.env[PERMITTED_EMAILS_VAR];
const originalBootstrap = process.env.ADMIN_BOOTSTRAP_EMAILS;

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

/**
 * One user with `sessions` live sessions, as @auth/core's database strategy
 * leaves things after a sign-in.
 */
async function signedIn(options: {
  email?: string | null;
  signInProvider?: string | null;
  sessions?: number;
}): Promise<{ id: string; email: string | null; signInProvider: unknown }> {
  const { email = LISTED, signInProvider = "google", sessions = 2 } = options;
  await prisma.user.create({
    data: { id: USER_ID, email, signInProvider },
  });
  for (let index = 0; index < sessions; index += 1) {
    await prisma.session.create({
      data: {
        sessionToken: `token-${index}`,
        userId: USER_ID,
        expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }
  return { id: USER_ID, email, signInProvider };
}

/** A session object shaped like the one @auth/core builds from the row. */
function sessionFor(user: {
  id: string;
  email: string | null;
}): Session & { sessionToken: string } {
  return {
    sessionToken: "token-0",
    userId: user.id,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    user: { id: user.id, email: user.email, role: "USER" },
  } as unknown as Session & { sessionToken: string };
}

function liveSessionCount(): Promise<number> {
  return prisma.session.count({ where: { userId: USER_ID } });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env[PERMITTED_EMAILS_VAR] = LISTED;
  delete process.env.ADMIN_BOOTSTRAP_EMAILS;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [name, value] of [
    [PERMITTED_EMAILS_VAR, originalAllowlist],
    ["ADMIN_BOOTSTRAP_EMAILS", originalBootstrap],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
});

describe("a session whose identity is still permitted (K2)", () => {
  it("is handed back untouched, with its rows intact", async () => {
    const user = await signedIn({});
    const session = sessionFor(user);

    const result = await enforceLiveSessionPolicy(session, user);

    // The same object, not a copy: the permitted path adds nothing to what
    // the rest of the app reads.
    expect(result).toBe(session);
    expect(result.user?.id).toBe(USER_ID);
    expect(await liveSessionCount()).toBe(2);
  });

  it("is permitted through the provider its entry is bound to", async () => {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    const user = await signedIn({ signInProvider: "google" });

    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(result.user?.id).toBe(USER_ID);
    expect(await liveSessionCount()).toBe(2);
  });
});

describe("a session whose permission has been revoked (K1)", () => {
  it("loses its user and all of its rows when the address is removed", async () => {
    const user = await signedIn({});
    // The control: permitted a moment ago, under the configuration the
    // session was minted under.
    expect((await enforceLiveSessionPolicy(sessionFor(user), user)).user?.id).toBe(
      USER_ID,
    );

    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(result.user).toBeUndefined();
    // Every session the identity holds, not only the one this request
    // arrived with.
    expect(await liveSessionCount()).toBe(0);
  });

  it("keeps the `user` key, because next-auth puts the row back if it is missing", async () => {
    // THE defect this shape exists to avoid: next-auth's own wrapper around
    // this app's session callback does `return { user, ...session }`
    // (node_modules/next-auth/lib/index.js:22-32). A returned object with no
    // `user` key at all gets the full adapter User row — id included — put
    // straight back, and the refusal becomes invisible. A present-but-
    // undefined key wins the spread.
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const user = await signedIn({});

    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(Object.keys(result)).toContain("user");
    expect({ user, ...result }.user).toBeUndefined();
  });

  it("carries nothing else off the Session row either", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
    const user = await signedIn({});
    const session = sessionFor(user);

    const result = await enforceLiveSessionPolicy(session, user);

    expect(result.expires).toBe(session.expires);
    expect(result).not.toHaveProperty("sessionToken");
    expect(result).not.toHaveProperty("userId");
  });

  it("revokes when the entry is rebound to the other provider", async () => {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    const user = await signedIn({ signInProvider: "google" });
    expect((await enforceLiveSessionPolicy(sessionFor(user), user)).user?.id).toBe(
      USER_ID,
    );

    process.env[PERMITTED_EMAILS_VAR] = `facebook:${LISTED}`;
    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(result.user).toBeUndefined();
    expect(await liveSessionCount()).toBe(0);
  });

  it("refuses a session with no recorded provider against a bound entry", async () => {
    // A row written before this column existed, or one whose linked
    // providers were ambiguous at backfill. Unrecognised fails closed.
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    const user = await signedIn({ signInProvider: null });

    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(result.user).toBeUndefined();
    expect(await liveSessionCount()).toBe(0);
  });

  it("permits the same session against an unbound entry", async () => {
    // The other half of the pair: null provider is only refused by an entry
    // that names a provider. Without this, the assertion above would be
    // satisfied by a check that refused every session with no provider
    // whatever the configuration said.
    process.env[PERMITTED_EMAILS_VAR] = LISTED;
    const user = await signedIn({ signInProvider: null });

    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(result.user?.id).toBe(USER_ID);
    expect(await liveSessionCount()).toBe(2);
  });

  it("refuses a user row with no address at all", async () => {
    const user = await signedIn({ email: null });

    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(result.user).toBeUndefined();
  });
});

describe("a policy that cannot be evaluated refuses without destroying rows", () => {
  it("refuses every session when nothing is configured, and keeps the rows", async () => {
    const user = await signedIn({});
    delete process.env[PERMITTED_EMAILS_VAR];

    const result = await enforceLiveSessionPolicy(sessionFor(user), user);

    // Refused — a deployment that lost its configuration permits nobody.
    expect(result.user).toBeUndefined();
    // But NOT revoked: an outage is not a decision about the list, and
    // restoring the variable has to restore the sessions rather than having
    // silently logged everyone out of every device while nobody could sign
    // in to notice.
    expect(await liveSessionCount()).toBe(2);
  });

  it("keeps the rows for a user row with no address", async () => {
    const user = await signedIn({ email: null });

    await enforceLiveSessionPolicy(sessionFor(user), user);

    expect(await liveSessionCount()).toBe(2);
  });
});

describe("recordSignInProvider (what makes the bound check possible)", () => {
  it("writes the provider the sign-in came through", async () => {
    await signedIn({ signInProvider: null });

    await recordSignInProvider({ id: USER_ID }, { provider: "facebook" });

    expect(
      (await prisma.user.findUnique({ where: { id: USER_ID } }))?.signInProvider,
    ).toBe("facebook");
  });

  it("overwrites the previous provider, so the column tracks the live session", async () => {
    await signedIn({ signInProvider: "google" });

    await recordSignInProvider({ id: USER_ID }, { provider: "facebook" });

    expect(
      (await prisma.user.findUnique({ where: { id: USER_ID } }))?.signInProvider,
    ).toBe("facebook");
  });

  it("leaves the column alone, quietly, when there is no provider to record", async () => {
    await signedIn({ signInProvider: "google" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordSignInProvider({ id: USER_ID }, null);
    await recordSignInProvider({ id: USER_ID }, undefined);
    // An empty string is the one that would actually REACH the column if the
    // guard only checked the type: `signInProvider = ""` is an unrecognised
    // provider, so it would fail closed rather than widen anything, but it
    // would also be a value nobody wrote.
    await recordSignInProvider({ id: USER_ID }, { provider: "" });
    await recordSignInProvider({ id: undefined }, { provider: "facebook" });

    expect(
      (await prisma.user.findUnique({ where: { id: USER_ID } }))?.signInProvider,
    ).toBe("google");
    // And nothing is LOGGED either, which is what separates "declined to
    // write" from "tried to write and the driver refused": handing Prisma a
    // non-string for a `String?` column throws, and the throw is swallowed,
    // so the column would look identical from the outside.
    await recordSignInProvider({ id: USER_ID }, { provider: 42 });
    expect(error).not.toHaveBeenCalled();
    expect(
      (await prisma.user.findUnique({ where: { id: USER_ID } }))?.signInProvider,
    ).toBe("google");
  });
});
