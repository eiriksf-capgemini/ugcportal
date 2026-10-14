// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cn } from "cn";

import { buttonVariants } from "@/components/ui/button";
import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";

/**
 * ugcportal-6wkd: nothing CI-wired ever rendered AuthStatus and asserted its
 * controls actually resolve to `buttonVariants({ size: "header-sm" })`
 * output — only e2e/front-page.spec.ts's K1/K2 test did, and that header's
 * own comment says "Not wired into CI" (deferred from PR #122 /
 * ugcportal-qqnt.2 round 3, low, confirmed by grep: button-system.test.tsx
 * has no reference to AuthStatus or "header-sm" anywhere). A future edit
 * reverting any of these four controls' `size="header-sm"` back to
 * `size="sm"` — the two look interchangeable at a glance, same box model,
 * same padding, same icon sizing (button.tsx's own SM_BOX_MODEL /
 * SM_PADDING_AND_TEXT / SM_ICON_SIZING constants) — would pass the full
 * committed vitest suite while silently shrinking the header's radius back
 * under `sm`'s own cap.
 *
 * FOUR call sites, not one (re-read after PR #171/b4e5e7b turned the old
 * two-always-visible-button layout into SignInMenu's single "Sign in"
 * disclosure): the trigger button SignInMenu renders
 * (src/components/sign-in-menu.tsx), the two provider buttons it discloses
 * behind that trigger ("Google"/"Facebook"), and the signed-in "Sign out"
 * button auth-status.tsx renders directly. All four call sites pass
 * `variant="outline" size="header-sm"` today, so all four are pinned here
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
   * is exactly what reverting any one of the controls above from
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

/**
 * ugcportal-hhjq K1: the four call sites' rendered class strings as literals.
 * The assertions above compare against `buttonVariants()` itself, so editing
 * `header-sm`'s definition moves both sides of those comparisons together;
 * these literals do not move. If `header-sm` or the base classes
 * change on purpose, update the strings in the same PR.
 */
const HEADER_SM_OUTLINE_LITERAL =
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border bg-clip-padding font-medium whitespace-nowrap transition-all select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent motion-safe:active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive/75 aria-invalid:ring-3 aria-invalid:ring-destructive/80 [&_svg]:pointer-events-none [&_svg]:shrink-0 border-primary bg-transparent text-primary hover:border-primary-hover hover:underline aria-expanded:border-primary-hover aria-expanded:underline h-7 gap-1 px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5";
const SRC_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");
let cachedSourceFiles: string[] | undefined;
const HEADER_SM_OUTLINE_FULL_WIDTH_LITERAL = `${HEADER_SM_OUTLINE_LITERAL} w-full`;

describe("header-sm class output is byte-identical at all four call sites (ugcportal-hhjq K1)", () => {
  it("signed-out Sign in trigger and signed-in Sign out match the literal", async () => {
    getSessionMock.mockResolvedValue(null);
    const element = await AuthStatus();
    act(() => {
      root.render(element);
    });
    expect(buttonWithText("Sign in").className).toBe(HEADER_SM_OUTLINE_LITERAL);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });
    const signedIn = await AuthStatus();
    act(() => {
      root.render(signedIn);
    });
    expect(buttonWithText("Sign out").className).toBe(HEADER_SM_OUTLINE_LITERAL);
  });

  it("both disclosed provider buttons (Google, Facebook) match the full-width literal", async () => {
    getSessionMock.mockResolvedValue(null);
    const element = await AuthStatus();
    act(() => {
      root.render(element);
    });
    act(() => {
      buttonWithText("Sign in").click();
    });
    await flush();
    expect(buttonWithText("Google").className).toBe(HEADER_SM_OUTLINE_FULL_WIDTH_LITERAL);
    expect(buttonWithText("Facebook").className).toBe(HEADER_SM_OUTLINE_FULL_WIDTH_LITERAL);
  });

  it("the literal header-sm occurs exactly five times across non-test sources, in any spelling: the key definition in button.tsx, three call sites in sign-in-menu.tsx, one in auth-status.tsx", () => {
    // Any quoted spelling counts: size="header-sm", size={"header-sm"},
    // buttonVariants({ size: "header-sm" }), a template literal. button.tsx is
    // scanned too and expected to hold exactly one occurrence, the cva key
    // definition, so a caller added inside button.tsx also fails here (round 4
    // of PR #237 showed a path-based exclusion let that through).
    const found: Record<string, number> = {};
    for (const file of (cachedSourceFiles ??= walkSourceFiles(SRC_ROOT, isTestFile))) {
      const n = stripComments(readFileSync(file, "utf8"), file).match(/["'`]header-sm["'`]/g)?.length ?? 0;
      if (n > 0) found[path.relative(REPO_ROOT, file).split(path.sep).join("/")] = n;
    }
    expect(found).toEqual({
      "src/components/auth-status.tsx": 1,
      "src/components/sign-in-menu.tsx": 3,
      "src/components/ui/button.tsx": 1,
    });
  });
});
