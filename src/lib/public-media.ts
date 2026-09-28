import { MEDIA_ANONYMOUS_SELECT } from "@/lib/media-access";
import {
  listMedia,
  type MediaAnonymousListingSelect,
  type MediaAnonymousScope,
  type MediaListingItem,
  type MediaListingResult,
} from "@/lib/media-listing";
import {
  publicMediaListingPath,
  type PublicMediaListingParams,
} from "@/lib/routes";

/**
 * The public feed's scope and select, in ONE place (ugcportal-71y).
 *
 * GET /api/public/media (ugcportal-r1d) used to spell the where-clause inline.
 * That was fine while it had exactly one caller; the gallery makes it two,
 * because the gallery's first page is rendered on the server and must not
 * HTTP-fetch its own app to get it. Two callers spelling the same filter is
 * the shape r1d's own comments warn about at length — "a future anonymous feed
 * that copied the public route and dropped one line would have type-checked,
 * passed CI, and shipped exactly the failure this whole bead was created to
 * prevent". The type system makes dropping `publishedAt` impossible; it does
 * not make two copies agree about anything else, so there is now one copy.
 *
 * Note what this module deliberately does NOT do: it does not relax, widen or
 * reinterpret anything. `listMedia`'s anonymous overload still requires the
 * publish filter structurally, and MEDIA_ANONYMOUS_SELECT is still the
 * narrower of the two projections. This is an extraction, not a new contract.
 */
export const PUBLIC_MEDIA_SCOPE: MediaAnonymousScope = {
  publishedAt: { not: null },
  previewKey: { not: null },
  previewId: { not: null },
};

/** A row exactly as the public feed returns it. */
export type PublicMediaRow = MediaListingItem<MediaAnonymousListingSelect>;

export type PublicMediaResult = MediaListingResult<MediaAnonymousListingSelect>;

/**
 * One page of the public feed.
 *
 * Takes a full request URL because that is what `listMedia` parses `?limit`
 * and `?cursor` out of — the route hands it `request.url` directly. A caller
 * with no request of its own (the server-rendered gallery) builds one with
 * `publicMediaListingUrl` below.
 */
export function listPublicMedia(requestUrl: string): Promise<PublicMediaResult> {
  return listMedia(requestUrl, PUBLIC_MEDIA_SCOPE, MEDIA_ANONYMOUS_SELECT);
}

/**
 * An origin that is not a real host, and is never dialled.
 *
 * `listMedia` reads its parameters out of a URL, so a caller that has no
 * request needs *some* absolute URL to put them in. Using the deployment's own
 * origin here would be worse than meaningless: it would suggest the gallery
 * fetches itself over HTTP, which is precisely the round trip this module
 * exists to avoid. Nothing resolves this name; only its query string is read.
 */
const INTERNAL_LISTING_ORIGIN = "http://listing.internal";

/**
 * The URL a server-side caller hands to `listPublicMedia`: the same path and
 * query the browser would request, made absolute so `new URL()` can parse it.
 *
 * Built from `publicMediaListingPath` rather than alongside it, so the server
 * and the browser cannot disagree about a parameter name — the client spelling
 * `?after=` while the server reads `?cursor=` is a silent always-first-page
 * bug, not an error. That builder lives in src/lib/routes.ts because the
 * gallery calls it from a client component, and this module's imports
 * (media-access, and through it auth and prisma) must not follow it there.
 */
export function publicMediaListingUrl(
  params: PublicMediaListingParams = {},
): string {
  return new URL(
    publicMediaListingPath(params),
    INTERNAL_LISTING_ORIGIN,
  ).toString();
}
