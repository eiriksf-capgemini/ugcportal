import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const deleteManyMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  prisma: { instagramAccount: { deleteMany: deleteManyMock } },
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { disconnectInstagramAccount } = await import(
  "@/app/admin/settings/instagram/actions"
);

function form(id?: string) {
  const data = new FormData();
  if (id !== undefined) data.set("id", id);
  return data;
}

beforeEach(() => {
  authMock.mockReset();
  deleteManyMock.mockReset().mockResolvedValue({ count: 1 });
  revalidatePathMock.mockReset();
});

describe("disconnectInstagramAccount", () => {
  // A server action is a public endpoint — reachable without the page that
  // renders its form, so it carries its own admin check (ugcportal-5ce K2).
  it("refuses an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    await expect(disconnectInstagramAccount(form("acc-1"))).rejects.toThrow(
      "Forbidden",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin caller", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    await expect(disconnectInstagramAccount(form("acc-1"))).rejects.toThrow(
      "Forbidden",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes the account for an admin and revalidates the settings page", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    await disconnectInstagramAccount(form("acc-1"));

    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: "acc-1" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/instagram");
  });

  it("rejects a missing id without touching the database", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    await expect(disconnectInstagramAccount(form())).rejects.toThrow(
      "Missing account id",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});
