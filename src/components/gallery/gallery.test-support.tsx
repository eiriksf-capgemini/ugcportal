import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";

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
 * fixture. `gallery.unmount.test.tsx`'s PhotoSwipe stubs (fake `Image`,
 * `matchMedia`, stale-viewer cleanup) and `gallery.focus.test.tsx`'s
 * `vi.stubGlobal("fetch", ...)` / `vi.unstubAllGlobals()` stay local to the
 * files that need them, each registered in that file's own additional
 * `afterEach` alongside the shared one below.
 */

/** The live container + client root a suite mounts `<Gallery>` into. */
export interface GalleryTestRoot {
  container: HTMLElement;
  root: Root;
}

/**
 * Registers the `beforeEach`/`afterEach` pair every `Gallery` jsdom suite
 * needs — a fresh container appended to `document.body`, a fresh client
 * root, and `IS_REACT_ACT_ENVIRONMENT` set so `act()` does not warn — and
 * returns the (mutable) state those hooks fill in.
 *
 * Must be called from the top level of a test file while vitest is still
 * collecting it, exactly like calling `beforeEach`/`afterEach` directly
 * would require — this does nothing more than wrap that same call.
 *
 * Returns the SAME object for the whole file's lifetime; only its
 * `container`/`root` properties are reassigned, by `beforeEach`, before
 * every test. Callers must read `ctx.container`/`ctx.root` at the point of
 * use — inside a test body or a helper a test calls — not destructure them
 * once at module scope, or they would keep referencing the first test's
 * container forever.
 */
export function setupGalleryTestRoot(): GalleryTestRoot {
  const ctx = {} as GalleryTestRoot;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    ctx.container = document.createElement("div");
    document.body.append(ctx.container);
    ctx.root = createRoot(ctx.container);
  });

  afterEach(async () => {
    // Unmounting an already-unmounted root is a no-op, so this is safe after
    // a test that unmounts `ctx.root` deliberately mid-test.
    await act(async () => {
      ctx.root.unmount();
    });
    ctx.container.remove();
  });

  return ctx;
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
