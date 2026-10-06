import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import { Gallery } from "@/components/gallery/gallery";

/**
 * Shared scaffolding for `Gallery`'s jsdom suites (gallery.unmount.test.tsx,
 * gallery.focus.test.tsx — ugcportal-jx4 round-2 review finding): a real
 * client root to mount/unmount `<Gallery>` against, and the `waitUntil` poll
 * both suites need because the behaviour under test resolves through a chain
 * of promises and React effects a test does not control directly.
 *
 * Deliberately NOT itself a `*.test.*` file: vitest's default test-file glob
 * would otherwise collect it as an (empty) suite of its own. It also needs no
 * `// @vitest-environment jsdom` pragma — it has no module-level DOM access,
 * only functions that touch `document`/`act` when a jsdom-pragma'd caller
 * invokes them at test run time.
 *
 * What is deliberately NOT here: anything specific to one suite's own
 * fixture or assertions. `gallery.unmount.test.tsx`'s PhotoSwipe stubs (fake
 * `Image`, `matchMedia`, stale-viewer cleanup) stay local to the file that
 * needs them, registered in its own additional `afterEach` alongside the
 * shared one below. `stubDeferredFetch`, `FINAL_PAGE` and `click` below are
 * the one exception (ugcportal-jx4 round-5 review finding): generic enough
 * — a held-open `fetch` stub, a minimal "one more item, no more after it"
 * listing-page response, and an `act`-wrapped click dispatch — to be worth
 * sharing with any future gallery jsdom test that needs the same shape,
 * not just the ones that happen to need them today.
 */

/**
 * The live container + client root a suite mounts `<Gallery>` into, read
 * via accessors (`ctx.container`/`ctx.root`) rather than plain properties
 * (ugcportal-jx4 round-5 review finding, getters per ugcportal-dj4i item 5):
 * a plain property would hand back a snapshot that goes stale across
 * `beforeEach`'s swap to a fresh container/root for the next test, so every
 * call site would need its own reminder to re-read at point of use instead
 * of destructuring once. A getter re-reads the closed-over variable on every
 * access, the same as the function form this replaced, without the `()` at
 * each call site.
 */
export interface GalleryTestRoot {
  readonly container: HTMLElement;
  readonly root: Root;
}

/**
 * Registers the `beforeEach`/`afterEach` pair every `Gallery` jsdom suite
 * needs — a fresh container appended to `document.body`, a fresh client
 * root, and `IS_REACT_ACT_ENVIRONMENT` set so `act()` does not warn — and
 * returns accessors for the state those hooks fill in.
 *
 * Must be called from the top level of a test file while vitest is still
 * collecting it, exactly like calling `beforeEach`/`afterEach` directly
 * would require — this does nothing more than wrap that same call.
 */
export function setupGalleryTestRoot(): GalleryTestRoot {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    // Unmounting an already-unmounted root is a no-op, so this is safe after
    // a test that unmounts the root deliberately mid-test.
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
  });

  return {
    get container() {
      if (!container) {
        throw new Error(
          "setupGalleryTestRoot: container accessed before beforeEach ran",
        );
      }
      return container;
    },
    get root() {
      if (!root) {
        throw new Error("setupGalleryTestRoot: root accessed before beforeEach ran");
      }
      return root;
    },
  };
}

/** Renders `<Gallery {...props} />` into `root`, wrapped in `act`. */
export async function renderGallery(
  root: Root,
  props: ComponentProps<typeof Gallery>,
): Promise<void> {
  await act(async () => {
    root.render(<Gallery {...props} />);
  });
}

/**
 * Unmounts `root`, wrapped in `act` — for a test that deliberately unmounts
 * partway through, rather than relying only on the shared `afterEach` above.
 */
export async function unmountGallery(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

/**
 * Dispatches a real `"click"` event at `button`, wrapped in `act` — the way
 * a visitor's click reaches a React handler, as opposed to calling the
 * handler directly.
 */
export function click(button: HTMLButtonElement): Promise<void> {
  return act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/**
 * A single extra photograph, with nothing after it — the minimal "last
 * page" shape `GET /api/public/media` returns: one more item, `hasMore:
 * false`, `nextCursor: null`. Any gallery jsdom test exercising "the last
 * page arrives" can use this directly rather than relaying its own copy.
 */
export const FINAL_PAGE = {
  items: [
    { id: "three", previewId: "pv-three", publishedAt: "2026-03-03T00:00:00.000Z" },
  ],
  hasMore: false,
  nextCursor: null,
};

/**
 * A `fetch` stub whose single response stays open until `resolveWith` is
 * called — for a test that needs to inspect state WHILE a request is still
 * in flight, then supply the response once it has seen what it needed to.
 *
 * `resolveWith` takes the parsed JSON body, not a `Response` — it builds
 * the minimal fake `Response` shape (`ok`, `status`, `json()`) itself and
 * wraps the resolution in `act`, since every current caller wants both.
 */
export function stubDeferredFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  resolveWith: (payload: unknown) => Promise<void>;
} {
  let resolveFetch: ((value: unknown) => void) | undefined;
  const fetchMock = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    resolveWith: async (payload: unknown) => {
      await act(async () => {
        resolveFetch?.({ ok: true, status: 200, json: async () => payload });
      });
    },
  };
}

/**
 * Waits for `condition`, polling inside `act` so pending promises and React
 * effects the caller does not control directly get a chance to flush, and
 * fails with a label naming what never came rather than a bare timeout.
 *
 * Also used outside a React tree entirely (lightbox.test.ts, which drives
 * PhotoSwipe directly): `act` around an ordinary `setTimeout` is harmless
 * when nothing React-owned is pending, and the polling itself answers a
 * jsdom gap specific to that file's PhotoSwipe opens/closes — they are CSS
 * transitions, jsdom never fires `transitionend`, so both complete on the
 * library's own fallback timer (duration + 500ms) rather than on an event a
 * fixed-sleep test could wait for cheaply and reliably.
 */
export async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
