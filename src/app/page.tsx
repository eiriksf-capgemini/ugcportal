import { Gallery } from "@/components/gallery/gallery";
import { toGalleryItems } from "@/lib/gallery-items";
import { listPublicMedia, publicMediaListingUrl } from "@/lib/public-media";

/**
 * The public gallery (ugcportal-71y), and the whole of the home page.
 *
 * It renders into the app shell's single <main> (src/components/app-shell.tsx)
 * rather than building a frame of its own.
 *
 * The first page is read HERE, on the server, straight through
 * `listPublicMedia` — the same scope and the same projection GET
 * /api/public/media serves, from the same module, so there is no second
 * definition of "what is public" to drift. Not an HTTP fetch of our own
 * endpoint: that would cost a round trip through our own web server to reach a
 * function already in this process, and it would need an absolute origin the
 * server does not reliably know. The browser uses the HTTP endpoint for every
 * page AFTER the first, where it has no other option.
 */

/**
 * Never prerendered, never cached.
 *
 * Two independent reasons, and both have to hold:
 *
 *   - Correctness. This is the same argument the `no-store` header on
 *     GET /api/public/media makes at length: unpublishing has to take effect.
 *     A statically generated home page keeps showing a withdrawn photograph to
 *     everyone until something happens to rebuild it, and nothing reports a
 *     problem. A visibility control a cache can outlive is not one.
 *   - Buildability. Without this, `next build` tries to prerender `/`, which
 *     means running a Prisma query at build time against a database the build
 *     environment has no reason to have. That failure at least announces
 *     itself; the first one does not.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const result = await listPublicMedia(publicMediaListingUrl());

  /*
   * `listMedia` only reports `ok: false` for a malformed `?cursor=`, and the
   * URL above carries no cursor — so this branch is not expected to run. It is
   * written out rather than asserted away because "not expected" is not
   * "cannot": the alternative is a non-null assertion that turns a future
   * change to that contract into a crash on the home page.
   */
  const page = result.ok
    ? result.page
    : { items: [], hasMore: false, nextCursor: null };

  return (
    <Gallery
      initialItems={toGalleryItems(page.items)}
      initialCursor={page.nextCursor}
      initialHasMore={page.hasMore}
    />
  );
}
