import { NextResponse } from "next/server";

import { MEDIA_ANONYMOUS_SELECT } from "@/lib/media-access";
import { listMedia } from "@/lib/media-listing";

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
export async function GET(request: Request) {
  const result = await listMedia(
    request.url,
    {
      publishedAt: { not: null },
      previewKey: { not: null },
      previewId: { not: null },
    },
    MEDIA_ANONYMOUS_SELECT,
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json(result.page);
}
