import { cache } from "react";

import {
  isStorablePriceCents,
  isSupportedCurrency,
  type PublicOffer,
} from "@/lib/pricing";
import { prisma } from "@/lib/prisma";
import { PUBLIC_MEDIA_SCOPE } from "@/lib/public-media";
import {
  MEDIA_GATE_SELECT,
  isSellable,
  type GateListing,
  type GateUpload,
} from "@/lib/resale-rights";

/**
 * THE SELLABILITY GATE, RE-EVALUATED AT RENDER (ugcportal-yzo7 K4).
 *
 * This module is the first render-time consumer of the gate. Re-derived at
 * `c5bf99f`, before any of this existed:
 * `grep -rn "evaluateSellability(" src --include="*.ts" --include="*.tsx" |
 * grep -v "\.test\."` returned three hits, of which exactly one was a
 * CALLER — the price endpoint — the other two being the definition and
 * `isSellable`'s own body; the same grep for `isSellable(` returned one hit,
 * its own definition, and `find src -iname "*checkout*"` returned nothing.
 * So a stored price was, until this file, read by nothing at all.
 *
 * WHY RE-EVALUATING IS THE WHOLE POINT, stated as the failure rather than
 * the rule. A price is written once, by an admin, behind
 * `evaluateSellability` (src/lib/curation-price-write.ts). Everything the
 * gate consults can stop holding afterwards WITHOUT ANY WRITE TO THE PRICED
 * ROW:
 *
 *   - the uploader's `ResaleRightsReview` moves to REVOKED, REJECTED,
 *     EXPIRED, IN_REVIEW or back to UNREVIEWED — a write to a different
 *     table;
 *   - its `validUntil` simply passes — no write at all, by anybody;
 *   - the checklist version it was granted under is retired from
 *     `ACCEPTED_CHECKLIST_VERSIONS` — a code change;
 *   - the admin who signed the triage, or who signed a layer clearance, is
 *     demoted — a write to `User.role`, which `triageBlocker` and
 *     `layerIsCleared` both re-read.
 *
 * `priceCents` is untouched through all four. Any design that treats a
 * stored price as the answer to "may this be sold" is wrong on all four, and
 * no amount of transaction isolation on the WRITE can help with a condition
 * that stops holding when no write happens. That — not a write-time race —
 * is why the offer is computed here, per row, per render.
 *
 * (The write-time race the parent bead asserted was MEASURED at `c5bf99f`
 * and did not reproduce; see `recordPrice`'s own comment in
 * src/lib/curation-price-write.ts for what the probe actually found. The
 * argument above does not depend on it.)
 *
 * SELLABILITY IS NOT IN `PUBLIC_MEDIA_SCOPE`, AND CANNOT BE. The publish
 * gate put its predicates inside the shared scope (ugcportal-3ae), and the
 * obvious move would be to follow that precedent exactly. It is the wrong
 * one here, for two independent reasons:
 *
 *   1. SELLABILITY IS NOT VISIBILITY. "An item can be perfectly publishable
 *      and unsellable, which is the ordinary case for everything on this
 *      site today" (src/lib/publishability.ts). Folding the sale gate into
 *      the scope would empty the public site — the home page, the portfolio,
 *      the sitemap and every item page — of everything nobody has priced,
 *      which is everything. The scope decides what is SHOWN; this decides
 *      what carries an OFFER, and the second is a strict subset rendered
 *      inside the first.
 *   2. IT IS NOT EXPRESSIBLE AS A `where`. The publish rule survived the
 *      translation to SQL with two enumerated disagreements
 *      (src/lib/publishability.scope-agreement.test.ts). The sale gate has
 *      strictly more that cannot cross: `attestedByUserId === Media.userId`
 *      compares columns in two tables, which Prisma field references cannot
 *      do; `layerIsCleared` trims a `reason` and Prisma has no trimming
 *      filter; and `uploaderClearanceBlocker`'s expiry branch is written as
 *      `!(expiry > now)` SPECIFICALLY so an unreadable date falls to the
 *      blocked side, which `validUntil: { gt: now }` in SQL does not
 *      reproduce. A `where` that got any of those wrong would sell
 *      something, silently.
 *
 * So the gate is evaluated ROW AT A TIME, in TypeScript, on exactly the
 * rows a surface is about to render, by the one function below. The scope is
 * still used — an item that is not public has no public offer — it is simply
 * not where the sale decision is made.
 */

/**
 * Prisma `select` for {@link OfferUpload}: the whole gate select, plus the
 * two money columns.
 *
 * SPREAD FROM `MEDIA_GATE_SELECT`, never re-spelled. A narrower select here
 * would read as `undefined` on whatever it omitted, and the gate's own
 * `typeof … !== "boolean"` guards would turn that into a refusal — fail
 * closed, so not a leak, but a silent "nothing is ever for sale" that no
 * test of the gate itself could notice. `src/lib/sellable-media.test.ts`
 * asserts this select's gate half is byte-for-byte the shared constant.
 *
 * NOT AN AUDIENCE SELECT, and must never be used as one. It reads
 * `Media.userId` and the uploader's review, exactly as `MEDIA_GATE_SELECT`
 * does — the same "a select that is not a third audience" case
 * `MEDIA_PREVIEW_DELIVERY_SELECT` documents in src/lib/media-access.ts.
 * Nothing it reads is serialised: `publicOffer` below returns two scalars
 * the admin chose to publish, and the test file asserts that no other field
 * of the row survives the function.
 */
export const SELLABLE_MEDIA_SELECT = {
  ...MEDIA_GATE_SELECT,
  listing: {
    select: {
      ...MEDIA_GATE_SELECT.listing.select,
      priceCents: true,
      currency: true,
    },
  },
} as const;

/** The two money columns, as this module reads them. */
export type OfferListing = GateListing & {
  priceCents: number | null;
  currency: string;
};

/** One upload as the offer decision sees it: the gate's view, plus a price. */
export type OfferUpload = GateUpload & { listing: OfferListing | null };

/**
 * Re-exported from src/lib/pricing.ts rather than redeclared, so a caller
 * reading this module's doc comment does not have to know the type lives
 * next door — and so there is exactly one declaration of what an offer is.
 */
export type { PublicOffer };

/**
 * The offer for one upload, or `null` when there is none.
 *
 * THE GATE IS CALLED FIRST, AND UNCONDITIONALLY. Not `if (price !== null &&
 * isSellable(...))`: short-circuiting on the price would make the gate call
 * conditional on the very field the gate exists to stop being trusted, and a
 * later edit that reordered the operands would be invisible. Asked this way
 * round, "is this sellable" is answered for every row the render path
 * considers, and the price is only ever read afterwards.
 *
 * A PRICE OF ZERO IS NOT AN OFFER. `priceCents: 0` passes
 * `isStorablePriceCents` — the ceiling check has no lower bound above zero,
 * deliberately, because 0 is a legitimate thing to store — but "free" is a
 * licensing decision nobody has taken, and rendering "NOK 0.00" beside a
 * photograph would be a claim this product has not made. Treated as "no
 * price set", the same as `null`, until a bead says otherwise.
 *
 * SO IS AN AMOUNT OR A CURRENCY THE WRITER WOULD REFUSE. Both are
 * re-validated here against the same predicates the write path uses rather
 * than trusted for having been stored — see the comments in the body.
 */
export function publicOffer(
  upload: OfferUpload,
  now: Date = new Date(),
): PublicOffer | null {
  if (!isSellable(upload, now)) return null;

  const listing = upload.listing;
  // Unreachable: `evaluateSellability` step (6) refuses an upload with no
  // listing, so a sellable upload always has one. Here because this function
  // is also called on hand-assembled inputs in tests and because narrowing
  // it by hand is cheaper than a non-null assertion that would be wrong the
  // day step (6) moves.
  if (!listing) return null;

  // RE-VALIDATED ON READ, not merely non-null, and both halves for the same
  // reason `toGalleryItem` re-checks an advertising label it was handed: do
  // not trust that a row was written through the validator. `recordPrice` is
  // the only writer today and these columns predate it, so a row written
  // before it existed — or by a hand-written statement, or by a future
  // second writer — can hold anything the column type allows.
  const priceCents = listing.priceCents;
  if (!isStorablePriceCents(priceCents) || priceCents === 0) {
    return null;
  }
  // An unsupported currency is NOT rendered as an amount with a bad code: it
  // is no offer at all. `formatOfferPrice` would throw a RangeError out of
  // `Intl.NumberFormat` for an unrecognised code, which on a server
  // component is a 500 on a page that was merely trying to show a
  // photograph — and for a code that IS recognised by Intl but is not on the
  // allowlist, it would render an amount divided by 100 that may not be the
  // right number of minor units at all.
  if (!isSupportedCurrency(listing.currency)) {
    return null;
  }
  return { priceCents, currency: listing.currency };
}

/**
 * The offer for one published item, by its opaque public handle — the
 * render-time entry point, and the only one.
 *
 * SCOPED BY `PUBLIC_MEDIA_SCOPE` as well as gated: an item that is not
 * public cannot carry a public price, and saying so with the shared scope
 * rather than a hand-written `publishedAt: { not: null }` is what keeps this
 * reader inside the publish gate ugcportal-3ae put in that constant. It is
 * therefore a declared consumer in src/lib/public-media.consumers.test.ts.
 *
 * `cache()`d for the same reason `getPublicMediaItem` next door is: Next
 * resolves metadata and the page tree separately, and this must not become a
 * second query per visit.
 */
export const getPublicOffer = cache(
  async (previewId: string): Promise<PublicOffer | null> => {
    const trimmed = previewId.trim();
    if (trimmed === "") return null;

    const upload = await prisma.media.findFirst({
      where: { ...PUBLIC_MEDIA_SCOPE, previewId: trimmed },
      select: SELLABLE_MEDIA_SELECT,
    });
    if (!upload) return null;

    return publicOffer(upload);
  },
);
