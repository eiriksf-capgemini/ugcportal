import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();
const countMock = vi.fn();
const updateMock = vi.fn();
const createRoleChangeMock = vi.fn();

const tx = {
  user: {
    findUnique: findUniqueMock,
    count: countMock,
    update: updateMock,
  },
  roleChange: { create: createRoleChangeMock },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  },
}));

const { isRole, setUserRole } = await import("@/lib/roles");

const ADMIN_ACTOR = {
  source: "ADMIN",
  userId: "admin-1",
  email: "admin@example.com",
} as const;

beforeEach(() => {
  findUniqueMock.mockReset();
  countMock.mockReset();
  updateMock.mockReset().mockResolvedValue({});
  createRoleChangeMock.mockReset().mockResolvedValue({});
});

describe("isRole", () => {
  it("accepts the two enum members and nothing else", () => {
    expect(isRole("USER")).toBe(true);
    expect(isRole("ADMIN")).toBe(true);
    for (const value of ["admin", "", undefined, null, 1, ["ADMIN"]]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe("setUserRole", () => {
  // ugcportal-lu7 K1: the promotion path writes role=ADMIN, which the
  // database session strategy re-reads on the user's next request.
  it("promotes a user and records who did it", async () => {
    findUniqueMock.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      role: "USER",
    });

    await expect(
      setUserRole({ userId: "user-1", role: "ADMIN", actor: ADMIN_ACTOR }),
    ).resolves.toBe("updated");

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { role: "ADMIN" },
    });
    expect(createRoleChangeMock).toHaveBeenCalledWith({
      data: {
        targetUserId: "user-1",
        targetEmail: "user@example.com",
        previousRole: "USER",
        newRole: "ADMIN",
        source: "ADMIN",
        actorUserId: "admin-1",
        actorEmail: "admin@example.com",
      },
    });
  });

  it("records the bootstrap path with no actor", async () => {
    findUniqueMock.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      role: "USER",
    });

    await setUserRole({
      userId: "user-1",
      role: "ADMIN",
      actor: { source: "BOOTSTRAP" },
    });

    expect(createRoleChangeMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "BOOTSTRAP",
        actorUserId: null,
        actorEmail: null,
      }),
    });
  });

  it("demotes an admin while another admin remains", async () => {
    findUniqueMock.mockResolvedValue({
      id: "admin-2",
      email: "other@example.com",
      role: "ADMIN",
    });
    countMock.mockResolvedValue(2);

    await expect(
      setUserRole({ userId: "admin-2", role: "USER", actor: ADMIN_ACTOR }),
    ).resolves.toBe("updated");

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "admin-2" },
      data: { role: "USER" },
    });
  });

  // Losing the last admin locks every admin surface, so this is refused even
  // though the caller is an admin and the request is well-formed.
  it("refuses to demote the last remaining admin", async () => {
    findUniqueMock.mockResolvedValue({
      id: "admin-1",
      email: "admin@example.com",
      role: "ADMIN",
    });
    countMock.mockResolvedValue(1);

    await expect(
      setUserRole({ userId: "admin-1", role: "USER", actor: ADMIN_ACTOR }),
    ).resolves.toBe("last_admin");

    expect(updateMock).not.toHaveBeenCalled();
    expect(createRoleChangeMock).not.toHaveBeenCalled();
  });

  it("refuses a self-demotion by the last admin too", async () => {
    findUniqueMock.mockResolvedValue({
      id: "admin-1",
      email: "admin@example.com",
      role: "ADMIN",
    });
    countMock.mockResolvedValue(1);

    await expect(
      setUserRole({ userId: "admin-1", role: "USER", actor: ADMIN_ACTOR }),
    ).resolves.toBe("last_admin");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports an unknown user without writing anything", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(
      setUserRole({ userId: "ghost", role: "ADMIN", actor: ADMIN_ACTOR }),
    ).resolves.toBe("user_not_found");

    expect(updateMock).not.toHaveBeenCalled();
    expect(createRoleChangeMock).not.toHaveBeenCalled();
  });

  it("writes no audit row when the role already matches", async () => {
    findUniqueMock.mockResolvedValue({
      id: "admin-2",
      email: "other@example.com",
      role: "ADMIN",
    });

    await expect(
      setUserRole({ userId: "admin-2", role: "ADMIN", actor: ADMIN_ACTOR }),
    ).resolves.toBe("unchanged");

    expect(countMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(createRoleChangeMock).not.toHaveBeenCalled();
  });
});
