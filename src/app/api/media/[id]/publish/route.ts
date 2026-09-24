import { NextResponse } from "next/server";

import {
  MEDIA_OWNER_SELECT,
  requireOwnedMedia,
  toOwnerMedia,
} from "@/lib/media-access";
import { prisma } from "@/lib/prisma";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

/**
 * Publish / unpublish one media item (ugcportal-r1d). Owner only.
 *
 * A route rather than a server action because the acceptance criteria are
 * stated in HTTP terms (401 unauthenticated, 403 for someone else's row) and
 * requireOwnedMedia — the same gate PATCH and DELETE use (ugcportal-bdh) —
 * already answers in exactly those codes. There is no form to bind an action
 * to yet either; the gallery UI is ugcportal-71y.
 *
 * Its own sub-route rather than a field on PATCH /api/media/[id] so that
 * handler's contract stays "originalName is the only editable column": one
 * request body, one thing it can change. Visibility is not a rename.
 *
 * WHAT THIS DOES NOT DO — publishing is a *visibility* switch and nothing
 * else. It confers no licence, sets no price, and does not make an item
 * purchasable. Sellability is decided independently by the per-account
 * resale-rights review (ugcportal-0ss) and the sale catalogue
 * (ugcportal-74w); both gates must hold on their own, and neither reads
 * publishedAt. Accordingly the only column either handler below writes is
 * `publishedAt` — see the assertions in route.test.ts. If you are adding a
 * field here, and it is not about who can *see* the item, it is in the wrong
 * file.
 */

/**
 * Publishes the item.
 *
 * Idempotent, and the timestamp means "public since", so an already-published
 * row keeps its original one rather than having its history rewritten by a
 * double-click. That idempotence comes from the `publishedAt: null` in the
 * write predicate, not from inspecting the row the gate read: an earlier
 * version short-circuited on `access.media.publishedAt !== null` and returned
 * without writing, which is wrong under interleaving. A DELETE landing between
 * the gate's read and this point would leave the short-circuit looking at a
 * pre-delete value — it would write nothing, answer 200 with a stale
 * timestamp, and leave the client believing an item is public that is not.
 * Letting the write decide means the database's current state is what the
 * answer is based on.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { status: access.status },
    );
  }

  // Deliberately the same condition both listings filter on, not a subset of
  // it. GET /api/media and GET /api/public/media each require `previewKey` AND
  // `previewId` to be non-null, so checking only one here would leave the exact
  // hole this guard exists to close, moved one field over: a row with a key but
  // no id would publish with 200 and a real timestamp, then appear in neither
  // feed — not even its owner's own library — with nothing to distinguish that
  // from a working publish.
  //
  // Such a row should not exist: mediaPreviewColumns (src/lib/media.ts) makes
  // the pair unexpressible-when-half-set. But that helper is a convention a
  // second writer has to opt into, and its own comment names ugcportal-ct0's
  // Instagram sync as the writer that will need to. A guard that trusts a
  // convention it cannot enforce is not a guard, so this reads both columns
  // rather than assuming the invariant held.
  //
  // Refused rather than silently pointless: publishing a row with no
  // watermarked preview — today, every VIDEO; poster frames are ugcportal-pmb
  // — would set publishedAt, answer 200, and still never surface anywhere.
  //
  // 409 rather than 400 or 422: the request is well-formed and the caller is
  // authorized. What blocks it is the row's current state, and that state is
  // expected to change when ugcportal-pmb lands, at which point this refusal
  // simply stops firing.
  //
  // Safe to decide from the gate's read even though that read is a round trip
  // old, because both columns are write-once: they are set together in the
  // `prisma.media.create` in POST /api/media and no code path anywhere updates
  // either (PATCH writes only originalName, and this file writes only
  // publishedAt). That is the opposite of `publishedAt` below, which is exactly
  // why that one is decided by the write instead.
  if (access.media.previewKey === null || access.media.previewId === null) {
    return NextResponse.json(
      {
        error:
          "This item has no watermarked preview yet, so it cannot be published.",
      },
      { status: 409 },
    );
  }

  const publishedAt = new Date();

  // `updateMany` scoped by `{ id, userId }` rather than `update` by id: the
  // gate above read the row in a separate statement, so only a where clause on
  // the write itself rules out a row that was deleted or re-owned in between.
  // The gate decides the status code; this decides what changes.
  //
  // `publishedAt: null` is in the predicate as well, so two concurrent
  // publishes can't both write — the loser falls through to the re-read below
  // and reports the winner's timestamp instead of overwriting it.
  const { count } = await prisma.media.updateMany({
    where: { id, userId: access.userId, publishedAt: null },
    data: { publishedAt },
  });

  if (count === 0) {
    // The row was already published (by an earlier request of this caller's,
    // or a concurrent one), or it went away entirely. One read tells the two
    // apart; guessing 404 would report a successful publish as a failure, and
    // guessing 200 would report a deleted row as published.
    const current = await prisma.media.findFirst({
      where: { id, userId: access.userId },
      select: MEDIA_OWNER_SELECT,
    });

    if (!current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(current);
  }

  // No re-read on the happy path: the only column touched is the one just
  // written, and Media has no DB-derived fields (no updatedAt, no triggers)
  // that a second round trip would reveal.
  //
  // Projected through toOwnerMedia rather than spread: the gate reads the
  // whole row because DELETE needs the storage keys, and echoing that row
  // verbatim would hand `key` — the ungated original (ugcportal-5d6) — to the
  // client, the one column every other handler goes out of its way to withhold.
  return NextResponse.json(toOwnerMedia({ ...access.media, publishedAt }));
}

/**
 * Unpublishes the item: writes `publishedAt` back to null, which removes it
 * from GET /api/public/media on the next request. Idempotent — unpublishing an
 * already-private row is a no-op that still answers 200.
 *
 * No preview check here, unlike POST: a row with no preview was never visible,
 * so making sure it is not visible cannot fail.
 *
 * DELETE on this sub-resource ("the published state"), not on the media item;
 * DELETE /api/media/[id] still deletes the row and its objects.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { status: access.status },
    );
  }

  const { count } = await prisma.media.updateMany({
    where: { id, userId: access.userId },
    data: { publishedAt: null },
  });

  if (count === 0) {
    // Lost the race with a concurrent delete — the row the caller was
    // authorized for no longer exists.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    toOwnerMedia({ ...access.media, publishedAt: null }),
  );
}
