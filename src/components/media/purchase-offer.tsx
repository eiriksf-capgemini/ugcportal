import { INLINE_LINK_CLASS } from "@/components/ui/inline-link";
import { LICENCE_PATH } from "@/lib/routes";
import { formatOfferPrice, type PublicOffer } from "@/lib/pricing";

/**
 * DOM id of the purchase offer block. Exported so a test can assert its
 * ABSENCE by id rather than by hunting for a formatted amount in the page —
 * a price string can coincide with other text, an id cannot, and the
 * assertion this component mostly exists to support is a negative one
 * (ugcportal-yzo7 K4).
 */
export const PURCHASE_OFFER_ID = "purchase-offer";

/**
 * What an item that may currently be sold says about itself
 * (ugcportal-yzo7).
 *
 * RENDERS NOTHING FOR `null`, which is the state of every item on this site
 * that is not priced AND currently through the sale gate. The decision is
 * not made here and must not be: this component draws an offer it is handed,
 * and `getPublicOffer` (src/lib/sellable-media.ts) is the one place that
 * decides whether there is one, by re-running `isSellable` against a fresh
 * read of the uploader's standing clearance.
 *
 * NO BUY BUTTON, and that is a boundary rather than an unfinished screen.
 * Checkout is ugcportal-p3v, the order model ugcportal-f3a and fulfilment
 * ugcportal-5d6; none exists. An affordance that looked like it took money
 * and did not would be worse than a sentence saying how to ask, so this
 * states the price and points at the licence the terms come from.
 *
 * THE LICENCE IS THE SITE-WIDE ONE. `MediaListing` carries no per-item
 * licence terms (ugcportal-74w.1), so this links to /licence rather than
 * rendering a field that does not exist — which is exactly what that page
 * promises: "unless an item says otherwise, all rights are reserved".
 */
export function PurchaseOffer({ offer }: { offer: PublicOffer | null }) {
  if (offer === null) return null;
  return (
    <aside
      id={PURCHASE_OFFER_ID}
      className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm"
    >
      <p className="font-medium">
        Available to licence for{" "}
        <span data-offer-price>{formatOfferPrice(offer)}</span>
      </p>
      {/*
        text-muted-foreground, not text-ink-muted (ugcportal-6uc2, phase 2):
        this whole panel is unconditionally bg-muted, which now reads the
        paper scale.
      */}
      <p className="mt-1 text-xs text-muted-foreground">
        That is the price for the original file under the terms on the{" "}
        <a className={INLINE_LINK_CLASS} href={LICENCE_PATH}>
          licence page
        </a>
        . There is no checkout yet — get in touch and the terms are agreed in
        writing before anything changes hands.
      </p>
    </aside>
  );
}
