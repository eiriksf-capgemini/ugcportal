import { NextResponse } from "next/server";

import {
  MEDIA_PUBLIC_SELECT,
  requireOwnedMedia,
  toPublicMedia,
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
 * Publishes the item. Idempotent, and the timestamp is "public since", so an
 * already-published row keeps its original one rather than having its history
 * quietly rewritten by a double-click.
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

  if (access.media.publishedAt !== null) {
    // Already public. No write at all — re-publishing must not move the
    // "public since" timestamp forward.
    return NextResponse.json(toPublicMedia(access.media));
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
    // Either the row went away (concurrent DELETE) or someone else's request
    // published it first. One read tells the two apart; guessing 404 would
    // report a successful publish as a failure.
    const current = await prisma.media.findFirst({
      where: { id, userId: access.userId },
      select: MEDIA_PUBLIC_SELECT,
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
  // Projected through toPublicMedia rather than spread: the gate reads the
  // whole row because DELETE needs the storage keys, and echoing that row
  // verbatim would hand `key` — the ungated original (ugcportal-5d6) — to the
  // client, the one column every other handler goes out of its way to withhold.
  return NextResponse.json(toPublicMedia({ ...access.media, publishedAt }));
}

/**
 * Unpublishes the item: writes `publishedAt` back to null, which removes it
 * from GET /api/public/media on the next request. Idempotent — unpublishing an
 * already-private row is a no-op that still answers 200.
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
    toPublicMedia({ ...access.media, publishedAt: null }),
  );
}
