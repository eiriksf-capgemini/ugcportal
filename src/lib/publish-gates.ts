import { advertisingLabelPublishRefusal } from "@/lib/advertising-disclosure";
import type { AdvertisingDisclosureFacts } from "@/lib/advertising-disclosure";
import { commercialPublishRefusal } from "@/lib/alcohol-commerce";
import type {
  BenefitSourceAlcoholFacts,
  ListingAlcoholFacts,
} from "@/lib/alcohol-commerce";
import { commercialLinkPublishRefusal } from "@/lib/commercial-link";
import type { prisma } from "@/lib/prisma";
import {
  PUBLISH_ATTESTATION_SELECT,
  PUBLISH_LISTING_SELECT,
  publishRightsRefusal,
  type PublishRefusal,
  type PublishabilityListing,
} from "@/lib/publishability";
import type { GateAttestation } from "@/lib/resale-rights";

/**
 * THE PUBLISH GATES, IN ONE PLACE (ugcportal-ho7j).
 *
 * Every condition on the MATERIAL that stands between an unpublished row and
 * `publishedAt`, in the order they are asked, with the status code and body
 * each refusal answers with. Two callers, and the reason this is a module of
 * its own rather than a block inside one route:
 *
 *   - POST /api/media/[id]/publish, the operator's manual publish, which
 *     asked these questions inline until this bead moved the checks here
 *     unchanged (their comments came too, with pointers to code that stayed
 *     in that route repointed);
 *   - POST /api/media, which publishes a CONFIGURED user's upload in the
 *     same transaction that creates the row, if and only if this function
 *     answers null.
 *
 * One function so the two cannot drift: a gate added here is a gate on both
 * doors, and a gate that exists on only one of them is not expressible.
 *
 * WHAT IS NOT HERE, deliberately. Who may publish — the ownership gate
 * (`requireOwnedMedia`) and the operator gate (`publishOperatorRefusal`,
 * src/lib/publish-authority.ts) — stays in the manual route, ahead of this
 * call: those are questions about the CALLER, and an upload's caller is by
 * construction its owner and, for an auto-publish, a configured user. The
 * `previewId` repair and the transition write stay in the manual route too;
 * they are how that route applies a decision, not part of the decision.
 *
 * LAZY SOURCES, NOT LOADED DATA, and the order is the reason. The manual
 * route reads the disclosure only once alt text has passed, the link count
 * only once the disclosure has, and so on — a refused request costs no read
 * that cannot change its answer, and its tests assert that ("refuses before
 * reading the disclosure when alt text is missing too"). Handing this
 * function four already-loaded values would have meant reading all four
 * before the first gate, which changes the manual route's read pattern even
 * where it does not change its answer. Each source is called at most once,
 * at the point the gate that needs it is reached.
 *
 * The comments on each gate below are the ones that stood beside the inline
 * checks in POST /api/media/[id]/publish; "this route" in them means that
 * route, which is still the only caller that can reach a row in every state
 * they discuss (an already-published row, a row with a disclosure or a
 * listing). An upload's row is freshly created, unpublished, with no
 * disclosure, no link and no listing.
 */

/** The `Media` columns the gates read off the row itself. */
export type PublishGateMedia = {
  publishedAt: Date | null;
  altText: string | null;
  previewKey: string | null;
};

/** The disclosure as the gates read it: the label pair and the brand's alcohol answer. */
export type PublishGateDisclosure = AdvertisingDisclosureFacts & {
  benefitSource: BenefitSourceAlcoholFacts | null;
};

/** The listing as the gates read it: the alcohol triage answer and the people half. */
export type PublishGateListing = ListingAlcoholFacts & PublishabilityListing;

/**
 * Where each gate's input comes from. Each is called at most once, and only
 * once every gate before it has passed — see the module comment.
 */
export type PublishGateSources = {
  disclosure: () => Promise<PublishGateDisclosure | null>;
  commercialLinkCount: () => Promise<number>;
  listing: () => Promise<PublishGateListing | null>;
  attestation: () => Promise<GateAttestation | null>;
  /**
   * `User.configuredHandle !== null` for the uploader. Consulted only when
   * the attestation is missing, the one case where the answer changes
   * anything (`publishabilityBlocker`, src/lib/publishability.ts).
   */
  uploaderConfigured: () => Promise<boolean>;
};

/** A refusal: the HTTP status and the body, exactly as the manual route answers. */
export type PublishGateRefusal =
  | { status: 400; body: { error: string; field: string } }
  | { status: 422; body: PublishRefusal }
  | { status: 409; body: { error: string } };

/** The disclosure select the gates read, shared by every caller. */
export const PUBLISH_GATE_DISCLOSURE_SELECT = {
  benefitReceived: true,
  label: true,
  // The brand's alcohol answer, for the second refusal below. Nested on
  // the same read rather than fetched separately: it is one join on a
  // query the label gate already makes, and the alternative is a second
  // round trip on the same rare, deliberate act.
  benefitSource: { select: { alcoholLinked: true } },
} as const;

/** The listing select the gates read, shared by every caller. */
export const PUBLISH_GATE_LISTING_SELECT = {
  depictsAlcohol: true,
  // The people half of the rights gate below (ugcportal-3ae): the
  // admin's own answer to the people question, and the per-layer
  // clearances with each clearer's CURRENT role. Folded into the read
  // the alcohol gate already makes rather than issued as a second one — the
  // same trade the disclosure read above states, and the reason the
  // select is spread from `PUBLISH_LISTING_SELECT` is so there is one
  // copy of what that gate reads rather than one here and one in the
  // module that decides.
  ...PUBLISH_LISTING_SELECT,
} as const;

/**
 * The first refusal, in the order the manual route has always asked, or
 * null when nothing about the material stands in the way of publishing it.
 *
 * `userId` is `Media.userId` — the uploader — which the rights gate checks
 * the declaration's author against.
 */
export async function publishGateRefusal(
  media: PublishGateMedia,
  userId: string,
  sources: PublishGateSources,
): Promise<PublishGateRefusal | null> {
  // Alt text is REQUIRED TO PUBLISH (ugcportal-gwr K1) — not to store an
  // upload (a configured uploader's upload with none is stored unpublished),
  // and not at the schema layer (Media.altText is nullable; see that column's
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
  // `publishedAt: null` is in the manual route's write. That one is
  // folded in because something CAN race it — a concurrent publish or
  // unpublish — and the predicate is how two racing writes agree on a
  // winner. Nothing today can race THIS check: `altText` is set once, at
  // upload, and never cleared afterwards (no route writes it null — the
  // rename endpoint only touches `originalName`), so there is no concurrent
  // writer for a `where: { altText: { not: null } }` clause to defend
  // against yet. The day a second writer can null it out (an edit surface,
  // say), this needs the same treatment `previewId`'s repair logic in the
  // manual route got — but adding it now, against nothing, would be exactly
  // the kind of check the manual route's own comments warn against: one
  // that reads as a defence and is not exercised by anything.
  //
  // GATED ON `publishedAt === null` — i.e. only on an actual TRANSITION,
  // never on an already-published row. Without
  // this, an idempotent re-POST on a row that is ALREADY published but
  // happens to have a null `altText` — which this bead's backfill migration
  // closes for every row that existed when it ran, but cannot close for a
  // row inserted by stale pre-this-bead code during the brief window of a
  // migrate-then-swap rolling deploy, the same deploy shape the manual
  // route's own `previewId` self-repair exists to tolerate — would
  // 400 instead of returning the 200 that route's own docstring promises
  // ("Idempotent... an already-published row keeps its original [timestamp]
  // rather than having its history rewritten"). K1 is a rule about the
  // TRANSITION (no row may go from unpublished to published without alt
  // text); it was never meant to retroactively block a row that is already
  // sitting on the other side of that transition. Nothing is weakened by
  // this: a genuinely unpublished row with no alt text is still refused
  // below, exactly as before.
  if (
    media.publishedAt === null &&
    (media.altText === null || media.altText.trim() === "")
  ) {
    return {
      status: 400,
      body: {
        error: "Add alt text before publishing this item.",
        field: "altText",
      },
    };
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
  // shared by PATCH, DELETE, tags and both handlers of the manual route, and none of the
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
  const disclosure = await sources.disclosure();
  const refusal = advertisingLabelPublishRefusal(disclosure);
  if (refusal) {
    return { status: 400, body: refusal };
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
    commercialLinkCount: await sources.commercialLinkCount(),
  };
  const linkRefusal = commercialLinkPublishRefusal(disclosure, commercialLinks);
  if (linkRefusal) {
    return { status: 400, body: linkRefusal };
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
  const listing = await sources.listing();
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
    return { status: 400, body: alcoholRefusal };
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
  // the flow that asks the rights questions (everybody but a configured
  // uploader is asked them), or an administrator recording a clearance. The body carries `blocker`, a closed-set code, rather than
  // `field`, for the same reason.
  //
  // NOT GATED ON `publishedAt === null`, matching the two refusals above
  // rather than the alt-text one. The alt-text check is transition-only
  // because an already-published row with blank alt text is a rolling-deploy
  // artefact that is in breach of nothing. A published row whose
  // declaration this gate refuses is the opposite: it is precisely the row K3
  // says must not be on a public surface. For a disclaiming or retired
  // declaration — or, from a NON-configured uploader, no declaration at all —
  // `PUBLIC_MEDIA_SCOPE` does not serve it either, and answering 200 to
  // "publish this" because it is already marked published would be this
  // route reporting success for a row the site is refusing to show. A
  // declaration made by someone other than the uploader is refused here but
  // still SERVED by the scope: it is one of the two states a Prisma `where`
  // cannot judge (ugcportal-0epl), asserted in both directions in
  // src/lib/publishability.scope-agreement.test.ts. (A configured
  // uploader's row with no declaration is not refused here and is served by
  // the scope — ugcportal-ho7j; the two agree.)
  //
  // THE ATTESTATION IS READ HERE AND NOT THROUGH `requireOwnedMedia`, the
  // same trade the two reads above make: PATCH, DELETE and tags have no use
  // for it, and a join on the shared gate would make all of them pay.
  //
  // A CONFIGURED UPLOADER WITH NO DECLARATION IS NOT REFUSED HERE
  // (ugcportal-ho7j): `publishabilityBlocker` skips the declaration check for
  // exactly that pair, and judges a declaration that IS present in full
  // whoever made it. `uploaderConfigured` is read only when the declaration
  // is missing; with one present the flag changes nothing, so `false` is
  // passed rather than paying for a read whose answer is unused.
  const attestation = await sources.attestation();
  const rightsRefusal = publishRightsRefusal({
    userId,
    attestation,
    listing,
    uploaderConfigured:
      attestation === null ? await sources.uploaderConfigured() : false,
  });
  if (rightsRefusal) {
    return { status: 422, body: rightsRefusal };
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
  if (media.previewKey === null || media.previewKey.trim() === "") {
    return {
      status: 409,
      body: {
        error:
          "This item has no watermarked preview yet, so it cannot be published.",
      },
    };
  }

  return null;
}

/**
 * The client the sources read through: the global Prisma client, or the
 * transaction a caller is already inside (POST /api/media creates the row in
 * one and has to read it back through the same one to see it at all).
 */
export type PublishGateClient = Pick<
  typeof prisma,
  | "mediaAdvertisingDisclosure"
  | "commercialLink"
  | "mediaListing"
  | "mediaAttestation"
  | "user"
>;

/**
 * The gates' sources, read from the database for one row.
 *
 * `uploaderConfigured`, when the caller already knows it (POST /api/media
 * decided it once, from the `User` row, before the watermark and storage
 * work), is used as given
 * rather than read a second time; otherwise it is read from the uploader's
 * `User` row on demand — never from the session or the request.
 */
export function publishGateSources(
  client: PublishGateClient,
  {
    mediaId,
    userId,
    uploaderConfigured,
  }: { mediaId: string; userId: string; uploaderConfigured?: boolean },
): PublishGateSources {
  return {
    disclosure: () =>
      client.mediaAdvertisingDisclosure.findUnique({
        where: { mediaId },
        select: PUBLISH_GATE_DISCLOSURE_SELECT,
      }),
    commercialLinkCount: () =>
      client.commercialLink.count({ where: { mediaId } }),
    listing: () =>
      client.mediaListing.findUnique({
        where: { mediaId },
        select: PUBLISH_GATE_LISTING_SELECT,
      }),
    attestation: () =>
      client.mediaAttestation.findUnique({
        where: { mediaId },
        select: PUBLISH_ATTESTATION_SELECT,
      }),
    uploaderConfigured: async () => {
      if (uploaderConfigured !== undefined) return uploaderConfigured;
      return isConfiguredUser(client, userId);
    },
  };
}

/**
 * Is this user one of the CONFIGURED people — `User.configuredHandle` not
 * null (src/config/users.ts, linked by src/lib/configured-user-link.ts)?
 *
 * Read from the `User` row by id, never from the session: the session
 * payload does not carry the column (src/lib/auth.session-payload.test.ts),
 * and nothing a client sends may decide it. A missing row answers `false`,
 * which is the fail-closed direction — the uploader is then treated as
 * anybody else.
 */
export async function isConfiguredUser(
  client: Pick<typeof prisma, "user">,
  userId: string,
): Promise<boolean> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { configuredHandle: true },
  });
  return (user?.configuredHandle ?? null) !== null;
}
