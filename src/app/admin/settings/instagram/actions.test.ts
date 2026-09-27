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

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};

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
    authMock.mockResolvedValue(ADMIN_SESSION);

    await disconnectInstagramAccount(form("acc-1"));

    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: "acc-1" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/instagram");
  });

  /**
   * ugcportal-vsm: disconnecting decides nothing about resale rights any
   * more, and must not pretend to.
   *
   * Under ugcportal-0ss the review hung off the account, so Disconnect had
   * to drive it to REVOKED first or the audit trail's last word for a
   * removed account read "cleared". The review now hangs off the uploader,
   * and revoking a person's standing clearance because an unrelated
   * Instagram connection was removed would be a decision no human made — a
   * silent write to the record that decides whether their work can be sold.
   *
   * Asserted rather than left implicit: the module must not import the
   * writer at all, so nobody re-adds the coupling by reflex when Instagram
   * work resumes.
   */
  it("records no resale-rights decision, because it is not one", async () => {
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync(
        new URL("./actions.ts", import.meta.url).pathname,
        "utf8",
      ),
    );

    expect(source).not.toContain("setResaleRightsStatus");
    expect(source).not.toContain("resaleRightsReview");
  });

  it("is a no-op that still revalidates when the account is already gone", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    // deleteMany rather than delete, so a double submit or a stale tab is
    // not a 500.
    deleteManyMock.mockResolvedValue({ count: 0 });

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
