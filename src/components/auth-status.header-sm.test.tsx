// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cn } from "cn";

import { buttonVariants } from "@/components/ui/button";

/**
 * ugcportal-6wkd: nothing CI-wired ever rendered AuthStatus and asserted its
 * controls actually resolve to `buttonVariants({ size: "header-sm" })`
 * output — only e2e/front-page.spec.ts's K1/K2 test did, and that header's
 * own comment says "Not wired into CI" (deferred from PR #122 /
 * ugcportal-qqnt.2 round 3, low, confirmed by grep: button-system.test.tsx
 * has no reference to AuthStatus or "header-sm" anywhere). A future edit
 * reverting any of these three controls' `size="header-sm"` back to
 * `size="sm"` — the two look interchangeable at a glance, same box model,
 * same padding, same icon sizing (button.tsx's own SM_BOX_MODEL /
 * SM_PADDING_AND_TEXT / SM_ICON_SIZING constants) — would pass the full
 * committed vitest suite while silently shrinking the header's radius back
 * under `sm`'s own cap.
 *
 * THREE controls, not one (re-read after PR #171/b4e5e7b turned the old
 * two-always-visible-button layout into SignInMenu's single "Sign in"
 * disclosure): the trigger button SignInMenu renders
 * (src/components/sign-in-menu.tsx), the two provider buttons it discloses
 * behind that trigger ("Google"/"Facebook"), and the signed-in "Sign out"
 * button auth-status.tsx renders directly. All three call sites pass
 * `variant="outline" size="header-sm"` today, so all three are pinned here
 * — the bead's own wording lists this as one of the open questions a
 * future reader would otherwise have to re-derive from the two source
 * files by hand.
 *
 * jsdom, not the default `node` environment, for the same reason
 * auth-status.test.tsx's own top comment gives: the signed-out provider
 * buttons only mount once SignInMenu's `@base-ui/react/popover` is actually
 * opened, which needs a real DOM and a real client root (`createRoot` +
 * `act`), not `renderToStaticMarkup`.
 */
const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { AuthStatus } = await import("./auth-status");

/**
 * Exactly what Button (src/components/ui/button.tsx) itself computes for a
 * `variant="outline" size="header-sm"` call — `cn(buttonVariants({
 * variant, size, className }))`, the same expression the bead's own
 * wording names as the arbiter, not a hand-copied string a reader has to
 * trust matches the real implementation.
 */
function expectedHeaderSmOutlineClass(extraClassName?: string): string {
  return cn(
    buttonVariants({ variant: "outline", size: "header-sm", className: extraClassName }),
  );
}

/**
 * The one thing that actually distinguishes `header-sm` from `sm` (see
 * button.tsx's own `size` comment): `header-sm` has no radius cap, so it
 * falls through to the base class's `rounded-lg` (`--radius-lg`, 10px);
 * `sm` carries its own `rounded-[min(var(--radius-md),12px)]` cap, which
 * `cn()`'s tailwind-merge dedup drops `rounded-lg` in favour of. Asserted
 * both ways (exact equality against the real `buttonVariants` output above,
 * and this pair of token-level checks) so a reader can see WHY a control
 * passes or fails, not only THAT it does.
 */
function expectHeaderSmRadius(classList: string): void {
  expect(classList.split(/\s+/)).toContain("rounded-lg");
  expect(classList).not.toMatch(/rounded-\[min\(var\(--radius-md\)/);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  getSessionMock.mockReset();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * `document`, not `container`: SignInMenu's disclosed panel renders through
 * `Popover.Portal` (src/components/sign-in-menu.tsx's own comment), so the
 * Google/Facebook buttons mount outside `container` once opened — the same
 * reason auth-status.test.tsx's own K2 test queries `document` for them
 * rather than the render container.
 */
function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button, `no <button> with text "${text}" found`).not.toBeUndefined();
  return button as HTMLButtonElement;
}

describe("AuthStatus controls pin header-sm (ugcportal-6wkd)", () => {
  it("the signed-out Sign in trigger carries exactly cn(buttonVariants({ variant: \"outline\", size: \"header-sm\" }))", async () => {
    getSessionMock.mockResolvedValue(null);
    const element = await AuthStatus();

    act(() => {
      root.render(element);
    });

    const trigger = buttonWithText("Sign in");
    expect(trigger.className).toBe(expectedHeaderSmOutlineClass());
    expectHeaderSmRadius(trigger.className);
  });

  it("both disclosed provider buttons carry exactly cn(buttonVariants({ variant: \"outline\", size: \"header-sm\", className: \"w-full\" }))", async () => {
    getSessionMock.mockResolvedValue(null);
    const element = await AuthStatus();

    act(() => {
      root.render(element);
    });

    act(() => {
      buttonWithText("Sign in").click();
    });
    await flush();

    const expected = expectedHeaderSmOutlineClass("w-full");

    const google = buttonWithText("Google");
    expect(google.className).toBe(expected);
    expectHeaderSmRadius(google.className);

    const facebook = buttonWithText("Facebook");
    expect(facebook.className).toBe(expected);
    expectHeaderSmRadius(facebook.className);
  });

  it("the signed-in Sign out button carries exactly cn(buttonVariants({ variant: \"outline\", size: \"header-sm\" }))", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });
    const element = await AuthStatus();

    act(() => {
      root.render(element);
    });

    const signOut = buttonWithText("Sign out");
    expect(signOut.className).toBe(expectedHeaderSmOutlineClass());
    expectHeaderSmRadius(signOut.className);
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): proves the radius
   * checks above can actually fail, against the REAL `sm` output (not a
   * hand-copied decoy string) — `sm`'s own cap drops the base class's
   * `rounded-lg` in favour of `rounded-[min(var(--radius-md),12px)]`, which
   * is exactly what reverting any one of the three controls above from
   * `size="header-sm"` back to `size="sm"` would silently reintroduce.
   *
   * Also hand-verified against the real component, not only this fixture:
   * temporarily changed auth-status.tsx's Sign out button from
   * `size="header-sm"` to `size="sm"` and re-ran this file —
   * `expect(signOut.className).toBe(expectedHeaderSmOutlineClass())` failed
   * with the actual rendered class list containing
   * `rounded-[min(var(--radius-md),12px)]` where `rounded-lg` belongs
   * (`expected "…rounded-[min(var(--radius-md)…" to be "…rounded-lg…"`,
   * two visibly different strings at the diff). Reverted immediately after.
   */
  it("the radius checks above fail against the real sm output, not only header-sm", () => {
    const smClass = cn(buttonVariants({ variant: "outline", size: "sm" }));

    expect(() => expectHeaderSmRadius(smClass)).toThrow();
    expect(smClass).not.toBe(expectedHeaderSmOutlineClass());
  });
});
