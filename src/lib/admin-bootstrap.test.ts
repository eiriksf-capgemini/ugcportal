import { beforeEach, describe, expect, it, vi } from "vitest";

import { pinEnvironment } from "@/lib/test-support/env";

const roleChangeCountMock = vi.fn();
const setUserRoleMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { roleChange: { count: roleChangeCountMock } },
}));
vi.mock("@/lib/roles", () => ({ setUserRole: setUserRoleMock }));

const { bootstrapAdminEmails, reconcileBootstrapAdmin } = await import(
  "@/lib/admin-bootstrap"
);
// The REAL slot mechanism, not a stand-in: what is under test is that the
// promotion reads the address the gate put there (PR #98 review, low 6).
const { withSignInIdentity, rememberSignInIdentity } = await import(
  "@/lib/live-session"
);

// Was its own save/set/restore of ADMIN_BOOTSTRAP_EMAILS (ugcportal-0p5s)
// — the same copy src/lib/test-support/env.ts was extracted to retire (see
// that module's header).
pinEnvironment({
  ADMIN_BOOTSTRAP_EMAILS: "First@Example.com, second@example.com",
});

beforeEach(() => {
  roleChangeCountMock.mockReset().mockResolvedValue(0);
  setUserRoleMock.mockReset().mockResolvedValue("updated");
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

/**
 * ugcportal-t33p made one user hold several addresses, and `User.email` is
 * whichever of them signed in FIRST — @auth/core never refreshes it. So the
 * promotion has to be judged on the address THIS sign-in was permitted
 * under, which is the one the gate put in the request's identity slot
 * (PR #98 review, low 6).
 */
describe("the bootstrap judges the address this sign-in was permitted under", () => {
  const wrapped = withSignInIdentity({
    run: ((flow: () => Promise<unknown>) => flow()) as (
      ...args: never[]
    ) => unknown,
  });
  function inSignInRequest<T>(flow: () => Promise<T>): Promise<T> {
    return (wrapped.run as unknown as (f: () => Promise<T>) => Promise<T>)(flow);
  }

  it("promotes somebody bootstrapped under their SECOND identity", async () => {
    // The case that silently did nothing before: the row was created by an
    // earlier sign-in under `other@example.com`, and the operator listed the
    // address this sign-in actually used.
    process.env.ADMIN_BOOTSTRAP_EMAILS = "google:second@example.com";

    await expect(
      inSignInRequest(async () => {
        rememberSignInIdentity({
          user: { email: "other@example.com" },
          account: { provider: "google" },
          profile: { email: "second@example.com" },
        });
        return reconcileBootstrapAdmin(
          { id: "user-1", email: "other@example.com" },
          { provider: "google" },
        );
      }),
    ).resolves.toBe(true);
    expect(setUserRoleMock).toHaveBeenCalledTimes(1);
  });

  it("still honours the provider binding on that address", async () => {
    // Fail-closed: reading a fresher address must not also loosen the
    // binding the entry names.
    process.env.ADMIN_BOOTSTRAP_EMAILS = "facebook:second@example.com";

    await expect(
      inSignInRequest(async () => {
        rememberSignInIdentity({
          user: { email: "other@example.com" },
          account: { provider: "google" },
          profile: { email: "second@example.com" },
        });
        return reconcileBootstrapAdmin(
          { id: "user-1", email: "other@example.com" },
          { provider: "google" },
        );
      }),
    ).resolves.toBe(false);
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("promotes nobody the slot does not name, even if the row's address is listed", async () => {
    // The other direction, and the one that makes this a narrowing rather
    // than a widening: the stored address is listed, the permitted one is
    // not, and the sign-in that is actually happening wins.
    process.env.ADMIN_BOOTSTRAP_EMAILS = "first@example.com";

    await expect(
      inSignInRequest(async () => {
        rememberSignInIdentity({
          user: { email: "first@example.com" },
          account: { provider: "google" },
          profile: { email: "unlisted@example.com" },
        });
        return reconcileBootstrapAdmin(
          { id: "user-1", email: "first@example.com" },
          { provider: "google" },
        );
      }),
    ).resolves.toBe(false);
  });

  it("falls back to the stored address when the slot is empty", async () => {
    // An unfilled slot carries nulls (a request that is not a sign-in), and
    // outside a wrapped request there is no slot at all. Both must behave
    // exactly as every caller did before this change.
    process.env.ADMIN_BOOTSTRAP_EMAILS = "first@example.com";

    await expect(
      inSignInRequest(() =>
        reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
      ),
    ).resolves.toBe(true);

    setUserRoleMock.mockClear();
    await expect(
      reconcileBootstrapAdmin({ id: "user-1", email: "first@example.com" }),
    ).resolves.toBe(true);
  });
});
