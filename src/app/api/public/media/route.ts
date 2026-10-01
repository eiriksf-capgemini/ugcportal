import { NextResponse } from "next/server";

import { listPublicMedia } from "@/lib/public-media";

/**
 * The public gallery feed (ugcportal-r1d). Readable by anyone, signed in or
 * not — it deliberately never calls `auth()`, because the answer must not
 * depend on who is asking. A feed that widens for some sessions is the shape
 * that eventually widens for the wrong one.
 *
 * Its own endpoint rather than a mode of GET /api/media: the owner's view has
 * to keep showing unpublished rows, so one handler could only serve both
 * audiences through a role-dependent filter. Both are paginated by the same
 * listMedia() helper, so the cursor contract ugcportal-71y consumes is
 * identical on both.
 *
 * Two independent conditions, both required:
 *   - `publishedAt != null` — the owner deliberately published it. Null is the
 *     default for every row, so nothing is public by accident or by migration.
 *   - a watermarked preview exists (`previewKey` and its public handle
 *     `previewId` both non-null). A published VIDEO has none yet
 *     (ugcportal-pmb owns poster frames) and is therefore absent from this
 *     feed even though its owner published it. That is the intended behaviour,
 *     not an oversight: without a preview the only representation of the row
 *     is `key`, the paid original (ugcportal-5d6), which no response may ever
 *     carry. MEDIA_ANONYMOUS_SELECT does not contain `key`, so the original is
 *     never even selected.
 *
 * Projected through MEDIA_ANONYMOUS_SELECT, which is strictly narrower than
 * the owner's. It drops `originalName` (uploader-supplied filenames were
 * owner-only before this endpoint existed and stay that way) and `previewKey`
 * (a storage path that embeds the uploader's account id, so publishing it
 * would publish exactly what withholding `userId` was meant to withhold). The
 * opaque `previewId` is exposed in its place. See src/lib/media-access.ts for
 * the full reasoning; the two feeds deliberately do not share one projection.
 *
 * Ordered by `createdAt desc`, not `publishedAt desc`, and that is a
 * deliberate trade rather than an oversight. `createdAt` is immutable, so a
 * row's position in this ordering never changes; `publishedAt` is not —
 * unpublishing and republishing rewrites it — and a sort key that moves under
 * a keyset cursor lets rows jump the window mid-scroll, to be served twice or
 * skipped entirely. Stable pagination won. The cost is real and worth naming:
 * publishing a long-dormant upload files it by capture date, so it lands deep
 * in the feed rather than at the top. If ugcportal-71y decides recency-of-
 * publication is the product-correct order, that is a deliberate change of
 * this endpoint's contract — it needs its own index (the measured
 * `@@index([createdAt, id])` would no longer serve the sort) and an answer for
 * the mutable-sort-key problem, not a one-line swap here.
 *
 * Published is NOT for sale. This endpoint decides *visibility only*. Whether
 * an item may be sold is a separate gate — the per-account resale-rights
 * review (ugcportal-0ss) plus the sale catalogue (ugcportal-74w) — and both
 * must hold independently. Appearing here confers no licence, no price and no
 * purchasability, and nothing in the publish path writes any of those. Do not
 * add a "buy" affordance driven off this feed; drive it off the sellability
 * gate once that exists.
 */
/**
 * Never cached, anywhere, by anything.
 *
 * This is the one response in the app that does not vary by session, which is
 * exactly what makes it the one a shared cache would happily store under the
 * URL alone and hand to everybody. Every other endpoint is either behind auth
 * or varies per user, so a cache has a reason not to reuse it; this one does
 * not, and would look like an ideal candidate.
 *
 * It must not be, because unpublishing has to take effect. ugcportal-r1d
 * exists so an owner can withdraw an item from public view, and a cached page
 * keeps serving that item after they have — the withdrawal appears to work,
 * the item stays visible to anyone whose request the cache answers, and
 * nothing anywhere reports a problem. A visibility control that a cache can
 * silently outlive is not a visibility control.
 *
 * There is a real tension here, and it is the same one the ordering comment
 * below reasons about: caching is precisely what would blunt this endpoint's
 * scan cost (see the index note in prisma/schema.prisma, and ugcportal-9w5 for
 * the rate-limiting side of it). That trade is worth making — but only
 * alongside an invalidation path that a publish and an unpublish both trigger.
 * Until that exists, correctness wins and the header says so plainly.
 * `no-store` rather than `no-cache` because there is nothing here worth
 * revalidating: the answer is cheap to recompute and must never be served
 * stale, not even once.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  /*
   * The scope and the projection moved to src/lib/public-media.ts when
   * ugcportal-71y became a second caller: the gallery renders its first page
   * on the server and must not HTTP-fetch this route to get it. Nothing about
   * the contract changed — `listMedia`'s anonymous overload still requires the
   * publish filter structurally — but there is now one copy of the filter
   * rather than one per caller.
   */
  const result = await listPublicMedia(request.url);

  if (!result.ok) {
    // `listPublicMedia` already logged this, throttled (ugcportal-0dh) — see
    // its own comment. THIS caller is the one a client actually controls: a
    // stale tab, a hand-written request, or a bot can send any `?cursor=` it
    // likes, unlike the server-rendered home page's call, which never sends
    // one. That is exactly why the throttle lives centrally rather than only
    // on the branch that looked reachable.
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: NO_STORE },
    );
  }

  return NextResponse.json(result.page, { headers: NO_STORE });
}
