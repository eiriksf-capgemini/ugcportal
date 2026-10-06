import { NextResponse } from "next/server";

import { benefitAttachmentRefusal } from "@/lib/alcohol-commerce";
import { validateBenefitSourceName } from "@/lib/benefit-source";
import {
  commercialLinkDisclosureRefusal,
  MAX_COMMERCIAL_LINKS_PER_ITEM,
  validateCommercialLinkNetwork,
  validateCommercialLinkUrl,
} from "@/lib/commercial-link";
import { requireOwnedMedia } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { PRISMA_UNIQUE_VIOLATION, prismaErrorCode } from "@/lib/prisma-errors";
import { readJsonBody } from "@/lib/request-body";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

/**
 * The commercial outbound links on one media item (ugcportal-qnq9.2.1). Owner
 * only.
 *
 * ITS OWN SUB-ROUTE, next to disclosure, publish and tags, for the reason all
 * three give for being one: PATCH /api/media/[id]'s contract is "originalName
 * is the only editable column", one request body and one thing it can change.
 *
 * It reuses the SAME ownership gate every handler on this resource uses —
 * `requireOwnedMedia` (ugcportal-bdh) — so 401 for no session, 403 for
 * someone else's row and 404 for a row that is not there are decided in one
 * place and answered identically here (docs/access-control.md).
 *
 * POST AND DELETE RATHER THAN PUT, which is the opposite call the tags and
 * disclosure routes made, and the difference is what the collection is. A tag
 * set and a disclosure are each a single value the operator holds in full and
 * replaces; a link set is a growing list of destinations, each of which has to
 * pass a gate on the way in. A replacing PUT would mean re-submitting every
 * existing link on every request, with each one re-gated against facts that
 * may have changed since — so a brand later recorded as alcohol-linked would
 * make the whole set unsaveable instead of making one link unattachable.
 *
 * WHAT THIS DOES NOT DO. It renders nothing: the per-link "Advertisement link
 * / Annonselenke" marker, the `rel="sponsored nofollow noopener noreferrer"`
 * token set and the all-surfaces sweep are ugcportal-qnq9.2.2, and no public
 * read path selects this relation yet. It also writes no `publishedAt`, no
 * price and no licence state — attaching a link neither publishes nor
 * unpublishes an item.
 */

/**
 * The body is a small flat object: a URL, a network name, an optional
 * free-text network name, and a brand name.
 *
 * NO FIELD LENGTH IS RESTATED HERE, and no arithmetic relating this number to
 * any of them: each cap lives next to the validator that enforces it, and a
 * second copy in a comment is a number that goes stale with nothing failing.
 * This is simply far above any body this route can legitimately be sent and
 * far below anything that is not a short flat object. A larger body is refused
 * with a 413 before it is buffered, which is the right answer for a request
 * that is not the shape this route accepts — App Router puts no default cap on
 * a request body, so without this the length checks in the validators would
 * only run after the server had buffered whatever arrived.
 */
const MAX_COMMERCIAL_LINKS_BODY_BYTES = 8192;

type Body = {
  url?: unknown;
  network?: unknown;
  networkOther?: unknown;
  benefitSource?: unknown;
};

/**
 * The projection a link is echoed through.
 *
 * `id` IS INCLUDED, unlike the disclosure route's echo, because the caller
 * needs it: DELETE addresses one link out of several and this is the only
 * place its id is ever handed out. The brand is reported by name and slug
 * rather than by id, the same call the disclosure route makes — the id is an
 * internal handle with no use outside the database, and the slug is the
 * identity anybody would look the brand up by.
 */
const COMMERCIAL_LINK_SELECT = {
  id: true,
  url: true,
  network: true,
  networkOther: true,
  createdAt: true,
  benefitSource: { select: { slug: true, name: true } },
} as const;

function badRequest(message: string, field?: string) {
  return NextResponse.json(
    field ? { error: message, field } : { error: message },
    { status: 400 },
  );
}

function notFound() {
  // Lost the race with a concurrent delete — the row the caller was authorized
  // for no longer exists. The same answer every sibling handler on this
  // resource gives when it loses the same race.
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/**
 * Attaches one commercial link to this item.
 *
 * THREE GATES, ALL BEFORE ANY WRITE, and they are three because they come
 * from three different places:
 *
 *   1. THE FIELDS. https only, no embedded credentials, no control or bidi
 *      characters, a length cap, a known network, and a brand name that slugs
 *      to something. src/lib/commercial-link.ts, plus
 *      `validateBenefitSourceName` from src/lib/benefit-source.ts — the same
 *      validator the disclosure route names a brand through, so an alcohol
 *      answer recorded against "Riedel" is not bypassable here by typing
 *      "riedel".
 *
 *   2. ALKOHOLLOVEN § 9-2 (K2). `benefitAttachmentRefusal`
 *      (src/lib/alcohol-commerce.ts), which refuses an item recorded as
 *      showing alcohol, a brand recorded as alcohol-linked, and a brand
 *      nobody has recorded an answer for. NO NEW ALCOHOL LOGIC IS WRITTEN
 *      HERE: that function is the only thing in the product that decides what
 *      those answers mean, and src/lib/alcohol-commerce.write-paths.test.ts
 *      enumerates every write site that has to reach it — this one included.
 *
 *   3. FORBRUKERTILSYNET § 3.2 (K3). `commercialLinkDisclosureRefusal`: the
 *      item must already declare a benefit under a permitted advertising
 *      label, because that label is the top-of-page half of the "labelled at
 *      the top AND at each link" rule and it is rendered from the disclosure
 *      and from nothing else.
 *
 * A FOURTH REFUSAL SITS BELOW THOSE THREE AND IS NOT A GATE: the per-item cap
 * (`MAX_COMMERCIAL_LINKS_PER_ITEM`). It is counted inside the transaction
 * rather than listed here because it is a fact about the item's current row
 * count rather than about the request, and it answers 409 rather than 400 for
 * the same reason. See the comment at the count itself.
 *
 * THE ALCOHOL GATE RUNS BEFORE THE DISCLOSURE GATE, deliberately. Both refuse
 * with a 400 and either order would be correct for every criterion, so the
 * tie is broken on what the refusal tells the operator to do next: a § 9-2
 * refusal is answered by a different photograph or a different brand, and
 * being told to go and fill in a disclosure form first — for a link that can
 * never be attached — would be advice that wastes their time and ends in the
 * same refusal.
 *
 * NO BRAND IS EVER MINTED HERE, and that is the one deliberate difference
 * from the disclosure route, which upserts the brand row it is handed. A
 * brand with no recorded alcohol answer is refused by gate 2, and a brand that
 * does not exist is exactly a brand with no recorded answer — so the only
 * brands that get past the gate are ones that already have a row. Looking the
 * brand up instead of upserting it is what makes "a refused request writes
 * nothing at all" true of the BenefitSource table as well as of this one,
 * which matters because nothing in this product deletes a BenefitSource
 * (`resolveBenefitSource`'s own docstring on permanent debris).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await readJsonBody(request, MAX_COMMERCIAL_LINKS_BODY_BYTES);
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

  const { url, network, networkOther, benefitSource } = body.value as Body;

  /*
   * THE REFUSAL NAMES ITS OWN FIELD rather than the handler choosing a name
   * per validator, which is what this used to do and got wrong.
   * `validateCommercialLinkNetwork` covers TWO body fields, and five of its
   * refusals are about `networkOther`; a fixed `"network"` here answered
   * every one of them with a `field` that contradicted its own `message`.
   * The key exists to tell the caller which input to correct, so only the
   * validator can fill it in.
   */
  const validatedUrl = validateCommercialLinkUrl(url);
  if (!validatedUrl.ok) {
    return badRequest(validatedUrl.message, validatedUrl.field);
  }

  const validatedNetwork = validateCommercialLinkNetwork(network, networkOther);
  if (!validatedNetwork.ok) {
    return badRequest(validatedNetwork.message, validatedNetwork.field);
  }

  const source = validateBenefitSourceName(benefitSource);
  if (!source.ok) {
    return badRequest(source.message, "benefitSource");
  }

  try {
    /*
     * ONE TRANSACTION for the reads the gates decide on and the write that
     * follows them, and THE MEDIA ROW IS RE-CHECKED INSIDE IT, scoped by
     * `{ id, userId }`. The ownership gate above read it in a separate
     * statement, so only a predicate on the write path itself rules out a row
     * deleted or re-owned in between — the same rule every sibling handler on
     * this resource states for its own writes. It cannot be folded into the
     * link's own insert the way PATCH folds its update, because a `create` has
     * no Media predicate to attach to: the foreign key would catch a row that
     * is already DELETED, and would say nothing at all about one that has
     * merely been re-owned.
     */
    const result = await prisma.$transaction(async (tx) => {
      const owned = await tx.media.findFirst({
        where: { id, userId: access.userId },
        select: {
          id: true,
          // The alcohol triage answer for gate 2. A listing that does not
          // exist is `null` here, which `alcoholDepiction` reads as
          // unanswered — and an item nobody has put forward for sale is
          // exactly an item nobody has triaged.
          listing: { select: { depictsAlcohol: true } },
          // The two columns gate 3 reads, and only those two: the brand, the
          // kind and the market value on that row are a compliance record
          // this route has no business reading.
          advertisingDisclosure: {
            select: { benefitReceived: true, label: true },
          },
        },
      });
      if (!owned) return null;

      // `findUnique`, not an upsert — see this handler's docstring on why no
      // brand is ever minted here. A brand that is not there comes back
      // `null`, which `alcoholLinkedBrandRefusal` reads as unchecked and
      // refuses, which is the correct answer and not a lookup failure.
      //
      // ONE COLUMN, which is exactly `BenefitSourceAlcoholFacts` — the gate's
      // own declared input. Not the `id`: the insert below connects the brand
      // by `slug`, so nothing here needs a handle the caller never sees, and
      // a projection narrower than the gate's input is a projection the gate
      // would reject.
      const brand = await tx.benefitSource.findUnique({
        where: { slug: source.value.slug },
        select: { alcoholLinked: true },
      });

      const alcohol = benefitAttachmentRefusal({
        listing: owned.listing,
        benefitSource: brand,
      });
      if (alcohol) {
        // Returned from inside the transaction, which commits — and commits
        // nothing, because every statement above it is a read. A
        // throw-to-roll-back would be the same outcome by a louder route.
        return NextResponse.json(alcohol, { status: 400 });
      }

      const disclosure = commercialLinkDisclosureRefusal(
        owned.advertisingDisclosure,
      );
      if (disclosure) {
        return NextResponse.json(disclosure, { status: 400 });
      }

      /*
       * THE PER-ITEM CAP (`MAX_COMMERCIAL_LINKS_PER_ITEM`), counted INSIDE
       * the transaction and immediately before the insert. Counted rather
       * than derived from anything the caller sent: the collection grows one
       * request at a time, so the only honest answer to "is this item full"
       * is how many rows it has right now, and a count taken outside this
       * transaction would be a number two concurrent attaches could both read
       * as one below the cap.
       *
       * 409 RATHER THAN 400, the same call the publish route makes for a
       * missing preview and this handler makes for a duplicate URL: the
       * request is well-formed and the caller is authorized, and what refuses
       * it is the row's current state — a state the caller can change, with a
       * DELETE.
       *
       * NO `field`, unlike every refusal above it. The key names the body
       * field to correct, and there is no edit to this body that would make
       * this request succeed; saying `url` would send the caller off to change
       * a destination that is not the problem. The message names the fix
       * instead.
       */
      const attached = await tx.commercialLink.count({
        where: { mediaId: owned.id },
      });
      if (attached >= MAX_COMMERCIAL_LINKS_PER_ITEM) {
        return NextResponse.json(
          {
            error: `This item already carries the most commercial links one item may have (${MAX_COMMERCIAL_LINKS_PER_ITEM}). Detach one with DELETE /api/media/[id]/commercial-links?linkId= before attaching another.`,
          },
          { status: 409 },
        );
      }

      /*
       * THE BRAND IS CONNECTED BY `slug`, not by an id read a moment ago, and
       * that is what lets the lookup above project one column. It also leaves
       * no `brand` could-be-null narrowing to argue with: past the gate, a
       * brand whose `alcoholLinked` is exactly `false` exists under that slug
       * — `benefitAttachmentRefusal` refuses every other answer, including
       * the `null` a missing row produces — so there is nothing here for an
       * unreachable `if` or a non-null assertion to do.
       */
      const created = await tx.commercialLink.create({
        data: {
          media: { connect: { id: owned.id } },
          url: validatedUrl.value,
          network: validatedNetwork.value.network,
          networkOther: validatedNetwork.value.networkOther,
          benefitSource: { connect: { slug: source.value.slug } },
        },
        select: COMMERCIAL_LINK_SELECT,
      });
      return NextResponse.json(created, { status: 201 });
    });

    return result ?? notFound();
  } catch (error: unknown) {
    if (prismaErrorCode(error) === PRISMA_UNIQUE_VIOLATION) {
      // `@@unique([mediaId, url])`. The ordinary way this arrives is a
      // double-submitted form, and the honest answer is that the second
      // request did not attach anything — reporting a 201 for a row this
      // request did not create would make "attached" mean two different
      // things on two identical responses.
      return NextResponse.json(
        {
          error: "This item already carries a commercial link to that URL",
          field: "url",
        },
        { status: 409 },
      );
    }
    throw error;
  }
}

/**
 * Detaches one commercial link from this item.
 *
 * THE LINK IS NAMED IN THE QUERY STRING (`?linkId=`), not in a body. A DELETE
 * with a body is permitted but not universally carried — intermediaries are
 * entitled to drop it — and a request whose subject can go missing in transit
 * is a request that deletes the wrong thing or nothing. The id comes from this
 * route's own POST echo.
 *
 * DETACHING IS NEVER GATED, and that is a decision rather than an omission.
 * Neither § 9-2 nor § 3.2 is consulted here: removing a commercial link is how
 * an unlawful one is taken down, and a gate that could refuse it would point
 * the rule backwards — the item recorded as showing alcohol is exactly the
 * item whose link most needs removing, and it is the one a gate here would
 * refuse to remove. The disclosure route makes the same call for the same
 * reason ("WITHDRAWING A BENEFIT IS NEVER REFUSED BY THAT GATE"), and the
 * curation price route for un-pricing.
 *
 * This is also why src/lib/alcohol-commerce.write-paths.test.ts is satisfied
 * by a FILE that reaches `benefitAttachmentRefusal` rather than by a handler
 * that does: a delete writes no benefit source, so there is nothing for the
 * gate to decide. What that test's enumeration pins is that no path in `src/`
 * ATTACHES one without passing it.
 *
 * `deleteMany` WITH THREE PREDICATES rather than `delete({ where: { id } })`,
 * and each one is doing different work. `id: linkId` names the link.
 * `mediaId: id` ties it to the item in the path — without it, a caller who
 * owns one item could delete a link off somebody else's by knowing its id,
 * since the ownership gate above only ever proved they own `id`.
 * `media: { userId }` re-asserts that ownership AT THE MOMENT OF THE WRITE:
 * the gate read the row in a separate statement, so only a predicate on the
 * write path itself rules out a row re-owned in between, which is the rule
 * every sibling handler on this resource states for its own writes. The
 * returned count is what distinguishes "deleted" from "there was nothing
 * there to delete", which is a 404 rather than a silent 204.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const linkId = new URL(request.url).searchParams.get("linkId");
  if (!linkId) {
    return badRequest(
      "Query parameter 'linkId' is required: which commercial link to detach",
      "linkId",
    );
  }

  const { count } = await prisma.commercialLink.deleteMany({
    where: { id: linkId, mediaId: id, media: { userId: access.userId } },
  });

  if (count === 0) {
    return notFound();
  }

  return new NextResponse(null, { status: 204 });
}
