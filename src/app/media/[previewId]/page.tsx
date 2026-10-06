import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  GalleryItemAdvertisingLabel,
  GalleryItemTags,
} from "@/components/gallery/gallery-item";
import { PageShell } from "@/components/site/page-shell";
import { ShareControl } from "@/components/share/share-control";
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
 *
 * `alternates.canonical` is OMITTED, not defaulted to a guess, when
 * `siteOrigin()` returns `null` (review round 1, finding 1) — in production
 * that means AUTH_URL is unset or malformed, and a canonical link pointing
 * at `http://localhost:3000` would assert to every search engine that this
 * page's real, permanent address is a loopback address nobody outside the
 * server can ever reach — arguably worse than no canonical link at all,
 * since a wrong one actively misdirects deduplication rather than merely
 * omitting a hint. The title/description are unaffected either way: they
 * describe the item, not its own URL, so they have nothing to omit.
 * `checkSiteOriginConfigured` (src/lib/origin.ts, wired into
 * src/instrumentation-node.ts) is what reports the actual cause.
 *
 * The Open Graph and Twitter-card tags (ugcportal-lju K1) follow the SAME
 * rule as `alternates.canonical`, for the same reason: `og:url` and
 * `og:image` are both required to be absolute by the crawlers that read
 * them (unlike a share link, which the browser resolves live — see
 * src/components/share/share-control.tsx's own comment — a crawler has no
 * "current page" to resolve a relative URL against), so a `null` origin
 * leaves nothing valid to put in either field. Rather than guess at
 * `http://localhost:3000` the way `alternates.canonical` deliberately
 * refuses to outside this one case too, the whole `openGraph`/`twitter`
 * block is omitted when `origin` is `null` — a page with no preview tags at
 * all degrades to a bare link when shared, which is no worse than today;
 * shipping `og:image` pointing at an address no sharer's recipient can ever
 * reach would be actively wrong, the same argument `alternates.canonical`'s
 * own comment makes.
 *
 * `images`/`og:image` is built from `item.previewSrc` — which
 * `toGalleryItem` (src/lib/gallery-items.ts) already built from
 * `mediaPreviewPath(previewId)`, the only media URL any surface may build
 * (see that function's own comment) — never from `Media.key` or
 * `previewKey` (K3): `MEDIA_ANONYMOUS_SELECT` never reads either column, so
 * there is nothing here to leak by mistake even if a future edit tried.
 *
 * `type: "website"`, not `"article"`: the Open Graph protocol's `article`
 * type carries its own expected fields (`article:published_time`,
 * `article:author`, …) that this page has no real value for, and a photo
 * post is not an article. `website` needs nothing beyond what every og:*
 * tag here already sets.
 */
export async function generateMetadata({
  params,
}: RouteContext): Promise<Metadata> {
  const { previewId } = await params;
  const item = await getPublicMediaItem(previewId);
  if (!item) notFound();

  const title = mediaItemTitle(item);
  const description = mediaItemShortText(item);
  const origin = siteOrigin();
  if (origin === null) {
    return { title, description };
  }

  const pageUrl = `${origin}${mediaItemPath(previewId)}`;
  const imageUrl = `${origin}${item.previewSrc}`;

  return {
    title,
    description,
    alternates: { canonical: pageUrl },
    openGraph: {
      title,
      description,
      url: pageUrl,
      images: [imageUrl],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function MediaItemPage({ params }: RouteContext) {
  const { previewId } = await params;
  const item = await getPublicMediaItem(previewId);
  if (!item) notFound();

  const title = mediaItemTitle(item);

  return (
    <PageShell title={title}>
      {/*
        The advertising-disclosure label (ugcportal-e0jv K1, part B of
        ugcportal-qnq9.1), FIRST — ahead of the photograph itself, same
        reasoning as the gallery tile and the lightbox: Forbrukertilsynet's
        rule is that the label is visible before anything else about the
        item. Renders nothing for an unlabelled item (K3/K4) — the
        conditional wrapper, not an unconditional one, is deliberate: an
        unconditional `mt-3` wrapper would still carry its own margin for
        an ordinary unlabelled item, the exact "empty element, non-empty
        margin" gap GalleryItemTags' own comment warns about. `mt-3`, not a
        change to the shared class: PageShell's own `<h1>` carries no
        bottom margin of its own (it normally relies on the figure's `mt-6`
        below for the gap), and this is the one caller of
        `GalleryItemAdvertisingLabel` that renders directly under a
        heading rather than under a grid tile or a lightbox panel.
      */}
      {item.advertisingLabel !== null ? (
        <div className="mt-3">
          <GalleryItemAdvertisingLabel item={item} />
        </div>
      ) : null}
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

      {/*
        The share affordance (ugcportal-lju K2): native `navigator.share`
        where supported, a clipboard-copy fallback otherwise. See
        ShareControl's own comment for why this loads no third-party script
        and writes no non-essential storage — the two reasons it needs no
        consent gate (ugcportal-3wgp) and nothing else on this page does
        either.
      */}
      <ShareControl title={title} text={mediaItemShortText(item)} />
    </PageShell>
  );
}
