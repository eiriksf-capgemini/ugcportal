"use client";

import type PhotoSwipeLightbox from "photoswipe/lightbox";
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  GALLERY_GRID_CLASS,
  GALLERY_STATE_CONTAINER_CLASS,
  GALLERY_TILE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
} from "@/components/gallery/containment";
import {
  GalleryItemCaption,
  GalleryItemTags,
} from "@/components/gallery/gallery-item";
import {
  createActivationGate,
  ensureSizes,
  isViewerOpen,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { Button } from "@/components/ui/button";
import {
  appendGalleryItems,
  galleryItemAlt,
  galleryItemLabel,
  isGenuinelyEmptyPage,
  toGalleryItems,
  type GalleryItem,
} from "@/lib/gallery-items";
import { publicMediaListingPath } from "@/lib/routes";

/**
 * The public gallery (ugcportal-71y): a grid of watermarked previews, a
 * PhotoSwipe lightbox, and cursor pagination over GET /api/public/media.
 *
 * The first page is rendered on the server (src/app/page.tsx) and handed in as
 * props, so the gallery is visible without JavaScript and without a loading
 * flash. Everything after it is fetched here. The two halves go through the
 * same mapping function (src/lib/gallery-items.ts) so they cannot disagree
 * about the shape of a row.
 *
 * This component renders into the app shell's single <main>
 * (src/components/app-shell.tsx). It does not, and must not, introduce a
 * second one.
 */

export type GalleryProps = {
  initialItems: GalleryItem[];
  initialCursor: string | null;
  initialHasMore: boolean;
};

type LoadState = "idle" | "loading" | "error";

export function Gallery({
  initialItems,
  initialCursor,
  initialHasMore,
}: GalleryProps) {
  const [items, setItems] = useState<GalleryItem[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  /*
   * Both halves of the server's contract, kept together deliberately.
   *
   * listMedia sets `hasMore: nextCursor !== null`, so the two always agree
   * there — but this state is also written from a parsed HTTP body, where
   * they might not. Requiring a cursor as well as the flag means a response
   * claiming `hasMore: true` with no cursor renders as the end of the list
   * rather than as a button that can never do anything.
   */
  const [hasMore, setHasMore] = useState<boolean>(
    initialHasMore && initialCursor !== null,
  );
  const [loadState, setLoadState] = useState<LoadState>("idle");
  /** Set when the viewer itself could not be opened — see `activate`. */
  const [viewerFailed, setViewerFailed] = useState(false);

  /**
   * Intrinsic pixel size per preview URL, filled in by the tiles themselves as
   * they load. PhotoSwipe needs a width and a height for every slide before it
   * will load one at all (see ensureSizes), and the feed cannot supply them:
   * the anonymous projection carries no dimensions, and `mimeType`/`sizeBytes`
   * are deliberately withheld and describe the original anyway.
   *
   * A ref, not state: nothing here should re-render the grid.
   */
  const measured = useRef(new Map<string, PixelSize>());

  const remember = useCallback((src: string, image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      measured.current.set(src, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    }
  }, []);

  /**
   * Which activation the visitor actually wants: the most recent one.
   *
   * Opening is not instantaneous. `ensureSizes` can wait on a network round
   * trip (ugcportal-8dn), and the first activation also downloads two
   * JavaScript chunks — all of it with the grid still clickable, because
   * nothing covers it until the viewer appears. Two clicks in that window are
   * ordinary, not pathological.
   *
   * Left unguarded, the second click was worse than ignored. Both activations
   * reached `loadAndOpen`, which does NOT serialise them — `window.pswp` is
   * only assigned later, inside `preload`'s `.then` — so both were accepted,
   * the earlier one won, and the later one's `afterInit` never fired. The
   * visitor got the FIRST photograph they clicked and, ten seconds later, an
   * error message about a viewer that was open and working.
   *
   * WHAT MATTERS IS THE SPAN, NOT THE GUARD. The round-2 version of this had a
   * counter and checked it once, before the awaits — so it read correct and
   * covered none of the window the race lives in. The predicate is now handed
   * down into `openGalleryViewer` and re-checked after its imports and again
   * against `loadAndOpen` itself.
   */
  const activations = useRef(createActivationGate());

  /**
   * The viewer that is on screen right now, so it can be taken down.
   *
   * PhotoSwipe appends its root to `document.body` — OUTSIDE React's tree — so
   * React unmounting this component removes the grid and leaves the overlay
   * exactly where it was. A visitor reaches that without trying: press Back
   * with the lightbox open and, because there is no history integration, Back
   * is an ordinary client-side navigation rather than a close. The next page
   * then renders underneath a full-screen `.pswp` overlay, with `window.pswp`
   * still set — which also makes every later activation a silent no-op, since
   * `loadAndOpen` refuses while it is set. Nothing but a reload recovers.
   *
   * So the instance `openGalleryViewer` hands back is kept instead of
   * discarded. A ref rather than state: it must not re-render the grid, and
   * the cleanup has to read the LATEST instance rather than one captured at
   * mount.
   *
   * At most one stale entry is held — a viewer the visitor closed themselves,
   * which the next activation overwrites. Calling `destroy()` on one of those
   * is a no-op (its `pswp` is already undefined), so nothing needs to clear it
   * on close. Registering a `destroy` listener to do so would mean touching
   * the one event this feature already blew the stack on; see lightbox.ts.
   */
  const viewer = useRef<PhotoSwipeLightbox | null>(null);

  /**
   * Set once this component is gone, and asked at every await in the open path.
   *
   * SUPERSESSION AND TEARDOWN ARE DIFFERENT QUESTIONS, which is why this is
   * not folded into the gate above. "A newer click superseded you" means stand
   * down and leave the viewer that replaced you alone. "This component is
   * gone" means there must be no viewer at all afterwards. Answer the second
   * with the first and an older activation would tear down a viewer the newer
   * one is using; answer the first with the second and Back would leave the
   * overlay up.
   *
   * WHAT MATTERS IS THE SPAN, and this path has four awaits, not one:
   * `ensureSizes`, then inside `openGalleryViewer` two dynamic imports and
   * PhotoSwipe's own initialisation. An unmount can land in any of them. So
   * this is folded into the predicate handed DOWN to `openGalleryViewer`,
   * which re-checks it after its imports and again immediately before
   * `loadAndOpen`; and because the last window ends with a viewer already
   * constructed and on screen, `openLightbox` asks once more after the open
   * resolves and destroys what it was handed. A check that stopped at the
   * first await would read correct and cover one window out of four.
   */
  const tornDown = useRef(false);

  /**
   * Where keyboard focus goes once "Load more" vanishes (ugcportal-jx4 K2).
   *
   * `{hasMore ? <Button/> : null}` unmounts the very element that was just
   * activated, and React does not move focus anywhere when that happens —
   * it falls to `<body>`, and the next Tab restarts the page at the skip
   * link. The paging status line (`GalleryPaging`'s polite live region,
   * already announcing "Showing all N photographs.") is a sensible,
   * always-present landing spot — UNLIKE the button, it is never
   * conditionally rendered, so `pagingStatusRef.current` is already the
   * final element by the time the layout effect below can act on it, with
   * no need to wait for a later render the way the button's own ref would.
   *
   * `tabIndex={-1}` on that paragraph (below, in `GalleryPaging`) is what
   * makes it a valid `.focus()` target without adding it to the Tab order.
   */
  const pagingStatusRef = useRef<HTMLParagraphElement>(null);

  /**
   * Whether the visitor was still on "Load more" when its request finished,
   * so the layout effect below knows whether to hand focus to the paging
   * status line once the button it came from unmounts (ugcportal-jx4 K2;
   * split from a single inline check into this ref plus the effect per
   * ugcportal-dj4i item 3).
   *
   * Set inside `loadMore`, at request-completion time, not at click time:
   * see the comment on that assignment for why the two give different
   * answers whenever a visitor tabs away while the request is in flight,
   * and gallery.focus.test.tsx's "K2 guard" tests for what that difference
   * guards.
   */
  const shouldFocusStatusRef = useRef(false);

  useEffect(() => {
    /*
     * Reset on mount as well as set on unmount. React's StrictMode mounts,
     * unmounts and remounts every component in development, so a flag that
     * only ever went true would leave the remounted gallery permanently unable
     * to open anything — a fix for Back that broke every dev session instead.
     */
    tornDown.current = false;
    return () => {
      tornDown.current = true;
      const live = viewer.current;
      viewer.current = null;
      /*
       * `destroy()`, not `pswp.close()`. Close plays the hide animation, and
       * there is nothing left for it to play over; worse, it is asynchronous,
       * so the overlay would still be up for the duration. `destroy()` is
       * immediate: it forwards to `pswp?.destroy()`, which clears
       * `window.pswp` through the listener PhotoSwipe registers on itself, and
       * it sets `shouldOpen = false` — which additionally cancels an open that
       * `loadAndOpen` has filed but whose `preload().then` has not run yet.
       */
      live?.destroy();
    };
  }, []);

  /**
   * The K2 handoff's "act" half (ugcportal-dj4i item 3) — keyed on `hasMore`,
   * so it re-runs only on mount and whenever `hasMore` actually changes value
   * (the dependency array means React skips it on every OTHER render, not
   * that it runs only once: it still runs once at mount in addition to each
   * later change). `shouldFocusStatusRef` defaults to `false`, so a mount
   * where `hasMore` already starts `false` (a gallery with no further page
   * from the first render) runs this at mount and does nothing — there is
   * no click yet to have set the ref.
   *
   * A layout effect, not an ordinary one: it runs synchronously after React
   * commits the re-render that unmounts the button, before the browser
   * paints, which is the same timing a real focus handoff needs (compare
   * `app-shell.tsx`'s skip link, also a programmatic `.focus()` on commit).
   */
  useLayoutEffect(() => {
    if (hasMore) return;
    if (shouldFocusStatusRef.current) {
      pagingStatusRef.current?.focus();
    }
    shouldFocusStatusRef.current = false;
  }, [hasMore]);

  const openLightbox = useCallback(
    async (index: number, isLive: () => boolean) => {
      // `index` is not decoration: it is what puts the slide the visitor
      // clicked in the first wave of measurements rather than somewhere in a
      // queue of fifty, which is the difference between the right aspect ratio
      // and a squared frame on the one photograph they asked for. See
      // MEASURE_CONCURRENCY in lightbox.ts.
      const sizes = await ensureSizes(items, measured.current, index);
      // Someone clicked again while we were measuring, or the gallery went
      // away underneath us. Their open is the one that should happen — or none
      // should — and this one must not also fire, or PhotoSwipe gets two
      // overlapping requests and answers the earlier of them.
      if (!isLive()) return;
      // Handed DOWN rather than checked once here: openGalleryViewer awaits two
      // dynamic imports of its own, and on the first activation that is a real
      // chunk download with the grid still clickable underneath. A guard that
      // stops at this line leaves the window where the race actually lives
      // unguarded — which is what the round-2 version of this did.
      const opened = await openGalleryViewer(items, sizes, index, isLive);
      // null is "this activation stood down": nothing was constructed, so
      // there is nothing to own and nothing to take down.
      if (opened === null) return;
      if (tornDown.current) {
        /*
         * The last window, and the only one a predicate cannot cover: between
         * `loadAndOpen` and PhotoSwipe reporting itself initialised, the
         * overlay is on screen but no reference to it has reached this
         * component yet — so the unmount cleanup above ran and found nothing
         * to destroy. Take it down here, at the first instant that is
         * possible, rather than handing it to a ref nobody will read again.
         *
         * NO TEST DRIVES THIS BRANCH, and that is a fact about the window
         * rather than a gap in the suite. In photoswipe@5.4.4 the window is
         * microtasks wide and nothing else: `preload` awaits a `Promise.all`
         * over an ALREADY-RESOLVED module (the core is handed over as a class,
         * see lightbox.ts), and `_openPhotoswipe` then constructs, registers
         * and `init()`s synchronously, dispatching `afterInit` before control
         * returns to the event loop. A React unmount is a task, so it cannot
         * land inside. Kept anyway, because what makes it unreachable is a
         * detail of a vendored library — an `openPromise` option, or a future
         * version that awaits anything in `preload`, reopens it — and the cost
         * of keeping it is four lines.
         */
        opened.destroy();
        return;
      }
      viewer.current = opened;
    },
    [items],
  );

  /**
   * Opens the viewer, and says so when it cannot.
   *
   * `openGalleryViewer` resolves when the viewer is actually open and rejects
   * when it is not — see the long note in lightbox.ts for why that took
   * arranging. A dynamic `import()` fails on a flaky connection and on a stale
   * tab whose chunk a deploy has replaced; left unobserved, that is an
   * unhandled rejection plus a button that visibly does nothing, which is the
   * worst pair, since the visitor gets no reason and the log gets no context.
   *
   * The wording matters too: the photograph is on screen and perfectly fine,
   * so the message says the VIEWER failed rather than implying the item is
   * broken.
   */
  const activate = useCallback(
    (index: number) => {
      const isCurrent = activations.current.begin();
      /*
       * One predicate, both questions, because every checkpoint in the open
       * path has to ask both: "is this still the activation the visitor wants"
       * and "is this gallery still here". See `tornDown` for why they are not
       * the same thing.
       */
      const isLive = () => isCurrent() && !tornDown.current;
      setViewerFailed(false);
      openLightbox(index, isLive).catch(() => {
        // Three conditions now, and none is redundant. A superseded activation
        // must not paint an error over the viewer that replaced it; an
        // unmounted gallery must not report anything at all, since the only
        // thing that could read the message is gone; and no activation should
        // announce "could not open the viewer" while a viewer is plainly on
        // screen, whatever the sequencing says. Telling a visitor something
        // failed while they are looking at it working is worse than saying
        // nothing.
        if (isLive() && !isViewerOpen()) setViewerFailed(true);
      });
    },
    [openLightbox],
  );

  const loadMore = useCallback(
    async (button: HTMLButtonElement) => {
      if (cursor === null || loadState === "loading") return;
      setLoadState("loading");
      try {
        const response = await fetch(publicMediaListingPath({ cursor }), {
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`the gallery feed answered ${response.status}`);
        }
        const payload: unknown = await response.json();
        const page = readListingPage(payload);
        const nextHasMore = page.hasMore && page.nextCursor !== null;
        setItems((current) => appendGalleryItems(current, page.items));
        setCursor(page.nextCursor);
        setHasMore(nextHasMore);
        setLoadState("idle");
        if (!nextHasMore) {
          /*
           * `button` is the click event's own `currentTarget` (passed in by
           * the caller below, ugcportal-dj4i item 4) — it identifies the
           * control this request was issued from without a persistent ref
           * dedicated to that one comparison. The comparison itself still
           * has to happen HERE, not in the click handler: only "was the
           * visitor on the button when this request STARTED" is knowable
           * there, and the guard this gates (gallery.focus.test.tsx's "K2
           * guard" describe blocks) needs "was the visitor on the button
           * when it FINISHED" — a visitor who tabs away while the request is
           * in flight must be left alone, not chased.
           *
           * Checked synchronously here, before this function returns and
           * React gets a chance to commit the re-render that removes the
           * button: nothing else runs between the state updates above and
           * this line, so `document.activeElement` still reflects whatever
           * the visitor's last actual action left it as. The actual
           * `.focus()` call reads this ref from the `useLayoutEffect` above,
           * once `hasMore` turning `false` actually commits — this line only
           * decides whether that effect should act.
           *
           * No `=== document.body` branch (round-4 review finding; an
           * earlier version had one, reasoning it meant "the button already
           * unmounted"). That reasoning doesn't hold AT THIS POINT: nothing
           * has unmounted yet, this check runs strictly before the state
           * updates above are committed — so `activeElement === body` here
           * means only "nothing was ever focused in the first place", the
           * ordinary case for a plain mouse click (Safari does not focus a
           * button on click, and neither does jsdom's synthetic click here).
           * Treating that as "move focus" would hand a mouse visitor an
           * unrequested focus ring on the status line.
           *
           * WHAT MATTERS IS THAT NOTHING AWAITS BETWEEN THE STATE UPDATES
           * ABOVE AND THIS CHECK — the same shape as `tornDown` and
           * `activations` further up this file: `setHasMore`/`setLoadState`
           * above are synchronous calls that QUEUE a re-render, they do not
           * commit one. An `await` inserted anywhere between them and
           * `document.activeElement` here would let React commit that
           * re-render in the gap, unmounting `button` for real before this
           * line ran — at which point `document.activeElement` can no
           * longer equal it regardless of where focus actually was, which
           * would silently stop recognising the visitor who was genuinely
           * still on the button, for a reason entirely unrelated to where
           * their focus was.
           */
          shouldFocusStatusRef.current = document.activeElement === button;
        }
      } catch {
        // Deliberately keeps `cursor` and `hasMore` as they were, so the retry
        // asks for the same page rather than silently skipping it.
        setLoadState("error");
      }
    },
    [cursor, loadState],
  );

  /*
   * Decided by the shared `isGenuinelyEmptyPage` (src/lib/gallery-items.ts;
   * ugcportal-3wcd consolidated this from an inline copy of the same
   * expression), not `items.length === 0` alone — see that function's own
   * comment for why: "there is nothing published" and "this page happened
   * to be empty" are different claims, and conflating them would strand a
   * visitor on the first with no way to ask for the rest. `items` here is
   * already `toGalleryItems(...)`-filtered and `hasMore` already folds in
   * the cursor check above (see its own `useState` initializer) — the same
   * two inputs this component always evaluated the expression over; only
   * the implementation moved.
   */
  if (isGenuinelyEmptyPage(items, hasMore)) {
    return <GalleryEmpty />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {/*
        The page's heading, and the reason it is here rather than assumed.

        app-shell.tsx's skip link moves focus to <main> and its comment reasons
        about landing "past the <h1> on both admin screens" — i.e. the shell
        takes for granted that a page HAS one. The gallery shipped without:
        every heading level below h1 was absent too, so the document outline
        began at the grid, and the empty state was the only branch that kept a
        heading at all.

        "Gallery", not a repeated description (ugcportal-14k9 PR #94 review,
        two rounds of the same mistake worth recording both of): round 1
        found this heading repeating SITE_DESCRIPTION, which by then
        duplicated the header's own new SITE_TAGLINE in different words.
        Round 1's fix switched it TO SITE_TAGLINE - which round 2 then found
        duplicates the header's tagline WORD FOR WORD a few dozen pixels
        below it, since src/components/site-header.tsx renders that exact
        same constant. Neither "say it differently" nor "say it the same way
        twice" was right; the actual fix is to stop this heading from
        restating site-wide copy at all. "Gallery" names what THIS page is
        rather than what the site is - the same word the header's own nav
        link already uses for this destination (src/components/site-
        header.tsx's NAV_ITEMS), so it cannot drift into being a second
        description no matter how either SITE_TAGLINE or SITE_DESCRIPTION's
        wording changes later. src/app/page.test.tsx's regression test
        asserts the tagline sentence appears exactly once on the rendered
        page (through AppShell, not just this component in isolation) for
        exactly this reason - a heading-text change here is not something a
        component-only test would have caught either time.
      */}
      <h1 className="max-w-2xl text-xl leading-tight font-medium tracking-tight text-balance text-foreground sm:text-2xl">
        Gallery
      </h1>

      <ul className={`mt-6 ${GALLERY_GRID_CLASS}`}>
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={GALLERY_TILE_CLASS}
              aria-label={galleryItemLabel(item, index)}
              data-gallery-tile={item.id}
              onClick={() => activate(index)}
            >
              {/*
                A plain <img>, not next/image, and on purpose.
                These bytes are already proxied through a Node route
                (ugcportal-a2l serves them so the storage key never reaches the
                browser); next/image would add a second proxy hop over the
                first. Its other draw — srcset and lazy loading — needs
                derivatives that do not exist yet and belongs to ugcportal-dex,
                which also owns the per-upload memory budget that generating
                them would move.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.previewSrc}
                /*
                  The REAL alt text (ugcportal-gwr K1/K2), not "" — this is the
                  attribute discoverability tooling (search, llms.txt) and a
                  text-only or image-failed render actually read, independently
                  of what any screen reader announces. `aria-hidden` below is
                  what stops that second channel, not an empty alt: the button
                  already carries the accessible name, so without aria-hidden
                  the two would announce the same photograph twice, not once
                  correctly and once as nothing.
                */
                alt={galleryItemAlt(item, index)}
                className={GALLERY_TILE_IMAGE_CLASS}
                /*
                  The default page is 50 items, and on a phone roughly 46 of
                  them are below the fold — so without this, first paint opens
                  up to 50 simultaneous requests against a route that PROXIES
                  every byte through the Node process rather than redirecting
                  to storage (ugcportal-a2l). `loading` and `decoding` cost
                  nothing and need no new derivatives; that is what separates
                  them from `srcset`, which does and is ugcportal-dex's.
                */
                loading="lazy"
                decoding="async"
                // The button carries the accessible name; the image inside it
                // would otherwise announce the same thing twice.
                aria-hidden="true"
                draggable={false}
                onLoad={(event) => remember(item.previewSrc, event.currentTarget)}
              />
            </button>
            <GalleryItemCaption item={item} />
            <GalleryItemTags item={item} />
          </li>
        ))}
      </ul>

      <GalleryPaging
        hasMore={hasMore}
        loadState={loadState}
        viewerFailed={viewerFailed}
        count={items.length}
        statusRef={pagingStatusRef}
        onLoadMore={(event) => {
          void loadMore(event.currentTarget);
        }}
      />
    </div>
  );
}

/**
 * `GalleryItemCaption` and `GalleryItemTags` used to live here (ugcportal-gwr,
 * ugcportal-jsc), and round 1 of ugcportal-qnq9.7 exported them for
 * `PortfolioTile` to reuse. Round 2 moved the implementations to
 * src/components/gallery/gallery-item.tsx, a plain module with no
 * `"use client"` — this file's own `"use client"` pulls its entire client
 * bundle (PhotoSwipe, `Gallery`'s state) along with anything imported from
 * it, which /about and /portfolio have no reason to pay for. Both are
 * imported from there above and used exactly as before in this file's own
 * render, below.
 */

/**
 * The whole-page "nothing published" state. Its sibling, `GalleryUnavailable`
 * — what renders instead when the listing itself failed rather than coming
 * back empty (ugcportal-0dh) — lives in its own module, gallery-unavailable.tsx,
 * rather than here: this file is `"use client"`, which is unavoidable for
 * THIS component (it is reachable from `Gallery`'s own client-side render,
 * below) but is not true of `GalleryUnavailable`, which is never rendered by
 * `Gallery` at all. See that module's docstring for why it stays out of this
 * one's client bundle.
 */
function GalleryEmpty() {
  return (
    <div className={GALLERY_STATE_CONTAINER_CLASS} data-gallery-state="empty">
      <h1 className="max-w-2xl text-2xl leading-tight font-medium tracking-tight text-balance text-foreground sm:text-3xl">
        Nothing is published yet.
      </h1>
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Photographs appear here as soon as they are published. Nothing is
        hidden from you — the gallery is genuinely empty.
      </p>
    </div>
  );
}

/**
 * "1 photograph", "2 photographs".
 *
 * A gallery with exactly one published item is not a corner case worth
 * shrugging at — it is what this gallery looks like on its first day, and
 * "Showing all 1 photographs." was what it said.
 */
function photographs(count: number): string {
  return count === 1 ? "1 photograph" : `${count} photographs`;
}

/** What the paging region says, given the state it is in. */
function pagingMessage(
  loadState: LoadState,
  hasMore: boolean,
  count: number,
): string {
  if (loadState === "loading") return "Loading more photographs…";
  if (loadState === "error") {
    return "Could not load more photographs. Check your connection and try again.";
  }
  if (hasMore) return `Showing ${photographs(count)}.`;
  // "Showing all 1 photograph." is grammatical and still reads oddly, so the
  // single-item end-of-list gets its own sentence rather than a pluralisation
  // trick.
  return count === 1
    ? "Showing the only photograph."
    : `Showing all ${count} photographs.`;
}

/**
 * The end of the grid: the load-more control, the busy announcement and the
 * error state, or the end-of-list note.
 *
 * TWO live regions, not one, and they are always in the DOM. Always-present
 * because a live region inserted at the same moment as its text is frequently
 * not announced at all. Separate because they report unrelated things, and
 * sharing one made the viewer error SUPPRESS paging entirely: `viewerFailed`
 * is cleared only by the next activation, and it was the first branch of a
 * single ternary, so after one failed open every "Loading more photographs…"
 * and every "Showing all N photographs." went unannounced for the rest of the
 * session. Two regions, each answering for itself.
 */
function GalleryPaging({
  hasMore,
  loadState,
  viewerFailed,
  count,
  statusRef,
  onLoadMore,
}: {
  hasMore: boolean;
  loadState: LoadState;
  viewerFailed: boolean;
  count: number;
  statusRef: RefObject<HTMLParagraphElement | null>;
  onLoadMore: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="mt-8 flex flex-col items-center gap-3">
      {/*
        Assertive, and rendered empty when there is nothing wrong: this
        answers an action the visitor just took and got no response to, which
        is the case a polite queue is wrong for.
      */}
      <p aria-live="assertive" className="text-sm text-destructive">
        {viewerFailed
          ? "Could not open the viewer. The photograph itself is fine — reload the page and try again."
          : ""}
      </p>
      {/*
        `tabIndex={-1}` and `ref={statusRef}` (ugcportal-jx4 K2): not in the
        Tab order, but a valid `.focus()` target, so `Gallery` can hand focus
        here once the "Load more" button it was on has unmounted. Still an
        ordinary polite live region otherwise — the ref does not change what
        it announces, only that it can also be focused deliberately.

        `outline-hidden` + an explicit `focus:ring` (round-1 review finding,
        ugcportal-jx4), not `outline-none` alone. `outline-none` drops the
        outline unconditionally, including the forced-colors fallback outline
        a real browser substitutes when every other outline is suppressed —
        `outline-hidden` is this repo's existing idiom for keeping that
        fallback (see src/components/app-shell.tsx's `<main>`, the skip
        link's own programmatic-focus target). And the ring is `focus:`, not
        `focus-visible:` like Button's own ring (src/components/ui/button.tsx)
        — deliberately, because the input that led here is a MOUSE click on
        "Load more", and a browser's `:focus-visible` heuristic keys off the
        last input modality rather than off whether the focus move was
        programmatic, so it is not reliable for a `.focus()` call that
        follows a click. `focus:` paints the ring unconditionally whenever
        this element is the one focused, which is exactly the case here.
      */}
      <p
        aria-live="polite"
        className="rounded-sm text-sm text-muted-foreground outline-hidden focus:ring-3 focus:ring-ring/80"
        ref={statusRef}
        tabIndex={-1}
      >
        {pagingMessage(loadState, hasMore, count)}
      </p>
      {hasMore ? (
        <Button
          type="button"
          size="lg"
          variant={loadState === "error" ? "outline" : "default"}
          /*
            `disabled` + `focusableWhenDisabled` (ugcportal-jx4 K1/K3), not
            `disabled` alone. A plain `disabled` button is pulled out of the
            accessibility tree AND the Tab order the instant React applies
            it — mid-click, since this is the click handler's own state
            update — so focus resets to <body> and the next Tab restarts at
            the skip link. `focusableWhenDisabled` (base-ui's own escape
            hatch for exactly this) keeps the element tabbable and renders
            `aria-disabled="true"` instead of the native attribute, while
            still blocking the click/keydown activation handlers that
            `disabled` always blocked — see useButton.ts's `getButtonProps`.
            `loadMore`'s own `loadState === "loading"` guard (K3) is kept
            regardless, so a request that slips through some other path
            (e.g. a form submit) still cannot double up.

            No `className` override for the dimmed/non-interactive look:
            `buttonVariants` itself pairs `aria-disabled:pointer-events-none
            aria-disabled:opacity-50` with its existing `disabled:` pair
            (ugcportal-jx4 round-2 review finding), so every
            `focusableWhenDisabled` button gets this for free.
          */
          disabled={loadState === "loading"}
          focusableWhenDisabled
          aria-busy={loadState === "loading"}
          onClick={onLoadMore}
        >
          {loadState === "error" ? "Try again" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The listing page, read out of an untrusted JSON body.
 *
 * Every field is checked for its own type rather than destructured and
 * trusted. A `nextCursor` that arrived as `undefined` would otherwise be
 * spelled into the next request as the literal string "undefined", which the
 * endpoint answers with 400 — an error that looks like a server fault and is
 * not one.
 */
function readListingPage(payload: unknown): {
  items: GalleryItem[];
  hasMore: boolean;
  nextCursor: string | null;
} {
  const body = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as Record<string, unknown>;
  const nextCursor =
    typeof body.nextCursor === "string" && body.nextCursor !== ""
      ? body.nextCursor
      : null;
  return {
    items: toGalleryItems(body.items),
    hasMore: body.hasMore === true,
    nextCursor,
  };
}
