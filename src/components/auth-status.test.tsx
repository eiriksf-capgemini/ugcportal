// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/design/scan-source";

/**
 * ugcportal-t0y round 1 low finding: nothing anywhere asserted on
 * AuthStatus's actual signed-in/signed-out content before this file existed
 * (`grep -rn "auth-status" src` hit only app-shell.tsx), so a session
 * regression that served every signed-in visitor the sign-in buttons, or
 * never offered "Sign out" to anyone, would have shipped green.
 *
 * `jsdom`, not the default `node` environment (ugcportal-qqnt.3): the
 * signed-out control is now `SignInMenu` (src/components/sign-in-menu.tsx),
 * a Client Component whose two provider forms only mount once its
 * `@base-ui/react/popover` is actually opened - the same "nothing exists
 * while closed" shape src/components/mobile-nav-toggle.tsx's own Popover
 * already has, confirmed there by mobile-nav-toggle.test.tsx's "panel is not
 * in the DOM" test. Proving K2 ("both provider forms exist behind the
 * control") needs a real DOM and a real client root to actually open it,
 * which `renderToStaticMarkup` alone cannot do - the static-markup tests
 * below stay on `renderToStaticMarkup` for the CLOSED-state assertions,
 * which do not need one.
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

/**
 * ugcportal-8df3 round-1 review, finding 3: the rejection test below
 * (`vi.spyOn(console, "error")`, `getSessionMock.mockRejectedValue(...)`)
 * is never otherwise undone. `vi.clearAllMocks()` in `beforeEach` above only
 * clears call history — not a spy's restored implementation, nor a mock's
 * configured resolved/rejected value — so without this, a leftover
 * console.error spy or a still-rejecting `getSessionMock` could silently
 * leak into whichever test runs after it. Harmless today only because that
 * test happens to be last in this file; the same anti-pattern src/app/
 * page.error.test.tsx's own top comment warns about by name for a different
 * mock. `vi.restoreAllMocks()` undoes the spy; `getSessionMock.mockReset()`
 * is explicit (not left to restoreAllMocks' documented but easy-to-miss
 * fallback behaviour for a plain `vi.fn()`) so a reader does not have to
 * know that nuance to see this mock is clean between tests.
 */
afterEach(() => {
  vi.restoreAllMocks();
  getSessionMock.mockReset();
});

describe("AuthStatus (ugcportal-t0y)", () => {
  it("shows Sign out and the signed-in user's email, and no sign-in offer", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderStatus();

    expect(markup).toContain("Sign out");
    expect(markup).toContain("someone@example.com");
    expect(markup).not.toContain("Sign in");
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

  /**
   * K1 (ugcportal-qqnt.3): exactly one control whose accessible name starts
   * with "Sign in" - the `SignInMenu` trigger - not two always-visible
   * provider buttons. The CLOSED trigger's own static markup contains
   * neither provider's name: `SignInMenu`'s `Popover.Popup` (and the two
   * provider forms inside it) does not mount at all until the popover opens
   * - see this file's own top comment. "Google"/"Facebook" reachability is
   * covered by the interactive test below instead.
   */
  it("offers a single Sign in control for a signed-out visitor, and no Sign out", async () => {
    getSessionMock.mockResolvedValue(null);

    const markup = await renderStatus();

    expect(markup).toContain(">Sign in<");
    expect(markup).not.toContain("Sign out");
    expect([...markup.matchAll(/<button\b/g)]).toHaveLength(1);
  });

  /**
   * K2's "a vitest render asserting both provider forms exist behind the
   * control": mounts the real, awaited `AuthStatus()` tree into a real DOM
   * (the same `createRoot` + `act()` shape mobile-nav-toggle.test.tsx uses
   * for its own Popover-backed disclosure), clicks the "Sign in" trigger,
   * and checks both provider forms are now present - each still a `<form>`
   * wrapping its own submit button, exactly the shape `auth-status.tsx`
   * always rendered, just disclosed rather than always-visible (K3: neither
   * provider button is removed).
   */
  describe("K2: the Sign in control discloses both providers", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      (
        globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });

    async function flush(): Promise<void> {
      await act(async () => {
        await Promise.resolve();
      });
    }

    it("reveals a Google form and a Facebook form once activated", async () => {
      getSessionMock.mockResolvedValue(null);
      const element = await AuthStatus();

      act(() => {
        root.render(element);
      });

      const trigger = container.querySelector("button");
      expect(trigger, "Sign in trigger not found").not.toBeNull();
      expect(trigger?.textContent).toContain("Sign in");

      act(() => {
        trigger?.click();
      });
      await flush();

      const googleButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Google",
      );
      const facebookButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Facebook",
      );

      expect(googleButton, "Google button not revealed").not.toBeUndefined();
      expect(facebookButton, "Facebook button not revealed").not.toBeUndefined();
      expect(googleButton?.closest("form"), "Google button is not inside a form").not.toBeNull();
      expect(
        facebookButton?.closest("form"),
        "Facebook button is not inside a form",
      ).not.toBeNull();
    });
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): proves the single-
   * control count above can actually fail, by running the same assertion
   * against a fixture markup string shaped like the OLD two-button layout.
   */
  it("the single sign-in-button count above fails against the old two-button layout", () => {
    const twoButtonFixture =
      '<div><button class="border-primary bg-transparent">Google</button>' +
      '<button class="border-primary bg-transparent">Facebook</button></div>';

    expect(() => {
      expect([...twoButtonFixture.matchAll(/<button\b/g)]).toHaveLength(1);
    }).toThrow();
  });

  /**
   * ugcportal-14k9 K3 (sign-in controls not more prominent than the content),
   * carried forward by ugcportal-qqnt.3: checked at the attribute level, on
   * the actual sign-in `<button>` element specifically - not
   * `expect(markup).toContain("outline")`-shaped, which the review-standards
   * family-3 sweep calls out by name (`src/app/upload/upload-flow.test.tsx`'s
   * own `disabled:` footgun is the same shape: every `Button` ships a class
   * list that could contain a loose needle regardless of which variant
   * actually rendered). `border-primary bg-transparent` is button.tsx's own
   * `PETROL_OUTLINE_STYLE`, applied only by the `outline`/`secondary`
   * variants; the `default` variant's solid fill is `bg-primary
   * text-primary-foreground` instead, and the two are mutually exclusive on
   * any one button, so this checks for the first and the explicit absence of
   * the second.
   */
  it("K3: the Sign in control is the outline variant, not the solid primary fill", async () => {
    getSessionMock.mockResolvedValue(null);

    const markup = await renderStatus();
    const buttons = [...markup.matchAll(/<button[^>]*class="([^"]*)"[^>]*>/g)];

    expect(buttons.length, "expected exactly one Sign in button").toBe(1);
    const [, classList] = buttons[0];
    expect(classList).toContain("border-primary");
    expect(classList).toContain("bg-transparent");
    expect(classList).not.toContain("bg-primary text-primary-foreground");
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

    expect(markup).toContain(">Sign in<");
    expect(markup).not.toContain("Sign out");
    expect(consoleError).toHaveBeenCalledOnce();
  });
});

/**
 * K3: "Following should never happen: ... any provider button is removed
 * rather than relocated." `SignInMenu` only ever renders the two forms a
 * PARENT hands it as props (src/components/sign-in-menu.tsx) - it is this
 * file, `auth-status.tsx`, that still owns both `signIn("google")` and
 * `signIn("facebook")` calls. Scans the REAL file on disk, comments
 * stripped first (`stripComments`, the same technique site-header.height.
 * test.ts and several other source-scan tests in this repo use) so a mere
 * mention of either call in a comment - this very file's own docstring
 * includes one - cannot make this pass while the real call is gone.
 */
describe("auth-status.tsx source scan (ugcportal-qqnt.3 K3)", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const AUTH_STATUS_PATH = path.join(HERE, "auth-status.tsx");

  function sourceWithoutComments(): string {
    return stripComments(readFileSync(AUTH_STATUS_PATH, "utf8"), AUTH_STATUS_PATH);
  }

  it('still calls signIn("google") and signIn("facebook") directly', () => {
    const source = sourceWithoutComments();

    expect(source).toMatch(/signIn\(\s*["']google["']\s*\)/);
    expect(source).toMatch(/signIn\(\s*["']facebook["']\s*\)/);
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): confirms the check
   * above can fail, against a fixture with only one of the two providers.
   */
  it("the check above fails if a provider call is missing", () => {
    const missingFacebook = 'await signIn("google");';

    expect(missingFacebook).toMatch(/signIn\(\s*["']google["']\s*\)/);
    expect(() => {
      expect(missingFacebook).toMatch(/signIn\(\s*["']facebook["']\s*\)/);
    }).toThrow();
  });
});
