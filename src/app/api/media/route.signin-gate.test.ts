import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEDIA_UPLOAD_PATH } from "@/lib/routes";
import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";

/**
 * ugcportal-egp K2: an identity this instance does not permit ends up with no
 * session, and therefore gets 401 from POST /api/media.
 *
 * The two halves are joined here rather than asserted separately, because
 * separately they are both true of the broken code: the route's 401 worked
 * fine before this bead, and a unit test of the policy proves nothing about
 * what a request gets. What was missing was the link.
 *
 * The ONLY thing faked is the session store. The sign-in gate is the real
 * `authConfig.callbacks.signIn`, the route handler is the real one, and the
 * session `auth()` returns is derived from what the gate answered, by
 * @auth/core's own rule (`handleAuthorized` in lib/actions/callback): a falsy
 * answer throws AccessDenied, and a string answer is taken as a redirect URL
 * — both short-circuit before `handleLoginOrRegister`, so no User, Account or
 * Session row is written. Only a truthy non-string produces a session.
 *
 * Both directions are asserted on every identity, because a 401 that is
 * always returned would satisfy the refusal half on its own.
 */

const { nextAuthMock, authMock } = vi.hoisted(() => {
  const authMock = vi.fn();
  return {
    authMock,
    // Replacing the constructor means `auth`, as imported by the route under
    // test, IS this mock — @/lib/auth destructures it from NextAuth()'s
    // return — while `authConfig` stays the real object. So nothing about the
    // gate is stubbed. (next-auth's runtime also cannot be loaded under
    // vitest; see the note in src/lib/auth.test.ts.)
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
  prisma: { media: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() } },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: vi.fn() }),
  getBucketName: () => "test-bucket",
}));

const { authConfig } = await import("@/lib/auth");
const { POST } = await import("@/app/api/media/route");

const LISTED = "owner@example.com";
const STRANGER = "anyone-with-a-google-account@gmail.com";

const originalAllowlist = process.env[PERMITTED_EMAILS_VAR];
const originalBootstrap = process.env.ADMIN_BOOTSTRAP_EMAILS;

/**
 * Sign in as `email` against the real gate, then record the session that
 * attempt would have produced.
 *
 * Returns the gate's answer so each test can assert on it as well as on the
 * response — a refusal that silently became a permission would otherwise show
 * up only as a changed status code.
 */
function signInAs(
  email: string | null | undefined,
  profile: Record<string, unknown> = { email },
): boolean {
  const user = { id: "user-1", email, role: "USER" as const };
  const answer: unknown = authConfig.callbacks.signIn({
    user,
    profile,
  } as Parameters<typeof authConfig.callbacks.signIn>[0]);

  // @auth/core's rule, not a convenient stand-in for it — see the file
  // header. Modelling it as `answer === true` would make this harness
  // disagree with the library for exactly the answers a broken callback
  // gives.
  const signedIn = Boolean(answer) && typeof answer !== "string";
  authMock.mockResolvedValue(
    signedIn ? { user: { id: user.id, role: user.role } } : null,
  );
  return signedIn;
}

/**
 * A POST with no body at all.
 *
 * Chosen because it separates the two failures cleanly and needs no storage:
 * without a session the route answers 401 before looking at the body, and
 * with one it gets as far as "Expected a multipart form body" and answers
 * 400. So 400 is positive evidence that the request passed the auth gate,
 * which is what makes the 401 assertions falsifiable.
 */
async function postWithNoBody(): Promise<Response> {
  return POST(new Request(`http://localhost${MEDIA_UPLOAD_PATH}`, {
    method: "POST",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("an unpermitted identity cannot upload (K2)", () => {
  it("gets 401 from POST /api/media", async () => {
    expect(signInAs(STRANGER)).toBe(false);

    const response = await postWithNoBody();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("while the permitted account reaches the route", async () => {
    // The needle-can-be-absent control. If this returned 401 too, the test
    // above would be asserting nothing about the gate.
    expect(signInAs(LISTED)).toBe(true);

    const response = await postWithNoBody();

    expect(response.status).toBe(400);
  });

  it("gets 401 even when nobody at all is configured", async () => {
    delete process.env[PERMITTED_EMAILS_VAR];

    expect(signInAs(LISTED)).toBe(false);
    expect((await postWithNoBody()).status).toBe(401);
  });

  it("gets 401 when the provider will not vouch for the address", async () => {
    // Listed, and still refused: the fixture differs from the permitted case
    // only in the email_verified claim.
    expect(signInAs(LISTED, { email: LISTED, email_verified: false })).toBe(
      false,
    );
    expect((await postWithNoBody()).status).toBe(401);

    expect(signInAs(LISTED, { email: LISTED, email_verified: true })).toBe(
      true,
    );
    expect((await postWithNoBody()).status).toBe(400);
  });

  it("gets 401 with no email to be permitted by", async () => {
    expect(signInAs(undefined)).toBe(false);
    expect((await postWithNoBody()).status).toBe(401);
  });
});
