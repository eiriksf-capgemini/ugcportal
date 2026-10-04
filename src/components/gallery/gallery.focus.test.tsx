// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Gallery } from "@/components/gallery/gallery";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * Keyboard focus through "Load more" and at the end of the list
 * (ugcportal-jx4, deferred from ugcportal-71y's round-6 cap).
 *
 * Two separate ways the control used to drop focus to <body>, and what each
 * half of this file can actually prove about them in jsdom (pinned ^26, see
 * gallery.unmount.test.tsx):
 *
 * 1. `disabled={loadState === "loading"}` put the real DOM `disabled`
 *    attribute on the button the instant a click handler set `loadState` to
 *    "loading" — and per spec a disabled form control cannot hold focus, so
 *    a real browser blurs it to <body>. jsdom does NOT implement that
 *    reactive "unfocusing steps" blur (confirmed directly: setting
 *    `.disabled = true` on an already-focused element, including through a
 *    React re-render, leaves `document.activeElement` untouched here), so a
 *    bare `document.activeElement` assertion around the click cannot tell
 *    the fixed and the broken version apart — it would pass either way.
 *
 *    A second route was tried and rejected for the same reason: blurring and
 *    re-`.focus()`-ing the button to use jsdom's (accurate)
 *    disabled-form-control focusability gate. It does not discriminate
 *    either, because `@base-ui/react`'s `Button` always stamps an explicit
 *    `tabindex="0"` attribute on the element regardless of `disabled` state,
 *    and jsdom's `isFocusableAreaElement` treats any explicit `tabindex` as
 *    focusable outright, checked BEFORE it ever looks at `disabled` —
 *    confirmed by instrumenting the real mutation below and watching that
 *    check pass unchanged with the fix reverted.
 *
 *    So the assertion actually doing the work here is a DOM-structural one:
 *    the button must carry no native `disabled` attribute during loading,
 *    only `aria-disabled`/`aria-busy`. That is what a reverted fix changes,
 *    and it is confirmed to fail under that reversion (see the PR body's
 *    mutation log). The plain `document.activeElement` checks alongside it
 *    are kept as the literal assertion K4 asks for and as a sanity net for a
 *    DIFFERENT regression (something explicitly calling `.blur()` or moving
 *    focus elsewhere) — they are not claimed as proof of K1 on their own.
 * 2. `{hasMore ? <Button/> : null}` unmounts the focused element outright on
 *    the last page, and jsdom DOES reproduce a real browser here: removing
 *    the focused element from the DOM moves focus to <body> with no help
 *    needed from this test file (confirmed directly, the same way). So the
 *    second describe block's `document.activeElement` assertions are
 *    genuinely load-bearing, unlike the first block's.
 */

const ITEMS = toGalleryItems([
  { id: "one", previewId: "pv-one", publishedAt: "2026-03-01T00:00:00.000Z" },
  { id: "two", previewId: "pv-two", publishedAt: "2026-03-02T00:00:00.000Z" },
]);

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <Gallery initialItems={ITEMS} initialCursor="cursor-1" initialHasMore={true} />,
    );
  });
}

/**
 * The paging control, distinguished from a gallery TILE — both are
 * `<button>` elements, and `container.querySelector("button")` alone would
 * silently match whichever comes first in document order.
 */
function loadMoreButtonOrNull(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (candidate) => !candidate.hasAttribute("data-gallery-tile"),
    ) ?? null
  );
}

function loadMoreButton(): HTMLButtonElement {
  const button = loadMoreButtonOrNull();
  expect(button, "expected a Load more / Try again button to be rendered").not.toBeNull();
  return button as HTMLButtonElement;
}

/** The polite paging status line — the K2 focus target. */
function pagingStatus(): HTMLParagraphElement {
  const status = container.querySelector('p[aria-live="polite"]');
  expect(status).not.toBeNull();
  return status as HTMLParagraphElement;
}

/**
 * Waits for a condition, the same labelled-timeout helper
 * gallery.unmount.test.tsx uses for the same reason: the behaviour under test
 * resolves through a chain of promises and React effects this test does not
 * control directly, so polling inside `act` is what lets them all flush.
 */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function click(button: HTMLButtonElement): Promise<void> {
  return act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("K1/K3 — focus survives activating Load more", () => {
  it("keeps the control a legitimate focus target while its request is in flight", async () => {
    // Never resolves: this test only cares about the state while loading.
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    await mount();
    const button = loadMoreButton();
    button.focus();
    expect(document.activeElement).toBe(button);

    await click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The load-bearing claim (see the file header for why this, and not a
    // bare `document.activeElement` check, is what actually distinguishes
    // the fix from the bug in jsdom): no native `disabled` attribute during
    // loading, only the ARIA state. This is what a reverted fix gets wrong —
    // confirmed by actually reverting it (PR body's mutation log).
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");

    // K4's literal assertion, and a sanity net against a different
    // regression (something explicitly moving focus away) — not, on its
    // own, proof of K1 in this environment; see the file header.
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("does not let a second activation while busy issue a second request", async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    await mount();
    const button = loadMoreButton();

    await click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The same control, now visibly busy (`aria-busy`/`aria-disabled`
    // asserted above) — a second click must not fire a second request.
    await click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("K2 — focus at the end of the list", () => {
  it("moves focus to the paging status, never to <body>, once the last page removes the button", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mount();
    const button = loadMoreButton();
    button.focus();
    expect(document.activeElement).toBe(button);

    await click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const finalPage = {
      items: [
        { id: "three", previewId: "pv-three", publishedAt: "2026-03-03T00:00:00.000Z" },
      ],
      hasMore: false,
      nextCursor: null,
    };
    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 200,
        json: async () => finalPage,
      });
    });

    await waitUntil(
      () => loadMoreButtonOrNull() === null,
      "the Load more button to be removed after the last page",
    );

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(pagingStatus());
  });

  it("does not move focus anywhere when there is more to load", async () => {
    // Guards the guard: a fix that moved focus to the status line on EVERY
    // completed page, not just the last one, would still look right to a
    // reader of the K2 test above but would steal focus from a visitor who
    // is about to click Load more again.
    const page = {
      items: [
        { id: "three", previewId: "pv-three", publishedAt: "2026-03-03T00:00:00.000Z" },
      ],
      hasMore: true,
      nextCursor: "cursor-2",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => page,
    });
    vi.stubGlobal("fetch", fetchMock);

    await mount();
    const button = loadMoreButton();
    button.focus();

    await click(button);
    await waitUntil(
      () => button.getAttribute("aria-busy") === "false",
      "the request to finish",
    );

    expect(loadMoreButtonOrNull()).not.toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
