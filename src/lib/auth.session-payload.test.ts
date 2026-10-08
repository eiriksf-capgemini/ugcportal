import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";
import { pinEnvironment } from "@/lib/test-support/env";
import { callbackSession } from "@/lib/test-support/session";

/**
 * ugcportal-5gii K1/K2/K3: what GET /api/auth/session actually hands the
 * browser.
 *
 * THE DEFECT. src/app/api/auth/[...nextauth]/route.ts is three lines —
 * `export const { GET, POST } = handlers;` — so the response body of that
 * endpoint IS whatever this app's `session` callback returns, serialised.
 * The permitted branch of `enforceLiveSessionPolicy` used to `return
 * session`, and at runtime that object is the whole `Session` ROW the
 * Prisma adapter read (`session: { ...session, user }` in
 * @auth/core/lib/actions/session.js, over @auth/prisma-adapter's
 * `getSessionAndUser`, which returns `{ user, ...row }`). So `sessionToken`
 * — a bearer credential for a 30-day database session, held in an httpOnly
 * cookie precisely so page script cannot read it — came back in readable
 * JSON to any same-origin `fetch("/api/auth/session")`, alongside `id`,
 * `userId`, `signInProvider` and `signInEmail`.
 *
 * THE SHAPE OF THESE TESTS, modelled on `asAuthResolvesIt` in
 * src/app/api/media/route.revocation.test.ts and from the same sources
 * rather than from intuition:
 *
 *   1. @auth/core calls the session callback with `{ ...sessionRow, user }`
 *      and the adapter user;
 *   2. next-auth wraps that callback and spreads the answer over the user
 *      it already had — `return { user, ...session };`
 *      (node_modules/next-auth/lib/index.js, pinned by
 *      src/lib/next-auth-session-merge.test.ts);
 *   3. `response.body = sessionPayload`, which is JSON.
 *
 * Step 2 is why asserting on the callback's return value alone would not be
 * enough: a callback that simply dropped the `user` key would look narrowed
 * and would in fact get the full adapter `User` row put back. Step 3 is why
 * the assertions below are on the SERIALISED key set — `undefined`-valued
 * keys do not survive it, and the browser only ever sees what does.
 *
 * The only things faked here are next-auth's constructor (its runtime
 * cannot be loaded under vitest; see src/lib/auth.test.ts) and Prisma. The
 * `session` callback, the policy it consults and the narrowing it applies
 * are all the real ones.
 */

const { nextAuthMock, deleteMany } = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  nextAuthMock: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("next-auth", () => ({ default: nextAuthMock }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // @/lib/auth wraps the Prisma adapter at import time; `create` is never
    // reached here because no test in this file mints a session.
    session: { deleteMany, create: vi.fn() },
  },
}));

const { authConfig } = await import("@/lib/auth");
const { SESSION_CLIENT_KEYS, SESSION_USER_CLIENT_KEYS } = await import(
  "@/lib/live-session"
);

const LISTED = "owner@example.com";

pinEnvironment({
  [PERMITTED_EMAILS_VAR]: LISTED,
  ADMIN_BOOTSTRAP_EMAILS: undefined,
});

beforeEach(() => {
  vi.clearAllMocks();
  deleteMany.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * NOT A REAL CREDENTIAL, and nothing in this repo ever produces it: these
 * are placeholder strings for columns that do not exist, used to prove the
 * payload is built by naming fields rather than by removing them.
 */
const FIXTURE_ONLY = "fixture-placeholder-not-a-credential";

/**
 * The adapter `User` row, in full, as `getSessionAndUser` returns it —
 * every column of `model User`, not just the ones this app reads. A fixture
 * that quietly omitted `emailVerified` or `configuredHandle` would be
 * testing a user shape production never produces, and would make the
 * nested allowlist look like it constrained something it had never been
 * handed.
 */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    name: "Owner",
    email: LISTED,
    emailVerified: new Date("2026-01-01T00:00:00.000Z"),
    image: "https://example.test/avatar.png",
    role: "USER" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    configuredHandle: "owner",
    ...overrides,
  };
}

/**
 * The `Session` row, in full, as the adapter read it. `callbackSession` is
 * the shared builder (src/lib/test-support/session.ts) precisely so no test
 * file quietly omits a column.
 */
function sessionRow(extra: Record<string, unknown> = {}) {
  return {
    ...(callbackSession({
      id: "session-1",
      sessionToken: "session-token-1",
      userId: "user-1",
      signInProvider: "google",
      signInEmail: LISTED,
    }) as unknown as Record<string, unknown>),
    ...extra,
  };
}

/** Every key of `model Session` that must never reach the browser. */
const SESSION_ROW_SECRETS = [
  "sessionToken",
  "id",
  "userId",
  "signInProvider",
  "signInEmail",
] as const;

/**
 * The body of GET /api/auth/session, resolved exactly as the three steps in
 * the header describe.
 */
async function sessionBody(
  session: Record<string, unknown> = sessionRow(),
  user: Record<string, unknown> = userRow(),
): Promise<Record<string, unknown>> {
  const payload = await authConfig.callbacks.session({
    session: { ...session, user },
    user,
  } as unknown as Parameters<typeof authConfig.callbacks.session>[0]);
  // Step 2: next-auth's own merge. Step 3: the JSON response body.
  return JSON.parse(JSON.stringify({ user, ...payload })) as Record<
    string,
    unknown
  >;
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

describe("the session payload a permitted request gets (K1)", () => {
  it("is exactly { expires, user: { id, name, email, image, role } }", async () => {
    const body = await sessionBody();

    // Spelled out literally rather than derived from the constants, so a
    // leak cannot be waved through by widening the allowlist: making this
    // pass again after adding a field means editing this line too.
    expect(keysOf(body)).toEqual(["expires", "user"]);
    expect(keysOf(body.user)).toEqual([
      "email",
      "id",
      "image",
      "name",
      "role",
    ]);
  });

  it("carries no sessionToken, row id, userId or recorded identity", async () => {
    const body = await sessionBody();

    // Redundant with the key-set assertion above and kept anyway: this one
    // names the fields by the reason they matter, so a failure says what
    // leaked rather than that a list changed.
    for (const secret of SESSION_ROW_SECRETS) {
      expect(body).not.toHaveProperty(secret);
    }
    // Nested too, because the merge in step 2 is a spread and a narrowing
    // that only emptied the top level would be a leak one level down.
    // `id` is excluded on purpose and only here: on `user` it is the USER
    // id, which K2 requires to be present — the Session row's own `id` is
    // covered by the loop above.
    for (const secret of SESSION_ROW_SECRETS.filter((key) => key !== "id")) {
      expect(body.user).not.toHaveProperty(secret);
    }
    // The needle can be absent: the fixture really did carry every one of
    // them into the callback, so the assertions above are falsifiable.
    const fixture = { ...sessionRow(), user: userRow() };
    for (const secret of SESSION_ROW_SECRETS) {
      expect(fixture).toHaveProperty(secret);
    }
  });

  it("carries none of the User columns this app does not read either", async () => {
    const body = await sessionBody();

    for (const column of ["emailVerified", "createdAt", "updatedAt", "configuredHandle"]) {
      expect(body.user).not.toHaveProperty(column);
      // Same falsifiability check: the adapter row handed in has it.
      expect(userRow()).toHaveProperty(column);
    }
  });

  it("still has a usable expires, which clients read", async () => {
    const body = await sessionBody();

    expect(typeof body.expires).toBe("string");
    expect(Number.isNaN(Date.parse(body.expires as string))).toBe(false);
  });
});

describe("what the narrowing must keep (K2)", () => {
  it("still surfaces user.id and user.role", async () => {
    const body = await sessionBody(sessionRow(), userRow({ role: "ADMIN" }));

    expect((body.user as Record<string, unknown>).id).toBe("user-1");
    expect((body.user as Record<string, unknown>).role).toBe("ADMIN");
  });

  it("reads role from the adapter row on every request, not from the session", async () => {
    // The pair, so neither answer is the one it always gives: revoking
    // somebody's admin role has to take effect on their next request.
    const admin = await sessionBody(sessionRow(), userRow({ role: "ADMIN" }));
    const plain = await sessionBody(sessionRow(), userRow({ role: "USER" }));

    expect((admin.user as Record<string, unknown>).role).toBe("ADMIN");
    expect((plain.user as Record<string, unknown>).role).toBe("USER");
  });

  it("still surfaces the name, email and image the header draws", async () => {
    const body = await sessionBody();

    expect(body.user).toMatchObject({
      name: "Owner",
      email: LISTED,
      image: "https://example.test/avatar.png",
    });
  });
});

describe("the payload is an allowlist, not a denylist (K3)", () => {
  /**
   * THE FIXTURE MUTATION. A column nobody has added yet, with a name no
   * denylist in the current code could possibly mention, carried on the
   * session row the callback is handed.
   *
   * This is the assertion that distinguishes the two implementations. An
   * allowlist that names `expires` and `user` cannot emit it. A denylist —
   * `const payload = { ...session }; delete payload.sessionToken;` — emits
   * it, because deleting the fields you thought of is not a rule about the
   * fields you have not.
   */
  it("drops a future Session column the code has never heard of", async () => {
    const future = { rotationSecret: FIXTURE_ONLY };
    const body = await sessionBody(sessionRow(future));

    expect(body).not.toHaveProperty("rotationSecret");
    expect(keysOf(body)).toEqual(["expires", "user"]);

    // And the proof that this assertion can fail: the denylist version of
    // the same payload, computed here, does leak it. Without this the test
    // above would pass for an implementation that simply never saw the
    // field.
    const denylisted: Record<string, unknown> = {
      ...sessionRow(future),
      user: userRow(),
    };
    delete denylisted.sessionToken;
    expect(denylisted).toHaveProperty("rotationSecret", FIXTURE_ONLY);
  });

  it("drops a future User column the code has never heard of", async () => {
    const body = await sessionBody(
      sessionRow(),
      userRow({ recoveryCodes: FIXTURE_ONLY }),
    );

    expect(body.user).not.toHaveProperty("recoveryCodes");
    expect(keysOf(body.user)).toEqual([
      "email",
      "id",
      "image",
      "name",
      "role",
    ]);
  });

  it("declares that allowlist where a reader will find it", () => {
    // The constants are the written-down decision; these two lines are what
    // stop them drifting from the literals every other test in this file
    // asserts against.
    expect([...SESSION_CLIENT_KEYS]).toEqual(["expires", "user"]);
    expect([...SESSION_USER_CLIENT_KEYS]).toEqual([
      "id",
      "name",
      "email",
      "image",
      "role",
    ]);
  });
});

describe("the refused path is still narrowed, and still refuses", () => {
  it("answers with expires alone, and no user key survives the JSON", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    const body = await sessionBody();

    expect(keysOf(body)).toEqual(["expires"]);
    // `user: undefined` is what wins next-auth's `{ user, ...session }`
    // merge; it is the JSON round trip that then removes the key. Both
    // halves matter, so both are asserted.
    expect(body).not.toHaveProperty("user");
  });

  it("drops a future Session column on the refused path too", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    const body = await sessionBody(sessionRow({ rotationSecret: FIXTURE_ONLY }));

    expect(keysOf(body)).toEqual(["expires"]);
  });

  it("and the refusal itself still happens", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    await sessionBody();

    // The needle-can-be-absent control for the whole file: a refusal really
    // is being produced above, by the real policy, rather than the tests
    // asserting an empty payload against a callback that never ran.
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "session-1" } });
  });
});
