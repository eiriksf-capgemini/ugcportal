import { describe, expect, it } from "vitest";

import { hasSignedInUser } from "./session";

/**
 * ugcportal-t0y round 3 finding 1: this is the one predicate
 * src/components/upload-nav-link.tsx and src/components/auth-status.tsx
 * both now call, replacing two hand-spelled expressions that used to
 * disagree. Direct unit coverage here, in addition to the two components'
 * own tests and src/components/header-session-agreement.test.tsx's
 * cross-component check, so a regression in the predicate itself is
 * pinned to this file rather than only inferred from two other suites.
 */
describe("hasSignedInUser", () => {
  it("is true for a session with a user id", () => {
    expect(
      hasSignedInUser({
        user: { id: "user-1", email: "someone@example.com" },
      } as never),
    ).toBe(true);
  });

  it("is false for null", () => {
    expect(hasSignedInUser(null)).toBe(false);
  });

  it("is false for a session with no user at all", () => {
    expect(hasSignedInUser({ expires: "2026-12-01T00:00:00.000Z" } as never)).toBe(
      false,
    );
  });

  it("is false for a user with no id", () => {
    // THE FIXTURE MUTATION this predicate exists for: a user object without
    // an id is exactly the shape the two header components used to
    // disagree about (round 3 finding 1).
    expect(
      hasSignedInUser({ user: { email: "someone@example.com" } } as never),
    ).toBe(false);
  });
});
