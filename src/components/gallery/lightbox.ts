import type PhotoSwipeLightbox from "photoswipe/lightbox";

import { galleryItemAlt, type GalleryItem } from "@/lib/gallery-items";

/**
 * The PhotoSwipe viewer the gallery opens (ugcportal-71y).
 *
 * Its own module rather than a closure inside gallery.tsx, so a test can drive
 * a real open and a real close against the real library. That is not
 * architectural neatness: the first version of this shipped a one-line
 * lifetime bug that no assertion in the suite could reach, because nothing
 * opened the viewer at all. See lightbox.test.ts.
 *
 * The import of `photoswipe/lightbox` below is an `import type`, and the real
 * one inside `openGalleryViewer` is dynamic, so the library's JAVASCRIPT is
 * not in the initial bundle: a visitor who never opens a photograph never
 * downloads the viewer's code.
 *
 * Its STYLESHEET is not deferred, and this comment used to claim it was.
 * `src/app/globals.css` does `@import "photoswipe/style.css"` unconditionally,
 * so the viewer's CSS is part of the global stylesheet served on every route,
 * the admin screens included. Only the JavaScript is split out. Said plainly
 * because the wrong version of it was the sort of claim a reader sizing the
 * initial payload would take at face value.
 */

export type PixelSize = { width: number; height: number };

/**
 * Intrinsic size used for a preview whose real size could not be read.
 *
 * Reached only when the browser could not read a size off the image — it
 * failed to load (a deleted object, a 404 from the delivery route) or reported
 * zero dimensions. In the first case the slide shows PhotoSwipe's error state
 * and these numbers decide nothing anyone can see; in the second there is no
 * better answer available.
 *
 * It is NOT a stand-in for "not measured yet": see `ensureSizes` in
 * gallery.tsx, which waits for the real value rather than guessing at one,
 * because PhotoSwipe sizes a slide from the numbers it is given, so a guessed
 * ratio over a perfectly loadable image distorts it. Square, because a wrong
 * ratio is wrong in every direction and this one at least does not pretend to
 * know the orientation.
 */
export const UNKNOWN_PREVIEW_SIZE: PixelSize = { width: 1280, height: 1280 };

/**
 * The viewer's options, as a pure function of the items and their sizes.
 *
 * `sizes` is positional — `sizes[n]` belongs to `items[n]` — and the caller
 * builds it by mapping over the same array, so the two cannot come apart. A
 * missing entry falls back rather than emitting `undefined` dimensions, which
 * PhotoSwipe reads as zero and answers by never loading the slide at all.
 */
export function galleryLightboxOptions(
  items: GalleryItem[],
  sizes: PixelSize[],
) {
  return {
    dataSource: items.map((item, position) => ({
      src: item.previewSrc,
      alt: galleryItemAlt(item, position),
      ...(sizes[position] ?? UNKNOWN_PREVIEW_SIZE),
    })),
    /*
     * Fade, not zoom-from-thumbnail.
     *
     * PhotoSwipe's zoom transition animates from the thumbnail's rectangle to
     * the full frame, and it is the better effect — but it assumes the
     * thumbnail shows the WHOLE image. These tiles are `object-cover` centre
     * crops (see containment.ts), so the rectangle it would fly out of holds a
     * different picture from the one it lands on, and the transition reads as
     * a jump. Telling PhotoSwipe about the crop means handing it an
     * `innerRect` per slide, which needs the intrinsic size *and* the laid-out
     * size of every tile at animation time. Not worth it for a transition;
     * fade is honest about what it knows.
     */
    showHideAnimationType: "fade" as const,
    // The preview is at most 1280px on its longest edge (ugcportal-44q), so
    // there is nothing to gain from zooming past its own resolution.
    maxZoomLevel: 1,
    // The whole overlay is the backdrop; closing by clicking outside the image
    // is what everybody already expects from a lightbox.
    bgClickAction: "close" as const,
  };
}

/**
 * Opens the viewer at `index` and hands back the instance.
 *
 * A fresh instance per activation. Reusing one would mean keeping its
 * `dataSource` in step with a list that grows on every "Load more" — a second
 * copy of the item list to get wrong — and costs nothing to avoid: with no
 * `gallery` option, `init()` binds no DOM listeners, so an instance whose
 * PhotoSwipe has been destroyed is already unreferenced and collectable.
 *
 * NOTHING IS REGISTERED ON THE `destroy` EVENT HERE, and that is a fix rather
 * than an omission. `lightbox.on("destroy", () => lightbox.destroy())` looks
 * like tidy symmetry and is an infinite recursion, verified against
 * photoswipe@5.4.4: `_openPhotoswipe` forwards the lightbox's listeners to the
 * PhotoSwipe instance BEFORE registering its own `this.pswp = undefined`
 * cleanup, `PhotoSwipe.destroy()` re-enters its own `dispatch("destroy")` once
 * `isDestroying` is set, and `Eventable.dispatch` has no re-entrancy guard. So
 * closing the viewer blew the stack, left `window.pswp` set, and — because
 * `_openPhotoswipe` returns early while that is set — permanently prevented
 * the viewer from reopening. The lightbox does not need the help: it clears
 * its own references on destroy.
 *
 * Focus returns to the tile without any help either. PhotoSwipe records
 * `document.activeElement` when its keyboard handler binds — the button that
 * was just activated — and restores it on destroy, but only for a visitor who
 * actually moved focus into the viewer, so a mouse user's focus is left alone.
 *
 * THE RETURNED PROMISE RESOLVES WHEN THE VIEWER IS ACTUALLY OPEN, not when the
 * request to open it has been filed, and the difference is the whole reason
 * this function is shaped the way it is. Two things in photoswipe@5.4.4 make
 * the naive version silently wrong:
 *
 *   - `loadAndOpen()` is SYNCHRONOUS. It returns a boolean and does the real
 *     work in `preload()`, which builds a `Promise.all([...]).then(...)` with
 *     NO `.catch`. So an `async` wrapper that just calls it resolves
 *     immediately, the caller's `.catch` can never observe a failed open, and
 *     a rejected `import("photoswipe")` — a stale chunk after a deploy, a
 *     flaky connection — is an unhandled rejection plus a button that does
 *     nothing. That is the same shape as the recursion bug above: a failure
 *     path nothing can reach.
 *
 *   - That boolean is the only report of a REFUSED open. `loadAndOpen` returns
 *     false when `window.pswp` is already set, and discarding it means a
 *     second activation while one is pending resolves as a success while the
 *     viewer shows the first tile — the wrong photograph, no error anywhere.
 *
 * So the core module is imported HERE, on this function's own awaited path,
 * and handed to the lightbox as a class rather than as a loader.
 * `isPswpClass()` (a function with `prototype.goTo`) makes `preload` wrap it in
 * `Promise.resolve` instead of calling an importer, which removes the
 * un-caught rejection at its source rather than trying to observe it. Both
 * imports stay dynamic, so neither module is in the initial bundle.
 */

/**
 * How long to wait for `afterInit` before treating the open as failed.
 *
 * Only reachable if PhotoSwipe stops short between `loadAndOpen` returning
 * true and its own initialisation, which nothing observed does — but the
 * alternative to a bound is an `await` that can hang forever behind a spinner
 * the visitor cannot dismiss. Generous, because exceeding it is a bug report,
 * not a slow network: by this point every module is already loaded.
 *
 * NOT the bound that matters most, and for two rounds it was the only one
 * there. The genuinely I/O-bound wait in this feature is the measurement —
 * see MEASURE_TIMEOUT_MS — and a bound on the step whose own comment says
 * nothing observed can hang on it, next to an unbounded network round trip,
 * is a bound in the wrong place.
 */
const OPEN_TIMEOUT_MS = 10_000;

/**
 * How long ONE preview's measurement may take before it is given up on.
 *
 * This is the bound on the step that can actually hang. A STALLED preview
 * request — connection accepted, bytes never delivered, no reset — fires
 * neither `onload` nor `onerror`, so `measureImage`'s promise never settles.
 * Unbounded, that pended `ensureSizes` forever and took the whole activation
 * with it: `openLightbox` never reached `openGalleryViewer`, so nothing
 * opened, nothing rejected, `activate`'s `.catch` never ran, `viewerFailed`
 * stayed false and there was no busy state either. The click produced NOTHING
 * AT ALL, which is the one outcome a visitor cannot interpret or act on.
 *
 * Shorter than OPEN_TIMEOUT_MS on purpose. That one bounds a step where every
 * module is already loaded; this one bounds a real network round trip through
 * a route that proxies every byte through the Node process (ugcportal-a2l),
 * with the visitor looking at a grid that has not answered their click yet.
 * Four seconds is long enough that an ordinary slow response still arrives and
 * short enough that a stall does not read as a dead page.
 */
const MEASURE_TIMEOUT_MS = 4_000;

/** Whether a PhotoSwipe viewer is on screen right now. */
export function isViewerOpen(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { pswp?: unknown }).pswp !== undefined
  );
}

/**
 * Sequences activations so the LAST one wins.
 *
 * `begin()` supersedes every earlier activation and returns the predicate that
 * one asks "am I still the activation the visitor wants?". A plain counter,
 * but behind a function so the rule is testable on its own — the previous
 * version of it was three lines inline in a component and was wrong in a way
 * no test could see.
 */
export function createActivationGate(): { begin: () => () => boolean } {
  let latest = 0;
  return {
    begin() {
      const mine = (latest += 1);
      return () => latest === mine;
    },
  };
}

/**
 * Opens the viewer, or returns null if a newer activation superseded this one.
 *
 * `isCurrent` is checked AFTER the dynamic imports and immediately before
 * `loadAndOpen`, and the placement is the entire point — a guard before the
 * awaits does not guard anything. The first activation downloads two chunks
 * here, which is a real wait with the grid still clickable underneath, so that
 * window is exactly where a second click lands.
 *
 * What went wrong when the check sat further up, verified against
 * photoswipe@5.4.4 rather than reasoned about: `loadAndOpen`'s own
 * `if (window.pswp) return false` does NOT serialise two overlapping opens,
 * because `window.pswp` is not assigned until `_openPhotoswipe` runs inside
 * `preload`'s `.then`. So both activations saw it unset, both returned true,
 * the earlier one's `_openPhotoswipe` won and set it, the later one's
 * early-returned — and the later one's `afterInit` therefore never fired, so
 * its promise pended the full OPEN_TIMEOUT_MS and then reported failure over a
 * viewer that was open and working, showing the wrong photograph.
 */
export async function openGalleryViewer(
  items: GalleryItem[],
  sizes: PixelSize[],
  index: number,
  isCurrent: () => boolean = () => true,
): Promise<PhotoSwipeLightbox | null> {
  const [{ default: Lightbox }, { default: PhotoSwipe }] = await Promise.all([
    import("photoswipe/lightbox"),
    import("photoswipe"),
  ]);

  // The await above is the window. Standing down here costs the visitor
  // nothing: nothing has been constructed and nothing is on screen.
  if (!isCurrent()) return null;

  const lightbox = new Lightbox({
    ...galleryLightboxOptions(items, sizes),
    pswpModule: PhotoSwipe,
  });

  // Registered before `loadAndOpen`, because `afterInit` is dispatched from a
  // microtask continuation that a later `.on()` would already have missed.
  let stopWaiting = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PhotoSwipe did not finish opening")),
      OPEN_TIMEOUT_MS,
    );
    stopWaiting = () => clearTimeout(timer);
    lightbox.on("afterInit", () => {
      stopWaiting();
      resolve();
    });
  });

  lightbox.init();

  // Re-checked immediately before the one irreversible step. Between the check
  // after the imports and this line there is only synchronous construction, so
  // in practice the two agree — but `loadAndOpen` is the call that puts a
  // viewer on screen, and the guard belongs against it rather than near it.
  if (!isCurrent()) {
    stopWaiting();
    return null;
  }

  if (!lightbox.loadAndOpen(index)) {
    // Leaves `opened` permanently pending, which is correct and not a leak:
    // nothing is awaiting it on this path, and cancelling the timer is what
    // stops it rejecting into nobody's hands later.
    stopWaiting();
    throw new Error("a viewer is already open");
  }
  await opened;

  return lightbox;
}

/**
 * Intrinsic sizes for every slide, in the order the items are in.
 *
 * PhotoSwipe will not load a slide whose width is falsy — `Content.load()`
 * starts the image "only after width is defined" — so a missing size is not a
 * cosmetic problem, it is a blank slide. And a *guessed* size is worse than a
 * missing one: PhotoSwipe sizes the slide from the numbers it is given, so a
 * square guess over a 3:2 photograph distorts it.
 *
 * So each size is either one a tile already reported through `onLoad`, or one
 * read by loading the same URL again. UNKNOWN_PREVIEW_SIZE is used only when
 * the image cannot be loaded at all.
 *
 * ONLY SUCCESSES ARE CACHED. Caching the fallback looks like the same thing
 * and is not: the preview route proxies every byte through the Node process,
 * so a single transient 5xx or a dropped connection is an ordinary event — and
 * writing 1280x1280 into the cache for it would pin that slide to a square for
 * the rest of the session, rendering a landscape photograph visibly stretched
 * with no way back but a reload. A failure is a fact about one moment, not
 * about the image; the next activation asks again.
 *
 * EVERY MEASUREMENT IS BOUNDED, and the bound is PER ITEM rather than over the
 * whole list. That matters twice. A stall no longer pends this function
 * forever (see MEASURE_TIMEOUT_MS for what that cost the visitor), and because
 * the items are measured concurrently and each carries its own deadline, one
 * stalled preview costs a single MEASURE_TIMEOUT_MS no matter how many others
 * are in the list, and does not stop the healthy ones reporting their real
 * sizes. A bound over the aggregate would have let one slow item downgrade
 * every slide in the gallery to the fallback.
 *
 * A TIMED-OUT MEASUREMENT FALLS BACK RATHER THAN FAILING THE OPEN. That is a
 * choice, and not the obvious one, so: PhotoSwipe needs *a* width and height
 * or it will not load the slide at all, but it does not need the RIGHT ones —
 * a wrong ratio costs a distorted frame and a worse zoom transition on that
 * one slide. Failing would instead cost the visitor the photograph they
 * actually asked for, because some other thumbnail in the list was slow. And
 * the wrong ratio is temporary, since the fallback is not cached (below): the
 * next activation measures again and gets it right. A refused open is the
 * visitor's whole answer; a squashed slide is a bad frame that heals itself.
 *
 * KNOWN GAP (ugcportal-8dn): this still measures EVERY item, not just the one
 * being opened, so an activation waits on previews nobody is looking at.
 * Adding `loading="lazy"` to the tiles widened that gap rather than narrowing
 * it, and the trade is deliberate: a tile below the fold is now never
 * requested until it is scrolled to, so its size is a real network round trip
 * here rather than a cache hit. Paying it on the rare activation is worth not
 * firing fifty proxied requests at first paint — but it is the reason 8dn is
 * worth doing, not a reason to have left the tiles eager. The bound above caps
 * what that gap can cost; it does not close it.
 */
export async function ensureSizes(
  items: GalleryItem[],
  cache: Map<string, PixelSize>,
  /*
   * How a size is read when the cache has none. Injectable for one reason:
   * `measureImage` below decodes a real image, which no headless environment
   * does, so the CACHING POLICY — the part with a bug in it — would otherwise
   * be untestable and was. The default is the real thing, so production has no
   * seam; the tests supply a measurer that can fail or stall on demand.
   */
  measure: (src: string) => Promise<PixelSize | null> = measureImage,
  /*
   * The per-item deadline. Injectable so a test can prove the bound exists
   * without spending the real four seconds to do it — the default is the one
   * production uses.
   */
  timeoutMs: number = MEASURE_TIMEOUT_MS,
): Promise<PixelSize[]> {
  return Promise.all(
    items.map(async (item) => {
      const known = cache.get(item.previewSrc);
      if (known !== undefined) return known;
      const measurement = await measureWithin(
        () => measure(item.previewSrc),
        timeoutMs,
      );
      // Covers both "the browser could not read a size" and "the request never
      // answered", deliberately on the same path: neither is a fact about the
      // image, so neither is cached and the next activation asks again.
      if (measurement === null) return UNKNOWN_PREVIEW_SIZE;
      cache.set(item.previewSrc, measurement);
      return measurement;
    }),
  );
}

/**
 * `measure()`, resolving null rather than waiting forever.
 *
 * The timeout resolves NULL — the same value the measurer itself uses for "no
 * size could be read" — so a stall lands on the fallback path `ensureSizes`
 * already has, instead of needing a second one.
 *
 * A REJECTION IS STILL PROPAGATED rather than folded into that null. This
 * bounds the WAIT and changes nothing about what counts as a failure: a
 * measurer that throws is a bug in the measurer, and turning every such bug
 * into a silently squashed slide is how it would go unnoticed. `measureImage`
 * does not throw, so in production only the timeout arm is reachable.
 *
 * The abandoned promise is not cancellable — there is no abort signal on an
 * `<img>` load — so a stalled measurement keeps its own closure alive until
 * the browser gives up on the request. One dead closure per stalled preview,
 * for the lifetime of a page view, is the price of not hanging the viewer.
 */
function measureWithin(
  measure: () => Promise<PixelSize | null>,
  timeoutMs: number,
): Promise<PixelSize | null> {
  return new Promise<PixelSize | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    measure().then(
      (size) => {
        clearTimeout(timer);
        resolve(size);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The image's intrinsic size, or null if the browser could not read one. */
export function measureImage(src: string): Promise<PixelSize | null> {
  return new Promise<PixelSize | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null,
      );
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
