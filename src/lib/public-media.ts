import { isPermittedAdvertisingLabel } from "@/lib/advertising-disclosure";
import { stripCurationTags } from "@/lib/curation-tags";
import { MEDIA_ANONYMOUS_SELECT } from "@/lib/media-access";
import {
  listMedia,
  type MediaAnonymousColumnScope,
  type MediaAnonymousListingSelect,
  type MediaAnonymousScope,
  type MediaListingItem,
  type MediaListingResult,
} from "@/lib/media-listing";
import { PUBLIC_MEDIA_RIGHTS_SCOPE } from "@/lib/publishability";
import {
  publicMediaListingPath,
  type PublicMediaListingParams,
} from "@/lib/routes";
import {
  DEFAULT_THROTTLE_INTERVAL_MS,
  createThrottledLog,
} from "@/lib/throttled-log";

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
/**
 * The three NOT-NULL COLUMN filters, named apart from the rights half below
 * (ugcportal-3ae).
 *
 * This is the half the public feed's partial index mirrors — see the
 * `@@index([createdAt, id], where: …)` comment in prisma/schema.prisma — and
 * src/lib/media-public-feed-index-migration.test.ts derives the index's
 * expected WHERE clause from `Object.keys` of THIS constant. Before the
 * rights filter existed it derived them from `PUBLIC_MEDIA_SCOPE` directly,
 * which stopped being right the moment the scope gained a key that is not a
 * column at all.
 */
export const PUBLIC_MEDIA_COLUMN_SCOPE: MediaAnonymousColumnScope = {
  publishedAt: { not: null },
  previewKey: { not: null },
  previewId: { not: null },
};

/**
 * WHAT IS PUBLIC, in one object: the three column filters above, and the
 * rights predicates (`PUBLIC_MEDIA_RIGHTS_SCOPE`, src/lib/publishability.ts
 * — a valid uploader attestation, and a cleared PEOPLE layer wherever an
 * identifiable person is shown).
 *
 * THE RIGHTS PREDICATES ARE HERE, IN THE SCOPE, AND NOT AT THE QUERIES
 * THAT USE IT (ugcportal-3ae K3). That placement is the criterion, not an
 * implementation detail of it. SIX call sites reach for this constant
 * today — `listPublicMedia` below (the paginated API route AND the
 * server-rendered home page), `listPortfolioPieces` (src/lib/portfolio.ts),
 * the sitemap (src/app/sitemap.ts, which hands item URLs to crawlers), the
 * per-item page's read (src/lib/media-item.ts), its price block
 * (`getPublicOffer`, src/lib/sellable-media.ts, added by ugcportal-yzo7)
 * and the preview bytes (GET /api/media/preview/[previewId], added by
 * ugcportal-nffp) — and an earlier draft of ugcportal-3ae listed only
 * three. The one it missed was the sitemap. Any version of this fix that
 * is written out per call site is one reader away from that mistake again,
 * and the reader it would be missing is the one that publishes to Google.
 *
 * The count above is prose and will go stale; the enumeration that cannot
 * is the AST scan in src/lib/public-media.consumers.test.ts, which derives
 * the list from the tree and fails when it does not match the map there.
 *
 * What makes it stick is not this comment: it is that
 * `MediaAnonymousScope` (src/lib/media-listing.ts) now REQUIRES the rights
 * half structurally, so a hand-built anonymous scope without it does not
 * compile, and that src/lib/public-media.consumers.test.ts fails when a
 * consumer of this constant is not covered by a test asserting the filter
 * actually holds for it.
 *
 * A NOTE ON WHAT THIS COSTS, because it is large and deliberate: every row
 * published before ugcportal-3ae landed has no attestation — nothing
 * backfills one, by design (K4) — so every one of them leaves the public
 * surfaces on the next request. That is fail-closed working, not a
 * regression. Their owners re-publish through the current upload flow,
 * which asks the rights questions.
 */
export const PUBLIC_MEDIA_SCOPE: MediaAnonymousScope = {
  ...PUBLIC_MEDIA_COLUMN_SCOPE,
  ...PUBLIC_MEDIA_RIGHTS_SCOPE,
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
export const LISTING_FAILURE_LOG_INTERVAL_MS = DEFAULT_THROTTLE_INTERVAL_MS;

/**
 * No `flush` (ugcportal-z3lo K2): unlike `watermark.ts`'s shed-upload
 * throttle, this one deliberately has no proactive timer for a quiet
 * burst's tail — see the doc comment above for why a malformed cursor does
 * not warrant that machinery.
 */
const listingFailureLog = createThrottledLog({
  intervalMs: LISTING_FAILURE_LOG_INTERVAL_MS,
});

/**
 * The real `ok: false` shape `listMedia` can return, reused rather than
 * re-typed. An earlier version of {@link logFailedPublicListing} declared its
 * own `{ status: number; error: string }` parameter type instead of this, so
 * a future change to the real branch's shape could drift from what this
 * function logs with no compiler error to catch it.
 */
type PublicMediaFailure = Extract<PublicMediaResult, { ok: false }>;

/**
 * Logs a failed public listing, throttled per the comment above.
 *
 * Two shapes, not one. `PublicMediaFailure` is `listMedia` REPORTING a
 * failure (today, only a malformed `?cursor=`) — it returned normally, with
 * `ok: false`. `{ threw: true; error }` is the other way this can fail: the
 * query itself throwing (a dropped database connection, say) rather than
 * answering at all. There is no existing type for that case, because it
 * never produces a `PublicMediaResult` — the function never returns.
 */
function logFailedPublicListing(
  detail: PublicMediaFailure | { threw: true; error: string },
): void {
  listingFailureLog.log((suppressed) => {
    console.error("[gallery] public media listing failed", {
      ...detail,
      // Present only when this line's own window actually swallowed others —
      // an absent field reads as "nothing was suppressed" without a `0` that
      // looks the same as a count nobody bothered to track.
      ...(suppressed > 0 ? { suppressed } : {}),
    });
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
 *
 * Logs AND rethrows when `listMedia` itself throws, rather than only
 * covering the `ok: false` contract. The bead this exists for (ugcportal-0dh)
 * is about a failing public feed being indistinguishable from an empty one,
 * "from both sides" — a dropped database connection is just as much a
 * failing feed as a malformed cursor, and it is the more serious of the two.
 * Rethrowing rather than swallowing is deliberate: this function reports what
 * happened, it does not decide how a caller recovers. `src/app/page.tsx`
 * catches it and renders `GalleryUnavailable`, the same as `ok: false`;
 * GET /api/public/media catches it too (ugcportal-c70s) and answers a 500
 * with the same `cache-control: no-store` header every other path on that
 * route sets, rather than letting Next's own route-handler error handling
 * answer a generic 500 with none of this route's headers.
 *
 * ALSO STRIPS any curation-only tag (`stripCurationTags`,
 * src/lib/curation-tags.ts — see that function's own comment, and round-5
 * review for why it is the same function `src/lib/gallery-items.ts#toGalleryTags`
 * now calls too) from every row's `tags`, before this function's result
 * leaves it in either direction (merged into this one doc comment,
 * ugcportal-qnq9.16, item 5 of the lows deferred from PR #93's round-6
 * review — this used to be a second JSDoc block directly above this one
 * with no code between them, which only the second block's own IDE
 * hover/typedoc surfaced).
 *
 * ROUND-4 REVIEW: this is the fix for a real leak, not belt-and-suspenders.
 * `toGalleryTags` already stripped the same tags, but only for callers
 * that convert a row through `toGalleryItem`/`toGalleryItems` — the
 * server-rendered home page does, but GET /api/public/media
 * (src/app/api/public/media/route.ts) serialises `listPublicMedia`'s own
 * result straight to JSON with NO such conversion. A photo tagged both a
 * real subject and "portfolio" therefore kept
 * `{"slug":"portfolio","name":"Portfolio"}` in the raw API response even
 * after round 2 fixed the rendered HTML — a leak to any direct API
 * consumer (curl, a future integration, a bot), not to a page visitor.
 * Fixing it HERE, in the one function both the route and the server-
 * rendered page call, means every current and future caller of
 * `listPublicMedia` gets it for free, rather than each caller having to
 * remember to filter its own copy of the result.
 */
export async function listPublicMedia(
  requestUrl: string,
): Promise<PublicMediaResult> {
  let result: PublicMediaResult;
  try {
    result = await listMedia(requestUrl, PUBLIC_MEDIA_SCOPE, MEDIA_ANONYMOUS_SELECT);
  } catch (error) {
    logFailedPublicListing({
      threw: true,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (!result.ok) {
    logFailedPublicListing(result);
    return result;
  }
  return {
    ok: true,
    page: {
      ...result.page,
      items: result.page.items.map((row) => ({
        ...row,
        tags: stripCurationTags(row.tags),
        // ugcportal-qnq9.2.2, and the IDENTICAL shape of fix the comment
        // above this function describes for `tags`: `toGalleryItem`
        // (src/lib/gallery-items.ts) already empties `commercialLinks`
        // whenever an item's label is absent — but that conversion only
        // runs for a caller that converts THROUGH it, and the raw JSON
        // GET /api/public/media serves `listPublicMedia`'s own result with
        // no such conversion. Without this, a disclosure withdrawn AFTER a
        // link was attached (ugcportal-jain: `PUT .../disclosure` with
        // `benefitReceived: false` clears the label but detaches no link)
        // would leave the link sitting in this raw response even though
        // every rendered page already hides it — a leak to a direct API
        // consumer, not a page visitor, the same audience round 4's `tags`
        // fix names. RE-VALIDATED against the closed allowlist
        // (`isPermittedAdvertisingLabel`), not merely checked for
        // non-null, for the same "do not trust a row was written through
        // the validator" reason `toAdvertisingLabel` gives for doing the
        // identical check on the render side.
        commercialLinks: isPermittedAdvertisingLabel(row.advertisingDisclosure?.label ?? null)
          ? row.commercialLinks
          : [],
      })),
    },
  };
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
