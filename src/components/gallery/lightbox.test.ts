// @vitest-environment jsdom
import type PhotoSwipeLightbox from "photoswipe/lightbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  UNKNOWN_PREVIEW_SIZE,
  galleryLightboxOptions,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { toGalleryItems } from "@/lib/gallery-items";
import { mediaPreviewPath } from "@/lib/routes";

/**
 * The lightbox, actually opened and actually closed (ugcportal-71y, K1).
 *
 * THIS FILE EXISTS BECAUSE ITS ABSENCE HID A BUG. The first push of this bead
 * wired `lightbox.on("destroy", () => lightbox.destroy())` — apparent symmetry,
 * and an infinite recursion: photoswipe@5.4.4 forwards a lightbox's listeners
 * to the PhotoSwipe instance BEFORE registering its own `this.pswp = undefined`
 * cleanup, and `Eventable.dispatch` has no re-entrancy guard, so closing blew
 * the stack, left `window.pswp` set and permanently prevented the viewer from
 * reopening. Sixteen assertions covered the grid's markup and not one of them
 * could see it, because none of them opened anything.
 *
 * So this runs the real library in a DOM. It is the only jsdom file in the
 * suite — everything else is a node test — which is why the environment is
 * pinned per-file rather than globally.
 *
 * What it does NOT claim: that the viewer *looks* right. jsdom has no layout
 * and no image decoding, so zoom, panning, the fade and the rendered slide are
 * ugcportal-2al's and a human's. What it does prove is lifecycle and plumbing:
 * that a close is clean, that a reopen works, and that each slide gets its own
 * item's source and its own item's dimensions.
 */

beforeAll(() => {
  /*
   * jsdom ships no `matchMedia`, and PhotoSwipe reads one in its constructor
   * (`_prepareOptions`). Without a stub the open fails inside a promise and
   * the test still PASSES, reporting only an unhandled rejection — the exact
   * shape of a test that proves nothing, and the first thing this file did.
   *
   * The stub reports a match, which puts these tests on PhotoSwipe's
   * REDUCED-MOTION path: `_prepareOptions` answers a matching
   * `(prefers-reduced-motion), (update: slow)` by forcing
   * `showHideAnimationType: "none"`, so opening and closing complete
   * synchronously instead of on a CSS transition.
   *
   * That is a real user path rather than a testing trick — it is what a
   * visitor with reduced motion enabled actually gets — but be clear about
   * what it costs: jsdom never fires `transitionend`, so with the animated
   * path PhotoSwipe's `opener` stays mid-flight, `isOpening` never clears, and
   * `close()` returns early at its own guard. The ANIMATED open and close are
   * therefore not exercised here; the lifecycle they share is. The fade itself
   * belongs to ugcportal-2al and a human.
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

/**
 * Three items with DISTINCT preview sources and DISTINCT sizes.
 *
 * Both kinds of distinctness are load-bearing. Identical sources would make
 * "the slide shows the item that was activated" pass whichever item it showed;
 * identical sizes would make "each slide gets its own dimensions" pass even if
 * every slide were handed the first item's. Neither is a shape a real feed
 * guarantees — two rows can share nothing here — so the fixture supplies the
 * difference the assertions need in order to be able to fail.
 */
const ITEMS = toGalleryItems([
  { id: "one", previewId: "pv-one", publishedAt: "2026-03-01T00:00:00.000Z" },
  { id: "two", previewId: "pv-two", publishedAt: "2026-03-02T00:00:00.000Z" },
  { id: "three", previewId: "pv-three", publishedAt: "2026-03-03T00:00:00.000Z" },
]);

const SIZES: PixelSize[] = [
  { width: 800, height: 1200 },
  { width: 1600, height: 900 },
  { width: 1000, height: 1000 },
];

/** PhotoSwipe stores the open instance here; a stale one blocks every reopen. */
function openInstance(): unknown {
  return (window as unknown as { pswp?: unknown }).pswp;
}

/**
 * Waits for a condition, then fails loudly if it never arrives.
 *
 * Polling rather than a fixed sleep, for a reason specific to jsdom:
 * PhotoSwipe's open and close are CSS transitions, and jsdom never fires
 * `transitionend`, so both complete on the library's own fallback timer
 * (duration + 500ms, i.e. about 833ms at the default 333ms). A fixed wait
 * short enough to keep the suite quick would be flaky; one long enough to be
 * safe would cost seconds per test.
 *
 * The timeout throwing with a label is the point. Under the recursion bug this
 * file was written for, a close never completes — and "timed out waiting for
 * the viewer to close" names the defect, where a bare sleep would have
 * reported some unrelated assertion further down.
 */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the viewer to ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function open(index: number): Promise<PhotoSwipeLightbox> {
  const lightbox = await openGalleryViewer(ITEMS, SIZES, index);
  await waitUntil(() => lightbox.pswp !== undefined, "open");
  return lightbox;
}

async function close(lightbox: PhotoSwipeLightbox): Promise<void> {
  lightbox.pswp?.close();
  await waitUntil(() => openInstance() === undefined, "close");
}

afterEach(async () => {
  // A test that left the viewer open would otherwise fail the NEXT one by
  // leaving window.pswp set — which is exactly the failure mode under
  // examination here, and would be maddening to attribute.
  const stale = openInstance() as { destroy?: () => void } | undefined;
  if (stale !== undefined) {
    stale.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  delete (window as unknown as { pswp?: unknown }).pswp;
});

describe("opening the viewer", () => {
  it("mounts PhotoSwipe and shows the item that was activated", async () => {
    const lightbox = await open(1);

    expect(lightbox.pswp).toBeDefined();
    expect(document.querySelector(".pswp")).not.toBeNull();
    expect(lightbox.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-two"));

    await close(lightbox);
  });

  it("gives the active slide its own item's dimensions", async () => {
    const lightbox = await open(1);

    // Not the first item's, and not a shared default.
    expect(lightbox.pswp?.currSlide?.data.width).toBe(SIZES[1].width);
    expect(lightbox.pswp?.currSlide?.data.height).toBe(SIZES[1].height);

    await close(lightbox);
  });

  it("describes the slide without telling the reader to open it", async () => {
    const lightbox = await open(2);

    // The tile's accessible name is "Open photograph 3, …" because a tile is a
    // control. A slide is an image, so the alt drops the instruction.
    expect(lightbox.pswp?.currSlide?.data.alt).toBe(
      "Photograph 3, published 3 March 2026",
    );

    await close(lightbox);
  });
});

describe("closing the viewer", () => {
  /*
   * The regression this file was written for. Under the recursion bug this
   * threw RangeError: Maximum call stack size exceeded, from inside a
   * transition callback where a try/catch at the call site cannot see it —
   * which is why the assertions below are about the state left behind rather
   * than about the throw.
   */
  it("tears PhotoSwipe down completely", async () => {
    const lightbox = await open(0);
    expect(openInstance()).toBeDefined();

    await close(lightbox);

    expect(lightbox.pswp).toBeUndefined();
    expect(openInstance()).toBeUndefined();
    expect(document.querySelector(".pswp")).toBeNull();
  });

  it("leaves the viewer able to open again", async () => {
    // The assertion the bug actually failed: `_openPhotoswipe` returns early
    // while `window.pswp` is set, so a close that does not clear it makes
    // every later activation a no-op with no error anywhere.
    const first = await open(0);
    await close(first);

    const second = await open(2);

    expect(second.pswp).toBeDefined();
    expect(second.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-three"));

    await close(second);
  });

  it("survives being opened and closed repeatedly", async () => {
    for (const index of [0, 1, 2, 0]) {
      const lightbox = await open(index);
      expect(lightbox.pswp, `open #${index}`).toBeDefined();
      await close(lightbox);
      expect(openInstance(), `close #${index}`).toBeUndefined();
    }
  });
});

describe("galleryLightboxOptions", () => {
  it("pairs each item with the size at its own position", () => {
    const { dataSource } = galleryLightboxOptions(ITEMS, SIZES);

    expect(dataSource).toEqual([
      {
        src: mediaPreviewPath("pv-one"),
        alt: "Photograph 1, published 1 March 2026",
        ...SIZES[0],
      },
      {
        src: mediaPreviewPath("pv-two"),
        alt: "Photograph 2, published 2 March 2026",
        ...SIZES[1],
      },
      {
        src: mediaPreviewPath("pv-three"),
        alt: "Photograph 3, published 3 March 2026",
        ...SIZES[2],
      },
    ]);
  });

  it("falls back rather than emitting a slide with no dimensions", () => {
    // A slide whose width is falsy is never loaded at all by PhotoSwipe, so a
    // short `sizes` array must not produce `undefined` here.
    const { dataSource } = galleryLightboxOptions(ITEMS, SIZES.slice(0, 1));

    expect(dataSource[0].width).toBe(SIZES[0].width);
    expect(dataSource[1]).toMatchObject(UNKNOWN_PREVIEW_SIZE);
    expect(dataSource[2]).toMatchObject(UNKNOWN_PREVIEW_SIZE);
    for (const slide of dataSource) {
      expect(slide.width).toBeGreaterThan(0);
      expect(slide.height).toBeGreaterThan(0);
    }
  });

  it("builds every source from the opaque previewId", () => {
    for (const slide of galleryLightboxOptions(ITEMS, SIZES).dataSource) {
      expect(slide.src).toMatch(/^\/api\/media\/preview\//);
      expect(slide.src).not.toContain("previews/");
    }
  });
});
