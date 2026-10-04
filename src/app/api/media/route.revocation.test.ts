import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEDIA_UPLOAD_PATH } from "@/lib/routes";
import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";

/**
 * ugcportal-mzr K1: an identity holding a valid, unexpired database session
 * can no longer reach POST /api/media once its address stops being permitted
 * — on the next request, not at its next sign-in.
 *
 * The two halves are joined here rather than asserted separately, for the
 * same reason src/app/api/media/route.signin-gate.test.ts joins its pair:
 * the route's 401 worked before this bead and a unit test of the policy
 * proves nothing about what a request gets. What was missing is the link,
 * and the link runs through a piece of library code that is easy to get
 * wrong in exactly one direction (see `asAuthResolvesIt`).
 *
 * The ONLY things faked are the session store and the request's starting
 * point. The session callback is the real `authConfig.callbacks.session`,
 * the policy it consults is the real one, and the route handler is the real
 * one.
 */

const { nextAuthMock, authMock, deleteMany } = vi.hoisted(() => {
  const authMock = vi.fn();
  return {
    authMock,
    deleteMany: vi.fn(),
    // Replacing the constructor means `auth`, as imported by the route under
    // test, IS this mock — @/lib/auth destructures it from NextAuth()'s
    // return — while `authConfig` stays the real object. (next-auth's
    // runtime also cannot be loaded under vitest; see src/lib/auth.test.ts.)
    nextAuthMock: vi.fn(() => ({
      handlers: {},
      auth: authMock,
      signIn: vi.fn(),
      signOut: vi.fn(),
    })),
  };
});

vi.mock("next-auth", () => ({ default: nextAuthMock }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    session: { deleteMany },
    user: { updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: vi.fn() }),
  getBucketName: () => "test-bucket",
}));

const { authConfig } = await import("@/lib/auth");
const { POST } = await import("@/app/api/media/route");

const LISTED = "owner@example.com";

const originalAllowlist = process.env[PERMITTED_EMAILS_VAR];
const originalBootstrap = process.env.ADMIN_BOOTSTRAP_EMAILS;

/**
 * The adapter `User` row, as `getSessionAndUser` returns it: the whole row,
 * `role` and `signInProvider` included.
 */
function userRow(signInProvider: string | null = "google") {
  return {
    id: "user-1",
    email: LISTED,
    name: "Owner",
    image: null,
    role: "USER" as const,
    signInProvider,
  };
}

/**
 * Resolve the session the way `auth()` does, and record it as what the route
 * will see.
 *
 * This models the one piece of next-auth that makes the refusal non-obvious,
 * and models it from the source rather than from intuition
 * (node_modules/next-auth/lib/index.js:22-32 and @auth/core/lib/actions/
 * session.js):
 *
 *   1. @auth/core calls the session callback with `{ ...sessionRow, user }`
 *      and the adapter user;
 *   2. next-auth wraps that callback and spreads the answer over the user it
 *      already had — `return { user, ...session }`. A callback that deleted
 *      `session.user` therefore gets the full row handed back, id and all;
 *   3. the payload becomes the JSON response body, and `auth()` is the
 *      parsed body.
 *
 * Step 2 is why the refusal has to return a present-but-undefined `user`,
 * and step 3 is why that key then disappears rather than arriving as
 * `undefined`. Skipping either step here would make this file agree with a
 * broken implementation.
 */
async function asAuthResolvesIt(user: ReturnType<typeof userRow>) {
  const payload = await authConfig.callbacks.session({
    session: {
      sessionToken: "session-token-1",
      userId: user.id,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      user,
    },
    user,
  } as unknown as Parameters<typeof authConfig.callbacks.session>[0]);

  const wrapped = { user, ...payload };
  const body: unknown = JSON.parse(JSON.stringify(wrapped));
  authMock.mockResolvedValue(body);
  return body as { user?: { id?: string } };
}

/**
 * A POST with no body at all — the same probe the sign-in-gate suite uses:
 * without a session the route answers 401 before looking at the body, and
 * with one it reaches "Expected a multipart form body" and answers 400. So
 * 400 is positive evidence that the request passed the auth gate, which is
 * what makes the 401 assertions falsifiable.
 */
async function postWithNoBody(): Promise<Response> {
  return POST(
    new Request(`http://localhost${MEDIA_UPLOAD_PATH}`, { method: "POST" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteMany.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env[PERMITTED_EMAILS_VAR] = LISTED;
  delete process.env.ADMIN_BOOTSTRAP_EMAILS;
});

afterEach(() => {
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
});

describe("a revoked identity cannot upload with the session it already holds (K1)", () => {
  it("gets 401 from POST /api/media once its address is removed", async () => {
    // The control, first: the same unexpired session row, under the
    // configuration it was minted under, reaches the route.
    expect((await asAuthResolvesIt(userRow())).user?.id).toBe("user-1");
    expect((await postWithNoBody()).status).toBe(400);

    // The operator removes the address. Nothing else changes: same session
    // row, same cookie, same unexpired `expires`.
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    expect((await asAuthResolvesIt(userRow())).user).toBeUndefined();
    const response = await postWithNoBody();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("and the session rows go with it, so the cookie is dead everywhere", async () => {
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    await asAuthResolvesIt(userRow());

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("gets 401 when the entry is rebound to the other provider", async () => {
    process.env[PERMITTED_EMAILS_VAR] = `google:${LISTED}`;
    expect((await asAuthResolvesIt(userRow("google"))).user?.id).toBe("user-1");
    expect((await postWithNoBody()).status).toBe(400);

    process.env[PERMITTED_EMAILS_VAR] = `facebook:${LISTED}`;

    await asAuthResolvesIt(userRow("google"));
    expect((await postWithNoBody()).status).toBe(401);
  });

  it("gets 401 when nobody at all is configured any more", async () => {
    delete process.env[PERMITTED_EMAILS_VAR];

    await asAuthResolvesIt(userRow());
    expect((await postWithNoBody()).status).toBe(401);
  });

  it("while a still-permitted identity keeps working on every request", async () => {
    // The needle-can-be-absent control for all of the above, and the K2
    // half: the ordinary request still succeeds, and nothing was deleted.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await asAuthResolvesIt(userRow())).user?.id).toBe("user-1");
      expect((await postWithNoBody()).status).toBe(400);
    }
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
