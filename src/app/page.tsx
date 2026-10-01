import { Gallery } from "@/components/gallery/gallery";
import { GalleryUnavailable } from "@/components/gallery/gallery-unavailable";
import { toGalleryItems } from "@/lib/gallery-items";
import {
  listPublicMedia,
  publicMediaListingUrl,
  type PublicMediaResult,
} from "@/lib/public-media";

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
  /*
   * `listMedia` only reports `ok: false` for a malformed `?cursor=`, and the
   * URL above carries no cursor — so that branch is not expected to run. It
   * is written out rather than asserted away because "not expected" is not
   * "cannot": the alternative is a non-null assertion that turns a future
   * change to that contract into a crash on the home page.
   *
   * `listPublicMedia` can also THROW outright — a dropped database
   * connection, say — rather than ever returning an `ok: false` result.
   * Catching that here, rather than letting it reach Next's own error
   * boundary (there is none configured for this route yet, so it would be
   * the framework's generic one), is what makes this the SAME failure as
   * `ok: false` from this page's point of view: both render
   * `GalleryUnavailable` rather than two different kinds of broken page for
   * what an operator experiences as one incident. `listPublicMedia` has
   * already logged either case — see that function's own comment for why
   * one shared, throttled log line beats one per caller and per failure
   * mode.
   *
   * A failed listing used to be substituted with an empty page here
   * (ugcportal-0dh), which routed straight into `GalleryEmpty` — telling the
   * visitor the gallery was "genuinely empty" on the one path where that is
   * not known to be true, and leaving no trace of the failure anywhere a
   * human could find it. `listPublicMedia` not answering is distinguishable
   * from it answering with nothing; the two must stay that way all the way
   * to the rendered page, so both branches below return before `Gallery`
   * ever sees anything rather than inside it.
   */
  let result: PublicMediaResult;
  try {
    result = await listPublicMedia(publicMediaListingUrl());
  } catch {
    return <GalleryUnavailable />;
  }

  if (!result.ok) {
    return <GalleryUnavailable />;
  }

  return (
    <Gallery
      initialItems={toGalleryItems(result.page.items)}
      initialCursor={result.page.nextCursor}
      initialHasMore={result.page.hasMore}
    />
  );
}
