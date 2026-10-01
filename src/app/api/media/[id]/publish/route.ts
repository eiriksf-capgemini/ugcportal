import { NextResponse } from "next/server";

import {
  MEDIA_OWNER_SELECT,
  requireOwnedMedia,
  toOwnerMedia,
} from "@/lib/media-access";
import { mediaPreviewColumns } from "@/lib/media";
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

  // Alt text is REQUIRED TO PUBLISH (ugcportal-gwr K1) — not at upload, and
  // not at the schema layer (Media.altText is nullable; see that column's
  // comment in prisma/schema.prisma). This is the one place that rule is
  // enforced, same spirit as the preview check below: well-formed, authorized
  // request, refused because of the row's own current state, so 400 — a
  // field-level validation failure, not an authorization or state-conflict
  // one — with a message naming the field, per K1 ("rejected... at the
  // field"). `.trim()` because an owner could in principle have stored
  // whitespace-only text before this check existed; `validateAltText` already
  // refuses that going forward, but this route must not trust that every row
  // in the table was written after this check existed.
  //
  // READ-THEN-CHECK, not folded into the `updateMany` where-clause the way
  // `publishedAt: null` below is (review round 1, finding 8). That one is
  // folded in because something CAN race it — a concurrent publish or
  // unpublish — and the predicate is how two racing writes agree on a
  // winner. Nothing today can race THIS check: `altText` is set once, at
  // upload, and never cleared afterwards (no route writes it null — the
  // rename endpoint only touches `originalName`), so there is no concurrent
  // writer for a `where: { altText: { not: null } }` clause to defend
  // against yet. The day a second writer can null it out (an edit surface,
  // say), this needs the same treatment `previewId`'s repair logic above
  // got — but adding it now, against nothing, would be exactly the kind of
  // check this file's own comments elsewhere warn against: one that reads as
  // a defence and is not exercised by anything.
  if (access.media.altText === null || access.media.altText.trim() === "") {
    return NextResponse.json(
      {
        error: "Add alt text before publishing this item.",
        field: "altText",
      },
      { status: 400 },
    );
  }

  // Two different problems hide behind "this row has no usable preview", and
  // they need different answers.
  //
  // `previewKey` null means there genuinely is no watermarked object — today,
  // every VIDEO; poster frames are ugcportal-pmb. Publishing would set
  // publishedAt, answer 200, and still surface nowhere, so it is refused.
  //
  // 409 rather than 400 or 422: the request is well-formed and the caller is
  // authorized. What blocks it is the row's current state, and that state is
  // expected to change when ugcportal-pmb lands, at which point this refusal
  // simply stops firing.
  //
  // Blank is treated as absent rather than handed to mediaPreviewColumns,
  // which would (correctly) throw on it. A writer-side bug should not become a
  // 500 on a request that is itself well formed.
  if (
    access.media.previewKey === null ||
    access.media.previewKey.trim() === ""
  ) {
    return NextResponse.json(
      {
        error:
          "This item has no watermarked preview yet, so it cannot be published.",
      },
      { status: 409 },
    );
  }

  // `previewId` null with `previewKey` set is the OTHER problem, and it is not
  // the same one: the watermarked object exists, only the public handle the
  // anonymous feed hands out is missing.
  //
  // This used to get the message above, which was false, and a 409 with no way
  // out. The migration backfilled only rows that existed when it ran, and
  // nothing anywhere writes previewId on an existing row — so an ordinary
  // migrate-then-swap deploy (migrations applied, previous build still
  // serving) mints exactly this shape, as would ugcportal-ct0's sync. The
  // owner feed deliberately still lists such a row with its preview, so the
  // owner could see an item they were permanently forbidden from publishing,
  // for a stated reason that was not true.
  //
  // So repair it. This is the first moment anything notices the gap, the value
  // is opaque and derived from nothing about the row, and minting it is cheap
  // — there is no "wrong" id to mint.
  //
  // Scoped to `previewId: null` so a concurrent repair is not clobbered.
  // `count === 0` is deliberately not an error: either the row was deleted, in
  // which case the publish below answers 404, or another request repaired it
  // first, in which case its id stands and is just as good — the re-read at
  // the bottom reports whichever won.
  let previewId = access.media.previewId;
  if (previewId === null) {
    const minted = mediaPreviewColumns(access.media.previewKey);
    const { count } = await prisma.media.updateMany({
      where: {
        id,
        userId: access.userId,
        previewKey: { not: null },
        previewId: null,
      },
      // previewId and nothing else. Publishing still writes only publishedAt;
      // this is a repair of preview identity, issued as its own statement so
      // neither write can smuggle the other's columns along.
      data: { previewId: minted.previewId },
    });
    previewId = count === 1 ? minted.previewId : null;
  }

  // Publish is a state TRANSITION — null to a timestamp — and the write is
  // scoped to the state the gate actually observed, not to whichever state
  // would let it proceed.
  //
  // This closes a race the previous version created while fixing its mirror.
  // That version always ran the write with `publishedAt: null` in the
  // predicate. If the gate saw the row PUBLISHED and the owner's unpublish
  // then committed before this statement, the predicate suddenly matched, this
  // older request republished the item and answered 200 — silently undoing an
  // explicit withdrawal and putting the item back on the public feed while the
  // owner's UI believed it private. The ordering argument offered at the time,
  // that the unpublish is the more recent instruction, only ever governed the
  // count === 0 branch; on this path nothing enforced it.
  //
  // So when the gate observed the row already published there is no transition
  // to attempt and no write is issued at all. Control falls through to the
  // re-read below, which reports what is actually there rather than the stale
  // value the gate held — which is what keeps this from reintroducing the
  // earlier bug of answering 200 with a timestamp that no longer applies.
  //
  // What this does NOT claim: full optimistic concurrency. A row that went
  // published -> unpublished between the gate and this write is now handled,
  // but one that went published -> unpublished -> published -> unpublished
  // would still be published by it, because by then the observed state and the
  // actual state agree. Closing that needs a version column and a precondition
  // on every Media writer — a wider change than this route. What is closed
  // here is the single-step interleaving, which is the one with clear intent
  // and clear harm.
  const publishedAt = new Date();
  let publishedNow = false;

  if (access.media.publishedAt === null) {
    // `updateMany` scoped by `{ id, userId }` rather than `update` by id: the
    // gate read the row in a separate statement, so only a where clause on the
    // write itself rules out a row deleted or re-owned in between. The gate
    // decides the status code; this decides what changes.
    //
    // `publishedAt: null` in the predicate is the transition guard: two
    // concurrent publishes cannot both write, and the loser falls through to
    // the re-read and reports the winner's timestamp rather than overwriting.
    const { count } = await prisma.media.updateMany({
      where: { id, userId: access.userId, publishedAt: null },
      data: { publishedAt },
    });
    publishedNow = count === 1;
  }

  if (publishedNow && previewId !== null) {
    // No re-read on the happy path: the only columns touched are the ones just
    // written, and Media has no DB-derived fields (no updatedAt, no triggers)
    // that a second round trip would reveal.
    //
    // Projected through toOwnerMedia rather than spread: the gate reads the
    // whole row because DELETE needs the storage keys, and echoing it verbatim
    // would hand `key` — the ungated original (ugcportal-5d6) — to the client,
    // the one column every other handler goes out of its way to withhold.
    return NextResponse.json(
      toOwnerMedia({ ...access.media, publishedAt, previewId }),
    );
  }

  // Everything else reads the row and answers on what is actually there:
  // the gate saw it already published, the transition matched nothing, or a
  // concurrent repair won and this request does not know the surviving
  // previewId. Guessing 404 would report a successful publish as a failure;
  // guessing 200 would report a deleted row as published, or answer with a
  // body saying the item is not published — a success describing its opposite.
  const current = await prisma.media.findFirst({
    where: { id, userId: access.userId },
    select: MEDIA_OWNER_SELECT,
  });

  if (!current) {
    // Deleted, or re-owned, between the gate and the write. The same answer
    // the sibling DELETE gives when it loses the same race.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (current.publishedAt === null) {
    // The row exists and is NOT published: an unpublish won. Reporting 200
    // here would tell the client its publish succeeded while handing back
    // `publishedAt: null`.
    //
    // 409 rather than retrying the write: the unpublish is the more recent
    // instruction and a retry would let this older request overturn it —
    // last-writer-wins, backwards. The caller is told what actually holds and
    // can decide whether it still wants to publish.
    //
    // 404 would be wrong too, which is why this is not folded into the branch
    // above: the row is right there, and the caller owns it.
    return NextResponse.json(
      {
        error:
          "This item was unpublished by another request. Publish it again if that was not intended.",
      },
      { status: 409 },
    );
  }

  // Published — by an earlier request of this caller's, a concurrent one, or
  // this one alongside a repair that a competing request also performed.
  // Idempotent success, reporting the winner's timestamp rather than
  // overwriting it.
  return NextResponse.json(current);
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
