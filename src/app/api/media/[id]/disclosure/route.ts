import { NextResponse } from "next/server";

import type { BenefitKind } from "@/generated/prisma/enums";
import {
  isBenefitKind,
  validateAdvertisingLabel,
  BENEFIT_KINDS,
} from "@/lib/advertising-disclosure";
import {
  benefitAttachmentRefusal,
  effectiveBrandAlcoholAnswer,
} from "@/lib/alcohol-commerce";
import { resolveBenefitSource, validateBenefitSourceName } from "@/lib/benefit-source";
import { disclosureWithdrawalRefusal } from "@/lib/commercial-link";
import { requireOwnedMedia } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { PRISMA_RECORD_NOT_FOUND, prismaErrorCode } from "@/lib/prisma-errors";
import { readJsonBody } from "@/lib/request-body";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

/**
 * The advertising disclosure on one media item (ugcportal-qnq9.1). Owner only.
 *
 * ITS OWN SUB-ROUTE, next to publish and tags, for the reason both of those
 * give for being one: PATCH /api/media/[id]'s contract is "originalName is the
 * only editable column", one request body and one thing it can change.
 *
 * It reuses the SAME ownership gate every handler on this resource uses —
 * `requireOwnedMedia` (ugcportal-bdh) — so 401/403/404 are decided in one
 * place and answered identically here.
 *
 * WHAT THIS IS NOT. It is not the resale triage: MediaListing.sponsoredContent
 * and RightsLayer.SPONSORED_CONTENT answer "may this be RESOLD" for the
 * sellability gate (src/lib/resale-rights.ts), and this answers "must this be
 * LABELLED as advertising for the public". An item can be perfectly sellable
 * and still need a label. Writing here touches no price, no licence state and
 * no `publishedAt`: recording a benefit neither publishes nor unpublishes an
 * item — the upsert below writes the disclosure's own columns and nothing
 * else, asserted by "does not touch publishedAt when a disclosure is
 * recorded" in route.test.ts (see also the note on the publish interaction
 * below).
 */

/**
 * The body is a small flat object: a boolean, an enum name, a brand name
 * (bounded by MAX_BENEFIT_SOURCE_NAME_LENGTH), an integer, and a label
 * (bounded by MAX_ADVERTISING_LABEL_INPUT_LENGTH).
 *
 * NO FIELD LENGTH IS RESTATED HERE. Both caps live next to the validator
 * that enforces each, and a second copy of either number in this comment is
 * a number that can go stale without anything failing.
 *
 * 2048 is NOT derived from those caps, and no arithmetic relating it to them
 * is asserted here — a byte count in a comment is a number that goes stale
 * the moment either cap moves, with nothing failing. It is simply far above
 * any body this route can legitimately be sent (the longest value the label
 * allowlist can ever store is a couple of dozen characters, and a brand name
 * is a few words) and far below anything that is not a short flat object.
 * A larger body is refused with a 413 before it is buffered, which is the
 * right answer for a request that is not the shape this route accepts.
 *
 * App Router puts no default cap on a request body, so without this the
 * length checks below would only run after the server had buffered whatever
 * arrived.
 */
const MAX_DISCLOSURE_BODY_BYTES = 2048;

/** Largest market value this will accept, in øre: NOK 10,000,000. Not a
 * compliance rule — §3.3 sets no ceiling — but an integer column deserves a
 * bound that is obviously above any real UGC benefit and obviously below the
 * point where a typo becomes a number nobody notices is wrong. */
const MAX_MARKET_VALUE_ORE = 1_000_000_000;

type Body = {
  benefitReceived?: unknown;
  benefitKind?: unknown;
  benefitSource?: unknown;
  /** The brand's answer to §3.1a's "who's behind the brand" question
   * (ugcportal-qnq9.3 K4). Accepted here, on the request that first names a
   * brand, because this is the only surface in the product where a brand is
   * ever named — see `upsertDisclosure` for what is done with it. */
  benefitSourceAlcoholLinked?: unknown;
  marketValueOre?: unknown;
  label?: unknown;
};

/** The projection a disclosure is echoed through. The brand is reported by
 * name and slug rather than by id: the id is an internal handle the caller
 * has no use for, and the slug is the identity they would look it up by. */
const DISCLOSURE_SELECT = {
  benefitReceived: true,
  benefitKind: true,
  marketValueOre: true,
  label: true,
  createdAt: true,
  updatedAt: true,
  // `alcoholLinked` is echoed so the caller can see which answer is now on
  // record against the brand — the one piece of this response that a second
  // request's outcome depends on, since an answered brand needs no answer
  // submitted next time (ugcportal-qnq9.3 K4).
  benefitSource: {
    select: { slug: true, name: true, alcoholLinked: true },
  },
} as const;

function badRequest(message: string, field?: string) {
  return NextResponse.json(
    field ? { error: message, field } : { error: message },
    { status: 400 },
  );
}

/**
 * Records (or replaces) the whole disclosure for this item.
 *
 * PUT rather than PATCH because it is a replacement, the same call the tags
 * route makes: the answer sent is the answer that ends up on the row, and
 * there is no add-one/clear-one verb. `{"benefitReceived": false}` is how a
 * benefit that was recorded by mistake is withdrawn, and it clears the kind,
 * the source, the value and the label with it — a label left behind on an item
 * declared benefit-free is itself misleading (K4).
 *
 * THE ONE INVARIANT THIS ROUTE EXISTS TO HOLD: `benefitReceived: true` may not
 * be stored without a permitted label. That is enforced here, at the write,
 * rather than only at the publish gate, and the difference is not redundancy.
 * Enforced only at publish, an operator could publish an honest item and then
 * record "actually this was gifted" with no label, leaving a public,
 * undisclosed advertisement that no further request would ever notice. Refused
 * here, that state is unreachable through this API: the upsert below is the
 * only writer of MediaAdvertisingDisclosure in the application (`grep -rn
 * mediaAdvertisingDisclosure src` finds it and the publish gate's read, and
 * nothing else), and it is never reached with a benefit of true and an
 * unpermitted label. The publish gate (src/lib/advertising-disclosure.ts,
 * read by POST /api/media/[id]/publish) is the backstop for rows written any
 * other way — a raw statement, or a future importer.
 *
 * AND A SECOND INVARIANT, FROM A DIFFERENT STATUTE (ugcportal-qnq9.3 K2/K4):
 * a benefit may not be attached to an item recorded as showing alcohol, nor
 * to one from a brand that produces, imports or sells alcohol — nor to one
 * from a brand nobody has checked, because §3.1a says to check before the
 * deal and an unasked question is not a `no`. Enforced in `upsertDisclosure`
 * below, before anything at all is written; the refusal is the same 400
 * shape as the ones above.
 *
 * WITHDRAWING A BENEFIT IS NEVER REFUSED BY THAT GATE, which is why it sits
 * on the declaring branch only. `{"benefitReceived": false}` is how a
 * mistaken declaration is taken back, and refusing to let an operator
 * withdraw a benefit from an alcohol photograph would point the rule
 * backwards — the same argument the curation price route makes for leaving
 * un-pricing ungated.
 *
 * A WITHDRAWAL IS NOT UNCONDITIONAL, THOUGH, AND THE PARAGRAPH ABOVE USED TO
 * READ AS IF IT WERE (ugcportal-jain). A DIFFERENT gate, from a different
 * statute, refuses one: `disclosureWithdrawalRefusal`
 * (src/lib/commercial-link.ts), called in `upsertDisclosure` below, answers
 * 409 to a write that would leave this item carrying a commercial link with
 * no permitted label — which every withdrawal would, since a withdrawal
 * clears the label. Clearing it off an item that carries a link leaves a
 * live advertising link with
 * nothing above it saying so — Forbrukertilsynet's § 3.2, not alkoholloven's
 * § 9-2. It points the rule forwards rather than backwards, and it traps
 * nobody: DELETE /api/media/[id]/commercial-links is itself ungated, so the
 * withdrawal is always two requests away.
 *
 * WHAT THIS DOES NOT DO: it does not unpublish. An item that is already public
 * and gains a benefit declaration WITH a valid label stays public, correctly —
 * it now carries the label. An item that is already public cannot gain a
 * declaration WITHOUT one, because of the paragraph above. Depublishing as a
 * remedy is ugcportal-qnq9.5's subject, not this route's.
 */
export async function PUT(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await readJsonBody(request, MAX_DISCLOSURE_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value)
  ) {
    return badRequest("Expected a JSON object body");
  }

  const {
    benefitReceived,
    benefitKind,
    benefitSource,
    benefitSourceAlcoholLinked,
    marketValueOre,
    label,
  } = body.value as Body;

  /*
   * A MISSING `benefitReceived` IS A 400, NOT A "no". The two are one line
   * apart and mean opposite things: `false` is the operator declaring that no
   * benefit was received — an assertion a regulator may later read — and `{}`
   * is a caller who spelled the field wrong. Treating the second as the first
   * puts a declaration nobody made into a compliance record, and answers 200
   * while doing it. `null` IS accepted and means "withdraw the answer", which
   * is the state every item starts in.
   */
  if (benefitReceived === undefined) {
    return badRequest(
      "Field 'benefitReceived' is required (true, false, or null for 'not answered')",
      "benefitReceived",
    );
  }
  if (benefitReceived !== null && typeof benefitReceived !== "boolean") {
    return badRequest(
      "Field 'benefitReceived' must be true, false or null",
      "benefitReceived",
    );
  }

  if (benefitReceived !== true) {
    /*
     * A declaration of "no benefit" (or a withdrawn answer) that also carries
     * a kind, a brand, a value or a label is CONTRADICTORY, and is refused
     * rather than silently stripped. Stripping would answer 200 to a caller
     * who believes they recorded a gifted item and leave the item publishable
     * with no label — the exact outcome this bead exists to prevent, reached
     * by being helpful.
     */
    const stray = (
      [
        ["benefitKind", benefitKind],
        ["benefitSource", benefitSource],
        ["benefitSourceAlcoholLinked", benefitSourceAlcoholLinked],
        ["marketValueOre", marketValueOre],
        ["label", label],
      ] as const
    ).find(([, value]) => value !== undefined && value !== null);
    if (stray) {
      return badRequest(
        `Field '${stray[0]}' may only be set when 'benefitReceived' is true`,
        stray[0],
      );
    }

    const cleared = await upsertDisclosure(id, access.userId, {
      benefitReceived,
      benefitKind: null,
      benefitSource: null,
      benefitSourceAlcoholLinked: undefined,
      marketValueOre: null,
      label: null,
    });
    return cleared ?? notFound();
  }

  // From here: the operator has declared a benefit, so every field that makes
  // the declaration auditable is required.
  if (!isBenefitKind(benefitKind)) {
    return badRequest(
      `Field 'benefitKind' must be one of: ${BENEFIT_KINDS.join(", ")}`,
      "benefitKind",
    );
  }

  const source = validateBenefitSourceName(benefitSource);
  if (!source.ok) {
    return badRequest(source.message, "benefitSource");
  }

  /*
   * §3.1a practical rule 1's answer, about the company rather than about this
   * photograph (ugcportal-qnq9.3 K4). OPTIONAL in the body and required in
   * effect: a brand that already carries an answer does not need one, and a
   * brand that does not carry one is refused by the gate below unless this
   * request supplies it. That is the shape rather than `required: true`
   * because re-answering a question already on record is what would let a
   * later request talk a `yes` back down to a `no`.
   *
   * `null` IS REFUSED, unlike `benefitReceived` where it means "withdraw the
   * answer". There is no withdrawing this one: the brand either has been
   * checked or has not, and a request that could reset it to unchecked would
   * be a request that could erase a `yes`.
   */
  if (
    benefitSourceAlcoholLinked !== undefined &&
    typeof benefitSourceAlcoholLinked !== "boolean"
  ) {
    return badRequest(
      "Field 'benefitSourceAlcoholLinked' must be true or false: does this company produce, import or sell alcohol, or share a brand or trademark with an alcoholic drink?",
      "benefitSourceAlcoholLinked",
    );
  }

  /*
   * The market value is OPTIONAL and `null` is an honest answer: the value of
   * an event invitation is often genuinely unknown when the label is set.
   * Whether the income log REQUIRES it is ugcportal-qnq9.6's call (§3.3, free
   * and discounted products are taxable income at market value); this route
   * only makes sure the number has somewhere true to live.
   */
  if (
    marketValueOre !== undefined &&
    marketValueOre !== null &&
    (typeof marketValueOre !== "number" ||
      !Number.isSafeInteger(marketValueOre) ||
      marketValueOre < 0 ||
      marketValueOre > MAX_MARKET_VALUE_ORE)
  ) {
    return badRequest(
      `Field 'marketValueOre' must be a whole number of øre between 0 and ${MAX_MARKET_VALUE_ORE}`,
      "marketValueOre",
    );
  }

  const validatedLabel = validateAdvertisingLabel(label ?? "");
  if (!validatedLabel.ok) {
    return badRequest(validatedLabel.message, "label");
  }

  const saved = await upsertDisclosure(id, access.userId, {
    benefitReceived: true,
    benefitKind,
    benefitSource: source.value,
    benefitSourceAlcoholLinked,
    marketValueOre: marketValueOre ?? null,
    label: validatedLabel.value,
  });
  return saved ?? notFound();
}

function notFound() {
  // Lost the race with a concurrent delete — the row the caller was authorized
  // for no longer exists. The same answer every sibling handler on this
  // resource gives when it loses the same race.
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

type DisclosureWrite = {
  benefitReceived: boolean | null;
  benefitKind: BenefitKind | null;
  marketValueOre: number | null;
  label: string | null;
  /** The brand to resolve to a row, or null when there is no benefit. A NAME
   * rather than an id, because the id does not exist until the transaction
   * below mints it. */
  benefitSource: { slug: string; name: string } | null;
  /** The brand's alcohol answer as this request supplied it, or undefined
   * when it did not supply one. Never `null`: the validator above refuses
   * that, because unchecked is not a state a request may put a brand back
   * into. */
  benefitSourceAlcoholLinked: boolean | undefined;
};

/**
 * Writes the disclosure, or answers null if the item is no longer there.
 *
 * OR REFUSES: both of the gates this route applies to the stored state rather
 * than to the body — `disclosureWithdrawalRefusal` (ugcportal-jain) and
 * `benefitAttachmentRefusal` (ugcportal-qnq9.3) — are asked here rather than
 * in the handler above, because each needs a fact read from the database in
 * the same transaction as the write it governs. Both return the refusal body
 * as a `NextResponse` from inside the transaction, which the handler passes
 * straight back.
 *
 * IN ONE TRANSACTION WITH the brand resolution, for the reason
 * `resolveBenefitSource` states: a brand minted for a disclosure whose write
 * then fails is permanent debris, because nothing in this product deletes a
 * BenefitSource.
 *
 * THE MEDIA ROW IS RE-CHECKED INSIDE THE TRANSACTION, scoped by `{ id, userId
 * }`. The ownership gate read it in a separate statement, so only a predicate
 * on the write path itself rules out a row deleted or re-owned in between —
 * the same rule the sibling handlers state for their own writes. It cannot be
 * folded into the disclosure's own where-clause the way those fold theirs,
 * because an upsert's `create` branch has no Media predicate to attach to: it
 * would otherwise insert a disclosure for a media row that is gone, and the
 * foreign key only catches that if the row is already deleted rather than
 * merely re-owned.
 */
async function upsertDisclosure(
  mediaId: string,
  userId: string,
  write: DisclosureWrite,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const owned = await tx.media.findFirst({
        where: { id: mediaId, userId },
        // The alcohol triage answer comes along for the gate below. A listing
        // that does not exist is `null` here, which `alcoholDepiction` reads
        // as unanswered — and an item nobody has put forward for sale is
        // exactly an item nobody has triaged.
        select: {
          id: true,
          listing: { select: { depictsAlcohol: true } },
          /*
           * How many commercial links this item carries (ugcportal-jain).
           *
           * READ UNCONDITIONALLY, not behind "is this a withdrawal", which is
           * the same call `recordTriageFacts` (src/lib/curation-triage-write.ts)
           * and the publish route both make about their own § 9-2 lookups, for
           * the reason they give: a short-circuit on the caller's side is a
           * SECOND reading of the condition the gate itself reads, in a place
           * that cannot see the gate's rule, and the direction that mistake
           * fails in is the gate never running at all. One indexed count on a
           * rare, deliberate act is the cheaper side of that trade.
           *
           * A COUNT AND NOT THE ROWS. `disclosureWithdrawalRefusal` decides on
           * "any", and a URL and a brand id are a compliance record this
           * handler has no business reading to answer a yes/no question.
           *
           * IN THE SAME TRANSACTION AS THE UPSERT it governs, and in the same
           * statement as the ownership re-check, so there is no window in which
           * this handler could read a clean count and then write against a row
           * that has changed underneath it. NOT because the transaction
           * serialises them: `@prisma/adapter-libsql` opens SQLite transactions
           * as `deferred`, the honest caveat `recordTriageFacts` records for
           * the identical shape of guard, so a link attached by a concurrent
           * request between this read and the upsert is excluded by nothing
           * here. What covers that interleaving is
           * `commercialLinkPublishRefusal` at the publish boundary, which asks
           * the same question of whatever the row actually ended up holding.
           */
          _count: { select: { commercialLinks: true } },
        },
      });
      if (!owned) return null;

      /*
       * THE LABEL AND THE LINKS TRAVEL TOGETHER (ugcportal-jain K1). Judged on
       * `write.label` — the label this transaction would LEAVE BEHIND — rather
       * than on which branch of the handler above got here, so there is one
       * statement of the rule and it is the rule itself rather than a proxy
       * for it. On the declaring branch `write.label` is a value
       * `validateAdvertisingLabel` just returned, so this never refuses there;
       * on the withdrawing branch it is `null`, which is exactly the state
       * that strands a link.
       *
       * 409 RATHER THAN 400, and no `field`: the same call the attach route
       * makes for its per-item cap. The request is well-formed and the caller
       * is authorized, and what refuses it is the row's current state — a
       * state the caller can change, with a DELETE.
       */
      const strandedLinks = disclosureWithdrawalRefusal(write.label, {
        commercialLinkCount: owned._count.commercialLinks,
      });
      if (strandedLinks) {
        // Returned from inside the transaction, which commits — and commits
        // nothing, because the only statement above it is a read, the same
        // shape the alcohol refusal below uses.
        return NextResponse.json(strandedLinks, { status: 409 });
      }

      let benefitSourceId: string | null = null;
      if (write.benefitSource) {
        /*
         * ugcportal-qnq9.3 K2 AND K4, BEFORE ANYTHING IS WRITTEN — including
         * before the brand row is minted. `resolveBenefitSource`'s own
         * docstring is the reason for that order: nothing in this product
         * deletes a BenefitSource, so a brand minted for a declaration that
         * is then refused is permanent debris. Reading the brand first and
         * minting it only past the gate means a refused request writes
         * nothing at all, which is also what makes "the row is unchanged"
         * true of the brand table and not just of the disclosure.
         */
        const recordedBrand = await tx.benefitSource.findUnique({
          where: { slug: write.benefitSource.slug },
          select: { alcoholLinked: true },
        });
        const recorded = recordedBrand?.alcoholLinked ?? null;
        const effective = effectiveBrandAlcoholAnswer(
          recorded,
          write.benefitSourceAlcoholLinked,
        );

        const refusal = benefitAttachmentRefusal({
          listing: owned.listing,
          benefitSource: { alcoholLinked: effective },
        });
        if (refusal) {
          // Returned from inside the transaction, which commits — and commits
          // nothing, because the two statements above are both reads. A
          // throw-to-roll-back would be the same outcome by a louder route.
          return NextResponse.json(refusal, { status: 400 });
        }

        benefitSourceId = await resolveBenefitSource(write.benefitSource, tx);

        /*
         * THE ONLY BRAND ANSWER THIS ROUTE EVER WRITES IS `null` -> `false`,
         * and that is not a limitation to work around later — it is the whole
         * monotonicity rule, enforced by the two conditions below rather than
         * by remembering it.
         *
         * A `yes` cannot be recorded here because a `yes` is a refusal: the
         * gate above has already returned, so control only reaches this line
         * with `effective === false`. The operator's recourse to an
         * alcohol-linked brand is to decline the deal, which is what §3.1a
         * practical rule 1 actually asks of them; filing the answer is not
         * what makes them compliant. (Recording a `yes` against a brand, so
         * that every future attempt is refused by name, needs a surface of
         * its own and is deliberately not this route — see the PR.)
         *
         * `where: { alcoholLinked: null }` IS THE WHOLE GUARD, and it is the
         * only one — there is deliberately no second `recorded === null`
         * condition in front of it, although an earlier draft had one. Two
         * predicates for one rule is this repo's family-2 shape, and the
         * outer one made the inner one unreachable by any test: with both in
         * place, deleting the `where` clause changed no observable behaviour
         * at all, which is exactly a check nothing exercises.
         *
         * As the single guard it is both tested and strictly stronger. A
         * brand that already carries an answer matches nothing, so its answer
         * and its date survive untouched ("does not ask again once the brand
         * carries an answer", route.test.ts, which fails if this clause is
         * dropped). And it is race-safe without a lock, which the outer
         * condition could not be: two first-time writers of the same brand
         * both read `null`, and whichever arrives second matches nothing —
         * and a brand answered `true` out of band between the read above and
         * this write keeps that answer rather than being overwritten with the
         * `false` this request computed from a staler read.
         */
        await tx.benefitSource.updateMany({
          where: { id: benefitSourceId, alcoholLinked: null },
          data: {
            alcoholLinked: effective,
            alcoholAnsweredAt: new Date(),
            alcoholAnsweredByUserId: userId,
          },
        });
      }

      const data = {
        benefitReceived: write.benefitReceived,
        benefitKind: write.benefitKind,
        benefitSourceId,
        marketValueOre: write.marketValueOre,
        label: write.label,
      };

      const saved = await tx.mediaAdvertisingDisclosure.upsert({
        where: { mediaId },
        create: { mediaId, ...data },
        update: data,
        select: DISCLOSURE_SELECT,
      });
      return NextResponse.json(saved);
    });
  } catch (error: unknown) {
    if (prismaErrorCode(error) === PRISMA_RECORD_NOT_FOUND) return null;
    throw error;
  }
}
