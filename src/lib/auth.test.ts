import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_ERROR_PATH } from "@/lib/routes";
import { PERMITTED_EMAILS_VAR, SIGN_IN_PROVIDERS } from "@/lib/sign-in-policy";

/**
 * ugcportal-egp K1, as WIRED rather than as written.
 *
 * A unit test of src/lib/sign-in-policy.ts passes whether or not anything
 * calls it — and the defect was exactly that: no `signIn` callback existed,
 * so @auth/core's `defaultCallbacks.signIn` applied, and it returns `true`.
 * So these tests drive `authConfig.callbacks.signIn`, and one of them asserts
 * that object is the one NextAuth was actually handed.
 */

// vi.hoisted, because vi.mock's factory is hoisted above every `const` in
// this module, so anything the factory closes over has to be created up
// there with it.
const {
  nextAuthMock,
  nextAuthConfigs,
  reconcileBootstrapAdminMock,
  deleteManyMock,
  updateManyMock,
} = vi.hoisted(() => {
    // The configs NextAuth was constructed with, recorded rather than read
    // off mock.calls: NextAuth is constructed once, when the module is first
    // evaluated, and the beforeEach below clears mock state.
    const nextAuthConfigs: unknown[] = [];
    return {
      nextAuthConfigs,
      // The two writes src/lib/live-session.ts makes. Their behaviour is
      // tested there; here they exist so the callback and the event can be
      // driven, and so this file can assert they were reached.
      deleteManyMock: vi.fn(async () => ({ count: 1 })),
      updateManyMock: vi.fn(async () => ({ count: 1 })),
      nextAuthMock: vi.fn((config: unknown) => {
        nextAuthConfigs.push(config);
        return {
          handlers: {},
          auth: vi.fn(),
          signIn: vi.fn(),
          signOut: vi.fn(),
        };
      }),
      reconcileBootstrapAdminMock: vi.fn(),
    };
  });

// next-auth is replaced, not because the config is uninteresting, but because
// its runtime cannot be loaded here: next-auth/lib/env.js does a bare
// `import "next/server"`, and Next ships no exports map, so Node's ESM
// resolver cannot find it from inside node_modules. Mocking the constructor
// keeps the real authConfig — the thing under test — and makes "was this
// config actually handed to NextAuth?" an assertion instead of an assumption.
vi.mock("next-auth", () => ({ default: nextAuthMock }));

vi.mock("@/lib/admin-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-bootstrap")>();
  return {
    ...actual,
    // Only the promotion is replaced. bootstrapAdminEmails is re-exported
    // from the sign-in policy and stays real, because how the two lists
    // compose is one of the things under test here.
    reconcileBootstrapAdmin: reconcileBootstrapAdminMock,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: { deleteMany: deleteManyMock },
    user: { updateMany: updateManyMock },
  },
}));

const { authConfig } = await import("@/lib/auth");

const LISTED = "owner@example.com";
const STRANGER = "anyone-with-a-google-account@gmail.com";

const originalAllowlist = process.env[PERMITTED_EMAILS_VAR];
const originalBootstrap = process.env.ADMIN_BOOTSTRAP_EMAILS;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * The callback reads process.env (that is the configuration seam), so these
 * tests set it and put it back. Every case states its own configuration; none
 * inherits the host's.
 */
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env[PERMITTED_EMAILS_VAR] = LISTED;
  delete process.env.ADMIN_BOOTSTRAP_EMAILS;
});

afterEach(() => {
  vi.restoreAllMocks();
  restore(PERMITTED_EMAILS_VAR, originalAllowlist);
  restore("ADMIN_BOOTSTRAP_EMAILS", originalBootstrap);
});

function signIn(
  user: { email?: string | null },
  profile?: Record<string, unknown>,
  account?: { provider: string },
) {
  // Shaped like what @auth/core passes: `user` is the adapter row when the
  // account is already linked and the provider-derived user when it is not,
  // `profile` is the provider's parsed profile for this sign-in, and
  // `account` names the provider it came through.
  return authConfig.callbacks.signIn({
    user,
    account,
    profile,
  } as Parameters<typeof authConfig.callbacks.signIn>[0]);
}

describe("the signIn callback hands the provider to the gate (ugcportal-1551)", () => {
  // Deleting `account` from the callback's destructuring would make every
  // bound entry refuse everyone — so the PERMITTED case is the one that
  // proves the wiring, and the refused case proves the binding is read.
  it("permits a bound address through its own provider and refuses it through the other", () => {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    expect(signIn({ email: LISTED }, { email: LISTED }, { provider: "google" })).toBe(true);
    expect(signIn({ email: LISTED }, { email: LISTED }, { provider: "facebook" })).toBe(false);
  });

  it("configures exactly the providers an entry may be bound to", () => {
    // SIGN_IN_PROVIDERS is what `google:`/`facebook:` prefixes are checked
    // against. If a provider is added here without being listed there, its
    // prefix is silently malformed and permits nobody; the reverse would let
    // an operator bind an address to a provider that cannot sign anyone in.
    const configured = authConfig.providers
      .map((provider) => provider.id)
      .sort();
    expect(configured).toEqual([...SIGN_IN_PROVIDERS].sort());
  });
});

describe("the signIn callback is the authorisation gate", () => {
  it("is wired into the config NextAuth was constructed with", () => {
    // If the callback is deleted, this fails on the property access below
    // before any behaviour is reached — and if the config object stops being
    // the one passed to NextAuth, the rest of this file would be testing a
    // dead object.
    // `toBe`, not `toEqual`: structural equality would be satisfied by
    // `NextAuth({ ...authConfig })`, and a clone is exactly the case this
    // needs to catch — every other test in this file drives `authConfig`, so
    // if NextAuth were handed a copy they would all be describing an object
    // the library never saw.
    expect(nextAuthConfigs).toHaveLength(1);
    expect(nextAuthConfigs[0]).toBe(authConfig);
    expect(typeof authConfig.callbacks.signIn).toBe("function");
  });

  it("refuses a Google account nobody configured", () => {
    // The defect: every Google and Facebook account on the internet.
    expect(signIn({ email: STRANGER }, { email: STRANGER })).toBe(false);
  });

  it("permits the account configuration names", () => {
    // The control for the refusals: the needle (false) can be absent.
    expect(signIn({ email: LISTED }, { email: LISTED })).toBe(true);
  });

  it("refuses everyone when no configuration is present at all", () => {
    delete process.env[PERMITTED_EMAILS_VAR];

    expect(signIn({ email: LISTED }, { email: LISTED })).toBe(false);
    expect(signIn({ email: STRANGER }, { email: STRANGER })).toBe(false);
  });

  it("answers with a boolean and never a string", () => {
    // Not pedantry about types. @auth/core's handleAuthorized reads a STRING
    // answer as a redirect URL, so a callback that returned, say, the
    // permitted address instead of `true` would neither permit nor refuse —
    // it would redirect to a path named after an email. Falsy answers are all
    // refusals there, so the boolean is the only answer with one meaning.
    for (const answer of [
      signIn({ email: LISTED }),
      signIn({ email: STRANGER }),
      signIn({}),
    ]) {
      expect(typeof answer).toBe("boolean");
    }
  });

  it("refuses an address the provider will not vouch for, even a listed one", () => {
    expect(
      signIn({ email: LISTED }, { email: LISTED, email_verified: false }),
    ).toBe(false);
    // Same fixture, verified: permitted. Without this pair the assertion
    // above would pass against a gate that refused everything.
    expect(
      signIn({ email: LISTED }, { email: LISTED, email_verified: true }),
    ).toBe(true);
  });
});

describe("the bootstrap and the allowlist compose (K3)", () => {
  it("lets a bootstrap-listed operator sign in with no allowlist at all", () => {
    // A fresh deployment that set only ADMIN_BOOTSTRAP_EMAILS, which is what
    // env.example told them to do for ugcportal-lu7.
    delete process.env[PERMITTED_EMAILS_VAR];
    process.env.ADMIN_BOOTSTRAP_EMAILS = `First@Example.com, ${LISTED}`;

    expect(signIn({ email: "first@example.com" })).toBe(true);
    expect(signIn({ email: LISTED })).toBe(true);
  });

  it("does not let the bootstrap variable admit anyone it does not name", () => {
    // The K3 worry, directly: "the database is empty, so let this person in".
    // There is no database condition in this path to arrange — the answer
    // below does not depend on any store being empty or populated, because
    // nothing here reads one.
    process.env.ADMIN_BOOTSTRAP_EMAILS = "admin@example.com";
    delete process.env[PERMITTED_EMAILS_VAR];

    expect(signIn({ email: STRANGER })).toBe(false);
    expect(signIn({ email: "admin@example.com" })).toBe(true);
  });

  it("runs the promotion as an event, so it cannot precede the gate", () => {
    // The callback is pure and touches no store; the promotion is an Auth.js
    // *event*, which @auth/core only fires after handleAuthorized has already
    // permitted the sign-in. Asserting the callback promotes nobody is what
    // keeps a future refactor from moving the write in front of the gate.
    expect(signIn({ email: LISTED })).toBe(true);
    expect(reconcileBootstrapAdminMock).not.toHaveBeenCalled();

    expect(typeof authConfig.events.signIn).toBe("function");
  });

  it("still promotes the first admin at sign-in", () => {
    // ugcportal-lu7 must keep working: the event delegates to
    // reconcileBootstrapAdmin, which owns the "listed and no role history"
    // rule and is tested in admin-bootstrap.test.ts.
    const user = { id: "user-1", email: LISTED };
    const account = { provider: "google", providerAccountId: "sub-1" };

    return expect(
      authConfig.events.signIn({ user, account } as Parameters<
        typeof authConfig.events.signIn
      >[0]),
    )
      .resolves.toBeUndefined()
      .then(() => {
        // The provider travels with the user, so a bound bootstrap entry can
        // be honoured at promotion (PR #81 round 5).
        expect(reconcileBootstrapAdminMock).toHaveBeenCalledWith(user, account);
      });
  });
});

/**
 * ugcportal-mzr, as WIRED. The enforcement itself — what it returns, what it
 * deletes, what it refuses to delete — is src/lib/live-session.ts's own
 * suite's business; what can only be checked here is that the `session`
 * callback this app hands NextAuth reaches it at all, and hands it the two
 * columns the decision is made on. Deleting either of the three lines in the
 * callback fails something below.
 */
describe("the session callback re-checks the policy on every request", () => {
  /** The adapter row, as the database strategy hands it to the callback. */
  function userRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "user-1",
      email: LISTED,
      role: "USER",
      signInProvider: "google",
      ...overrides,
    };
  }

  function resolveSession(user: Record<string, unknown>) {
    return authConfig.callbacks.session({
      session: {
        sessionToken: "session-token-1",
        userId: user.id,
        expires: new Date(Date.now() + 86_400_000),
        user,
      },
      user,
    } as unknown as Parameters<typeof authConfig.callbacks.session>[0]);
  }

  it("surfaces the id and role of a still-permitted identity", async () => {
    const session = await resolveSession(userRow({ role: "ADMIN" }));

    expect(session.user?.id).toBe("user-1");
    expect((session.user as { role?: string }).role).toBe("ADMIN");
  });

  it("refuses the identity once its address stops being permitted", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    const session = await resolveSession(userRow());

    expect(session.user).toBeUndefined();
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("judges the provider recorded on the row", async () => {
    // The pair that pins `toSignInProvider` to the callback: the two cases
    // differ only in the column's value, so a callback that stopped reading
    // it would answer the same way twice.
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;

    expect(
      (await resolveSession(userRow({ signInProvider: "google" }))).user?.id,
    ).toBe("user-1");
    expect(
      (await resolveSession(userRow({ signInProvider: "facebook" }))).user,
    ).toBeUndefined();
  });
});

describe("the signIn event records which provider got them in", () => {
  it("writes it to the User row, so the session callback can read it back", async () => {
    await authConfig.events.signIn({
      user: { id: "user-1", email: LISTED },
      account: { provider: "facebook", providerAccountId: "sub-1" },
    } as Parameters<typeof authConfig.events.signIn>[0]);

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { signInProvider: "facebook" },
    });
  });
});

describe("a refused sign-in has somewhere to land", () => {
  it("points Auth.js at the first-party error page", () => {
    // Without this, @auth/core renders its own Access Denied card with a
    // "Sign in" button that restarts the identical, identically refused
    // journey.
    expect(authConfig.pages.error).toBe(AUTH_ERROR_PATH);
  });
});
