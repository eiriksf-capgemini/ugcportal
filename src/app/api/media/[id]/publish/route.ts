import { NextResponse } from "next/server";

import { advertisingLabelPublishRefusal } from "@/lib/advertising-disclosure";
import { commercialPublishRefusal } from "@/lib/alcohol-commerce";
import { commercialLinkPublishRefusal } from "@/lib/commercial-link";
import {
  MEDIA_OWNER_SELECT,
  requireOwnedMedia,
  toOwnerMedia,
} from "@/lib/media-access";
import { mediaPreviewColumns } from "@/lib/media";
import { prisma } from "@/lib/prisma";
import { publishOperatorRefusal } from "@/lib/publish-authority";
import {
  PUBLISH_ATTESTATION_SELECT,
  PUBLISH_LISTING_SELECT,
  publishRightsRefusal,
} from "@/lib/publishability";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

/**
 * Publish / unpublish one media item (ugcportal-r1d). Owner only — and, for
 * the publishing direction, an OPERATOR's own row (ugcportal-9gt1).
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

  // AND OWNING THE ROW IS NOT PERMISSION TO PUBLISH IT (ugcportal-9gt1).
  // `requireOwnedMedia` above answers "is this row yours"; this answers "may
  // you make anything public at all", and until this check existed nothing
  // asked the second question. The rule — only operators publish — held
  // solely because `ALLOWED_SIGNIN_EMAILS` happens to list two people, so
  // adding a third address to let somebody upload would silently have handed
  // them the public gallery. See src/lib/publish-authority.ts for the
  // decision itself, and for why "may publish" is asked as its own question
  // rather than by calling `requireAdmin` even though the two sets are the
  // same set today.
  //
  // 403 — the same code the ownership gate above answers for "not your row",
  // and deliberately the same: both mean "you may not do this", and the BODY
  // is what tells them apart (that one is a bare `{ error: "Forbidden" }`,
  // this one carries a `blocker`). A 422 would be wrong here. That code says
  // "the records make this impossible", which is what the rights gate below
  // means and is not what this means: nothing about the ROW is wrong, and no
  // work on it changes the answer. The closed-set `blocker` rather than a
  // `field` matches `publishRightsRefusal` for the reason it gives — there
  // is no form field to point at.
  //
  // AFTER THE OWNERSHIP GATE, so this route's existing contract is untouched:
  // ugcportal-r1d specified 401 for an anonymous caller and 403 for someone
  // else's row, and a non-owner must keep getting the ownership answer rather
  // than learning about this one.
  //
  // BEFORE EVERY CONDITION ON THE MATERIAL — alt text, the advertising label,
  // the alcohol answer and the ugcportal-3ae rights gate all come after it.
  // Two reasons, and the second is the one that matters. It is cheaper: a
  // refused caller costs no disclosure, listing or attestation read, three
  // round trips that cannot change the answer. And it is quieter: a
  // non-operator gets ONE stable sentence whatever state their row is in,
  // instead of a refusal that narrates how far along the compliance record
  // is and shifts as an administrator works on it.
  const operatorRefusal = publishOperatorRefusal(access.role);
  if (operatorRefusal) {
    return NextResponse.json(operatorRefusal, { status: 403 });
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
  //
  // GATED ON `publishedAt === null` — i.e. only on an actual TRANSITION,
  // never on an already-published row (review round 4 finding 4). Without
  // this, an idempotent re-POST on a row that is ALREADY published but
  // happens to have a null `altText` — which this bead's backfill migration
  // closes for every row that existed when it ran, but cannot close for a
  // row inserted by stale pre-this-bead code during the brief window of a
  // migrate-then-swap rolling deploy, the same deploy shape this route's
  // own `previewId` self-repair a few lines below exists to tolerate — would
  // 400 instead of returning the 200 this route's own docstring promises
  // ("Idempotent... an already-published row keeps its original [timestamp]
  // rather than having its history rewritten"). K1 is a rule about the
  // TRANSITION (no row may go from unpublished to published without alt
  // text); it was never meant to retroactively block a row that is already
  // sitting on the other side of that transition. Nothing is weakened by
  // this: a genuinely unpublished row with no alt text is still refused
  // below, exactly as before.
  if (
    access.media.publishedAt === null &&
    (access.media.altText === null || access.media.altText.trim() === "")
  ) {
    return NextResponse.json(
      {
        error: "Add alt text before publishing this item.",
        field: "altText",
      },
      { status: 400 },
    );
  }

  // AN UNLABELLED ADVERTISEMENT MAY NOT BE PUBLISHED (ugcportal-qnq9.1 K2).
  // Forbrukertilsynet requires a prominent advertising label on any item the
  // operator was paid or given a benefit for, and holds both the creator and
  // the brand responsible for one that is missing (docs/ugc-research.md §3.2;
  // §5.7 confirms posting in English does not change that). So the same
  // refusal shape alt text gets, a line above: a 400 naming the field,
  // because the request is well-formed and authorized and what blocks it is
  // the row's own current state.
  //
  // A SEPARATE READ rather than widening `requireOwnedMedia`. That gate is
  // shared by PATCH, DELETE, tags and both handlers here, and none of the
  // others has any use for the disclosure — adding it to the gate would make
  // every one of them pay for a join to answer a question only this branch
  // asks. Publishing is a rare, deliberate act; one extra round trip on it is
  // the cheaper side of that trade.
  //
  // NOT GATED ON `publishedAt === null`, which is the one place this
  // deliberately differs from the alt-text check above, so the difference is
  // worth stating. That check is transition-only because `altText` has no
  // writer that can clear it, so the only way an already-published row can
  // have a blank one is a stale pre-backfill insert during a rolling deploy —
  // a row that is not in breach of anything, which a 400 on an idempotent
  // re-POST would wrongly punish. This column is the opposite case: there is
  // no backfill and no pre-existing row that lands in the refused state (an
  // item with no disclosure row is unanswered, which publishes), and PUT
  // /api/media/[id]/disclosure will not create the refused pair at all. So a
  // published row that reaches this check and fails it was written outside
  // this API and IS in breach — and answering 200 to "publish this undisclosed
  // advertisement" because it already happens to be public is the wrong
  // answer to give.
  const disclosure = await prisma.mediaAdvertisingDisclosure.findUnique({
    where: { mediaId: id },
    select: {
      benefitReceived: true,
      label: true,
      // The brand's alcohol answer, for the second refusal below. Nested on
      // the same read rather than fetched separately: it is one join on a
      // query this branch already makes, and the alternative is a second
      // round trip on the same rare, deliberate act.
      benefitSource: { select: { alcoholLinked: true } },
    },
  });
  const refusal = advertisingLabelPublishRefusal(disclosure);
  if (refusal) {
    return NextResponse.json(refusal, { status: 400 });
  }

  // AND NEITHER MAY AN ADVERTISING LINK WITH NO LABEL ABOVE IT
  // (ugcportal-jain K2). The check above asks whether a DECLARED BENEFIT is
  // labelled and answers null the moment `benefitReceived` is not `true`,
  // which is precisely the state a withdrawal leaves behind — so until this
  // bead, an item whose disclosure had been withdrawn after a link was
  // attached passed every gate on this route and published carrying a live
  // affiliate link with nothing labelling it. §3.2 wants the page labelled at
  // the top AND at each link; the top label is rendered from
  // `MediaAdvertisingDisclosure.label` and from nothing else.
  //
  // A SEPARATE COUNT RATHER THAN A WIDENED `requireOwnedMedia`, the same
  // trade the disclosure read above states and for the same reason: PATCH,
  // DELETE and tags have no use for the link count, and a join on the shared
  // gate would make all three pay for it.
  //
  // A COUNT AND NOT THE ROWS — `CommercialLinkFacts`
  // (src/lib/alcohol-commerce.ts) is what both gates below declare as their
  // input, and both decide on "any". The destinations and the brands behind
  // them are a compliance record this route has no business reading to answer
  // a yes/no question.
  //
  // READ UNCONDITIONALLY, although the gate immediately below answers null
  // for every item that carries no link, which is almost all of them. The
  // version that skipped it behind a second reading of the disclosure would
  // be the mistake the alcohol lookup further down documents at length: a
  // short-circuit in a place that cannot see the gate's rule, failing in the
  // direction of the gate never running.
  const commercialLinks = {
    commercialLinkCount: await prisma.commercialLink.count({
      where: { mediaId: id },
    }),
  };
  const linkRefusal = commercialLinkPublishRefusal(disclosure, commercialLinks);
  if (linkRefusal) {
    return NextResponse.json(linkRefusal, { status: 400 });
  }

  // AND NO ADVERTISEMENT MAY SHOW ALCOHOL, OR COME FROM A BRAND THAT SELLS IT
  // (ugcportal-qnq9.3 K6). alkoholloven § 9-2 bans alcohol from appearing in
  // advertising for other products, and §3.1a reads the ban as covering
  // products that share a brand or trademark with an alcoholic drink; the
  // breach has been administratively finable since 13 September 2024.
  //
  // A SECOND REFUSAL RATHER THAN A WIDER FIRST ONE. The two gates answer
  // different questions about the same row — "is this advertisement
  // labelled" and "may this advertisement exist at all" — and they come from
  // different beads, different regulators and different statutes. Folding
  // them together would produce one function whose message had to cover both,
  // on a page where the message is the only instruction the operator gets.
  //
  // PUBLISHING IS THE CHOKEPOINT, which is why this lives here and not on the
  // price route. Every public surface — the gallery tile, the lightbox, the
  // item page, the public feed, and the advertising label all four of them
  // render (ugcportal-e0jv) — is downstream of `publishedAt`, so an item
  // refused here reaches none of them. A price on an unpublished row is not
  // an offer to anybody.
  //
  // NOT GATED ON `publishedAt === null`, for the reason the paragraph above
  // the alt-text check gives at length: a published row that fails this was
  // written outside this API and IS in breach, and answering 200 to "publish
  // this alcohol advertisement" because it already happens to be public is
  // the wrong answer to give.
  //
  // THE LISTING IS READ HERE AND NOT THROUGH `requireOwnedMedia`, the same
  // trade the disclosure read above makes: the triage answer is of no use to
  // PATCH, DELETE or tags, and a join on the shared gate would make all of
  // them pay for it.
  //
  // READ UNCONDITIONALLY, although `commercialPublishRefusal` answers null
  // for every item that records no benefit and the lookup is then wasted. The
  // version that skipped it behind `disclosure?.benefitReceived === true` was
  // a second reading of the field the gate itself reads, in a module that
  // could not see it — and the direction that mistake fails in is the gate
  // never running at all. One indexed lookup by a unique key, on a rare and
  // deliberate act, is the cheaper side of that trade; the predicate lives in
  // exactly one place.
  const listing = await prisma.mediaListing.findUnique({
    where: { mediaId: id },
    select: {
      depictsAlcohol: true,
      // The people half of the rights gate below (ugcportal-3ae): the
      // admin's own answer to the people question, and the per-layer
      // clearances with each clearer's CURRENT role. Folded into the read
      // this branch already makes rather than issued as a second one — the
      // same trade the disclosure read above states, and the reason the
      // select is spread from `PUBLISH_LISTING_SELECT` is so there is one
      // copy of what that gate reads rather than one here and one in the
      // module that decides.
      ...PUBLISH_LISTING_SELECT,
    },
  });
  // `commercialLinks` is the same count the label gate above already took,
  // reused rather than re-counted: two reads of the same number on one
  // request could disagree, and the gate that ran second would be deciding
  // about a row the gate that ran first never saw (ugcportal-jain).
  const alcoholRefusal = commercialPublishRefusal({
    disclosure,
    listing,
    commercialLinks,
  });
  if (alcoholRefusal) {
    return NextResponse.json(alcoholRefusal, { status: 400 });
  }

  // AND NOTHING IS PUBLISHED THAT ITS UPLOADER HAS NOT VOUCHED FOR, OR THAT
  // SHOWS A PERSON NOBODY HAS SIGNED OFF ON (ugcportal-3ae K1/K2). The gate
  // itself is src/lib/publishability.ts; see that module for why it is
  // separate from `evaluateSellability` and for what each refusal means.
  //
  // 422 rather than the 400 its two neighbours above answer with. Those
  // refuse a FIELD the operator can go and correct — an advertising label,
  // an alcohol answer — and a 400 naming the field is the right shape for
  // that. These refuse the REQUEST as semantically impossible given records
  // that live outside this form entirely: the fix is a re-upload through
  // the flow that asks the rights questions, or an administrator recording
  // a clearance. The body carries `blocker`, a closed-set code, rather than
  // `field`, for the same reason.
  //
  // NOT GATED ON `publishedAt === null`, matching the two refusals above
  // rather than the alt-text one. The alt-text check is transition-only
  // because an already-published row with blank alt text is a rolling-deploy
  // artefact that is in breach of nothing. A published row with no
  // attestation is the opposite: it is precisely the row K3 says must not be
  // on a public surface, and `PUBLIC_MEDIA_SCOPE` has already stopped
  // serving it. Answering 200 to "publish this" because it is already marked
  // published would be this route reporting success for a row the site is
  // refusing to show.
  //
  // THE ATTESTATION IS READ HERE AND NOT THROUGH `requireOwnedMedia`, the
  // same trade the two reads above make: PATCH, DELETE and tags have no use
  // for it, and a join on the shared gate would make all of them pay.
  const attestation = await prisma.mediaAttestation.findUnique({
    where: { mediaId: id },
    select: PUBLISH_ATTESTATION_SELECT,
  });
  const rightsRefusal = publishRightsRefusal({
    userId: access.userId,
    attestation,
    listing,
  });
  if (rightsRefusal) {
    return NextResponse.json(rightsRefusal, { status: 422 });
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
 * AND NO OPERATOR CHECK EITHER (ugcportal-9gt1), which is the one place this
 * handler deliberately diverges from its sibling now rather than merely
 * having less to verify. Every other refusal POST applies is a condition on
 * making something public, and withdrawing it moves in the safe direction:
 * the gate exists so that material reaches the public gallery only by an
 * operator's decision, not so that it STAYS there against its owner's. An
 * owner who is demoted, or who was never an operator but holds a row
 * published before this rule existed, must still be able to take their own
 * photograph down — gating this would turn a safety check into a trap, and
 * route.test.ts asserts it does not. Nothing here gives an operator a way
 * into somebody ELSE's visibility either: `requireOwnedMedia` has no role
 * branch, so an admin who does not own the row still gets 403 from both
 * handlers, exactly as before. ugcportal-r1d put admin curation of another
 * person's visibility out of scope and no screen has taken it up since —
 * the command, rather than a count that rots: `grep -rni unpublish src`
 * outside this directory is comments and test names, with no component,
 * server action or `fetch` among them.
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
