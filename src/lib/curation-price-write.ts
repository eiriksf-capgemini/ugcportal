import {
  isStorablePriceCents,
  isSupportedCurrency,
} from "@/lib/pricing";
import { prisma } from "@/lib/prisma";
import {
  PRISMA_RECORD_NOT_FOUND,
  prismaErrorCode,
} from "@/lib/prisma-errors";
import {
  MEDIA_GATE_SELECT,
  evaluateSellability,
  type SellabilityBlocker,
} from "@/lib/resale-rights";

/**
 * THE ONE PLACE `MediaListing.priceCents` AND `currency` ARE WRITTEN
 * (ugcportal-yzo7 K1/K2/K3).
 *
 * Two entry points reach this function and neither may price anything
 * without it: the admin curation screen's `setPrice` server action
 * (src/app/admin/curation/actions.ts) and POST
 * /api/admin/curation/[id]/price (src/app/api/admin/curation/[id]/price/
 * route.ts). The same chokepoint argument `recordTriageFacts` and
 * `recordLayerClearance` make next door, and here it is the one that
 * carries K2 and K3: the clearance check and the preview check are
 * conditions on a WRITE, so they are only enforceable if there is exactly
 * one place the write can happen. `src/lib/sellability-signal.test.ts` asserts
 * against the whole tree that there is: of every Prisma write of
 * `mediaListing` under `src/`, exactly one names `priceCents` in its
 * payload, and it is this one. Do not add a second price writer; widen this
 * one.
 *
 * WHAT A PRICE IS AND IS NOT. A stored price is a record that an admin once
 * decided an item could be offered at an amount. It is NOT evidence that the
 * item may be sold now, and nothing may read it as one — `priceCents` is
 * written here, behind the gate, and read at render only beside a fresh
 * `isSellable()` (src/lib/sellable-media.ts, K4; the repository scan that
 * keeps it that way is src/lib/sellability-signal.test.ts, K5).
 *
 * THE BOUNDS AND THE CURRENCY ALLOWLIST ARE NOT HERE. They are in
 * src/lib/pricing.ts, which imports nothing: two React components need them
 * and neither may pull `@/lib/prisma` into its module graph. See that file's
 * own comment for the measured failure that forced the split.
 *
 * LICENCE TERMS ARE NOT A COLUMN, and that is a boundary rather than an
 * omission. `MediaListing` has `priceCents` and `currency` and nothing
 * describing what a buyer would be granted; the licence that applies is the
 * site-wide one at /licence (src/app/licence/content.ts), which already says
 * "unless an item says otherwise, all rights are reserved". Per-item licence
 * terms would be a new column, a new migration and a new thing for the gate
 * to have an opinion about, and this bead has none of the three. Filed as
 * ugcportal-74w.1.
 */

/**
 * Why a price write was refused. A closed set, every member of which has a
 * message in src/app/admin/curation/outcomes.ts — enforced by `tsc` there
 * rather than by memory, so a refusal added here cannot ship rendering
 * nothing.
 *
 * Prefixed `price_` because these codes share one `?error=` namespace with
 * the triage and clearance writes' own refusals on the same screen, and two
 * different refusals answering to one code would render the wrong sentence.
 * `price_no_preview` is therefore a DIFFERENT code from the triage write's
 * `no_preview` even though both describe the same column: the sentence an
 * admin needs is not the same one ("this cannot be curated" versus "this
 * cannot be priced"), and collapsing them to share a message would make one
 * of the two wrong.
 */
export const PRICE_WRITE_REFUSALS = [
  "price_media_not_found",
  "price_no_preview",
  "price_not_sellable",
  "price_amount_invalid",
] as const;

export type PriceWriteRefusal = (typeof PRICE_WRITE_REFUSALS)[number];

export type PriceWriteOutcome =
  | { kind: "priced"; listingId: string; priceCents: number; currency: string }
  | { kind: "unpriced"; listingId: string; currency: string }
  | { kind: "price_media_not_found" }
  | { kind: "price_no_preview" }
  | { kind: "price_amount_invalid" }
  | { kind: "price_not_sellable"; blocker: SellabilityBlocker };

/**
 * Which upload to price, named the way the caller already holds it.
 *
 * The admin screen works in Media ids (every form on it carries one); the
 * HTTP endpoint's `[id]` is a MediaListing id and has been since
 * ugcportal-0ss. Rather than make one of them do a lookup just to call the
 * other's spelling — which is a second query and a second chance to resolve
 * to a different row — the target is a discriminated union and the single
 * `where` below is built from it. Both arms start at MEDIA and follow the
 * relation, so the clearance consulted is the file's own uploader's either
 * way; see MEDIA_GATE_SELECT's own comment for why that direction matters.
 */
export type PriceTarget = { mediaId: string } | { listingId: string };

export type RecordPriceInput = {
  target: PriceTarget;
  /**
   * The amount in minor units, or `null` to REMOVE the price.
   *
   * `null` is un-pricing and is deliberately NOT gated — see the branch
   * below. Anything that is not `null` and not a storable integer is
   * `price_amount_invalid` rather than a silently clamped number: a caller
   * that got this wrong must be told, not corrected.
   */
  priceCents: number | null;
  /** Only meaningful alongside a price; ignored on an un-pricing call. */
  currency?: string;
  /** Injectable for the clearance-expiry branch, same as the gate's own. */
  now?: Date;
};

/**
 * Set or clear the price on one curated upload.
 *
 * THREE REFUSALS, and the order they are checked in is the contract:
 *
 *   1. `price_media_not_found` — no such listing, or no file behind it.
 *   2. `price_no_preview` (K3) — the Media row has no watermarked preview.
 *      Checked BEFORE the gate, because it is the cheaper answer and the
 *      more specific one: an upload with no preview is not a rights problem
 *      an admin can clear, it is a missing artefact. `previewKey` is the
 *      column read, not `previewId`, and blank counts as absent — the same
 *      reading `recordTriageFacts` and the publish endpoint both use, so the
 *      three agree about which rows have a protected copy. Pricing a row
 *      with no preview would put an unprotected original in front of buyers,
 *      because the preview IS the thing a buyer is shown before paying.
 *   3. `price_not_sellable` (K2) — `evaluateSellability` says no. The
 *      uploader's standing resale-rights clearance is the first thing it
 *      asks about, so this is what refuses an upload whose uploader has no
 *      closed confirmation, including for a caller that skipped the UI
 *      entirely and invoked this directly.
 *
 * UN-PRICING IS UNGATED, and skips 2 and 3 rather than passing them. The
 * gate exists to stop things being offered for sale; refusing to WITHDRAW an
 * offer would point it backwards, and would strand a price on exactly the
 * uploads that just lost their clearance. An admin can always take something
 * off sale. (It is not the only thing that takes them off sale: K4's
 * render-time re-evaluation already does, with no write at all.)
 *
 * THE READ AND THE WRITE SHARE A TRANSACTION, and what that does buy is
 * narrower than the comment this function replaced claimed. Measured at
 * c5bf99f against a real file-backed SQLite database through
 * `@prisma/adapter-libsql`, with the probe recorded on ugcportal-yzo7: a
 * revoke issued on a SECOND client while this transaction is open fails with
 * `SQLITE_BUSY: database is locked` and does not commit, and a revoke issued
 * on the SAME client (the shape production has, since `prisma` is a
 * singleton) blocks until this transaction finishes. Neither interleaving
 * produced "the revoke committed and the price was written anyway", so the
 * race the previous comment here described as unclosable was not
 * reproducible. What IS unclosable, and is the real reason K4 exists, is
 * that nothing about a stored price can be made to track a clearance that
 * lapses AFTERWARDS: `validUntil` passing is time passing, with no write for
 * any transaction to serialise against; retiring a checklist version is a
 * code change; demoting the admin who signed the triage happens on a
 * different table entirely. The price stays exactly as written through all
 * three, which is why the catalogue re-evaluates the gate at render
 * (src/lib/sellable-media.ts) rather than trusting what is stored.
 */
export async function recordPrice({
  target,
  priceCents,
  currency,
  now = new Date(),
}: RecordPriceInput): Promise<PriceWriteOutcome> {
  const unpricing = priceCents === null;

  // Before the transaction: an unstorable amount is a property of the
  // request, not of any row, and there is no reason to open a transaction to
  // discover it.
  if (!unpricing && !isStorablePriceCents(priceCents)) {
    return { kind: "price_amount_invalid" };
  }
  if (!unpricing && currency !== undefined && !isSupportedCurrency(currency)) {
    return { kind: "price_amount_invalid" };
  }

  return prisma.$transaction(async (tx): Promise<PriceWriteOutcome> => {
    // Rooted at MEDIA and projected through the shared gate select, so the
    // clearance this write consults is the file's own uploader's by
    // construction rather than by remembering to. `previewKey` is read for
    // exactly one yes/no question and is never returned: it is
    // `previews/{userId}/{uuid}`, so handing it back would put an uploader's
    // account id into whatever renders the result.
    const upload = await tx.media.findFirst({
      where: "mediaId" in target ? { id: target.mediaId } : { listing: { id: target.listingId } },
      select: { ...MEDIA_GATE_SELECT, previewKey: true, listing: { select: { ...MEDIA_GATE_SELECT.listing.select, id: true } } },
    });
    if (!upload) {
      return { kind: "price_media_not_found" };
    }
    // A file with no sale record has nothing to price: the row this writes
    // to is created by the triage screen, not here. Answered as
    // "not found" rather than created on the fly, deliberately — minting a
    // MediaListing here would be a second triage writer, which
    // `recordTriageFacts` is explicit must not exist.
    const listingId = upload.listing?.id ?? null;
    if (listingId === null) {
      return { kind: "price_media_not_found" };
    }

    if (!unpricing) {
      // (K3) Blank is absent, not a working preview.
      if (upload.previewKey === null || upload.previewKey.trim() === "") {
        return { kind: "price_no_preview" };
      }
      // (K2) The whole checklist, in one call, including the uploader's
      // standing confirmation.
      const gate = evaluateSellability(upload, now);
      if (!gate.sellable) {
        return { kind: "price_not_sellable", blocker: gate.blocker };
      }
    }

    let updated;
    try {
      updated = await tx.mediaListing.update({
        where: { id: listingId },
        data: {
          priceCents,
          // Currency is only meaningful alongside a price, and applying it on
          // an un-pricing call would be a write the gate never checked.
          ...(!unpricing && currency ? { currency } : {}),
        },
        select: { id: true, priceCents: true, currency: true },
      });
    } catch (error) {
      // The read above and this write are not serialised against a DELETE of
      // the listing — the one interleaving the probe recorded on this bead
      // did NOT rule out, because a delete is a write that can be in flight
      // before this transaction's own read takes its lock. A lost race there
      // is the same "no such listing" the caller would have been told a
      // moment earlier, not a server fault, and answering it as one on a
      // path whose outcomes are a deliberate closed set would be the odd one
      // out.
      if (prismaErrorCode(error) === PRISMA_RECORD_NOT_FOUND) {
        return { kind: "price_media_not_found" };
      }
      throw error;
    }

    if (updated.priceCents === null) {
      return { kind: "unpriced", listingId: updated.id, currency: updated.currency };
    }
    return {
      kind: "priced",
      listingId: updated.id,
      priceCents: updated.priceCents,
      currency: updated.currency,
    };
  });
}
