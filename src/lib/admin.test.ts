import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();

vi.mock("@/lib/auth", () => ({ getSession: getSessionMock }));

const { requireAdmin, requireAdminAccess } = await import("@/lib/admin");

beforeEach(() => {
  getSessionMock.mockReset();
});

describe("requireAdmin", () => {
  // The other half of ugcportal-lu7 K1: once the bootstrap has written
  // role=ADMIN, this is the gate every admin surface (starting with
  // /admin/settings/instagram) consults on the user's next request.
  it("returns the session for a signed-in admin", async () => {
    const session = { user: { id: "admin-1", role: "ADMIN" } };
    getSessionMock.mockResolvedValue(session);

    // `toEqual`, not `toBe`: since ugcportal-mzr made `Session["user"]`
    // optional, this gate rebuilds the session around the user it has just
    // proved is there (see AdminSession), so the value is equal rather than
    // identical. What callers rely on is the content and the narrower type,
    // neither of which the copy changes.
    await expect(requireAdmin()).resolves.toEqual(session);
    // And the user really is on it — the narrowing is the point of the
    // rebuild, so a version that dropped it must not pass.
    expect((await requireAdmin())?.user.id).toBe("admin-1");
  });

  it("returns null for anyone else", async () => {
    for (const session of [
      null,
      {},
      { user: { id: "user-1", role: "USER" } },
      { user: { id: "user-1" } },
      { user: { role: "ADMIN" } },
    ]) {
      getSessionMock.mockResolvedValue(session);
      await expect(requireAdmin()).resolves.toBeNull();
    }
  });

  /**
   * ugcportal-8df3 K2: "Following should never happen: an auth gate
   * (upload page, requireAdmin) treating a failed session read as signed
   * out." A failed read must stay distinguishable from `null` — resolving
   * to `null` here would be indistinguishable from "signed out" to every
   * caller, which is exactly the ambiguity this gate must not create. This
   * is why `requireAdmin` calls the raw `getSession()` rather than
   * src/lib/session-or-anonymous.ts's shared fail-safe — see the comment
   * on that call site.
   *
   * THE FIXTURE MUTATION: swap `requireAdmin`'s `getSession()` call for
   * `resolveSessionOrAnonymous()` and this test fails — the rejection
   * would be swallowed and `requireAdmin()` would resolve to `null`
   * instead of rejecting.
   */
  it("propagates rather than resolving to null when the session read fails (fails CLOSED)", async () => {
    getSessionMock.mockRejectedValue(new Error("getSession() failed (simulated)"));

    await expect(requireAdmin()).rejects.toThrow(
      "getSession() failed (simulated)",
    );
  });
});

/**
 * `requireAdmin` by another shape (ugcportal-mqh8 K4): 401 for nobody
 * signed in, 403 for a signed-in non-admin — distinct status codes rather
 * than `requireAdmin`'s collapse of both to one `null`.
 */
describe("requireAdminAccess", () => {
  it("answers ok for a signed-in admin", async () => {
    const session = { user: { id: "admin-1", role: "ADMIN" } };
    getSessionMock.mockResolvedValue(session);

    const result = await requireAdminAccess();

    expect(result).toEqual({ ok: true, session });
  });

  it.each([null, {}, { user: {} }])(
    "answers 401 for %j (nobody signed in)",
    async (session) => {
      getSessionMock.mockResolvedValue(session);
      await expect(requireAdminAccess()).resolves.toEqual({
        ok: false,
        status: 401,
        error: "Unauthorized",
      });
    },
  );

  it.each([
    { user: { id: "user-1", role: "USER" } },
    { user: { id: "user-1" } },
  ])("answers 403 for a signed-in non-admin %j", async (session) => {
    getSessionMock.mockResolvedValue(session);
    await expect(requireAdminAccess()).resolves.toEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
  });

  it("propagates rather than resolving to a refusal when the session read fails (fails CLOSED)", async () => {
    getSessionMock.mockRejectedValue(
      new Error("getSession() failed (simulated)"),
    );

    await expect(requireAdminAccess()).rejects.toThrow(
      "getSession() failed (simulated)",
    );
  });
});
