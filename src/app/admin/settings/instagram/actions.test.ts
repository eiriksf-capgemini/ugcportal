import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const deleteManyMock = vi.fn();
const revalidatePathMock = vi.fn();
const setResaleRightsStatusMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  prisma: { instagramAccount: { deleteMany: deleteManyMock } },
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/resale-rights-review", () => ({
  setResaleRightsStatus: setResaleRightsStatusMock,
}));

const { disconnectInstagramAccount } = await import(
  "@/app/admin/settings/instagram/actions"
);

function form(id?: string) {
  const data = new FormData();
  if (id !== undefined) data.set("id", id);
  return data;
}

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};

beforeEach(() => {
  authMock.mockReset();
  deleteManyMock.mockReset().mockResolvedValue({ count: 1 });
  revalidatePathMock.mockReset();
  setResaleRightsStatusMock
    .mockReset()
    .mockResolvedValue({ outcome: "recorded", reviewId: "rev-1", selfReview: false });
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
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin caller", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    await expect(disconnectInstagramAccount(form("acc-1"))).rejects.toThrow(
      "Forbidden",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("deletes the account for an admin and revalidates the settings page", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await disconnectInstagramAccount(form("acc-1"));

    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: "acc-1" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/instagram");
  });

  // Checklist Part E.3. The review row cascades away with the account, so
  // without this the trail's last word on a disconnected account is still
  // "CLEARED".
  it("revokes through the audited writer before deleting", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await disconnectInstagramAccount(form("acc-1"));

    expect(setResaleRightsStatusMock).toHaveBeenCalledWith("acc-1", {
      source: "SYSTEM",
      status: "REVOKED",
      reason: "Account disconnected by an admin.",
      // Named on the audit row, but not written in as the reviewer:
      // disconnecting an account is not reviewing one.
      triggeredByUserId: "admin-1",
      triggeredByEmail: "admin@example.com",
    });
    expect(setResaleRightsStatusMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteManyMock.mock.invocationCallOrder[0],
    );
  });

  it("does not delete the account when the revoke could not be recorded", async () => {
    // Deleting anyway would destroy the evidence of why it was removed.
    authMock.mockResolvedValue(ADMIN_SESSION);
    setResaleRightsStatusMock.mockRejectedValue(new Error("db down"));

    await expect(disconnectInstagramAccount(form("acc-1"))).rejects.toThrow(
      "db down",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("stays a no-op when the account is already gone", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    setResaleRightsStatusMock.mockResolvedValue({
      outcome: "account_not_found",
    });

    await disconnectInstagramAccount(form("acc-1"));

    expect(deleteManyMock).not.toHaveBeenCalled();
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
