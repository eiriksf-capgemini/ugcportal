import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const setUserRoleMock = vi.fn();
const revalidatePathMock = vi.fn();
const redirectMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));
// Only setUserRole is stubbed — the real isRole is the input validation under
// test, and stubbing it would let a tampered role through unnoticed.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/roles", async () => {
  const actual = await vi.importActual<typeof import("@/lib/roles")>(
    "@/lib/roles",
  );
  return { isRole: actual.isRole, setUserRole: setUserRoleMock };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { changeUserRole } = await import("@/app/admin/settings/users/actions");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};

beforeEach(() => {
  authMock.mockReset();
  setUserRoleMock.mockReset().mockResolvedValue("updated");
  revalidatePathMock.mockReset();
  redirectMock.mockReset();
});

describe("changeUserRole", () => {
  // ugcportal-lu7 K2: nobody may promote themselves or anyone else without
  // already being an admin. Mirrors the 403 tests on the Instagram routes.
  it("refuses an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    await expect(
      changeUserRole(form({ userId: "user-1", role: "ADMIN" })),
    ).rejects.toThrow("Forbidden");
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin promoting someone else", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    await expect(
      changeUserRole(form({ userId: "user-2", role: "ADMIN" })),
    ).rejects.toThrow("Forbidden");
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin promoting themselves", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    await expect(
      changeUserRole(form({ userId: "user-1", role: "ADMIN" })),
    ).rejects.toThrow("Forbidden");
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("refuses a session that carries no role at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });

    await expect(
      changeUserRole(form({ userId: "user-1", role: "ADMIN" })),
    ).rejects.toThrow("Forbidden");
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("promotes a user for an admin and records the actor", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await changeUserRole(form({ userId: "user-1", role: "ADMIN" }));

    expect(setUserRoleMock).toHaveBeenCalledWith({
      userId: "user-1",
      role: "ADMIN",
      actor: {
        source: "ADMIN",
        userId: "admin-1",
        email: "admin@example.com",
      },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/users");
    expect(redirectMock).toHaveBeenCalledWith("/admin/settings/users");
  });

  it("demotes a user for an admin", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await changeUserRole(form({ userId: "admin-2", role: "USER" }));

    expect(setUserRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-2", role: "USER" }),
    );
  });

  it("surfaces a refused last-admin demotion as an outcome code", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    setUserRoleMock.mockResolvedValue("last_admin");

    await changeUserRole(form({ userId: "admin-1", role: "USER" }));

    expect(redirectMock).toHaveBeenCalledWith(
      "/admin/settings/users?error=last_admin",
    );
  });

  it("surfaces an unknown user as an outcome code", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    setUserRoleMock.mockResolvedValue("user_not_found");

    await changeUserRole(form({ userId: "ghost", role: "ADMIN" }));

    expect(redirectMock).toHaveBeenCalledWith(
      "/admin/settings/users?error=user_not_found",
    );
  });

  it("rejects a tampered role value without touching the database", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      changeUserRole(form({ userId: "user-1", role: "SUPERADMIN" })),
    ).rejects.toThrow("Unknown role");
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("rejects a missing user id without touching the database", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(changeUserRole(form({ role: "ADMIN" }))).rejects.toThrow(
      "Missing user id",
    );
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });
});
