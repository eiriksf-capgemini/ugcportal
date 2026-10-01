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
 * The class the caption element carries, and the hook its CSS is written
 * against (src/app/globals.css). Exported so the test asserts the same string
 * the viewer renders rather than a copy of it.
 */
export const LIGHTBOX_TAG_CAPTION_CLASS = "pswp__gallery-tags";

/** What separates two tag names in the caption. */
const CAPTION_SEPARATOR = " · ";

/**
 * The caption for each slide, positionally — `captions[n]` belongs to
 * `items[n]`, the same arrangement `sizes` uses, and built by mapping over the
 * same array so the two cannot come apart.
 *
 * An untagged item gets the empty string rather than a placeholder, and the
 * caption element hides itself for it. There is nothing truthful to put there:
 * the alt text already names the photograph and its date, and "Untagged" is a
 * statement about our database rather than about the picture.
 */
export function galleryTagCaptions(items: GalleryItem[]): string[] {
  return items.map((item) =>
    item.tags.map((tag) => tag.name).join(CAPTION_SEPARATOR),
  );
}

/**
 * Puts the subject tags on the open slide (ugcportal-jsc).
 *
 * PhotoSwipe renders its own DOM outside React, so this is the one place in
 * the feature that builds an element by hand — and the reason the whole
 * caption is `textContent` and never `innerHTML`. A tag name is
 * user-supplied text; assigning it as text is inert by construction, with no
 * escaping step for anyone to forget, remove or double-apply. React gives the
 * grid the same guarantee for free; here it has to be chosen.
 *
 * WHY POSITIONAL RATHER THAN OFF THE SLIDE'S OWN DATA. PhotoSwipe will carry
 * arbitrary extra fields on a `dataSource` entry through to
 * `pswp.currSlide.data`, and reading a `tags` field off it would be the
 * shorter version of this. It is also the version where the caption silently
 * reads `undefined` the first time somebody changes how `dataSource` is
 * built, because nothing types that round trip. `captions[pswp.currIndex]` is
 * checked against the array this module built.
 *
 * `?? ""` rather than a non-null assertion: `currIndex` is PhotoSwipe's, and
 * an index past the end of the array would otherwise print "undefined" over
 * the photograph.
 *
 * Registered through `uiRegister`, which is dispatched while the viewer's UI
 * is being assembled — so this has to be attached BEFORE `loadAndOpen`, for
 * the same reason `afterInit` does.
 */
export function registerTagCaption(
  lightbox: PhotoSwipeLightbox,
  captions: string[],
): void {
  lightbox.on("uiRegister", () => {
    lightbox.pswp?.ui?.registerElement({
      name: "gallery-tags",
      className: LIGHTBOX_TAG_CAPTION_CLASS,
      appendTo: "root",
      // Positioned at order: 9, which in photoswipe@5.4.4 (defaults:
      // counter 5, preloader 7, arrowPrev 10, zoom 10, arrowNext 11, close 20)
      // lands between preloader and arrowPrev in sort order. This position in
      // the sort list is moot visually because appendTo: "root" targets a
      // different container than the default controls, which all use
      // appendTo: "wrapper".
      order: 9,
      isButton: false,
      tagName: "p",
      onInit: (element, pswp) => {
        const show = () => {
          const caption = captions[pswp.currIndex] ?? "";
          element.textContent = caption;
          // `hidden`, not an empty string alone: the element has padding, so
          // an empty one still darkens a strip across the bottom of an
          // untagged photograph.
          element.hidden = caption === "";
        };
        /*
         * `change` ALONE IS ENOUGH, and that is a measured claim rather than
         * an assumption. The obvious extra `show()` call here — on the theory
         * that `change` only fires for slides after the first, so the
         * photograph the visitor clicked would open uncaptioned — is dead
         * code in photoswipe@5.4.4: `init()` reaches `goTo()` for the opening
         * slide after the UI has been registered, so this listener runs for
         * it too.
         *
         * Verified by deleting the extra call and watching the suite: nothing
         * failed, which is what identified it as dead. It was removed rather
         * than kept "just in case" — an unreachable line next to a comment
         * explaining the case it handles is a claim about behaviour that is
         * not true. If a future PhotoSwipe stops dispatching `change` on
         * open, "names the tags of the slide the visitor actually opened" in
         * lightbox.caption.test.ts fails, because it opens at index 2.
         */
        pswp.on("change", show);
      },
    });
  });
}

/**
 * The class the visible media caption carries (ugcportal-gwr), and the hook
 * its CSS is written against. Exported for the same reason
 * LIGHTBOX_TAG_CAPTION_CLASS is: a test asserts the string the viewer
 * actually renders.
 */
export const LIGHTBOX_MEDIA_CAPTION_CLASS = "pswp__media-caption";

/**
 * Stable element ids the dialog's `aria-labelledby`/`aria-describedby` point
 * at (ugcportal-gwr) — the pattern docs/design/lightbox.html's reference
 * sketch uses, with the title/caption pair it names adapted to the fields
 * this product actually has today. There is no separate title field
 * (out of scope for this bead), so the label is the photograph's own alt
 * text rather than a second string.
 *
 * MODULE-SCOPED CONSTANTS, not generated per open. PhotoSwipe tears down and
 * rebuilds its DOM on every `openGalleryViewer` call (a fresh `Lightbox`
 * instance per activation — see that function's own docstring), so there is
 * never more than one `.pswp` root in the document at a time for these ids to
 * collide inside.
 */
const MEDIA_TITLE_ID = "pswp__media-title";
const MEDIA_CAPTION_ID = "pswp__media-caption";

/**
 * The alt text for each slide, positionally — same arrangement as
 * `galleryTagCaptions` and `sizes`, so the three cannot come apart.
 *
 * `GalleryItem.altText` is already the finished string by this point —
 * sanitized and, for the rare published row without one, already carrying
 * `galleryItemAlt`'s own fallback — so this is a plain projection, not a
 * second place that decides what the text is.
 */
function galleryItemAltTexts(items: GalleryItem[]): string[] {
  return items.map((item, position) => galleryItemAlt(item, position));
}

/**
 * Puts the photograph's description and caption on the open slide, and wires
 * the dialog's `aria-labelledby`/`aria-describedby` to them (ugcportal-gwr).
 *
 * TWO ELEMENTS, NOT ONE, because the two questions an assistive-technology
 * user asks of a dialog are different: "what is this" (the label) and "what
 * does it say about itself" (the description). The first is `galleryItemAlt`
 * — already required to be non-empty for anything published, so the dialog
 * always has a name — rendered into a visually hidden (`sr-only`) heading,
 * because the photograph itself already conveys that description visually;
 * repeating it as on-screen text would be clutter the viewer does not need.
 * The second is the uploader's optional `caption`, visible, the same
 * "textContent only" rule `registerTagCaption` uses, for the same reason: a
 * caption containing `<script>` must render as inert text, never execute
 * (K2's XSS criterion).
 *
 * BOTH IDS ARE SET ONCE, not refreshed per slide. Only the elements'
 * `textContent` changes on `change`, matching `registerTagCaption` — the
 * dialog keeps pointing at the same two elements for its whole lifetime, and
 * screen readers re-read an `aria-labelledby`/`aria-describedby` target's
 * current text on each announcement, so there is nothing to re-wire.
 *
 * Positioned opposite the tag caption (`LIGHTBOX_TAG_CAPTION_CLASS` sits at
 * the slide's bottom) so the two visible bars never overlap: this one is
 * anchored to the top.
 */
export function registerMediaCaption(
  lightbox: PhotoSwipeLightbox,
  items: GalleryItem[],
): void {
  const altTexts = galleryItemAltTexts(items);
  const captions = items.map((item) => item.caption);

  lightbox.on("uiRegister", () => {
    lightbox.pswp?.ui?.registerElement({
      name: "gallery-media-title",
      className: "sr-only",
      appendTo: "root",
      order: 6,
      isButton: false,
      tagName: "h2",
      onInit: (element, pswp) => {
        element.id = MEDIA_TITLE_ID;
        const show = () => {
          element.textContent = altTexts[pswp.currIndex] ?? "";
        };
        pswp.on("change", show);
      },
    });

    lightbox.pswp?.ui?.registerElement({
      name: "gallery-media-caption",
      className: LIGHTBOX_MEDIA_CAPTION_CLASS,
      appendTo: "root",
      // Between preloader (7) and the tag caption (9) — see that element's
      // own note on why the sort position is moot visually (`appendTo:
      // "root"` targets a different container than the default controls).
      order: 8,
      isButton: false,
      tagName: "p",
      onInit: (element, pswp) => {
        element.id = MEDIA_CAPTION_ID;
        const show = () => {
          const caption = captions[pswp.currIndex] ?? "";
          element.textContent = caption;
          // `hidden`, not an empty string alone — the same reason the tag
          // caption does this: the element still carries padding, which would
          // otherwise darken a strip across an uncaptioned photograph.
          element.hidden = caption === "";
        };
        pswp.on("change", show);
      },
    });
  });

  // Set once the dialog root exists. `afterInit` is the same event
  // `openGalleryViewer` itself awaits, and it fires after `uiRegister`, so
  // both ids above are already on the page by the time this runs.
  lightbox.on("afterInit", () => {
    const element = lightbox.pswp?.element;
    if (!element) return;
    element.setAttribute("aria-labelledby", MEDIA_TITLE_ID);
    element.setAttribute("aria-describedby", MEDIA_CAPTION_ID);
    // PhotoSwipe sets role="dialog" itself but not this — and the mockup
    // this follows (docs/design/lightbox.html) has it on the same element.
    element.setAttribute("aria-modal", "true");
  });
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
 * How long the measurement may take, in total, before the rest is given up on.
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
 * module is already loaded; this one bounds real network round trips through a
 * route that proxies every byte through the Node process (ugcportal-a2l), with
 * the visitor looking at a grid that has not answered their click yet. Four
 * seconds is long enough that an ordinary slow response still arrives and
 * short enough that a stall does not read as a dead page.
 *
 * ONE DEADLINE FOR THE ACTIVATION, not one per item, and the difference is the
 * round-5 finding. Round 4 wrote this as a per-item bound and argued that "one
 * slow thumbnail costs that slide a bad frame" — sound, but only if the
 * per-item timers are independent, and they were not. See MEASURE_CONCURRENCY.
 * What the visitor experiences is the total wait, so that is what this bounds;
 * what protects an individual slide from a neighbour is the dispatch order and
 * the concurrency bound, not a private timer.
 */
const MEASURE_TIMEOUT_MS = 4_000;

/**
 * How many previews are measured at once.
 *
 * SIX, BECAUSE THE DEADLINE ABOVE HAS TO MEASURE A REQUEST RATHER THAN A PLACE
 * IN A QUEUE. A default page is 50 items, so the round-4 shape started fifty
 * `new Image()` loads — and fifty timers — simultaneously, while the browser
 * dispatches roughly six at a time to one origin and gives no priority to the
 * slide the visitor actually clicked. A request still queued when its private
 * deadline passed took UNKNOWN_PREVIEW_SIZE WITHOUT EVER HAVING BEEN SENT, so
 * the cost of a crowded page was not slowness, it was a squared slide — and on
 * a 50-item page it was the squared slide roughly 44 times out of 50, because
 * the activated index was as likely as any other to be at the back. That is a
 * different defect from ugcportal-8dn, which records the slowness of measuring
 * items nobody is looking at, not a wrong aspect ratio on the one they are.
 *
 * Bounding the dispatch here is what makes the timer start when the request
 * goes out, since nothing is handed to the browser until a slot frees. Six
 * matches what a browser will actually run against one origin over HTTP/1.1,
 * so the queue this replaces is the browser's own rather than an extra one.
 *
 * Paired with `measurementOrder`, which puts the activated index in the first
 * wave. Both halves are needed: the order alone would be leaning on the
 * browser dispatching in the sequence `src` was assigned, which is a
 * convention rather than a guarantee, and the bound alone would leave the
 * activated slide wherever in the list it happened to sit.
 */
export const MEASURE_CONCURRENCY = 6;

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
 * A RETURNED INSTANCE IS THE CALLER'S TO DESTROY, and nothing else is: every
 * other exit from this function destroys what it built before leaving. See the
 * note over the `try`/`finally` below for what the partial version of that
 * rule cost.
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
  /*
   * The open deadline. Injectable for the same reason `ensureSizes`'s is: a
   * test proving that a timed-out open leaves nothing behind should not have
   * to spend the real ten seconds doing it. The default is what production
   * uses, so there is no seam in the shipped path.
   */
  openTimeoutMs: number = OPEN_TIMEOUT_MS,
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

  // Also before `loadAndOpen`: `uiRegister` is dispatched while PhotoSwipe
  // assembles its controls, which happens inside the open.
  registerTagCaption(lightbox, galleryTagCaptions(items));
  // The photograph's description and caption, plus the dialog's
  // aria-labelledby/aria-describedby wiring (ugcportal-gwr).
  registerMediaCaption(lightbox, items);

  // Registered before `loadAndOpen`, because `afterInit` is dispatched from a
  // microtask continuation that a later `.on()` would already have missed.
  let stopWaiting = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PhotoSwipe did not finish opening")),
      openTimeoutMs,
    );
    stopWaiting = () => clearTimeout(timer);
    lightbox.on("afterInit", () => {
      stopWaiting();
      resolve();
    });
  });

  lightbox.init();

  /*
   * FROM HERE, EVERY EXIT OWNS THE INSTANCE. The totality is the fix — not a
   * third special case beside the two that already cleaned up. `init()` is the
   * line after which there is something to own, and the rule below is the
   * whole of the policy: THE CALLER OWNS THE LIGHTBOX IF AND ONLY IF THIS
   * FUNCTION RETURNS IT. Stand-down, refusal, timeout, or any throw — the
   * `finally` destroys it.
   *
   * Three exits used to fall through that rule, and the timeout was the one
   * with teeth. `loadAndOpen` returns TRUE and then does the real work later,
   * inside `preload`'s `.then`, so a rejection at `openTimeoutMs` left an
   * instance with `shouldOpen` still set and no reference to it anywhere: it
   * never reached `viewer.current`, so gallery.tsx's unmount cleanup had
   * nothing to take down, and the late `_openPhotoswipe` then put a
   * full-screen overlay on `document.body` that nothing in the application
   * could remove. `activate`'s `.catch` swallowed the rejection into the
   * bargain, because by that point `isViewerOpen()` answered true.
   *
   * `destroy()` is what closes it, on both halves: it forwards to
   * `pswp?.destroy()` for the case where the viewer did mount, and it sets
   * `shouldOpen = false`, which `preload`'s `.then` re-reads before calling
   * `_openPhotoswipe` — so an open that has been FILED but not yet performed
   * is cancelled rather than orphaned. On the refusal path it touches nothing
   * else: `this.pswp` is undefined there, and the viewer that IS open belongs
   * to a different instance.
   */
  let handedOver = false;
  try {
    // Re-checked immediately before the one irreversible step. Between the
    // check after the imports and this line there is only synchronous
    // construction, so in practice the two agree — but `loadAndOpen` is the
    // call that puts a viewer on screen, and the guard belongs against it
    // rather than near it.
    if (!isCurrent()) return null;

    if (!lightbox.loadAndOpen(index)) {
      throw new Error("a viewer is already open");
    }
    await opened;

    handedOver = true;
    return lightbox;
  } finally {
    // `opened` stays permanently pending on the exits that never awaited it,
    // which is correct and not a leak: nothing holds it, and clearing the
    // timer is what stops it rejecting into nobody's hands later.
    stopWaiting();
    if (!handedOver) lightbox.destroy();
  }
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
 * THE ACTIVATED SLIDE IS MEASURED FIRST AND THE REST ARE DISPATCHED A FEW AT A
 * TIME, which is the round-5 correction and is about correctness rather than
 * speed. Round 4 gave each item a private deadline on the reasoning that "one
 * slow thumbnail costs that slide a bad frame". The trade was right; the
 * implementation did not deliver it, because the timers were not independent:
 * fifty were started at once against a browser that dispatches about six, so
 * the ones at the back expired while still queued and took the fallback
 * without ever having been requested — and the slide the visitor was looking
 * at was as likely as any other to be one of them. See MEASURE_CONCURRENCY.
 *
 * So `activeIndex` goes out in the first wave. Whatever else this gives up to
 * the deadline, it does not give up the photograph that was actually clicked.
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
 * WHAT THE DEADLINE COSTS, said plainly: on a page whose previews are all
 * stalled, the items behind the first wave are never dispatched at all and
 * every one of them takes the fallback. That is not a regression — under the
 * round-4 shape they were queued in the browser and took the fallback too —
 * but it is the reason the ordering above is load-bearing rather than a
 * refinement. Nothing here promises that a slide the visitor swipes to five
 * slides later was measured.
 *
 * KNOWN GAP (ugcportal-8dn): this still measures EVERY item, not just the one
 * being opened, so an activation waits on previews nobody is looking at.
 * Adding `loading="lazy"` to the tiles widened that gap rather than narrowing
 * it, and the trade is deliberate: a tile below the fold is now never
 * requested until it is scrolled to, so its size is a real network round trip
 * here rather than a cache hit. Paying it on the rare activation is worth not
 * firing fifty proxied requests at first paint — but it is the reason 8dn is
 * worth doing, not a reason to have left the tiles eager. The bounds above cap
 * what that gap can cost; they do not close it.
 */
export async function ensureSizes(
  items: GalleryItem[],
  cache: Map<string, PixelSize>,
  /*
   * The slide the visitor asked for, so it can be measured before the rest.
   * Defaults to the first item, which is what a caller with no particular
   * slide in mind is showing anyway.
   */
  activeIndex: number = 0,
  /*
   * How a size is read when the cache has none. Injectable for one reason:
   * `measureImage` below decodes a real image, which no headless environment
   * does, so the CACHING POLICY — the part with a bug in it — would otherwise
   * be untestable and was. The default is the real thing, so production has no
   * seam; the tests supply a measurer that can fail or stall on demand.
   */
  measure: (src: string) => Promise<PixelSize | null> = measureImage,
  /*
   * The deadline for the whole batch. Injectable so a test can prove the bound
   * exists without spending the real four seconds to do it — the default is
   * the one production uses.
   */
  timeoutMs: number = MEASURE_TIMEOUT_MS,
): Promise<PixelSize[]> {
  const sizes = new Array<PixelSize | undefined>(items.length).fill(undefined);

  // Cached items cost nothing and must not take a slot from one that would.
  const queue: number[] = [];
  for (const position of measurementOrder(items.length, activeIndex)) {
    const known = cache.get(items[position].previewSrc);
    if (known !== undefined) sizes[position] = known;
    else queue.push(position);
  }

  /*
   * The batch deadline, started once. `overdue` is registered on it before any
   * measurement is, so a worker's `while` sees the expiry on the same tick the
   * measurement it was waiting on resolves null — it stops pulling work rather
   * than starting one more request nobody will wait for.
   */
  let stopWaiting = () => {};
  const expired = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    stopWaiting = () => clearTimeout(timer);
  });
  let overdue = false;
  void expired.then(() => {
    overdue = true;
  });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length && !overdue) {
      const position = queue[next];
      next += 1;
      const item = items[position];
      const measurement = await measureBefore(
        () => measure(item.previewSrc),
        expired,
      );
      // Covers "the browser could not read a size" and "the request never
      // answered" on the same path, deliberately: neither is a fact about the
      // image, so neither is cached and the next activation asks again.
      if (measurement === null) {
        sizes[position] = UNKNOWN_PREVIEW_SIZE;
        continue;
      }
      cache.set(item.previewSrc, measurement);
      sizes[position] = measurement;
    }
  };

  try {
    await Promise.all(
      /*
       * Not injectable, deliberately: a caller who could pass 0 here would
       * turn every slide in the gallery into a square and nothing would say
       * so. The tests read MEASURE_CONCURRENCY instead, which is the number
       * production uses, so what they assert is the shipped bound rather than
       * one they chose.
       */
      Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, worker),
    );
  } finally {
    stopWaiting();
  }

  // Everything the deadline cut off before it was ever dispatched.
  return sizes.map((size) => size ?? UNKNOWN_PREVIEW_SIZE);
}

/**
 * Positions to measure, the activated one first and the rest in order.
 *
 * Its own function so the rule is testable without a measurer, and because
 * "first" has to survive an index the caller got wrong: a list is rendered
 * from the same array the index came from, but this is the one place where a
 * stale index would silently demote the slide it was supposed to promote. An
 * out-of-range or non-integer index clamps rather than dropping an item.
 */
function measurementOrder(count: number, activeIndex: number): number[] {
  const first =
    count === 0 || !Number.isFinite(activeIndex)
      ? -1
      : Math.min(Math.max(Math.trunc(activeIndex), 0), count - 1);
  const order: number[] = first >= 0 ? [first] : [];
  for (let position = 0; position < count; position += 1) {
    if (position !== first) order.push(position);
  }
  return order;
}

/**
 * `measure()`, resolving null once the batch deadline has passed.
 *
 * The deadline resolves NULL — the same value the measurer itself uses for "no
 * size could be read" — so an abandoned measurement lands on the fallback path
 * `ensureSizes` already has, instead of needing a second one.
 *
 * A REJECTION IS STILL PROPAGATED rather than folded into that null. This
 * bounds the WAIT and changes nothing about what counts as a failure: a
 * measurer that throws is a bug in the measurer, and turning every such bug
 * into a silently squashed slide is how it would go unnoticed. `measureImage`
 * does not throw, so in production only the deadline arm is reachable.
 *
 * Both of the measurement's outcomes are handled even when the deadline won,
 * which is why the losing arm is a no-op resolve rather than a dangling
 * promise: a measurer that rejects after the batch gave up would otherwise be
 * an unhandled rejection.
 *
 * The abandoned promise is not cancellable — there is no abort signal on an
 * `<img>` load — so a stalled measurement keeps its own closure alive until
 * the browser gives up on the request. One dead closure per stalled preview,
 * for the lifetime of a page view, is the price of not hanging the viewer.
 */
function measureBefore(
  measure: () => Promise<PixelSize | null>,
  expired: Promise<void>,
): Promise<PixelSize | null> {
  return new Promise<PixelSize | null>((resolve, reject) => {
    void expired.then(() => resolve(null));
    measure().then(
      (size) => resolve(size),
      (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
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
