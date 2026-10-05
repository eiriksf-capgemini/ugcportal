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

  /**
   * ugcportal-14k9 K3: "sign-in controls not more prominent than the
   * content or the tagline". Checked at the attribute level, on the actual
   * sign-in `<button>` elements specifically — not
   * `expect(markup).toContain("outline")`-shaped, which the review-standards
   * family-3 sweep calls out by name (`src/app/upload/upload-flow.test.tsx`'s
   * own `disabled:` footgun is the same shape: every `Button` ships a class
   * list that could contain a loose needle regardless of which variant
   * actually rendered). `border-primary bg-transparent` is button.tsx's own
   * `PETROL_OUTLINE_STYLE`, applied only by the `outline`/`secondary`
   * variants; the `default` variant's solid fill is `bg-primary
   * text-primary-foreground` instead, and the two are mutually exclusive on
   * any one button, so this checks for the first and the explicit absence of
   * the second on each sign-in `<button>` in turn — not merely elsewhere in
   * the markup.
   */
  it("K3: the sign-in buttons are the outline variant, not the solid primary fill", async () => {
    getSessionMock.mockResolvedValue(null);

    const markup = await renderStatus();
    const buttons = [...markup.matchAll(/<button[^>]*class="([^"]*)"[^>]*>/g)];

    expect(buttons.length, "expected two sign-in buttons").toBe(2);
    for (const [, classList] of buttons) {
      expect(classList).toContain("border-primary");
      expect(classList).toContain("bg-transparent");
      expect(classList).not.toContain("bg-primary text-primary-foreground");
    }
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): proves the K3 check
   * above can fail, by running its own assertions against a fixture class
   * list shaped like the `default` (solid) variant instead of `outline`.
   */
  it("the K3 outline-variant check above fails against a solid-fill button", () => {
    const solidFillClassList =
      "group/button inline-flex ... bg-primary text-primary-foreground hover:bg-primary-hover";

    expect(() => {
      expect(solidFillClassList).toContain("border-primary");
    }).toThrow();
    expect(() => {
      expect(solidFillClassList).not.toContain("bg-primary text-primary-foreground");
    }).toThrow();
  });

  /**
   * ugcportal-8df3: AuthStatus reads the session through the shared
   * fail-safe (src/lib/session-or-anonymous.ts), not `getSession()`
   * directly — so a rejected read degrades to the signed-out markup
   * instead of crashing this component (and, with it, every page it is
   * rendered on; see src/components/site-header.tsx). This file mocks
   * `@/lib/auth`, not the fail-safe module itself, so the real
   * `resolveSessionOrAnonymous` runs here.
   *
   * THE FIXTURE MUTATION: remove the `try`/`catch` from
   * src/lib/session-or-anonymous.ts (or swap this component back to a bare
   * `await getSession()`) and this test fails — `renderStatus()` rejects
   * instead of resolving to the signed-out markup.
   */
  it("falls back to the signed-out markup when the session read fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getSessionMock.mockRejectedValue(new Error("getSession() failed (simulated)"));

    const markup = await renderStatus();

    expect(markup).toContain("Google");
    expect(markup).toContain("Facebook");
    expect(markup).not.toContain("Sign out");
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
