"use client";

import { useCallback, useRef, useState } from "react";

import {
  GALLERY_GRID_CLASS,
  GALLERY_TILE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
} from "@/components/gallery/containment";
import { Button } from "@/components/ui/button";
import {
  appendGalleryItems,
  galleryItemLabel,
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

/**
 * Intrinsic size of a preview whose real size could not be read.
 *
 * Reached only when the browser could not read a size off the image — it
 * failed to load (a deleted object, a 404 from the delivery route) or reported
 * zero dimensions. In the first case the slide shows PhotoSwipe's error state
 * and these numbers decide nothing anyone can see; in the second there is no
 * better answer available.
 *
 * It is NOT a stand-in for "not measured yet": see ensureSizes, which waits
 * for the real value rather than guessing at one, because PhotoSwipe sizes a
 * slide from the numbers it is given, so a guessed ratio over a perfectly
 * loadable image distorts it. Square, because a wrong ratio is wrong in every
 * direction and this one at least does not pretend to know the orientation.
 */
const UNKNOWN_PREVIEW_SIZE = { width: 1280, height: 1280 } as const;

type PixelSize = { width: number; height: number };

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

  const openLightbox = useCallback(
    async (index: number) => {
      const [{ default: PhotoSwipeLightbox }, sizes] = await Promise.all([
        import("photoswipe/lightbox"),
        ensureSizes(items, measured.current),
      ]);

      const lightbox = new PhotoSwipeLightbox({
        dataSource: items.map((item, position) => ({
          src: item.previewSrc,
          alt: galleryItemLabel(item),
          ...sizes[position],
        })),
        pswpModule: () => import("photoswipe"),
        /*
         * Fade, not zoom-from-thumbnail.
         *
         * PhotoSwipe's zoom transition animates from the thumbnail's
         * rectangle to the full frame, and it is the better effect — but it
         * assumes the thumbnail shows the WHOLE image. These tiles are
         * `object-cover` centre crops (see containment.ts), so the rectangle
         * it would fly out of holds a different picture from the one it lands
         * on, and the transition reads as a jump. Telling PhotoSwipe about
         * the crop means handing it an `innerRect` per slide, which needs the
         * intrinsic size *and* the laid-out size of every tile at animation
         * time. Not worth it for a transition; fade is honest about what it
         * knows.
         */
        showHideAnimationType: "fade",
        // The preview is at most 1280px on its longest edge (ugcportal-44q),
        // so there is nothing to gain from zooming past its own resolution.
        maxZoomLevel: 1,
        // The whole overlay is the backdrop; closing by clicking outside the
        // image is the behaviour everybody already expects from a lightbox.
        bgClickAction: "close",
      });
      /*
       * A fresh instance per activation, torn down when the viewer closes.
       *
       * With no `gallery` option, `init()` binds no DOM listeners and
       * `destroy()` unbinds none — the instance is already collectable once
       * PhotoSwipe clears its own reference. This is here to make the lifetime
       * explicit rather than to fix a leak: reusing one instance would mean
       * keeping its `dataSource` in step with a list that grows on every
       * "Load more", which is a second copy of the item list to get wrong.
       *
       * Focus returns to the tile by itself: PhotoSwipe records
       * `document.activeElement` at init — the button that was just activated
       * — and restores it on destroy, but only for a visitor who actually
       * moved focus into the viewer. A mouse user's focus is left alone.
       */
      lightbox.on("destroy", () => lightbox.destroy());
      lightbox.init();
      lightbox.loadAndOpen(index);
    },
    [items],
  );

  /**
   * Opens the viewer, and says so when it cannot.
   *
   * The dynamic `import()` in openLightbox is a network request, so it fails
   * on a flaky connection and on a stale tab whose chunk a deploy has since
   * replaced. Left as a floating promise, that failure is an unhandled
   * rejection plus a button that visibly does nothing — the worst pair, since
   * the visitor gets no reason and the log gets no context.
   *
   * The wording matters too: the photograph is on screen and perfectly fine,
   * so the message says the VIEWER failed rather than implying the item is
   * broken.
   */
  const activate = useCallback(
    (index: number) => {
      setViewerFailed(false);
      openLightbox(index).catch(() => setViewerFailed(true));
    },
    [openLightbox],
  );

  const loadMore = useCallback(async () => {
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
      setItems((current) => appendGalleryItems(current, page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore && page.nextCursor !== null);
      setLoadState("idle");
    } catch {
      // Deliberately keeps `cursor` and `hasMore` as they were, so the retry
      // asks for the same page rather than silently skipping it.
      setLoadState("error");
    }
  }, [cursor, loadState]);

  /*
   * `&& !hasMore`, not `items.length === 0` alone.
   *
   * The two are the same thing today: `listMedia` only ever builds a cursor
   * from a row it emitted, so a first page with no items always comes back
   * with `hasMore: false`. But they are not the same *claim* — "there is
   * nothing published" and "this page happened to be empty" are different
   * statements, and the early return says the first out loud. If the feed ever
   * did answer with an empty page and a cursor, returning here would strand
   * the visitor on "nothing is published yet" with no way to ask for the rest.
   */
  if (items.length === 0 && !hasMore) {
    return <GalleryEmpty />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ul className={GALLERY_GRID_CLASS}>
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={GALLERY_TILE_CLASS}
              aria-label={galleryItemLabel(item)}
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
                alt=""
                className={GALLERY_TILE_IMAGE_CLASS}
                // The button carries the accessible name; the image inside it
                // would otherwise announce the same thing twice.
                aria-hidden="true"
                draggable={false}
                onLoad={(event) => remember(item.previewSrc, event.currentTarget)}
              />
            </button>
          </li>
        ))}
      </ul>

      <GalleryPaging
        hasMore={hasMore}
        loadState={loadState}
        viewerFailed={viewerFailed}
        count={items.length}
        onLoadMore={() => {
          void loadMore();
        }}
      />
    </div>
  );
}

function GalleryEmpty() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-24 sm:px-6">
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
 * The end of the grid: the load-more control, the busy announcement and the
 * error state, or the end-of-list note.
 *
 * `aria-live="polite"` on a region that is always in the DOM, rather than one
 * mounted when the state changes — a live region inserted at the same moment
 * as its text is frequently not announced at all.
 */
function GalleryPaging({
  hasMore,
  loadState,
  viewerFailed,
  count,
  onLoadMore,
}: {
  hasMore: boolean;
  loadState: LoadState;
  viewerFailed: boolean;
  count: number;
  onLoadMore: () => void;
}) {
  return (
    <div className="mt-8 flex flex-col items-center gap-3">
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {viewerFailed
          ? "Could not open the viewer. The photograph itself is fine — reload the page and try again."
          : loadState === "loading"
            ? "Loading more photographs…"
            : loadState === "error"
              ? "Could not load more photographs. Check your connection and try again."
              : hasMore
                ? `Showing ${count} photographs.`
                : `Showing all ${count} photographs.`}
      </p>
      {hasMore ? (
        <Button
          type="button"
          size="lg"
          variant={loadState === "error" ? "outline" : "default"}
          disabled={loadState === "loading"}
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
 * read by loading the same URL again — which comes from the browser cache, as
 * the tile has already requested it. UNKNOWN_PREVIEW_SIZE is used only when
 * the image cannot be loaded at all.
 *
 * KNOWN GAP (ugcportal-8dn): this waits for EVERY item, not just the one being
 * opened, so on a slow connection with several pages loaded the lightbox does
 * not open until the last tile has finished downloading. Correct, but it can
 * be slow; filed rather than hidden.
 */
async function ensureSizes(
  items: GalleryItem[],
  cache: Map<string, PixelSize>,
): Promise<PixelSize[]> {
  return Promise.all(
    items.map(async (item) => {
      const known = cache.get(item.previewSrc);
      if (known !== undefined) return known;
      const size = await measureImage(item.previewSrc);
      cache.set(item.previewSrc, size);
      return size;
    }),
  );
}

function measureImage(src: string): Promise<PixelSize> {
  return new Promise<PixelSize>((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : UNKNOWN_PREVIEW_SIZE,
      );
    };
    image.onerror = () => resolve(UNKNOWN_PREVIEW_SIZE);
    image.src = src;
  });
}
