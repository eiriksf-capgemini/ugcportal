import { NextResponse } from "next/server";

import type { BenefitKind } from "@/generated/prisma/enums";
import {
  isBenefitKind,
  validateAdvertisingLabel,
  BENEFIT_KINDS,
} from "@/lib/advertising-disclosure";
import { resolveBenefitSource, validateBenefitSourceName } from "@/lib/benefit-source";
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
  benefitSource: { select: { slug: true, name: true } },
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
};

/**
 * Writes the disclosure, or answers null if the item is no longer there.
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
        select: { id: true },
      });
      if (!owned) return null;

      const benefitSourceId = write.benefitSource
        ? await resolveBenefitSource(write.benefitSource, tx)
        : null;

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
