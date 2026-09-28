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
 * The import of `photoswipe/lightbox` below is a `import type`, and the real
 * one inside `openGalleryViewer` is dynamic, so neither the library nor its
 * stylesheet is in the initial bundle. A visitor who never opens a photograph
 * never downloads the viewer.
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
 */
const OPEN_TIMEOUT_MS = 10_000;

export async function openGalleryViewer(
  items: GalleryItem[],
  sizes: PixelSize[],
  index: number,
): Promise<PhotoSwipeLightbox> {
  const [{ default: Lightbox }, { default: PhotoSwipe }] = await Promise.all([
    import("photoswipe/lightbox"),
    import("photoswipe"),
  ]);

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
