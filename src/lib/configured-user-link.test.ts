import { AuthError } from "@auth/core/errors";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("leaves an identity nobody configured on @auth/core's own behaviour", async () => {
    // The wrapper narrows nothing for an unlisted identity: @auth/core's
    // signed-in branch links it to the open session exactly as it always
    // has. Changing that is a different bead, not this one.
    process.env.ALLOWED_SIGNIN_EMAILS = "google:colleague@example.com";
    try {
      const gry = await gryIsSignedIn();

      const outcome = await replayOAuthSignIn({
        provider: "google",
        email: "colleague@example.com",
        subject: "google-subject-colleague",
        withSessionToken: gry.token,
      });

      expect((outcome as { userId: string }).userId).toBe(gry.userId);
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
