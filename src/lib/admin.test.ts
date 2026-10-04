import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();

vi.mock("@/lib/auth", () => ({ getSession: getSessionMock }));

const { requireAdmin } = await import("@/lib/admin");

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
});
