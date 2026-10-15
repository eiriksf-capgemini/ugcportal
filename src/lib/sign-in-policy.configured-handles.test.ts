import { afterEach, describe, expect, it, vi } from "vitest";

import * as UsersModule from "@/config/users";
import { CONFIGURED_USERS } from "@/config/users";
import {
  CURRENT_CONFIGURED_HANDLES,
  configuredUserHandle,
  reviewConfiguredUsers,
} from "@/lib/sign-in-policy";
import {
  FIXTURE_CONFIGURED_HANDLE,
  FIXTURE_CONFIGURED_NAME,
  FORMER_CONFIGURED_HANDLE,
  withFixtureConfiguredUser,
} from "@/lib/test-support/fixture-configured-user";

/**
 * ugcportal-lskg K2: the ONE list every reader of the publish-on-upload
 * grant asks (`isConfiguredUser` in src/lib/publish-gates.ts, the Prisma arm
 * in src/lib/publishability.ts). It is the CHECKED array's handles —
 * `reviewConfiguredUsers().sound`, the list sign-in and linking use — not
 * the raw array's (PR #251 round 1, M1).
 *
 * The first cases read the REAL array, with no mock of `@/config/users`
 * (unlike src/lib/sign-in-policy.test.ts); the cases that need a different
 * array load a fresh copy of the module under `vi.doMock`, so they cannot
 * leak into the real-array cases.
 */
const checkedHandles = (users: readonly UsersModule.ConfiguredUser[]) =>
  reviewConfiguredUsers(users)
    .sound.map(configuredUserHandle)
    .filter((handle): handle is string => handle !== null);

describe("CURRENT_CONFIGURED_HANDLES (ugcportal-lskg K2)", () => {
  afterEach(() => {
    vi.doUnmock("@/config/users");
    vi.resetModules();
  });

  it("equals the checked array's handles, on the real array", () => {
    // Non-empty first: two empty lists would agree about nothing.
    expect(CONFIGURED_USERS.length).toBeGreaterThan(0);
    expect(CURRENT_CONFIGURED_HANDLES.length).toBeGreaterThan(0);
    expect(CURRENT_CONFIGURED_HANDLES).toEqual(checkedHandles(CONFIGURED_USERS));
  });

  it("is frozen, so no caller can add a handle to the shared list", () => {
    expect(Object.isFrozen(CURRENT_CONFIGURED_HANDLES)).toBe(true);
  });

  it("leaves out a person the boot check drops, though the raw array still lists them (K1, K2)", async () => {
    vi.resetModules();
    vi.doMock("@/config/users", async (importOriginal) => {
      const actual = await importOriginal<typeof UsersModule>();
      return {
        ...actual,
        CONFIGURED_USERS: [
          ...actual.CONFIGURED_USERS,
          { name: "Dropped Person", identities: [] },
        ],
      };
    });
    const fresh = await import("@/lib/sign-in-policy");
    const { CONFIGURED_USERS: freshUsers } = await import("@/config/users");

    // The mock took: the raw array lists the person and derives the handle.
    const raw = freshUsers.map(fresh.configuredUserHandle);
    expect(raw).toContain("dropped-person");
    // The review drops them (no identities), and says so.
    expect(fresh.reviewConfiguredUsers().problems.length).toBeGreaterThan(0);

    expect(fresh.CURRENT_CONFIGURED_HANDLES).toEqual(checkedHandles(freshUsers));
    expect(fresh.CURRENT_CONFIGURED_HANDLES).not.toContain("dropped-person");
    expect(fresh.CURRENT_CONFIGURED_HANDLES).not.toEqual(raw);
    // Everybody the review keeps is still there (K3).
    for (const handle of checkedHandles(CONFIGURED_USERS)) {
      expect(fresh.CURRENT_CONFIGURED_HANDLES).toContain(handle);
    }
  });

  it("leaves out a name that yields no handle", async () => {
    vi.resetModules();
    vi.doMock("@/config/users", () => ({
      CONFIGURED_USERS: [
        { name: "Ada", identities: ["google:ada@example.com"] },
        { name: "!!!", identities: ["google:bang@example.com"] },
      ],
    }));
    const fresh = await import("@/lib/sign-in-policy");
    expect(fresh.configuredUserHandle({ name: "!!!", identities: [] })).toBeNull();
    expect(fresh.CURRENT_CONFIGURED_HANDLES).toEqual(["ada"]);
  });

  it("the test fixtures mean what their names say", () => {
    // src/lib/test-support/fixture-configured-user.ts appends a person to
    // the array in the ho7j/lskg suites. If the handle that name derives
    // drifted from the constant, or the review dropped the fixture person
    // (no identity, or one that collides with a real entry), those suites'
    // configured rows would silently stop being configured.
    expect(
      configuredUserHandle({ name: FIXTURE_CONFIGURED_NAME, identities: [] }),
    ).toBe(FIXTURE_CONFIGURED_HANDLE);
    const withFixture = withFixtureConfiguredUser(UsersModule).CONFIGURED_USERS;
    expect(reviewConfiguredUsers(withFixture).problems).toEqual([]);
    expect(checkedHandles(withFixture)).toEqual([
      ...checkedHandles(CONFIGURED_USERS),
      FIXTURE_CONFIGURED_HANDLE,
    ]);
    expect(CURRENT_CONFIGURED_HANDLES).not.toContain(FIXTURE_CONFIGURED_HANDLE);
    expect(CURRENT_CONFIGURED_HANDLES).not.toContain(FORMER_CONFIGURED_HANDLE);
  });
});
