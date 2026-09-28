import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ugcportal-t0y round 1 low finding: nothing anywhere asserted on
 * AuthStatus's actual signed-in/signed-out content before this file existed
 * (`grep -rn "auth-status" src` hit only app-shell.tsx), so a session
 * regression that served every signed-in visitor the sign-in buttons, or
 * never offered "Sign out" to anyone, would have shipped green.
 */
const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { AuthStatus } = await import("./auth-status");

async function renderStatus(): Promise<string> {
  return renderToStaticMarkup(await AuthStatus());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AuthStatus (ugcportal-t0y)", () => {
  it("shows Sign out and the signed-in user's email, and no sign-in offer", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderStatus();

    expect(markup).toContain("Sign out");
    expect(markup).toContain("someone@example.com");
    expect(markup).not.toContain("Sign in with");
  });

  it("prefers the user's name over their email when both are present", async () => {
    getSessionMock.mockResolvedValue({
      user: {
        id: "user-1",
        name: "Jamie Uploader",
        email: "someone@example.com",
        role: "USER",
      },
    });

    const markup = await renderStatus();

    expect(markup).toContain("Jamie Uploader");
    expect(markup).not.toContain("someone@example.com");
  });

  it("offers Google and Facebook sign-in for a signed-out visitor, and no Sign out", async () => {
    getSessionMock.mockResolvedValue(null);

    const markup = await renderStatus();

    expect(markup).toContain("Google");
    expect(markup).toContain("Facebook");
    expect(markup).not.toContain("Sign out");
  });
});
