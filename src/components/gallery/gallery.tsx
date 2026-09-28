"use client";

import { useCallback, useRef, useState } from "react";

import {
  GALLERY_GRID_CLASS,
  GALLERY_TILE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
} from "@/components/gallery/containment";
import {
  ensureSizes,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { Button } from "@/components/ui/button";
import {
  appendGalleryItems,
  galleryItemLabel,
  toGalleryItems,
  type GalleryItem,
} from "@/lib/gallery-items";
import { publicMediaListingPath } from "@/lib/routes";
import { SITE_DESCRIPTION } from "@/lib/site";

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
   * Which activation is the current one.
   *
   * Opening is not instantaneous — `ensureSizes` can wait on a network round
   * trip, which ugcportal-8dn is about — and the grid stays clickable the
   * whole time, because nothing covers it until the viewer appears. So two
   * clicks in that window are ordinary, not pathological.
   *
   * Without this counter the second click was worse than ignored. PhotoSwipe's
   * `loadAndOpen` refuses a second open by returning false, the return value
   * was discarded, and the viewer opened on whichever tile won the race — the
   * FIRST one clicked. The visitor asked for one photograph and silently got
   * another.
   *
   * The counter makes the LAST click win, which is what a second click means.
   * A superseded open stops before touching the viewer rather than racing it.
   */
  const activation = useRef(0);

  const openLightbox = useCallback(
    async (index: number, request: number) => {
      const sizes = await ensureSizes(items, measured.current);
      // Someone clicked again while we were measuring. Their open is the one
      // that should happen; this one must not also fire, or PhotoSwipe gets
      // two overlapping requests and answers the earlier of them.
      if (activation.current !== request) return;
      await openGalleryViewer(items, sizes, index);
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
      const request = (activation.current += 1);
      setViewerFailed(false);
      openLightbox(index, request).catch(() => {
        // Only the current activation may report a failure. A superseded one
        // that fails would otherwise paint an error over a viewer that opened
        // perfectly well.
        if (activation.current === request) setViewerFailed(true);
      });
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
      {/*
        The page's heading, and the reason it is here rather than assumed.

        app-shell.tsx's skip link moves focus to <main> and its comment reasons
        about landing "past the <h1> on both admin screens" — i.e. the shell
        takes for granted that a page HAS one. The gallery shipped without:
        every heading level below h1 was absent too, so the document outline
        began at the grid, and the empty state was the only branch that kept a
        heading at all.

        It is the site description rather than the word "Gallery", because
        this IS the site's front page and the tagline says what the
        photographs are of. Sized modestly on purpose — the surround is
        supposed to recede behind the pictures.
      */}
      <h1 className="max-w-2xl text-xl leading-tight font-medium tracking-tight text-balance text-foreground sm:text-2xl">
        {SITE_DESCRIPTION}
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
                alt=""
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
  return hasMore
    ? `Showing ${count} photographs.`
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
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {pagingMessage(loadState, hasMore, count)}
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
