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
 * Shortest interval between "listing failed" log lines; the rest in between
 * are counted and folded into the next one.
 *
 * `listPublicMedia` has two callers (below) and both are reachable by an
 * anonymous request: the server-rendered home page always asks for the first
 * page with no cursor, so in practice it is GET /api/public/media
 * (src/app/api/public/media/route.ts) that a client actually controls — and
 * that route has no rate limit of its own yet (ugcportal-9w5 is the open bead
 * for one). Logging one line per request would let a single looping bot turn
 * this bead's own fix into a free way to flood the error log. Throttled the
 * same way watermark.ts's `logShedUpload` is: the first failure after a quiet
 * period always logs, so the transition into failing is never delayed.
 *
 * Unlike `logShedUpload`, there is no proactive flush timer here for a quiet
 * burst's tail. A shed is a capacity signal operators page on, and losing its
 * tail to a throttle that only flushes on the next event is a real cost
 * `watermark.ts` goes to some length to avoid; a malformed cursor is a
 * nuisance-input signal, not a capacity one, and is not worth that same
 * machinery. The accepted cost is the same shape, smaller: a handful of
 * requests at the very end of a burst can go uncounted if nothing in this
 * window logs again.
 */
export const LISTING_FAILURE_LOG_INTERVAL_MS = 10_000;

let listingFailureLogLastAt = 0;
let listingFailureLogSuppressed = 0;

/** Logs a failed public listing, throttled per the comment above. */
function logFailedPublicListing(result: { status: number; error: string }): void {
  const now = Date.now();
  if (now - listingFailureLogLastAt < LISTING_FAILURE_LOG_INTERVAL_MS) {
    listingFailureLogSuppressed += 1;
    return;
  }
  const suppressed = listingFailureLogSuppressed;
  listingFailureLogLastAt = now;
  listingFailureLogSuppressed = 0;
  console.error("[gallery] public media listing failed", {
    status: result.status,
    error: result.error,
    // Present only when this line's own window actually swallowed others —
    // an absent field reads as "nothing was suppressed" without a `0` that
    // looks the same as a count nobody bothered to track.
    ...(suppressed > 0 ? { suppressed } : {}),
  });
}

/**
 * One page of the public feed.
 *
 * Takes a full request URL because that is what `listMedia` parses `?limit`
 * and `?cursor` out of — the route hands it `request.url` directly. A caller
 * with no request of its own (the server-rendered gallery) builds one with
 * `publicMediaListingUrl` below.
 *
 * Logs its own failure (ugcportal-0dh), here rather than in each caller.
 * `src/app/page.tsx` and `src/app/api/public/media/route.ts` both call this
 * function and both need the SAME signal on the SAME condition — spelling the
 * log line twice is exactly the shape ugcportal-ws3's sibling-omission family
 * warns about, except with a log line instead of a check: a future third
 * caller, or a changed log shape, needs to remember to update every copy
 * rather than the one place that produces the event.
 */
export async function listPublicMedia(
  requestUrl: string,
): Promise<PublicMediaResult> {
  const result = await listMedia(
    requestUrl,
    PUBLIC_MEDIA_SCOPE,
    MEDIA_ANONYMOUS_SELECT,
  );
  if (!result.ok) {
    logFailedPublicListing(result);
  }
  return result;
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
