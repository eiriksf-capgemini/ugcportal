import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A BROKEN users array, so that `register()` — the real boot hook — can be
 * shown to actually print what `checkConfiguredUsers` finds (ugcportal-t33p,
 * scope item 5).
 *
 * Its own file, not another describe in src/instrumentation.test.ts: the
 * array is a module-level constant, so a test needing a different one needs
 * a different module registry. Mutating a shared fixture in place would also
 * leave `permittedIdentities` — which memoises on the array's identity —
 * holding a parse of data that no longer exists.
 *
 * The one thing being asserted is the WIRING. What counts as a problem is
 * tested in src/lib/configured-users.test.ts, and the boot check's own shape
 * in src/instrumentation.test.ts; the failure this file exists for is the
 * check being written and never called, which neither of those can see.
 */
vi.mock("@/config/users", () => ({
  CONFIGURED_USERS: [
    { name: "Ada", identities: ["google:shared@example.com"] },
    { name: "Grace", identities: ["google:shared@example.com"] },
    { name: "Nobody", identities: [] },
  ],
}));

const { register } = await import("@/instrumentation");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("register() reports the users array's problems at boot", () => {
  it("prints one line per problem", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await register();

    const lines = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("Configured user") || line.includes("identity"));

    // TWO lines, not one: the check answers with a list because these are
    // independent problems with independent fixes, and an implementation
    // that folded them into a single console call would fail this length.
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("google:shared@example.com");
    expect(lines.join("\n")).toContain("has no identities");
  });
});
