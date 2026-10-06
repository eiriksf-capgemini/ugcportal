// @vitest-environment jsdom
/*
 * A VALUE import, not a type-only one, and the difference is load-bearing:
 * the ownership tests below patch `PhotoSwipeLightbox.prototype`, and that
 * only reaches `openGalleryViewer` because its `await import(...)` resolves to
 * this same module record. Patching a copy would make those tests assert
 * nothing at all.
 */
import PhotoSwipeLightbox from "photoswipe/lightbox";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MEASURE_CONCURRENCY,
  UNKNOWN_PREVIEW_SIZE,
  createActivationGate,
  ensureSizes,
  galleryLightboxOptions,
  measureImage,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { waitUntil } from "@/components/gallery/gallery.test-support";
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
 * So this runs the real library in a DOM. It is one of the suite's three jsdom
 * files — this one, gallery.unmount.test.tsx and lightbox.caption.test.ts;
 * everything else is a node test — which is why the environment is pinned
 * per-file rather than globally.
 *
 * jsdom is pinned at ^26 deliberately (ugcportal-71y): 30 breaks on CI's Node
 * 20, and the way it breaks is SILENT DE-COLLECTION — every file carrying this
 * pragma stops being collected at all, and the run reports fewer files with no
 * failures. All three, not just this one, which is why the count above is
 * worth keeping accurate.
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

async function open(index: number): Promise<PhotoSwipeLightbox> {
  // No `waitUntil` here any more, deliberately: openGalleryViewer's promise
  // now resolves when the viewer is genuinely open, so polling afterwards
  // would hide a regression in exactly that guarantee.
  const lightbox = await openGalleryViewer(ITEMS, SIZES, index);
  // Null means "a newer activation superseded this one", which none of these
  // tests arrange. Failing here says so, instead of leaving every assertion
  // below to fail separately on a null.
  if (lightbox === null) throw new Error("the viewer stood down unexpectedly");
  return lightbox;
}

async function close(lightbox: PhotoSwipeLightbox): Promise<void> {
  lightbox.pswp?.close();
  await waitUntil(() => openInstance() === undefined, "the viewer to close");
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
  /*
   * The round-2 finding. `loadAndOpen()` is synchronous and does the real work
   * in `preload()`, whose `Promise.all([...]).then(...)` carries no `.catch` —
   * so an `async` wrapper that merely called it resolved before anything had
   * opened, and the caller's `.catch` could never see a failure.
   *
   * Asserted by checking the state at the moment the promise resolves, with no
   * polling in between. Under the old shape `lightbox.pswp` is still undefined
   * here and there is no `.pswp` element in the document.
   */
  it("resolves only once the viewer is really open", async () => {
    const lightbox = await open(0);

    expect(lightbox.pswp).toBeDefined();
    expect(openInstance()).toBeDefined();
    expect(document.querySelector(".pswp")).not.toBeNull();
    // Not merely mounted — initialised far enough to have a current slide.
    expect(lightbox.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-one"));

    await close(lightbox);
  });

  it("rejects rather than quietly showing the wrong photograph", async () => {
    // PhotoSwipe refuses a second open while one is live, and reports it only
    // through `loadAndOpen`'s return value. Discarding that turned a refusal
    // into an apparent success showing whichever tile won the race.
    const first = await open(0);

    await expect(openGalleryViewer(ITEMS, SIZES, 2)).rejects.toThrow(
      /already open/,
    );
    // And the refusal did not disturb the viewer that IS open.
    expect(first.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-one"));

    await close(first);
  });

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

describe("superseding an activation in flight", () => {
  /*
   * The round-3 finding, and the reason these assert on WHERE the guard is
   * rather than that one exists.
   *
   * Round 2 added an activation counter and checked it once, before
   * openGalleryViewer — ahead of the two dynamic imports, which on a first
   * activation are a real chunk download with the grid still clickable. The
   * guard read correct and covered none of the window the race lives in.
   *
   * These flip `current` to false AFTER calling openGalleryViewer but BEFORE
   * awaiting it. Because the function is async, the call runs synchronously up
   * to its first await — the imports — and then hands control back, so the
   * flip lands precisely inside the window under test. A guard placed at
   * function entry would have read `true` and opened anyway, which is the
   * behaviour these tests exist to reject.
   */
  it("does not open when superseded during the module load", async () => {
    let current = true;
    const pending = openGalleryViewer(ITEMS, SIZES, 0, () => current);

    // Synchronous, so this happens while `pending` is parked on its imports.
    current = false;

    await expect(pending).resolves.toBeNull();
    expect(openInstance()).toBeUndefined();
    expect(document.querySelector(".pswp")).toBeNull();
  });

  it("does not report a failure when it stands down", async () => {
    // Standing aside for a newer click is a normal outcome, not an error. If
    // this rejected, the caller would paint "could not open the viewer" over
    // the viewer that replaced it.
    let current = true;
    const pending = openGalleryViewer(ITEMS, SIZES, 0, () => current);
    current = false;
    await expect(pending).resolves.not.toThrow();
  });

  it("lets the newer activation open on ITS tile, not the older one's", async () => {
    // The whole point, end to end: two overlapping activations, and the one
    // the visitor asked for last is the one on screen. Under the round-2
    // shape the earlier activation won and showed tile 1.
    const gate = createActivationGate();

    const firstIsCurrent = gate.begin();
    const first = openGalleryViewer(ITEMS, SIZES, 0, firstIsCurrent);
    const secondIsCurrent = gate.begin();
    const second = openGalleryViewer(ITEMS, SIZES, 2, secondIsCurrent);

    expect(await first).toBeNull();
    const viewer = await second;
    expect(viewer).not.toBeNull();
    expect(viewer?.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-three"));

    await close(viewer as PhotoSwipeLightbox);
  });

  it("opens normally when nothing supersedes it", async () => {
    // Guards the guard: if `isCurrent` were wired up wrongly and always
    // answered false, every test above would pass and the viewer would never
    // open at all.
    const gate = createActivationGate();
    const viewer = await openGalleryViewer(ITEMS, SIZES, 1, gate.begin());

    expect(viewer).not.toBeNull();
    expect(viewer?.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-two"));

    await close(viewer as PhotoSwipeLightbox);
  });
});

describe("owning the viewer on every exit path", () => {
  /*
   * The round-5 finding, and the reason the rule in openGalleryViewer is "the
   * caller owns the instance if and only if the function returns it" rather
   * than a cleanup at each exit that someone remembered.
   *
   * Once `init()` has been called there is something to own, and three exits
   * owned nothing: the post-init stand-down, the refusal, and — the one with
   * teeth — the OPEN_TIMEOUT_MS rejection. `loadAndOpen` returns TRUE and does
   * the real work later inside `preload`'s `.then`, so a rejection at the
   * deadline left `shouldOpen` set on an instance no reference in the
   * application pointed at. gallery.tsx's unmount cleanup reads
   * `viewer.current`, which that instance never reached.
   *
   * These assert on the DAMAGE rather than on `destroy` having been called,
   * wherever the damage is reachable: an overlay on `document.body` and a set
   * `window.pswp`, which is what makes every later activation anywhere in the
   * application a silent no-op.
   */

  /** Records every real `destroy()`, and still performs it. */
  function watchDestroys(): {
    destroyed: PhotoSwipeLightbox[];
    restore: () => void;
  } {
    const destroyed: PhotoSwipeLightbox[] = [];
    const real = PhotoSwipeLightbox.prototype.destroy;
    PhotoSwipeLightbox.prototype.destroy = function (this: PhotoSwipeLightbox) {
      destroyed.push(this);
      real.call(this);
    };
    return {
      destroyed,
      restore: () => {
        PhotoSwipeLightbox.prototype.destroy = real;
      },
    };
  }

  it("leaves a timed-out open nothing to mount later", async () => {
    /*
     * `preload` is stubbed to HOLD the open rather than perform it, which is
     * precisely the state the deadline exists for: `loadAndOpen` has returned
     * true and `shouldOpen` is set, but `_openPhotoswipe` has not run yet.
     * Nothing about the stub is fictional — it is the same suspension a slow
     * `Promise.all` inside `preload` produces.
     *
     * Releasing it AFTERWARDS is what makes this a test about the leak rather
     * than about the rejection. Without the fix the late `_openPhotoswipe`
     * finds `shouldOpen` still true and puts a full-screen overlay on
     * `document.body` with `window.pswp` set, and nothing in the application
     * holds a reference with which to take it down.
     */
    const realPreload = PhotoSwipeLightbox.prototype.preload;
    const filed: (() => void)[] = [];
    PhotoSwipeLightbox.prototype.preload = function (
      this: PhotoSwipeLightbox,
      index: number,
    ) {
      filed.push(() => realPreload.call(this, index));
    };
    const watch = watchDestroys();
    try {
      await expect(
        openGalleryViewer(ITEMS, SIZES, 0, () => true, 20),
      ).rejects.toThrow(/did not finish opening/);

      // The premise, asserted rather than assumed: the open really was filed,
      // so there really is something that could still mount.
      expect(filed).toHaveLength(1);
      expect(watch.destroyed).toHaveLength(1);
      // `shouldOpen` is the flag `preload`'s `.then` re-reads before calling
      // `_openPhotoswipe`, so this is the mechanism, not a proxy for it.
      expect(watch.destroyed[0].shouldOpen).toBe(false);

      filed[0]();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(document.querySelector(".pswp")).toBeNull();
      expect(openInstance()).toBeUndefined();
    } finally {
      PhotoSwipeLightbox.prototype.preload = realPreload;
      watch.restore();
    }
  });

  it("destroys what it built when superseded between init and loadAndOpen", async () => {
    /*
     * The other post-`init()` stand-down. `isCurrent` answers true at the
     * check after the imports and false at the check against `loadAndOpen`,
     * which is the only way to reach it: between the two there is nothing but
     * synchronous construction, so no test can flip a flag in between.
     */
    let asked = 0;
    const watch = watchDestroys();
    try {
      const viewer = await openGalleryViewer(ITEMS, SIZES, 0, () => {
        asked += 1;
        return asked === 1;
      });

      expect(viewer).toBeNull();
      expect(asked).toBe(2);
      expect(watch.destroyed).toHaveLength(1);
      expect(openInstance()).toBeUndefined();
    } finally {
      watch.restore();
    }
  });

  it("destroys the instance it built when the open is refused", async () => {
    // The refusal path: `loadAndOpen` returns false because a viewer is
    // already up. The refused instance is still a constructed lightbox, and
    // the throw took it out of the caller's reach.
    const first = await open(0);
    const watch = watchDestroys();
    try {
      await expect(openGalleryViewer(ITEMS, SIZES, 2)).rejects.toThrow(
        /already open/,
      );

      expect(watch.destroyed).toHaveLength(1);
      // And destroying the refused one did not disturb the viewer that IS
      // open — it belongs to a different instance.
      expect(first.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-one"));
    } finally {
      watch.restore();
    }
    await close(first);
  });

  it("does NOT destroy the instance it hands back", async () => {
    // Guards the rule in the other direction. An implementation that simply
    // destroyed on the way out would pass every assertion above and close the
    // viewer the instant it opened.
    const watch = watchDestroys();
    try {
      const viewer = await open(1);

      expect(watch.destroyed).toHaveLength(0);
      expect(viewer.pswp?.currSlide?.data.src).toBe(mediaPreviewPath("pv-two"));

      await close(viewer);
    } finally {
      watch.restore();
    }
  });
});

describe("createActivationGate", () => {
  it("treats only the most recent activation as current", () => {
    const gate = createActivationGate();
    const first = gate.begin();
    expect(first()).toBe(true);

    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);

    const third = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });

  it("keeps separate gates independent", () => {
    // One gate per component instance; beginning on one must not supersede
    // an activation on another.
    const a = createActivationGate();
    const b = createActivationGate();
    const onA = a.begin();
    b.begin();
    expect(onA()).toBe(true);
  });
});

describe("ensureSizes", () => {
  const src = (item: (typeof ITEMS)[number]) => item.previewSrc;

  it("reads a size once and then serves it from the cache", async () => {
    const cache = new Map<string, PixelSize>();
    const calls: string[] = [];
    const measure = async (url: string) => {
      calls.push(url);
      return { width: 640, height: 480 };
    };

    await ensureSizes(ITEMS, cache, 0, measure);
    await ensureSizes(ITEMS, cache, 0, measure);

    expect(calls).toHaveLength(ITEMS.length);
    expect(cache.get(src(ITEMS[0]))).toEqual({ width: 640, height: 480 });
  });

  /*
   * The round-2 finding, and the whole reason `measure` is injectable.
   *
   * The preview route proxies every byte through the Node process, so one
   * transient 5xx is an ordinary event — and caching the fallback for it
   * pinned that slide to 1280x1280 for the rest of the session, rendering a
   * landscape photograph visibly stretched with no way back but a reload.
   *
   * The fixture is what makes this checkable: a measurer that fails ONCE and
   * then succeeds. One that always failed could not tell "the failure was
   * cached" from "the image is genuinely unreadable" — which is the version of
   * this test that would have passed over the bug.
   */
  it("does not cache a failed measurement", async () => {
    const cache = new Map<string, PixelSize>();
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      return attempts === 1 ? null : { width: 1600, height: 900 };
    };

    const first = await ensureSizes([ITEMS[0]], cache, 0, flaky);
    expect(first[0]).toEqual(UNKNOWN_PREVIEW_SIZE);
    expect(cache.has(src(ITEMS[0]))).toBe(false);

    // The next activation asks again, and gets the real shape.
    const second = await ensureSizes([ITEMS[0]], cache, 0, flaky);
    expect(second[0]).toEqual({ width: 1600, height: 900 });
    expect(cache.get(src(ITEMS[0]))).toEqual({ width: 1600, height: 900 });
  });

  it("never yields a zero dimension, which PhotoSwipe would refuse to load", async () => {
    const sizes = await ensureSizes(ITEMS, new Map(), 0, async () => null);
    for (const size of sizes) {
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });

  /*
   * The round-4 finding: the only bound in this module was on `afterInit`, the
   * step whose own comment says nothing observed can hang on it, while the
   * genuinely I/O-bound wait right here had none.
   *
   * A STALL is the case, and it is not the same as an error. A preview request
   * that is accepted and then never answered fires neither `onload` nor
   * `onerror`, so `measureImage` never settles — `ensureSizes` pended forever,
   * `openLightbox` never reached `openGalleryViewer`, nothing rejected,
   * `activate`'s `.catch` never ran, and the click produced no viewer, no error
   * and no busy state. The fixture below is therefore a promise that never
   * settles, NOT one that resolves null: a measurer that failed cleanly took
   * the already-covered path and could not have caught this.
   */
  describe("when a measurement stalls", () => {
    /** A measurement that is accepted and never answered. */
    const stalls = () => new Promise<PixelSize | null>(() => {});

    it("gives up and falls back instead of pending forever", async () => {
      const cache = new Map<string, PixelSize>();

      const sizes = await ensureSizes(ITEMS, cache, 0, stalls, 20);

      expect(sizes).toEqual(ITEMS.map(() => UNKNOWN_PREVIEW_SIZE));
    });

    it("lets the healthy previews report their real sizes anyway", async () => {
      // One stalled item used to wedge the whole activation. It must now cost
      // that item its exact dimensions and nothing else.
      const cache = new Map<string, PixelSize>();
      const measure = (url: string) =>
        url === src(ITEMS[0]) ? stalls() : Promise.resolve({ width: url.length, height: 100 });

      const sizes = await ensureSizes(ITEMS, cache, 0, measure, 20);

      expect(sizes[0]).toEqual(UNKNOWN_PREVIEW_SIZE);
      // Their own lengths, which differ from each other and from 1280 — so
      // these assertions fail if either slide were handed the fallback.
      expect(sizes[1]).toEqual({ width: src(ITEMS[1]).length, height: 100 });
      expect(sizes[2]).toEqual({ width: src(ITEMS[2]).length, height: 100 });
    });

    it("does not cache the fallback, so the next activation asks again", async () => {
      // Same reasoning as a failed measurement: a stall is a fact about one
      // moment, not about the image. Caching 1280x1280 for it would pin that
      // slide to a square for the rest of the session.
      const cache = new Map<string, PixelSize>();
      let attempts = 0;
      const stallsOnce = () => {
        attempts += 1;
        return attempts === 1 ? stalls() : Promise.resolve({ width: 1600, height: 900 });
      };

      const first = await ensureSizes([ITEMS[0]], cache, 0, stallsOnce, 20);
      expect(first[0]).toEqual(UNKNOWN_PREVIEW_SIZE);
      expect(cache.has(src(ITEMS[0]))).toBe(false);

      const second = await ensureSizes([ITEMS[0]], cache, 0, stallsOnce, 20);
      expect(second[0]).toEqual({ width: 1600, height: 900 });
      expect(cache.get(src(ITEMS[0]))).toEqual({ width: 1600, height: 900 });
    });

    it("costs one deadline for the whole list, not one per item", async () => {
      /*
       * A short list is measured all at once, so a stalled page costs one
       * deadline rather than one per item. Three items fit inside
       * MEASURE_CONCURRENCY, which is what makes "all at once" the expected
       * answer here; the bound itself is asserted separately below, on a list
       * long enough to reach it.
       *
       * Asserted through the peak number of in-flight measurements rather than
       * through elapsed time, which would be a flaky way to say the same
       * thing.
       */
      let inFlight = 0;
      let peak = 0;
      const countingStall = () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return stalls();
      };

      await ensureSizes(ITEMS, new Map(), 0, countingStall, 20);

      expect(peak).toBe(ITEMS.length);
    });

    it("still waits for a slow measurement that does arrive", async () => {
      /*
       * Guards the bound against being the new bug. One set tight enough to
       * discard real measurements would pass every assertion above and turn
       * every photograph in the gallery into a 1280x1280 square — the exact
       * distortion UNKNOWN_PREVIEW_SIZE's comment says a guess causes.
       */
      const slow = async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { width: 1600, height: 900 };
      };

      const sizes = await ensureSizes([ITEMS[0]], new Map(), 0, slow, 500);

      expect(sizes[0]).toEqual({ width: 1600, height: 900 });
    });

    it("still lets a thrown error through rather than calling it a fallback", async () => {
      // The bound is on the WAIT only. Folding rejections into the fallback as
      // well would be the cheaper implementation and would hide a broken
      // measurer behind a silently squashed slide for the rest of the session.
      await expect(
        ensureSizes(
          [ITEMS[0]],
          new Map(),
          0,
          () => Promise.reject(new Error("measurer is broken")),
          500,
        ),
      ).rejects.toThrow("measurer is broken");
    });
  });

  /*
   * The round-5 finding. Round 4's per-item deadline was justified as "one
   * slow thumbnail costs that slide a bad frame", which assumed the timers
   * were independent — and they are not. A default page is 50 items, so all
   * fifty timers started at once against a browser that dispatches about six
   * to an origin at a time and gives no priority to the slide that was
   * clicked. Requests at the back of that queue expired BEFORE BEING SENT and
   * took UNKNOWN_PREVIEW_SIZE, so a crowded page did not cost slowness, it
   * cost a squared slide — and the squared one was as likely as not to be the
   * photograph the visitor had asked for.
   *
   * These assert the outcome that actually goes wrong — a slide taking the
   * fallback size while healthy ones did not — rather than elapsed time, which
   * would be both flaky and a different claim.
   */
  describe("when the page is long enough to queue", () => {
    const MANY = toGalleryItems(
      Array.from({ length: 50 }, (_, position) => ({
        id: `id-${position}`,
        previewId: `pv-${position}`,
        publishedAt: "2026-03-01T00:00:00.000Z",
      })),
    );
    const OPENED = 40;

    /**
     * A measurer that behaves like a browser connection pool: it accepts every
     * call immediately, but only `parallelism` of them are ever in flight, and
     * the rest wait their turn in arrival order.
     *
     * THE WAITING IS THE POINT. A measurer that answered everything at once
     * could not express the defect at all, because the defect is entirely
     * about what happens to a request that has been handed over but not yet
     * sent.
     */
    function connectionPool(parallelism: number, serviceMs: number) {
      let active = 0;
      const waiting: (() => void)[] = [];
      return async (url: string): Promise<PixelSize> => {
        if (active >= parallelism) {
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
        active += 1;
        await new Promise((resolve) => setTimeout(resolve, serviceMs));
        active -= 1;
        waiting.shift()?.();
        return { width: url.length, height: 100 };
      };
    }

    it("measures the slide being opened rather than leaving it in the queue", async () => {
      // Six at a time, 10ms each, so item 40 is in the seventh wave — roughly
      // 60ms away — if the list is measured in order. The deadline is 40ms.
      const sizes = await ensureSizes(
        MANY,
        new Map(),
        OPENED,
        connectionPool(MEASURE_CONCURRENCY, 10),
        40,
      );

      expect(sizes[OPENED]).toEqual({
        width: MANY[OPENED].previewSrc.length,
        height: 100,
      });
      // Said the other way round too, because the failure is specifically the
      // fallback and 1280x1280 is a value a real measurement could never be
      // here (the widths above are URL lengths).
      expect(sizes[OPENED]).not.toEqual(UNKNOWN_PREVIEW_SIZE);
    });

    it("never hands the browser more than it will dispatch", async () => {
      /*
       * The other half, and the one the ordering leans on. Measuring the
       * activated item first only helps if it is genuinely SENT first, and
       * with fifty measurements handed over at once that depends on the
       * browser draining its own queue in the order `src` was assigned — a
       * convention, not a guarantee. Bounding the dispatch here is what makes
       * the deadline time a request instead of a place in a queue.
       *
       * The needle is a peak of 50. Asserting the exact bound rules out the
       * other wrong answer as well: a serial implementation would peak at 1
       * and would make a stalled page cost fifty deadlines.
       */
      let inFlight = 0;
      let peak = 0;
      const countingStall = () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<PixelSize | null>(() => {});
      };

      const sizes = await ensureSizes(MANY, new Map(), OPENED, countingStall, 20);

      expect(peak).toBe(MEASURE_CONCURRENCY);
      // Nothing was measured, so nothing may be missing either: an item the
      // deadline cut off before dispatch still needs a size PhotoSwipe will
      // load.
      expect(sizes).toHaveLength(MANY.length);
      expect(sizes.every((size) => size.width > 0 && size.height > 0)).toBe(true);
    });

    it("measures every item when the activated index is out of range", async () => {
      // A stale index must demote nothing and, above all, must not index past
      // the end of the list and hand `measure` an undefined source.
      const asked: string[] = [];
      const sizes = await ensureSizes(
        ITEMS,
        new Map(),
        99,
        async (url) => {
          asked.push(url);
          return { width: url.length, height: 100 };
        },
        500,
      );

      expect(asked).toHaveLength(ITEMS.length);
      expect(sizes.map((size) => size.width)).toEqual(
        ITEMS.map((item) => item.previewSrc.length),
      );
    });
  });

  it("keeps sizes aligned with the items that asked for them", async () => {
    // Positional, so a reordering bug would hand slide 2 slide 1's shape.
    const sizes = await ensureSizes(ITEMS, new Map(), 0, async (url) => ({
      width: url.length,
      height: 100,
    }));
    expect(sizes.map((size) => size.width)).toEqual(
      ITEMS.map((item) => item.previewSrc.length),
    );
  });
});

describe("measureImage", () => {
  /**
   * A stand-in for the browser's `Image`, because jsdom loads no resources —
   * `new Image()` there never fires `load` or `error`, so the real one cannot
   * be exercised at all. This covers the three branches that decide whether a
   * measurement counts: loaded with dimensions, loaded with none, and failed.
   */
  function stubImage(outcome: "ok" | "zero" | "error"): void {
    class FakeImage {
      naturalWidth = outcome === "ok" ? 1600 : 0;
      naturalHeight = outcome === "ok" ? 900 : 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => {
          if (outcome === "error") this.onerror?.();
          else this.onload?.();
        });
      }
    }
    (globalThis as unknown as { Image: unknown }).Image = FakeImage;
  }

  const realImage = (globalThis as unknown as { Image: unknown }).Image;
  afterEach(() => {
    (globalThis as unknown as { Image: unknown }).Image = realImage;
  });

  it("reports the intrinsic size of an image that loads", async () => {
    stubImage("ok");
    await expect(measureImage("/api/media/preview/pv-one")).resolves.toEqual({
      width: 1600,
      height: 900,
    });
  });

  it("reports null when the image fails to load", async () => {
    stubImage("error");
    await expect(measureImage("/api/media/preview/pv-one")).resolves.toBeNull();
  });

  it("reports null rather than zero when the image loads with no dimensions", async () => {
    // Zero is not a measurement, and PhotoSwipe treats a falsy width as "do
    // not load this slide" — so it must travel as null and reach the fallback.
    stubImage("zero");
    await expect(measureImage("/api/media/preview/pv-one")).resolves.toBeNull();
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

  /**
   * ugcportal-i72n: the fade is a JS-driven PhotoSwipe option, not CSS, so
   * `prefers-reduced-motion` has to be read explicitly rather than falling
   * out of a Tailwind variant — `galleryLightboxOptions` used to set
   * `showHideAnimationType: "fade"` unconditionally.
   *
   * Each test stubs `window.matchMedia` for itself and restores whatever was
   * there before (the module's own `beforeAll` stub, which matches every
   * query — see that stub's own comment above) — this describe block is last
   * in the file, but restoring per-test rather than relying on that keeps
   * these tests independent of file order.
   */
  describe("honours prefers-reduced-motion (ugcportal-i72n)", () => {
    let original: typeof window.matchMedia;

    beforeEach(() => {
      original = window.matchMedia;
    });

    afterEach(() => {
      window.matchMedia = original;
    });

    function stubMatchMedia(matches: boolean): void {
      window.matchMedia = ((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }

    it("K1: collapses the fade to instant when the query matches", () => {
      stubMatchMedia(true);

      const options = galleryLightboxOptions(ITEMS, SIZES);

      expect(options.showHideAnimationType).toBe("none");
      expect(options.showAnimationDuration).toBe(0);
      expect(options.hideAnimationDuration).toBe(0);
      expect(options.zoomAnimationDuration).toBe(0);
    });

    /**
     * K2: following should never happen — the fade removed for a visitor
     * who has NOT asked for reduced motion. Asserted against an
     * implementation that hardcodes "none" (the vacuous-pass this guards
     * against): that implementation fails every assertion here, because it
     * never reads `matches` at all. See containment.ts's own
     * GALLERY_TILE_IMAGE_CLASS comment for the CSS-side sibling of this same
     * "the fix must not just remove the effect" shape.
     */
    it("K2: keeps the fade and PhotoSwipe's own durations when the query does not match", () => {
      stubMatchMedia(false);

      const options = galleryLightboxOptions(ITEMS, SIZES);

      expect(options.showHideAnimationType).toBe("fade");
      // Omitted, not `undefined`-valued — see galleryLightboxOptions's own
      // comment for why the distinction matters to PhotoSwipe's own option
      // merge.
      expect("showAnimationDuration" in options).toBe(false);
      expect("hideAnimationDuration" in options).toBe(false);
      expect("zoomAnimationDuration" in options).toBe(false);
    });

    it("K3: falls back to the unreduced defaults, rather than throwing, when window.matchMedia is unavailable", () => {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;

      let options: ReturnType<typeof galleryLightboxOptions> | undefined;
      expect(() => {
        options = galleryLightboxOptions(ITEMS, SIZES);
      }).not.toThrow();

      expect(options?.showHideAnimationType).toBe("fade");
      expect("showAnimationDuration" in (options ?? {})).toBe(false);
    });
  });
});
