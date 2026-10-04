import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roleChangeCountMock = vi.fn();
const setUserRoleMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { roleChange: { count: roleChangeCountMock } },
}));
vi.mock("@/lib/roles", () => ({ setUserRole: setUserRoleMock }));

const { bootstrapAdminEmails, reconcileBootstrapAdmin } = await import(
  "@/lib/admin-bootstrap"
);

const originalEnv = process.env.ADMIN_BOOTSTRAP_EMAILS;

beforeEach(() => {
  roleChangeCountMock.mockReset().mockResolvedValue(0);
  setUserRoleMock.mockReset().mockResolvedValue("updated");
  process.env.ADMIN_BOOTSTRAP_EMAILS = "First@Example.com, second@example.com";
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.ADMIN_BOOTSTRAP_EMAILS;
  } else {
    process.env.ADMIN_BOOTSTRAP_EMAILS = originalEnv;
  }
});

describe("bootstrapAdminEmails", () => {
  it("splits, trims and lowercases the list", () => {
    expect(bootstrapAdminEmails(" A@b.com , C@d.com ")).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });

  it("is empty when blank", () => {
    expect(bootstrapAdminEmails("")).toEqual([]);
    expect(bootstrapAdminEmails(" , ,")).toEqual([]);
  });

  it("defaults to the env var, and to nothing when it is unset", () => {
    expect(bootstrapAdminEmails()).toEqual([
      "first@example.com",
      "second@example.com",
    ]);

    delete process.env.ADMIN_BOOTSTRAP_EMAILS;
    expect(bootstrapAdminEmails()).toEqual([]);
  });
});

describe("reconcileBootstrapAdmin", () => {
  // ugcportal-lu7 K1: the documented bootstrap path is the only way to get
  // the first admin on a fresh instance where every user is USER.
  it("promotes a listed user who has no role history", async () => {
    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
    ).resolves.toBe(true);

    expect(setUserRoleMock).toHaveBeenCalledWith({
      userId: "user-1",
      role: "ADMIN",
      actor: { source: "BOOTSTRAP" },
    });
  });

  it("matches the email case-insensitively", async () => {
    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "FIRST@example.com" }),
    ).resolves.toBe(true);
  });

  // The footgun this design exists to close: leaving the variable set must
  // not quietly undo a deliberate demotion at the next login.
  it("does not re-promote a user whose role has already been changed", async () => {
    roleChangeCountMock.mockResolvedValue(1);

    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
    ).resolves.toBe(false);

    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("ignores a user who isn't listed", async () => {
    await expect(
      reconcileBootstrapAdmin({ id: "user-9", email: "nobody@example.com" }),
    ).resolves.toBe(false);

    expect(roleChangeCountMock).not.toHaveBeenCalled();
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("ignores a user with no email, and does nothing when the var is unset", async () => {
    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: null }),
    ).resolves.toBe(false);

    delete process.env.ADMIN_BOOTSTRAP_EMAILS;
    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
    ).resolves.toBe(false);

    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("honours a provider-bound entry: promotes through that provider only (PR #81 round 5)", async () => {
    process.env.ADMIN_BOOTSTRAP_EMAILS = "google:first@example.com";

    await expect(
      reconcileBootstrapAdmin(
        { id: "user-1", email: "first@example.com" },
        { provider: "facebook" },
      ),
    ).resolves.toBe(false);
    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
    ).resolves.toBe(false);
    expect(setUserRoleMock).not.toHaveBeenCalled();

    await expect(
      reconcileBootstrapAdmin(
        { id: "user-1", email: "first@example.com" },
        { provider: "google" },
      ),
    ).resolves.toBe(true);
    expect(setUserRoleMock).toHaveBeenCalledTimes(1);
  });

  it("promotes an unbound entry through any provider, or none", async () => {
    for (const account of [{ provider: "google" }, { provider: "facebook" }, null]) {
      setUserRoleMock.mockClear();
      await expect(
        reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }, account),
      ).resolves.toBe(true);
      expect(setUserRoleMock).toHaveBeenCalledTimes(1);
    }
  });

  it("reports false when the user was already an admin", async () => {
    setUserRoleMock.mockResolvedValue("unchanged");

    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
    ).resolves.toBe(false);
  });
});
