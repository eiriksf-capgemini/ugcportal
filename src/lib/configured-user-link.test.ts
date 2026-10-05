import { AuthError } from "@auth/core/errors";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfiguredUser } from "@/config/users";
import { decideSignIn } from "@/lib/sign-in-policy";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * One person, several sign-in identities, end to end (ugcportal-t33p K1, K2
 * and the post-gate half of K5).
 *
 * AGAINST A REAL DATABASE and the REAL `authConfig`. The claims are that two
 * Account rows point at one User row and that three people get three Users —
 * statements about rows, which a mocked adapter can only agree with. So this
 * file stands up a temporary SQLite database with the real migrations, and
 * drives `authConfig.adapter` and `authConfig.callbacks.signIn` exactly as
 * @auth/core drives them (`replayOAuthSignIn` below mirrors the OAuth branch
 * of `handleLoginOrRegister` statement for statement, with the line numbers
 * to check it against).
 *
 * `next-auth` itself is mocked, for the reason src/lib/auth.test.ts gives:
 * its runtime cannot load under vitest (next-auth/lib/env.js does a bare
 * `import "next/server"`, which Node's ESM resolver cannot find from inside
 * node_modules). Mocking the CONSTRUCTOR leaves the real `authConfig` — the
 * adapter wrapper, the gate, the events — which is the thing under test.
 */

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { authConfig } = await import("@/lib/auth");
const { withSignInIdentity } = await import("@/lib/live-session");

const EIRIK_GOOGLE = "eiriksanderfjeld@gmail.com";
const EIRIK_FACEBOOK = "eirik@sander-fjeld.com";
const GRY_FACEBOOK = "gry@sander-fjeld.no";
const AUGUST_GOOGLE = "augustsanderfjeld@gmail.com";

type Identity = {
  provider: "google" | "facebook";
  email: string;
  /** The provider's stable subject — `Account.providerAccountId`. */
  subject: string;
  /** What the provider calls them, which is NOT what the array calls them. */
  providerName?: string;
  /**
   * A session cookie this browser already carries when the OAuth callback
   * runs — somebody else's, usually. @auth/core takes a different branch
   * entirely when one is present (PR #98 review, medium 1).
   */
  withSessionToken?: string;
};

/**
 * One Auth.js request, with its own AsyncLocalStorage identity slot.
 *
 * The REAL `withSignInIdentity`, not a stand-in: the slot is how the gate
 * hands the identity to the adapter, so a test that supplied the identity
 * some other way would not be testing the mechanism that ships.
 */
const wrappedHandlers = withSignInIdentity({
  run: ((flow: () => Promise<unknown>) => flow()) as (...args: never[]) => unknown,
});
function inSignInRequest<T>(flow: () => Promise<T>): Promise<T> {
  return (wrappedHandlers.run as unknown as (f: () => Promise<T>) => Promise<T>)(
    flow,
  );
}

type SignInOutcome =
  | { permitted: false }
  | { permitted: true; userId: string; sessionToken: string };

let sessionCounter = 0;

/**
 * @auth/core's OAuth sign-in, replayed against this app's configured adapter
 * and callbacks.
 *
 * Mirrors node_modules/@auth/core/lib/actions/callback/handle-login.js, the
 * `account.type === "oauth"` branch at the bottom of the file: gate, then
 * `getUserByAccount`, then `getUserByEmail`, then `createUser` +
 * `linkAccount`, then `createSession`, then the `signIn` event. The order
 * matters more than any single call — it is what makes the linking
 * post-gate — so it is written out rather than abbreviated.
 */
async function replayOAuthSignIn(identity: Identity): Promise<SignInOutcome> {
  return inSignInRequest(async () => {
    const account = {
      provider: identity.provider,
      type: "oauth" as const,
      providerAccountId: identity.subject,
    };
    const user = {
      id: identity.subject,
      name: identity.providerName ?? "Name From The Provider",
      email: identity.email,
      image: null,
    };
    const profile = { email: identity.email, name: user.name };

    // 1. THE GATE. A refusal throws AccessDenied in @auth/core and nothing
    //    below runs; here it returns false and this function stops.
    const permitted = await authConfig.callbacks.signIn({
      user,
      account,
      profile,
    } as unknown as Parameters<typeof authConfig.callbacks.signIn>[0]);
    if (permitted !== true) {
      return { permitted: false };
    }

    const adapter = authConfig.adapter as Required<
      Pick<
        Adapter,
        | "getUserByAccount"
        | "getUserByEmail"
        | "createUser"
        | "linkAccount"
        | "createSession"
        | "getSessionAndUser"
      >
    >;

    // 1b. THE SESSION COOKIE THIS BROWSER ALREADY HAS, if any
    //     (handle-login.js:48). @auth/core loads it BEFORE deciding
    //     anything, and its presence changes which branch runs below.
    const signedIn = identity.withSessionToken
      ? ((await adapter.getSessionAndUser(identity.withSessionToken))?.user ??
        null)
      : null;

    // 2. An account that is already linked already names its user.
    let resolved = await adapter.getUserByAccount({
      provider: account.provider,
      providerAccountId: account.providerAccountId,
    });

    if (resolved && signedIn) {
      // handle-login.js:180-188: signed in as somebody else, and this
      // account already belongs to a third party.
      if (resolved.id !== signedIn.id) {
        throw new Error("OAuthAccountNotLinked");
      }
      return { permitted: true, userId: resolved.id, sessionToken: identity.withSessionToken! };
    }

    if (!resolved && signedIn) {
      // THE BRANCH medium 1 IS ABOUT (handle-login.js:206-212). No
      // getUserByEmail, no createUser: @auth/core links this brand-new
      // account straight onto whoever owns the session cookie.
      await adapter.linkAccount({
        ...account,
        userId: signedIn.id,
      } as Parameters<typeof adapter.linkAccount>[0]);
      return {
        permitted: true,
        userId: signedIn.id,
        sessionToken: identity.withSessionToken!,
      };
    }

    if (!resolved) {
      // 3. Otherwise: does some other row already hold this address?
      const byEmail = await adapter.getUserByEmail(profile.email);
      if (byEmail) {
        // @auth/core throws OAuthAccountNotLinked here rather than linking.
        throw new Error("OAuthAccountNotLinked");
      }
      // 4. A new user, and the account attached to whatever comes back.
      resolved = await adapter.createUser({
        ...user,
        emailVerified: null,
      } as unknown as AdapterUser);
      await adapter.linkAccount({
        ...account,
        userId: resolved.id,
      } as Parameters<typeof adapter.linkAccount>[0]);
    }

    // 5. The session, then the event the bootstrap runs from.
    sessionCounter += 1;
    const sessionToken = `session-token-${sessionCounter}`;
    await adapter.createSession({
      sessionToken,
      userId: resolved.id,
      expires: new Date(Date.now() + 60_000),
    });
    await authConfig.events.signIn({
      user: resolved,
      account,
    } as unknown as Parameters<typeof authConfig.events.signIn>[0]);

    return { permitted: true, userId: resolved.id, sessionToken };
  });
}

/**
 * @auth/core's WEBAUTHN sign-in, replayed the same way
 * (handle-login.js:88-170, the `account.type === "webauthn"` branch).
 *
 * A SECOND BRANCH, not a variation on the first, and it is here for a
 * structural reason rather than because this app offers passkeys: it reaches
 * `linkAccount` from two more call sites (:133 when a session is already
 * open, :161 after creating a user) and calls `getUserByEmail` on a path the
 * OAuth harness never touches. A guard written into the paths the OAuth
 * replay exercises — rather than into the adapter METHOD — passes every test
 * above and fails the ones below.
 *
 * `provider` is deliberately not one of SIGN_IN_PROVIDERS, which is the
 * point: `providerId` maps it to `null`, so `signingIn()` is always `null`
 * here and the only guard that can fire is the one that asks about the
 * TARGET row. That is medium 2's direction, on a path medium 2 was not
 * reported against.
 */
async function replayWebAuthnSignIn(options: {
  email: string;
  subject: string;
  withSessionToken?: string;
}): Promise<{ permitted: boolean; userId?: string }> {
  return inSignInRequest(async () => {
    const account = {
      provider: "webauthn",
      type: "webauthn" as const,
      providerAccountId: options.subject,
    };
    const user = {
      id: options.subject,
      name: "Passkey Holder",
      email: options.email,
      image: null,
    };
    const profile = { email: options.email, name: user.name };

    const permitted = await authConfig.callbacks.signIn({
      user,
      account,
      profile,
    } as unknown as Parameters<typeof authConfig.callbacks.signIn>[0]);
    if (permitted !== true) {
      return { permitted: false };
    }

    const adapter = authConfig.adapter as Required<
      Pick<
        Adapter,
        | "getUserByAccount"
        | "getUserByEmail"
        | "createUser"
        | "linkAccount"
        | "createSession"
        | "getSessionAndUser"
      >
    >;

    const signedIn = options.withSessionToken
      ? ((await adapter.getSessionAndUser(options.withSessionToken))?.user ??
        null)
      : null;

    const byAccount = await adapter.getUserByAccount({
      provider: account.provider,
      providerAccountId: account.providerAccountId,
    });
    if (byAccount) {
      return { permitted: true, userId: byAccount.id };
    }

    if (signedIn) {
      // handle-login.js:133 — the second of the four linkAccount call sites.
      await adapter.linkAccount({
        ...account,
        userId: signedIn.id,
      } as Parameters<typeof adapter.linkAccount>[0]);
      return { permitted: true, userId: signedIn.id };
    }

    // handle-login.js:141-149 — getUserByEmail on a path the OAuth replay
    // does not reach.
    const byEmail = await adapter.getUserByEmail(profile.email);
    if (byEmail) {
      throw new Error("AccountNotLinked");
    }
    const created = await adapter.createUser({
      ...user,
      emailVerified: null,
    } as unknown as AdapterUser);
    // handle-login.js:161 — the third call site.
    await adapter.linkAccount({
      ...account,
      userId: created.id,
    } as Parameters<typeof adapter.linkAccount>[0]);
    return { permitted: true, userId: created.id };
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // Order matters: Account and Session carry FKs to User.
  await prisma.session.deleteMany({});
  await prisma.account.deleteMany({});
  await prisma.media.deleteMany({});
  await prisma.roleChange.deleteMany({});
  await prisma.user.deleteMany({});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a person's identities resolve to one user (K1)", () => {
  it("lands Eirik's Google and Facebook sign-ins on the same User id", async () => {
    const google = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    const facebook = await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
    });

    expect(google.permitted).toBe(true);
    expect(facebook.permitted).toBe(true);
    expect(google).toMatchObject({ permitted: true });
    expect(facebook).toMatchObject({ permitted: true });
    expect((facebook as { userId: string }).userId).toBe(
      (google as { userId: string }).userId,
    );
  });

  it("leaves exactly one User row, carrying the configured handle and name", async () => {
    await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
      // Facebook calls him something else. The second sign-in must not mint
      // a second row just because the provider disagrees about the name.
      providerName: "Eirik S-F",
    });

    const users = await prisma.user.findMany();

    expect(users).toHaveLength(1);
    expect(users[0].configuredHandle).toBe("eirik");
    // The name comes from src/config/users.ts, not from either provider.
    expect(users[0].name).toBe("Eirik");
  });

  it("leaves two Account rows, both pointing at that one user", async () => {
    const google = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
    });

    const accounts = await prisma.account.findMany({ orderBy: { provider: "asc" } });

    expect(accounts.map((account) => account.provider)).toEqual([
      "facebook",
      "google",
    ]);
    expect(new Set(accounts.map((account) => account.userId))).toEqual(
      new Set([(google as { userId: string }).userId]),
    );
  });

  it("keeps one upload history across both identities", async () => {
    // The consequence the bead is actually about: `Media.userId` is the
    // anchor for ownership and for the resale-rights gate, so two users
    // would be two histories and two rights positions.
    const google = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    await prisma.media.create({
      data: {
        userId: (google as { userId: string }).userId,
        kind: "IMAGE",
        key: "uploads/one.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
        originalName: "one.jpg",
      },
    });
    const facebook = await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
    });

    const owned = await prisma.media.count({
      where: { userId: (facebook as { userId: string }).userId },
    });

    expect(owned).toBe(1);
  });

  it("reuses the one user when the two providers assert the SAME address", async () => {
    // The case that makes the `getUserByEmail` wrapper load-bearing rather
    // than tidy: without it, @auth/core finds the existing row by e-mail at
    // step 3 and throws OAuthAccountNotLinked for a sign-in the gate just
    // permitted — permanently, since nothing ever links the two.
    const users = [
      {
        name: "Ada",
        identities: ["google:ada@example.com", "facebook:ada@example.com"],
      },
    ] as const;

    const { withConfiguredUserLinking } = await import("@/lib/configured-user-link");
    const adapter = withConfiguredUserLinking(
      authConfig.adapter as Adapter,
      users,
    );

    const first = await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      rememberSignInIdentity({
        user: { email: "ada@example.com" },
        account: { provider: "google" },
        profile: { email: "ada@example.com" },
      });
      const created = await adapter.createUser!({
        name: "From Google",
        email: "ada@example.com",
        emailVerified: null,
      } as unknown as AdapterUser);
      return created;
    });

    const second = await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      rememberSignInIdentity({
        user: { email: "ada@example.com" },
        account: { provider: "facebook" },
        profile: { email: "ada@example.com" },
      });
      // Step 3 of the replay above: @auth/core asks this before creating.
      const byEmail = await adapter.getUserByEmail!("ada@example.com");
      expect(byEmail).toBeNull();
      return adapter.createUser!({
        name: "From Facebook",
        email: "ada@example.com",
        emailVerified: null,
      } as unknown as AdapterUser);
    });

    expect(second.id).toBe(first.id);
    expect(await prisma.user.count({ where: { configuredHandle: "ada" } })).toBe(1);
  });
});

describe("different people get different users (K2)", () => {
  it("gives Gry and August their own users, linked to nobody else", async () => {
    const eirik = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
    });
    const gry = await replayOAuthSignIn({
      provider: "facebook",
      email: GRY_FACEBOOK,
      subject: "facebook-subject-gry",
    });
    const august = await replayOAuthSignIn({
      provider: "google",
      email: AUGUST_GOOGLE,
      subject: "google-subject-august",
    });

    const ids = [eirik, gry, august].map(
      (outcome) => (outcome as { userId: string }).userId,
    );

    expect(new Set(ids).size).toBe(3);
    const users = await prisma.user.findMany({ orderBy: { configuredHandle: "asc" } });
    expect(users.map((user) => user.configuredHandle)).toEqual([
      "august",
      "eirik",
      "gry",
    ]);
    expect(users.map((user) => user.name)).toEqual(["August", "Eirik", "Gry"]);
  });

  it("leaves no Account row crossing from one person to another", async () => {
    await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
    });
    await replayOAuthSignIn({
      provider: "facebook",
      email: GRY_FACEBOOK,
      subject: "facebook-subject-gry",
    });
    await replayOAuthSignIn({
      provider: "google",
      email: AUGUST_GOOGLE,
      subject: "google-subject-august",
    });

    // Which identity each Account came from, by its provider subject, and
    // which person's handle its user carries. Checked against the array's
    // own answer rather than against a list repeated here.
    const accounts = await prisma.account.findMany({ include: { user: true } });
    const byHandle = new Map(
      accounts.map((account) => [
        account.providerAccountId,
        account.user.configuredHandle,
      ]),
    );

    expect(accounts).toHaveLength(4);
    expect(byHandle).toEqual(
      new Map([
        ["google-subject-eirik", "eirik"],
        ["facebook-subject-eirik", "eirik"],
        ["facebook-subject-gry", "gry"],
        ["google-subject-august", "august"],
      ]),
    );
  });

  it("still gives somebody outside the array their own, unhandled user", async () => {
    // Nobody is linked who is not listed. An allowlisted colleague keeps the
    // unmodified Auth.js behaviour: one user per identity, no handle.
    process.env.ALLOWED_SIGNIN_EMAILS = "google:colleague@example.com";
    try {
      const outcome = await replayOAuthSignIn({
        provider: "google",
        email: "colleague@example.com",
        subject: "google-subject-colleague",
      });

      expect(outcome.permitted).toBe(true);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: (outcome as { userId: string }).userId },
      });
      expect(user.configuredHandle).toBeNull();
      expect(user.name).toBe("Name From The Provider");
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });
});

describe("linking is post-gate and unreachable from the gate (K5)", () => {
  it("writes nothing when only the signIn callback runs", async () => {
    // THE PROPERTY K5 asks for, stated as behaviour: `callbacks.signIn` is
    // where the permission decision is made, and it must not be where any
    // row is created. Driving it on its own — for a configured identity,
    // which is the case most likely to tempt an implementation into linking
    // early — leaves the database untouched.
    const permitted = await inSignInRequest(async () =>
      authConfig.callbacks.signIn({
        user: { id: "x", name: "Eirik", email: EIRIK_GOOGLE, image: null },
        account: {
          provider: "google",
          type: "oauth",
          providerAccountId: "google-subject-eirik",
        },
        profile: { email: EIRIK_GOOGLE },
      } as unknown as Parameters<typeof authConfig.callbacks.signIn>[0]),
    );

    expect(permitted).toBe(true);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.account.count()).toBe(0);
  });

  it("links nothing for a sign-in the gate refused", async () => {
    // A refused identity never reaches the adapter in @auth/core. Even if
    // something did reach it, the slot was never filled — the gate returns
    // before `rememberSignInIdentity` — so the wrapper has no identity and
    // the unwrapped adapter runs. Asserted by calling `createUser` directly
    // after a refusal, which is strictly more than the real flow can do.
    const refused = await replayOAuthSignIn({
      provider: "facebook",
      // Eirik's GOOGLE address, arriving through Facebook: listed, but not
      // for this provider.
      email: EIRIK_GOOGLE,
      subject: "facebook-subject-impostor",
    });

    expect(refused.permitted).toBe(false);
    expect(await prisma.user.count()).toBe(0);

    const created = await inSignInRequest(async () => {
      await authConfig.callbacks.signIn({
        user: { id: "x", name: "Impostor", email: EIRIK_GOOGLE, image: null },
        account: {
          provider: "facebook",
          type: "oauth",
          providerAccountId: "facebook-subject-impostor",
        },
        profile: { email: EIRIK_GOOGLE },
      } as unknown as Parameters<typeof authConfig.callbacks.signIn>[0]);
      return (authConfig.adapter as Adapter).createUser!({
        name: "Impostor",
        email: "impostor@example.com",
        emailVerified: null,
      } as unknown as AdapterUser);
    });

    // Read back from the DATABASE rather than off the returned object:
    // `AdapterUser` does not declare `configuredHandle` (it is a column
    // @auth/core knows nothing about), and the row is the claim anyway.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.configuredHandle).toBeNull();
  });

  it("links nothing outside an Auth.js request, where there is no slot", async () => {
    // No AsyncLocalStorage store at all: a user created by anything that is
    // not one of this app's handlers gets the plain adapter behaviour. This
    // is what makes "the gate permitted it" a precondition of linking rather
    // than a comment about one.
    const created = await (authConfig.adapter as Adapter).createUser!({
      name: "Out Of Band",
      email: EIRIK_GOOGLE,
      emailVerified: null,
    } as unknown as AdapterUser);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.configuredHandle).toBeNull();
    expect(await prisma.user.count({ where: { configuredHandle: "eirik" } })).toBe(0);
  });

  it("leaves getUserByEmail answering normally for an unlisted identity", async () => {
    // The @auth/core protection this wrapper suspends for a configured
    // identity is untouched for everybody else: the lookup still runs and
    // still finds the row that holds the address.
    const existing = await prisma.user.create({
      data: { email: "colleague@example.com", name: "Colleague" },
    });

    const found = await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      rememberSignInIdentity({
        user: { email: "colleague@example.com" },
        account: { provider: "google" },
        profile: { email: "colleague@example.com" },
      });
      return (authConfig.adapter as Adapter).getUserByEmail!(
        "colleague@example.com",
      );
    });

    expect(found?.id).toBe(existing.id);
  });
});

describe("an open session cannot capture somebody else's identity (PR #98 round 1, medium 1)", () => {
  /** Gry, signed in, holding a live session cookie on this browser. */
  async function gryIsSignedIn(): Promise<{ userId: string; token: string }> {
    const gry = await replayOAuthSignIn({
      provider: "facebook",
      email: GRY_FACEBOOK,
      subject: "facebook-subject-gry",
    });
    const outcome = gry as { userId: string; sessionToken: string };
    return { userId: outcome.userId, token: outcome.sessionToken };
  }

  it("refuses the sign-in instead of linking the account to the signed-in user", async () => {
    const gry = await gryIsSignedIn();

    await expect(
      replayOAuthSignIn({
        provider: "google",
        email: EIRIK_GOOGLE,
        subject: "google-subject-eirik",
        withSessionToken: gry.token,
      }),
    ).rejects.toThrow(/belongs to a different user/);
  });

  it("writes no Account row at all, so Eirik never resolves to Gry", async () => {
    const gry = await gryIsSignedIn();

    await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
      withSessionToken: gry.token,
    }).catch(() => undefined);

    // The row that would have done the damage: `getUserByAccount` on
    // Eirik's Google subject is what every later sign-in of his consults.
    expect(
      await prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId: "google-subject-eirik",
          },
        },
      }),
    ).toBeNull();
    // And nothing crossed onto Gry.
    const gryAccounts = await prisma.account.findMany({
      where: { userId: gry.userId },
    });
    expect(gryAccounts.map((account) => account.provider)).toEqual(["facebook"]);
  });

  it("leaves Eirik able to sign in as himself afterwards", async () => {
    // The refusal must not be a lockout: the attempt wrote nothing, so the
    // same identity on a clean browser gets its own user as usual.
    const gry = await gryIsSignedIn();
    await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
      withSessionToken: gry.token,
    }).catch(() => undefined);

    const eirik = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });

    expect(eirik.permitted).toBe(true);
    expect((eirik as { userId: string }).userId).not.toBe(gry.userId);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: (eirik as { userId: string }).userId },
    });
    expect(row.configuredHandle).toBe("eirik");
  });

  it("still links when the signed-in user IS the configured person", async () => {
    // The permitted half of the same branch, and the control for the
    // refusals above: Eirik, signed in through Google, adds Facebook. Same
    // code path, same wrapper, opposite answer — one user, two accounts.
    const first = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    });
    const eirik = first as { userId: string; sessionToken: string };

    const second = await replayOAuthSignIn({
      provider: "facebook",
      email: EIRIK_FACEBOOK,
      subject: "facebook-subject-eirik",
      withSessionToken: eirik.sessionToken,
    });

    expect((second as { userId: string }).userId).toBe(eirik.userId);
    const accounts = await prisma.account.findMany({
      where: { userId: eirik.userId },
      orderBy: { provider: "asc" },
    });
    expect(accounts.map((account) => account.provider)).toEqual([
      "facebook",
      "google",
    ]);
  });

  it("refuses an unlisted identity onto this row too, from the other side", async () => {
    // THIS TEST ASSERTED THE OPPOSITE IN ROUND 1, and that is worth leaving
    // on the record: it claimed the wrapper "narrows nothing for an unlisted
    // identity", so a colleague admitted by ALLOWED_SIGNIN_EMAILS linking
    // onto GRY's open session was fine and a matter for a different bead.
    // Round 2 found that it is the same defect from the other end — the
    // colleague's account lands on Gry's row and `getUserByAccount` resolves
    // them to her for good — so the test was encoding the hole as intended
    // behaviour. The guard now asks about the target row as well as the
    // identity, and the legitimate case (an ordinary row, no handle) has its
    // own test in the round-2 block below.
    process.env.ALLOWED_SIGNIN_EMAILS = "google:colleague@example.com";
    try {
      const gry = await gryIsSignedIn();

      await expect(
        replayOAuthSignIn({
          provider: "google",
          email: "colleague@example.com",
          subject: "google-subject-colleague",
          withSessionToken: gry.token,
        }),
      ).rejects.toThrow(/cannot be added to the signed-in user/);

      expect(
        await prisma.account.count({ where: { userId: gry.userId } }),
      ).toBe(1);
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });

  it("refuses with an error that lands on this app's Access Denied page", async () => {
    // PINNED, because the routing is the whole reason this class was chosen
    // over `AccountNotLinked` (which reads better and goes somewhere else).
    // @auth/core sends an AuthError to `config.pages[error.kind]`, and this
    // config sets `pages.error` and no `pages.signIn`.
    const gry = await gryIsSignedIn();

    const refusal = await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
      withSessionToken: gry.token,
    }).then(
      () => null,
      (error: unknown) => error as { type?: string; kind?: string },
    );

    // `kind` is what @auth/core indexes `config.pages` with
    // (index.js:135-137). "error" is `pages.error`, this app's own Access
    // Denied page; "signIn" — which `AccountNotLinked` carries — would be
    // `pages.signIn`, unset here, so @auth/core's built-in sign-in page.
    expect(refusal?.kind).toBe("error");
    // `type` becomes `?error=`, and only a type in @auth/core's client-safe
    // set survives; anything else is replaced with "Configuration", which
    // this app's error copy reads as a broken deployment rather than a
    // refusal. "AccessDenied" is in that set and has its own copy
    // (src/app/auth/error/outcomes.ts).
    expect(refusal?.type).toBe("AccessDenied");
    // And it really is one of @auth/core's errors, which is the precondition
    // for any of the above being consulted at all.
    expect(refusal).toBeInstanceOf(AuthError);
  });
});

describe("a stranger cannot attach themselves to a configured person's row (PR #98 round 2, medium 2)", () => {
  /** Eirik, signed in, with a live session cookie and a stamped handle. */
  async function eirikIsSignedIn(): Promise<{ userId: string; token: string }> {
    const outcome = (await replayOAuthSignIn({
      provider: "google",
      email: EIRIK_GOOGLE,
      subject: "google-subject-eirik",
    })) as { userId: string; sessionToken: string };
    return { userId: outcome.userId, token: outcome.sessionToken };
  }

  it("refuses an env-var-only identity signing in on top of his session (OAuth, :209)", async () => {
    // THE MIRROR IMAGE of round 1's finding. The identity is permitted —
    // ALLOWED_SIGNIN_EMAILS names it — and belongs to nobody in the array,
    // so the "is this the right person's row?" guard says nothing about it.
    // What stops it is the row: Eirik's carries a handle.
    process.env.ALLOWED_SIGNIN_EMAILS = "google:colleague@example.com";
    try {
      const eirik = await eirikIsSignedIn();

      await expect(
        replayOAuthSignIn({
          provider: "google",
          email: "colleague@example.com",
          subject: "google-subject-colleague",
          withSessionToken: eirik.token,
        }),
      ).rejects.toThrow(/cannot be added to the signed-in user/);

      // No new Account row anywhere...
      expect(
        await prisma.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: "google",
              providerAccountId: "google-subject-colleague",
            },
          },
        }),
      ).toBeNull();
      // ...and Eirik still owns exactly his own.
      const eirikAccounts = await prisma.account.findMany({
        where: { userId: eirik.userId },
      });
      expect(eirikAccounts.map((account) => account.providerAccountId)).toEqual(
        ["google-subject-eirik"],
      );
      // His session survives: the refusal is about the write, not about him.
      expect(
        await prisma.session.findUnique({
          where: { sessionToken: eirik.token },
        }),
      ).not.toBeNull();
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });

  it("refuses it on the WebAuthn path too (:133), because the METHOD is wrapped", async () => {
    // The same refusal, reached through a branch this wrapper's own code
    // says nothing about. A guard written into the OAuth path would pass
    // every assertion above and fail here.
    process.env.ALLOWED_SIGNIN_EMAILS = "colleague@example.com";
    try {
      const eirik = await eirikIsSignedIn();

      await expect(
        replayWebAuthnSignIn({
          email: "colleague@example.com",
          subject: "passkey-colleague",
          withSessionToken: eirik.token,
        }),
      ).rejects.toThrow(/cannot be added to the signed-in user/);

      expect(
        await prisma.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: "webauthn",
              providerAccountId: "passkey-colleague",
            },
          },
        }),
      ).toBeNull();
      expect(
        await prisma.account.count({ where: { userId: eirik.userId } }),
      ).toBe(1);
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });

  it("leaves an ordinary user's row alone, on both paths", async () => {
    // The control, and the limit of this guard: a row with no handle is not
    // a configured person's, so two allowlisted colleagues sharing a browser
    // get exactly Auth.js's own behaviour. Widening that is a decision about
    // Auth.js's default, not this bead.
    process.env.ALLOWED_SIGNIN_EMAILS =
      "google:colleague@example.com,second@example.com";
    try {
      const colleague = (await replayOAuthSignIn({
        provider: "google",
        email: "colleague@example.com",
        subject: "google-subject-colleague",
      })) as { userId: string; sessionToken: string };
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: colleague.userId },
          })
        ).configuredHandle,
      ).toBeNull();

      const webauthn = await replayWebAuthnSignIn({
        email: "second@example.com",
        subject: "passkey-second",
        withSessionToken: colleague.sessionToken,
      });

      expect(webauthn.userId).toBe(colleague.userId);
      expect(
        await prisma.account.count({ where: { userId: colleague.userId } }),
      ).toBe(2);
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });

  it("still lets a brand-new passkey user create their own row (:161)", async () => {
    // The third linkAccount call site, with no session open: nothing to
    // refuse, and the `getUserByEmail` the WebAuthn branch makes on its way
    // there must answer normally.
    process.env.ALLOWED_SIGNIN_EMAILS = "passkey@example.com";
    try {
      const outcome = await replayWebAuthnSignIn({
        email: "passkey@example.com",
        subject: "passkey-new",
      });

      expect(outcome.permitted).toBe(true);
      const account = await prisma.account.findUniqueOrThrow({
        where: {
          provider_providerAccountId: {
            provider: "webauthn",
            providerAccountId: "passkey-new",
          },
        },
      });
      expect(account.userId).toBe(outcome.userId);
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });
});

describe("an array the boot check calls broken is not acted on either (PR #98 round 1, medium 2)", () => {
  /**
   * Both scenarios need an env entry, because a rejected identity is no
   * longer permitted by the array at all — that is half the fix. What is
   * being checked is that having signed in, they get the ORDINARY Auth.js
   * treatment: their own user, no handle, nobody else's row.
   */
  const BOTH = "google:shared@example.com,facebook:kari@example.com,google:kari@example.com";

  it("refuses an identity two people claim, and links it to neither", async () => {
    const users = [
      { name: "Ada", identities: ["google:shared@example.com"] },
      { name: "Grace", identities: ["google:shared@example.com"] },
    ] as const;

    // Not permitted by the array...
    expect(
      decideSignIn(
        {
          user: { email: "shared@example.com" },
          account: { provider: "google" },
          profile: { email: "shared@example.com" },
        },
        {},
        users,
      ),
    ).toEqual({ permitted: false, reason: "no-configuration" });

    // ...and, admitted by the env var instead, linked to nobody.
    process.env.ALLOWED_SIGNIN_EMAILS = BOTH;
    try {
      const { withConfiguredUserLinking } = await import(
        "@/lib/configured-user-link"
      );
      const adapter = withConfiguredUserLinking(
        authConfig.adapter as Adapter,
        users,
      );
      const created = await inSignInRequest(async () => {
        const { rememberSignInIdentity } = await import("@/lib/live-session");
        rememberSignInIdentity({
          user: { email: "shared@example.com" },
          account: { provider: "google" },
          profile: { email: "shared@example.com" },
        });
        return adapter.createUser!({
          name: "From Google",
          email: "shared@example.com",
          emailVerified: null,
        } as unknown as AdapterUser);
      });

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.configuredHandle).toBeNull();
      expect(row.name).toBe("From Google");
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });

  it("refuses two people whose names slug to one handle, and gives them separate users", async () => {
    const users = [
      { name: "Kari", identities: ["facebook:kari@example.com"] },
      { name: "KARI ", identities: ["google:kari@example.com"] },
    ] as const;

    expect(
      decideSignIn(
        {
          user: { email: "kari@example.com" },
          account: { provider: "facebook" },
          profile: { email: "kari@example.com" },
        },
        {},
        users,
      ),
    ).toEqual({ permitted: false, reason: "no-configuration" });

    process.env.ALLOWED_SIGNIN_EMAILS = BOTH;
    try {
      const { withConfiguredUserLinking } = await import(
        "@/lib/configured-user-link"
      );
      const adapter = withConfiguredUserLinking(
        authConfig.adapter as Adapter,
        users,
      );

      const made = [];
      for (const provider of ["facebook", "google"] as const) {
        made.push(
          await inSignInRequest(async () => {
            const { rememberSignInIdentity } = await import(
              "@/lib/live-session"
            );
            rememberSignInIdentity({
              user: { email: "kari@example.com" },
              account: { provider },
              profile: { email: "kari@example.com" },
            });
            return adapter.createUser!({
              name: `From ${provider}`,
              email: `kari+${provider}@example.com`,
              emailVerified: null,
            } as unknown as AdapterUser);
          }),
        );
      }

      // Two people, two users — NOT one row they competed for.
      expect(made[0].id).not.toBe(made[1].id);
      const rows = await prisma.user.findMany({
        where: { id: { in: made.map((user) => user.id) } },
      });
      expect(rows.map((row) => row.configuredHandle)).toEqual([null, null]);
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });
});

describe("one address under two people never reaches the database (PR #98 round 3)", () => {
  const SHARED = "shared@example.com";
  const TWO_PEOPLE: readonly ConfiguredUser[] = [
    { name: "Ada", identities: ["google:shared@example.com"] },
    { name: "Bob", identities: ["facebook:shared@example.com"] },
  ];

  it("permits neither through the array, and says so once", async () => {
    const { configuredUserProblems } = await import("@/lib/sign-in-policy");

    expect(configuredUserProblems(TWO_PEOPLE)).toHaveLength(1);
    for (const provider of ["google", "facebook"] as const) {
      expect(
        decideSignIn(
          {
            user: { email: SHARED },
            account: { provider },
            profile: { email: SHARED },
          },
          {},
          TWO_PEOPLE,
        ),
      ).toEqual({ permitted: false, reason: "no-configuration" });
    }
  });

  it("creates no second row, and stamps no handle on the first", async () => {
    // Admitted by the env var instead, which is what the review leaves them
    // — so what happens next is Auth.js's own rule about two people sharing
    // an address, not this feature quietly merging them. The first gets an
    // ordinary row; the second cannot have one, and crucially the row that
    // exists carries NO handle, so nothing can later be told to "adopt" it
    // on the wrong person's behalf.
    process.env.ALLOWED_SIGNIN_EMAILS = `google:${SHARED},facebook:${SHARED}`;
    try {
      const { withConfiguredUserLinking } = await import(
        "@/lib/configured-user-link"
      );
      const adapter = withConfiguredUserLinking(
        authConfig.adapter as Adapter,
        TWO_PEOPLE,
      );

      // STEPS 4 AND 5 OF @auth/core's OAuth branch, in that order. The
      // `getUserByEmail` is not decoration: it is what refuses the second
      // of them, and an earlier version of this test called `createUser`
      // straight away, so it asserted a P2002 the real flow never reaches
      // (PR #98 round 4). Neither identity is configured any more — the
      // review dropped both — so the wrapper does not withhold the lookup,
      // the first person's row comes back, and @auth/core throws
      // OAuthAccountNotLinked without this feature writing or logging
      // anything.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const signIn = (provider: "google" | "facebook") =>
        inSignInRequest(async () => {
          const { rememberSignInIdentity } = await import(
            "@/lib/live-session"
          );
          rememberSignInIdentity({
            user: { email: SHARED },
            account: { provider },
            profile: { email: SHARED },
          });
          const byEmail = await adapter.getUserByEmail!(SHARED);
          if (byEmail) {
            throw new Error("OAuthAccountNotLinked");
          }
          return adapter.createUser!({
            name: `From ${provider}`,
            email: SHARED,
            emailVerified: null,
          } as unknown as AdapterUser);
        });

      const first = await signIn("google");
      await expect(signIn("facebook")).rejects.toThrow(
        /OAuthAccountNotLinked/,
      );
      // Auth.js's refusal, not ours: no lockout line, because the P2002
      // branch is never reached.
      expect(
        errors.mock.calls
          .map((call) => String(call[0]))
          .filter((text) => text.includes("Could not create the user row")),
      ).toEqual([]);

      const rows = await prisma.user.findMany({ where: { email: SHARED } });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
      expect(rows[0].configuredHandle).toBeNull();
      expect(
        await prisma.user.count({
          where: { configuredHandle: { in: ["ada", "bob"] } },
        }),
      ).toBe(0);
    } finally {
      delete process.env.ALLOWED_SIGNIN_EMAILS;
    }
  });

  it("still links ONE person who holds that address at both providers", async () => {
    // The control, driven through the same adapter: the mirror case is the
    // feature working, and this must not have been broken by the check.
    const onePerson: readonly ConfiguredUser[] = [
      {
        name: "Ada",
        identities: ["google:shared@example.com", "facebook:shared@example.com"],
      },
    ];
    const { withConfiguredUserLinking } = await import(
      "@/lib/configured-user-link"
    );
    const adapter = withConfiguredUserLinking(
      authConfig.adapter as Adapter,
      onePerson,
    );

    const create = (provider: "google" | "facebook") =>
      inSignInRequest(async () => {
        const { rememberSignInIdentity } = await import("@/lib/live-session");
        rememberSignInIdentity({
          user: { email: SHARED },
          account: { provider },
          profile: { email: SHARED },
        });
        return adapter.createUser!({
          name: `From ${provider}`,
          email: SHARED,
          emailVerified: null,
        } as unknown as AdapterUser);
      });

    const first = await create("google");
    const second = await create("facebook");

    expect(second.id).toBe(first.id);
    expect(
      await prisma.user.count({ where: { configuredHandle: "ada" } }),
    ).toBe(1);
  });
});

describe("getUserByEmail only withholds the address the gate judged (PR #98 round 1, low 1)", () => {
  it("answers honestly about a DIFFERENT address during a configured sign-in", async () => {
    const colleague = await prisma.user.create({
      data: { email: "colleague@example.com", name: "Colleague" },
    });

    const found = await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      // Eirik is the one signing in...
      rememberSignInIdentity({
        user: { email: EIRIK_GOOGLE },
        account: { provider: "google" },
        profile: { email: EIRIK_GOOGLE },
      });
      // ...so a lookup for somebody else's address is none of this
      // wrapper's business and must still find them.
      return (authConfig.adapter as Adapter).getUserByEmail!(
        "colleague@example.com",
      );
    });

    expect(found?.id).toBe(colleague.id);
  });

  it("still withholds the slot's own address when a row really holds it", async () => {
    // The control for the test above, and the half that must keep working:
    // a row with this exact address EXISTS, so `null` here can only be the
    // wrapper withholding it. (Without the row, this assertion could not
    // fail — the plain adapter would answer `null` too.)
    await prisma.user.create({ data: { email: EIRIK_GOOGLE, name: "Older" } });

    const found = await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      rememberSignInIdentity({
        user: { email: EIRIK_GOOGLE },
        account: { provider: "google" },
        profile: { email: EIRIK_GOOGLE },
      });
      return (authConfig.adapter as Adapter).getUserByEmail!(EIRIK_GOOGLE);
    });

    expect(found).toBeNull();
  });

  it("compares the two addresses normalised, and delegates everything else", async () => {
    // WHICH CALLS REACH THE ADAPTER UNDERNEATH, which is the actual claim —
    // and one the real Prisma adapter cannot show, because it answers `null`
    // for a padded or upper-cased address whether or not the wrapper
    // withheld it. A spy makes the difference visible.
    const { withConfiguredUserLinking } = await import(
      "@/lib/configured-user-link"
    );
    const delegated: string[] = [];
    const stub = {
      ...(authConfig.adapter as Adapter),
      getUserByEmail: async (email: string) => {
        delegated.push(email);
        return null;
      },
    } as Adapter;
    const adapter = withConfiguredUserLinking(stub);

    await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      rememberSignInIdentity({
        user: { email: EIRIK_GOOGLE },
        account: { provider: "google" },
        profile: { email: EIRIK_GOOGLE },
      });
      // The slot's own address, in three spellings the gate treats as one.
      await adapter.getUserByEmail!(EIRIK_GOOGLE);
      await adapter.getUserByEmail!(EIRIK_GOOGLE.toUpperCase());
      await adapter.getUserByEmail!(`  ${EIRIK_GOOGLE}  `);
      // Somebody else's, twice over.
      await adapter.getUserByEmail!("colleague@example.com");
      await adapter.getUserByEmail!(EIRIK_FACEBOOK);
    });

    expect(delegated).toEqual(["colleague@example.com", EIRIK_FACEBOOK]);
  });
});

describe("a lockout says which row to adopt and how (PR #98 round 2, low)", () => {
  it("names the handle, the colliding address and the cure before rethrowing", async () => {
    // The pre-ugcportal-t33p state: some OTHER row already holds the address
    // this person signs in with, so creating theirs violates `User.email`'s
    // UNIQUE index. Rethrowing is right — a sign-in that silently did
    // nothing would be worse — but it is also a LOCKOUT, and a bare P2002
    // from inside an adapter tells the operator nothing about which of the
    // three or four things that could mean it is.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await prisma.user.create({
      data: { email: EIRIK_GOOGLE, name: "Somebody Else", configuredHandle: null },
    });

    await expect(
      replayOAuthSignIn({
        provider: "google",
        email: EIRIK_GOOGLE,
        subject: "google-subject-eirik",
      }),
    ).rejects.toThrow();

    const line = errors.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("Could not create the user row"));

    expect(line).toBeDefined();
    // Which person, which address, and somewhere to go. WHICH cure it names
    // depends on what the offending row has on it, and the two branches have
    // a test each below — this one owns only the parts that are true of
    // both. (Its own fixture, a row with no accounts at all, takes the
    // "cannot adopt" branch, and correctly: the migration's join needs an
    // Account, and there is none.)
    expect(line).toContain('"eirik"');
    expect(line).toContain(EIRIK_GOOGLE);
    expect(line).toContain("cannot sign in until that row is adopted");
    expect(line).toContain("docs/access-control.md");
  });

  it("sends the operator to the UPDATE when no migration could adopt the row", async () => {
    // THE CROSS-SOURCE SIBLING of the round-3 collision (PR #98 round 4,
    // low 4): `google:x` in the array, `facebook:x` in the env var. The
    // Facebook sign-in is not a configured identity, so it takes an
    // ordinary row holding the address with a FACEBOOK account on it. The
    // Google sign-in then cannot create Eirik's row — and the reconciliation
    // migration cannot adopt that one either, because its join needs an
    // Account with the provider that is signing in. Telling the operator to
    // run it would be telling them to run a no-op.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const holder = await prisma.user.create({
      data: { email: EIRIK_GOOGLE, name: "Arrived Via Facebook" },
    });
    await prisma.account.create({
      data: {
        userId: holder.id,
        provider: "facebook",
        providerAccountId: "facebook-subject-other",
        type: "oauth",
      },
    });

    await expect(
      replayOAuthSignIn({
        provider: "google",
        email: EIRIK_GOOGLE,
        subject: "google-subject-eirik",
      }),
    ).rejects.toThrow();

    const line = errors.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("Could not create the user row"));

    expect(line).toBeDefined();
    expect(line).toContain("has no google account");
    expect(line).toContain("(it has: facebook)");
    expect(line).toContain("cannot adopt it");
    expect(line).toContain("UPDATE");
    expect(line).toContain("docs/access-control.md");
    // And it does NOT send them to the migration, which is the whole point.
    expect(line).not.toContain("20261005120500_reconcile_configured_users");
  });

  it("sends them to the migration when it COULD adopt the row", async () => {
    // The other branch, and the control: the offending row already has an
    // account with the provider signing in, so the migration's join matches
    // and running it really is the cure.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const holder = await prisma.user.create({
      data: { email: EIRIK_GOOGLE, name: "Arrived Via Google" },
    });
    await prisma.account.create({
      data: {
        userId: holder.id,
        provider: "google",
        providerAccountId: "google-subject-older",
        type: "oauth",
      },
    });

    await expect(
      replayOAuthSignIn({
        provider: "google",
        email: EIRIK_GOOGLE,
        subject: "google-subject-eirik",
      }),
    ).rejects.toThrow();

    const line = errors.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("Could not create the user row"));

    expect(line).toContain("20261005120500_reconcile_configured_users");
    expect(line).not.toContain("cannot adopt it");
  });

  it("does not log it when the handle row simply raced into existence", async () => {
    // The other P2002 this path can see, and the one that is NOT a lockout:
    // two sign-ins by the same person at the same moment. The loser re-reads
    // the winner's row and returns it, so there is nothing to tell anybody.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { withConfiguredUserLinking } = await import(
      "@/lib/configured-user-link"
    );

    const racy = {
      ...(authConfig.adapter as Adapter),
      createUser: async (data: AdapterUser) => {
        // Stand in for the other request having just won: the row exists by
        // the time this insert runs.
        await prisma.user.create({
          data: {
            email: "winner@example.com",
            name: "Eirik",
            configuredHandle: "eirik",
          },
        });
        return (authConfig.adapter as Adapter).createUser!(data);
      },
    } as Adapter;
    const adapter = withConfiguredUserLinking(racy);

    const resolved = await inSignInRequest(async () => {
      const { rememberSignInIdentity } = await import("@/lib/live-session");
      rememberSignInIdentity({
        user: { email: EIRIK_GOOGLE },
        account: { provider: "google" },
        profile: { email: EIRIK_GOOGLE },
      });
      return adapter.createUser!({
        name: "From Google",
        email: EIRIK_GOOGLE,
        emailVerified: null,
      } as unknown as AdapterUser);
    });

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: resolved.id } }))
        .configuredHandle,
    ).toBe("eirik");
    expect(
      errors.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("Could not create the user row")),
    ).toEqual([]);
  });
});

describe("the adapter wrapper refuses a configuration it cannot honour", () => {
  it("throws at construction when the adapter cannot create users", async () => {
    // Same decision `withSessionIdentity` makes: a silent pass-through here
    // would give every configured person a second user per provider, which
    // is the defect this wrapper removes, with nothing saying why.
    const { withConfiguredUserLinking } = await import("@/lib/configured-user-link");

    expect(() => withConfiguredUserLinking({} as Adapter)).toThrow(
      /no createUser\/getUserByEmail/,
    );
  });
});
