import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GalleryItemTags } from "@/components/gallery/gallery-item";
import { PageShell } from "@/components/site/page-shell";
import {
  getPublicMediaItem,
  mediaItemShortText,
  mediaItemTitle,
} from "@/lib/media-item";
import { siteOrigin } from "@/lib/origin";
import { mediaItemPath } from "@/lib/routes";

/**
 * /media/[previewId] (ugcportal-qnq9.12): one published item's own page.
 *
 * THE ROUTE DECISION the bead's own notes asked for, recorded here: a real
 * route, keyed on the opaque `previewId` handle every anonymous surface
 * already uses (see `mediaItemPath`'s own comment in src/lib/routes.ts) —
 * not a gallery deep link (`/?item=<previewId>`). §5.5's "one topic per page
 * or post, with a descriptive title" and Pinterest's per-pin destination
 * both need a URL that is its own page: a query-param deep link into `/`
 * would still serve the SAME document (and the SAME `<title>`) to a crawler
 * requesting any item, which is exactly what this bead exists to fix.
 *
 * THE K2 DECISION: an item that is not currently publicly visible — never
 * published, unpublished, unpublished-again, or deleted — answers 404, via
 * `notFound()`. Not a soft "this item is unavailable" page: a 404 is what
 * tells a crawler to drop the URL from its index rather than keep it around
 * expecting the content to come back, which is the right instruction for
 * every one of those states (a re-publish, if it ever happens, mints a fresh
 * crawl rather than relying on a stale one resolving again).
 */

type RouteParams = { previewId: string };
type RouteContext = { params: Promise<RouteParams> };

/**
 * Never prerendered, same reasoning as src/app/page.tsx and
 * src/app/portfolio/page.tsx: this reads a live, published Media row, and a
 * statically generated copy would keep serving a withdrawn item after its
 * owner unpublished it (K2) — the same staleness every other public,
 * database-backed page in this app refuses for the same reason.
 */
export const dynamic = "force-dynamic";

/**
 * Metadata is resolved separately from the page tree (Next's own contract),
 * so this re-reads the item through `getPublicMediaItem` rather than
 * trusting whatever the page component below renders — `cache()` on that
 * function is what keeps the two calls to one real query per request (see
 * its own comment in src/lib/media-item.ts).
 *
 * `notFound()` is valid to call from `generateMetadata` (Next 13.3+): doing
 * so here, rather than only in the page component, is what keeps an
 * unpublished item's page from shipping a `<title>`/description built from
 * data that should not be public at all, even for the brief moment before
 * the page component's own render would have caught it.
 */
export async function generateMetadata({
  params,
}: RouteContext): Promise<Metadata> {
  const { previewId } = await params;
  const item = await getPublicMediaItem(previewId);
  if (!item) notFound();

  const title = mediaItemTitle(item);
  return {
    title,
    description: mediaItemShortText(item),
    alternates: { canonical: `${siteOrigin()}${mediaItemPath(previewId)}` },
  };
}

export default async function MediaItemPage({ params }: RouteContext) {
  const { previewId } = await params;
  const item = await getPublicMediaItem(previewId);
  if (!item) notFound();

  const title = mediaItemTitle(item);

  return (
    <PageShell title={title}>
      <figure className="mt-6 overflow-hidden rounded-md bg-surface-1">
        {/* eslint-disable-next-line @next/next/no-img-element -- same
            reasoning as src/components/portfolio/portfolio-tile.tsx: the
            preview is served by GET /api/media/preview/[previewId], which
            next/image's optimizer cannot reach through (it proxies bytes
            from object storage, not a static asset). */}
        <img
          src={item.previewSrc}
          alt={title}
          className="h-auto w-full"
          loading="eager"
          decoding="async"
        />
      </figure>

      {/*
        text-muted-foreground directly on the page canvas: the SAME pairing
        GALLERY_CAPTION_CLASS (src/components/gallery/containment.ts) uses
        for a gallery tile's caption, and contrast.ts's own
        "muted-foreground-on-background" entry names exactly this usage
        ("Secondary/caption text directly on the page canvas... supporting
        paragraphs"). Not reused as that whole constant: its own `mt-1.5`
        is sized for sitting directly under a cropped grid tile, not under
        this page's full-width image.
      */}
      <p
        className="mt-4 max-w-prose text-sm whitespace-pre-line text-muted-foreground"
        data-media-item-text
      >
        {mediaItemShortText(item)}
      </p>

      <GalleryItemTags item={item} />
    </PageShell>
  );
}
