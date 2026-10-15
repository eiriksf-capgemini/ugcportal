import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIGURED_USERS } from "@/config/users";
import {
  CURRENT_CONFIGURED_HANDLES,
  configuredUserHandle,
} from "@/lib/sign-in-policy";
import {
  FIXTURE_CONFIGURED_HANDLE,
  FIXTURE_CONFIGURED_NAME,
  FORMER_CONFIGURED_HANDLE,
} from "@/lib/test-support/fixture-configured-user";

/**
 * ugcportal-lskg K2: the ONE list every reader of configured-ness asks
 * (`isConfiguredUser` in src/lib/publish-gates.ts, the Prisma arm in
 * src/lib/publishability.ts), checked against the REAL array — no mock of
 * `@/config/users` in this file, unlike src/lib/sign-in-policy.test.ts.
 */
describe("CURRENT_CONFIGURED_HANDLES (ugcportal-lskg K2)", () => {
  afterEach(() => {
    vi.doUnmock("@/config/users");
    vi.resetModules();
  });

  it("equals CONFIGURED_USERS.map(configuredUserHandle)", () => {
    // Non-empty first: two empty lists would agree about nothing.
    expect(CONFIGURED_USERS.length).toBeGreaterThan(0);
    expect(CURRENT_CONFIGURED_HANDLES).toEqual(
      CONFIGURED_USERS.map(configuredUserHandle),
    );
  });

  it("is frozen, so no caller can add a handle to the shared list", () => {
    expect(Object.isFrozen(CURRENT_CONFIGURED_HANDLES)).toBe(true);
  });

  it("drops a name that yields no handle, rather than carrying a null", async () => {
    vi.resetModules();
    vi.doMock("@/config/users", () => ({
      CONFIGURED_USERS: [
        { name: "Ada", identities: [] },
        { name: "!!!", identities: [] },
      ],
    }));
    const fresh = await import("@/lib/sign-in-policy");
    expect(fresh.configuredUserHandle({ name: "!!!", identities: [] })).toBeNull();
    expect(fresh.CURRENT_CONFIGURED_HANDLES).toEqual(["ada"]);
  });

  it("the test fixtures mean what their names say", () => {
    // src/lib/test-support/fixture-configured-user.ts appends a person to
    // the array in the ho7j/lskg suites; if the handle that name derives
    // ever drifted from the constant, those suites' configured rows would
    // silently stop being configured.
    expect(
      configuredUserHandle({ name: FIXTURE_CONFIGURED_NAME, identities: [] }),
    ).toBe(FIXTURE_CONFIGURED_HANDLE);
    expect(CURRENT_CONFIGURED_HANDLES).not.toContain(FIXTURE_CONFIGURED_HANDLE);
    expect(CURRENT_CONFIGURED_HANDLES).not.toContain(FORMER_CONFIGURED_HANDLE);
  });
});
