// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Gallery } from "@/components/gallery/gallery";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * What happens to an OPEN viewer when the gallery goes away (ugcportal-71y).
 *
 * The round-4 finding this file exists for: PhotoSwipe appends its root to
 * `document.body`, outside React's tree, and `openGalleryViewer`'s returned
 * instance was discarded with no cleanup anywhere. Press Back with the
 * lightbox open — there is no history integration, so Back is an ordinary
 * client-side navigation rather than a close — and `Gallery` unmounted while
 * the full-screen `.pswp` overlay stayed on top of the next page, with
 * `window.pswp` still set. That last part is the nastier half: `loadAndOpen`
 * refuses while it is set, so every later activation anywhere in the app was a
 * silent no-op until a reload.
 *
 * Its own file rather than assertions added to gallery.test.tsx, because the
 * two ask incompatible things of the environment. That file renders with
 * `renderToStaticMarkup` in the suite's default node environment and checks
 * markup; this one needs a DOM, a real client root, a real mount and a real
 * unmount. Switching the whole of gallery.test.tsx to jsdom to add two tests
 * would move thirty-odd passing assertions onto a different environment for no
 * reason.
 *
 * jsdom is pinned at ^26 deliberately (ugcportal-71y): 30 breaks on CI's Node
 * 20 and silently drops every file with this pragma, this one included.
 */

const ITEMS = toGalleryItems([
  { id: "one", previewId: "pv-one", publishedAt: "2026-03-01T00:00:00.000Z" },
  { id: "two", previewId: "pv-two", publishedAt: "2026-03-02T00:00:00.000Z" },
]);

/**
 * Measurements this test controls, standing in for the browser's `Image`.
 *
 * Two reasons it has to be a stub rather than the real thing. jsdom loads no
 * resources, so a real `new Image()` never fires `load` or `error` at all —
 * with the round-4 bound in place that now resolves, but only after the full
 * MEASURE_TIMEOUT_MS, which is four seconds per test. And the in-flight test
 * below needs to hold an activation open ACROSS the unmount, which means
 * deciding when the measurement answers.
 *
 * `release()` answers every measurement taken so far. `pending` is how many
 * are waiting, so a test can assert it actually parked the activation where it
 * meant to rather than racing past it.
 */
const measurements: (() => void)[] = [];

function installImageStub(mode: "immediate" | "deferred"): void {
  class FakeImage {
    naturalWidth = 1600;
    naturalHeight = 900;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      const answer = () => this.onload?.();
      if (mode === "immediate") queueMicrotask(answer);
      else measurements.push(answer);
    }
  }
  (globalThis as unknown as { Image: unknown }).Image = FakeImage;
}

async function release(): Promise<void> {
  const answers = measurements.splice(0, measurements.length);
  await act(async () => {
    for (const answer of answers) answer();
  });
}

const realImage = (globalThis as unknown as { Image: unknown }).Image;

function overlay(): Element | null {
  return document.querySelector(".pswp");
}

function openInstance(): unknown {
  return (window as unknown as { pswp?: unknown }).pswp;
}

/** Whether a viewer is on screen by EITHER of the two ways it can be. */
function viewerPresent(): boolean {
  return overlay() !== null || openInstance() !== undefined;
}

beforeAll(() => {
  /*
   * PhotoSwipe reads `matchMedia` in its constructor and jsdom ships none.
   * Reporting a match puts these tests on the reduced-motion path, where
   * `_prepareOptions` forces `showHideAnimationType: "none"` and opening
   * completes without waiting on a CSS transition jsdom would never fire. Same
   * stub and same reasoning as lightbox.test.ts, which has the long version.
   */
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

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
  // Unmounting an already-unmounted root is a no-op, so this is safe after the
  // tests that unmount deliberately.
  await act(async () => {
    root.unmount();
  });
  container.remove();
  measurements.length = 0;
  (globalThis as unknown as { Image: unknown }).Image = realImage;
  /*
   * A test that left a viewer behind would otherwise fail the NEXT one by
   * leaving `window.pswp` set — which is precisely the failure under
   * examination here, and would be maddening to attribute.
   */
  const stale = openInstance() as { destroy?: () => void } | undefined;
  stale?.destroy?.();
  delete (window as unknown as { pswp?: unknown }).pswp;
  overlay()?.remove();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <Gallery initialItems={ITEMS} initialCursor={null} initialHasMore={false} />,
    );
  });
}

/** Clicks the tile at `index`, the way a visitor does. */
async function clickTile(index: number): Promise<void> {
  const tiles = container.querySelectorAll<HTMLButtonElement>(
    "button[data-gallery-tile]",
  );
  expect(tiles).toHaveLength(ITEMS.length);
  await act(async () => {
    tiles[index].dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

/**
 * Waits for a condition and then fails with a label naming what never came.
 *
 * Polling rather than a fixed sleep, and the same helper lightbox.test.ts has
 * for the same reason: PhotoSwipe's teardown finishes on its own timer in
 * jsdom, which never fires `transitionend`. The labelled timeout is the point —
 * under the bug this file was written for the overlay never goes away, and
 * "timed out waiting for the overlay to go away when the gallery unmounts"
 * says so directly.
 */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("a viewer that is open when the gallery unmounts", () => {
  it("is destroyed rather than left on top of the next page", async () => {
    installImageStub("immediate");
    await mount();
    await clickTile(0);

    // The premise, asserted rather than assumed: without this the test below
    // would pass over a gallery whose tiles open nothing at all.
    await waitUntil(() => openInstance() !== undefined, "the viewer to open");
    expect(overlay()).not.toBeNull();

    await unmount();

    await waitUntil(
      () => !viewerPresent(),
      "the overlay to go away when the gallery unmounts",
    );
    // Both halves. The element is what the visitor sees; `window.pswp` is what
    // makes every later activation in the app a silent no-op while it is set.
    expect(overlay()).toBeNull();
    expect(openInstance()).toBeUndefined();
  });

  it("leaves a later gallery able to open its own viewer", async () => {
    // The assertion the bug actually failed, and the reason clearing
    // `window.pswp` is not cosmetic: `loadAndOpen` returns false while it is
    // set, so a stale one turns the next page's gallery into dead tiles.
    installImageStub("immediate");
    await mount();
    await clickTile(0);
    await waitUntil(() => openInstance() !== undefined, "the viewer to open");
    await unmount();
    await waitUntil(() => !viewerPresent(), "the overlay to go away");

    const secondContainer = document.createElement("div");
    document.body.append(secondContainer);
    const secondRoot = createRoot(secondContainer);
    try {
      await act(async () => {
        secondRoot.render(
          <Gallery
            initialItems={ITEMS}
            initialCursor={null}
            initialHasMore={false}
          />,
        );
      });
      const tile = secondContainer.querySelector<HTMLButtonElement>(
        "button[data-gallery-tile]",
      );
      expect(tile).not.toBeNull();
      await act(async () => {
        tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitUntil(
        () => openInstance() !== undefined,
        "the second gallery's viewer to open",
      );
      expect(overlay()).not.toBeNull();
    } finally {
      await act(async () => {
        secondRoot.unmount();
      });
      secondContainer.remove();
    }
  });
});

describe("an activation still in flight when the gallery unmounts", () => {
  /*
   * The half that a cleanup effect alone does not fix, and the one two earlier
   * rounds of this PR got wrong in the same shape: a guard that reads correct
   * because it exists, while covering none of the window the bug lives in.
   *
   * The open path has four awaits — `ensureSizes`, then two dynamic imports
   * and PhotoSwipe's own initialisation inside `openGalleryViewer` — and an
   * unmount can land in any of them. Cleanup that only destroys what is
   * already on screen cannot help in any of them: at unmount there is nothing
   * to destroy yet, and the viewer appears AFTERWARDS.
   *
   * These park the activation on the measurement, which is the widest of the
   * four windows and the only one a test can hold open deterministically,
   * unmount, and only then let the measurement answer.
   */
  it("does not open a viewer after the gallery is gone", async () => {
    installImageStub("deferred");
    await mount();
    await clickTile(0);

    // Parked mid-activation, not raced past it: two items, so two
    // measurements, and no viewer yet.
    expect(measurements).toHaveLength(ITEMS.length);
    expect(viewerPresent()).toBe(false);

    await unmount();
    await release();
    /*
     * Then wait, which is unusual in a test and is the only way to assert an
     * absence. The activation would carry on through two dynamic imports and
     * PhotoSwipe's initialisation before anything appeared, so checking
     * immediately after `release()` would report "no viewer" while the
     * unguarded version was still on its way to opening one. 100ms is far
     * longer than that path takes here, where both modules are already in the
     * loader's cache from the tests above.
     */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(overlay()).toBeNull();
    expect(openInstance()).toBeUndefined();
  });

  it("opens normally when the gallery is still there", async () => {
    /*
     * Guards the guard. If the teardown flag were wired up so that it read
     * "gone" whenever an activation crossed an await, the test above would
     * pass and the gallery would never open a photograph again — the failure
     * mode of a fix that only ever says no.
     *
     * Same fixture, same deferred measurement, same release. The single
     * difference is that this one does not unmount.
     */
    installImageStub("deferred");
    await mount();
    await clickTile(1);

    expect(measurements).toHaveLength(ITEMS.length);
    expect(viewerPresent()).toBe(false);

    await release();

    await waitUntil(() => openInstance() !== undefined, "the viewer to open");
    expect(overlay()).not.toBeNull();
  });
});
