import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ugcportal-t0y round 3 finding 1: UploadNavLink and AuthStatus each read
 * the session independently, and before this test existed they hand-spelled
 * two DIFFERENT expressions for "signed in" — `session?.user?.id` in one,
 * `session?.user` in the other. For a session shaped like `{ user: { email
 * } }` (a user object with no id — the same fixture src/app/upload/
 * page.test.tsx's own K5 suite uses to prove the page's own gate requires
 * an id), the two disagreed: AuthStatus rendered "Sign out", while
 * UploadNavLink rendered nothing, so a visitor who looked signed in had no
 * in-app route to /upload at all.
 *
 * Both now call the same `hasSignedInUser` (src/lib/session.ts). This test
 * exists to keep it that way — not by re-reading either component's
 * internals, but by asserting the externally-observable agreement directly,
 * for every session shape either component's own test suite already treats
 * as a boundary case. A regression that reintroduced two different
 * expressions (rather than removing the shared predicate) would fail here
 * even if each component's own test suite, tested in isolation, still
 * passed - the earlier finding shipped with test suites for each of these
 * two files that were individually green.
 */
const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { UploadNavLink } = await import("./upload-nav-link");
const { AuthStatus } = await import("./auth-status");

async function isNavLinkShown(): Promise<boolean> {
  return (await UploadNavLink()) !== null;
}

async function isAuthStatusSignedIn(): Promise<boolean> {
  const markup = renderToStaticMarkup(await AuthStatus());
  return markup.includes("Sign out");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UploadNavLink and AuthStatus agree on 'signed in' (ugcportal-t0y round 3)", () => {
  const cases: Array<[string, unknown]> = [
    ["no session", null],
    [
      // THE FIXTURE THIS FINDING IS ABOUT. Round 3 shipped with the two
      // components disagreeing on exactly this shape.
      "a user with no id",
      { user: { email: "someone@example.com" } },
    ],
    ["a session with no user at all", { expires: "2026-12-01T00:00:00.000Z" }],
    ["a fully signed-in user", { user: { id: "user-1", email: "someone@example.com", role: "USER" } }],
  ];

  for (const [label, session] of cases) {
    it(`both agree on "${label}"`, async () => {
      getSessionMock.mockResolvedValue(session);

      const navShown = await isNavLinkShown();
      const authSignedIn = await isAuthStatusSignedIn();

      expect(navShown).toBe(authSignedIn);
    });
  }
});
