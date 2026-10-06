// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  setupGalleryTestRoot,
  renderGallery,
  waitUntil,
  click,
  FINAL_PAGE,
  stubDeferredFetch,
} from "@/components/gallery/gallery.test-support";
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
 *
 * A third concern, added at round-2 review: the K2 handoff must not run
 * unconditionally. If the visitor tabs away to something else entirely
 * while the final page's request is still in flight, the handoff firing
 * anyway would yank focus back to the gallery — exactly the kind of
 * surprise a focus-management fix exists to prevent. The last `describe`
 * block below covers that.
 */

const ITEMS = toGalleryItems([
  { id: "one", previewId: "pv-one", publishedAt: "2026-03-01T00:00:00.000Z" },
  { id: "two", previewId: "pv-two", publishedAt: "2026-03-02T00:00:00.000Z" },
]);

const ctx = setupGalleryTestRoot();

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await renderGallery(ctx.root, {
    initialItems: ITEMS,
    initialCursor: "cursor-1",
    initialHasMore: true,
  });
}

/**
 * The paging control, distinguished from a gallery TILE — both are
 * `<button>` elements, and `ctx.container.querySelector("button")` alone
 * would silently match whichever comes first in document order.
 */
function loadMoreButtonOrNull(): HTMLButtonElement | null {
  return ctx.container.querySelector<HTMLButtonElement>(
    "button:not([data-gallery-tile])",
  );
}

function loadMoreButton(): HTMLButtonElement {
  const button = loadMoreButtonOrNull();
  expect(button, "expected a Load more / Try again button to be rendered").not.toBeNull();
  return button as HTMLButtonElement;
}

/** The polite paging status line — the K2 focus target. */
function pagingStatus(): HTMLParagraphElement {
  const status = ctx.container.querySelector('p[aria-live="polite"]');
  expect(status).not.toBeNull();
  return status as HTMLParagraphElement;
}

/**
 * Resolves a held-open `stubDeferredFetch` response with `FINAL_PAGE` and
 * waits for the Load more button to be removed — the fake-timer block
 * (`useFakeTimers`, the resolve, a concurrent `advanceTimersByTimeAsync`,
 * `useRealTimers`) all three K2 tests below need, extracted once
 * (ugcportal-dj4i item 2). `waitUntil`'s own polling now runs on fake
 * timers too, so it is raced against `advanceTimersByTimeAsync` rather than
 * awaited after it — nothing else fires the poll's timers otherwise.
 * `useRealTimers()` runs in `finally` so a failed assertion inside
 * `waitUntil` still restores the real clock for whatever runs next.
 */
async function resolveFinalPage(
  resolveWith: (payload: unknown) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers();
  try {
    await resolveWith(FINAL_PAGE);
    await Promise.all([
      waitUntil(
        () => loadMoreButtonOrNull() === null,
        "the Load more button to be removed after the last page",
      ),
      vi.advanceTimersByTimeAsync(3000),
    ]);
  } finally {
    vi.useRealTimers();
  }
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
    const { fetchMock, resolveWith } = stubDeferredFetch();

    await mount();
    const button = loadMoreButton();
    button.focus();
    expect(document.activeElement).toBe(button);

    await click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Fake timers (upload-transport.test.ts's convention), scoped to this
    // test alone, not a describe-level hook: the sibling test just below
    // polls for a DIFFERENT condition (`aria-busy`) on the real clock, and a
    // describe-level `vi.useFakeTimers()` would starve it of the real timer
    // its own poll relies on. See `resolveFinalPage` above.
    await resolveFinalPage(resolveWith);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(pagingStatus());

    // Round-1 review finding: programmatic focus with no visible indicator
    // is barely better than none, and `:focus-visible` is not trustworthy
    // for this element — the input that led here was a MOUSE click on
    // "Load more" (see the long comment on this <p> in gallery.tsx), and a
    // browser's `:focus-visible` heuristic keys off the last input
    // modality rather than off whether the focus move was programmatic. A
    // computed style isn't available (jsdom applies no CSS), so this
    // checks class-list membership instead — the same structural proxy the
    // K1 disabled-attribute checks above already rely on, for the same
    // reason.
    const statusClasses = pagingStatus().className.split(/\s+/);
    expect(statusClasses).toContain("focus:ring-3");
    expect(statusClasses).toContain("focus:ring-ring/80");
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

describe("K2 guard — a visitor who tabbed elsewhere while the request was pending", () => {
  it("leaves focus alone instead of chasing it to the paging status", async () => {
    // Round-2 review finding: the K2 handoff fired whenever `hasMore`
    // flipped to `false`, with no check of where focus actually was by
    // then. A visitor who tabs away to something else entirely — this
    // "elsewhere" element stands in for any of it — while the request is
    // still in flight must not have their focus overridden once it
    // resolves.
    const { fetchMock, resolveWith } = stubDeferredFetch();

    await mount();
    const button = loadMoreButton();
    button.focus();

    await click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    try {
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      // See `resolveFinalPage` above for why this is per-test, not a
      // describe-level hook.
      await resolveFinalPage(resolveWith);

      // Left exactly where the visitor put it — not pulled to the paging
      // status, and not dropped to <body> either.
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(pagingStatus());
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      elsewhere.remove();
    }
  });
});

describe("K2 guard — a mouse click that never focused the button", () => {
  it("leaves focus exactly where it was once the last page arrives", async () => {
    // Round-4 review finding: an earlier version of the guard also treated
    // `document.activeElement === document.body` as "the button just
    // unmounted, chase it with focus" — but the check runs BEFORE any
    // state commit unmounts anything, so at that point `body` means only
    // "nothing was ever focused". That is the ordinary case for a plain
    // mouse click: Safari does not focus a button on click, and neither
    // does the synthetic `dispatchEvent("click")` this suite's own `click`
    // helper uses, below — deliberately NOT preceded by `button.focus()`,
    // unlike every other test in this file, to reproduce exactly that
    // visitor rather than the keyboard-activation one K1-K3 cover.
    const { fetchMock, resolveWith } = stubDeferredFetch();

    await mount();
    const button = loadMoreButton();

    // The premise, asserted rather than assumed: a click helper that
    // secretly also focused its target would make the rest of this test
    // pass over a scenario it never actually reached.
    expect(document.activeElement).not.toBe(button);
    const before = document.activeElement;

    await click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // See `resolveFinalPage` above for why this is per-test, not a
    // describe-level hook.
    await resolveFinalPage(resolveWith);

    // Exactly where it was before the click — not pulled to the paging
    // status, which is what an unrequested focus ring would look like.
    expect(document.activeElement).toBe(before);
    expect(document.activeElement).not.toBe(pagingStatus());
  });
});
