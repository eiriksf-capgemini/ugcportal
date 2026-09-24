import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { requireAdmin } = await import("@/lib/admin");

beforeEach(() => {
  authMock.mockReset();
});

describe("requireAdmin", () => {
  // The other half of ugcportal-lu7 K1: once the bootstrap has written
  // role=ADMIN, this is the gate every admin surface (starting with
  // /admin/settings/instagram) consults on the user's next request.
  it("returns the session for a signed-in admin", async () => {
    const session = { user: { id: "admin-1", role: "ADMIN" } };
    authMock.mockResolvedValue(session);

    await expect(requireAdmin()).resolves.toBe(session);
  });

  it("returns null for anyone else", async () => {
    for (const session of [
      null,
      {},
      { user: { id: "user-1", role: "USER" } },
      { user: { id: "user-1" } },
      { user: { role: "ADMIN" } },
    ]) {
      authMock.mockResolvedValue(session);
      await expect(requireAdmin()).resolves.toBeNull();
    }
  });
});
