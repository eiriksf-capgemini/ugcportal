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
 * Marker attribute on the per-item licence grant's container
 * (ugcportal-74w.1). Exported for the same reason as the id above: the
 * assertions that matter most are that it is ABSENT — for an item with no
 * grant, and for an item that is no longer sellable — and an attribute is a
 * needle no grant text can forge, because the text is a text node.
 */
export const LICENCE_GRANT_ATTRIBUTE = "data-licence-grant";
// The JSX below spells the attribute literally (`data-licence-grant`), as
// the sale badge does; purchase-offer.test.tsx asserts the two agree.

/**
 * ugcportal-dmne: the one terracotta "chip" treatment this component renders
 * TWICE — the for-sale badge and the highlighted offer price — one named
 * constant so the two cannot independently drift onto a different,
 * unmeasured pairing. `--terracotta-900` text on `--terracotta-100` fill,
 * checked by `terracotta-900-on-terracotta-100` in src/lib/design/
 * contrast.ts at 7.01:1, comfortably clearing body's 4.5:1.
 *
 * Deliberately its own opaque fill, not bare text coloured directly on this
 * `<aside>`'s ambient `bg-muted`: `--muted` is NOT mode-invariant (it reads
 * `--paper-card`, near-white, in light mode but `--petrol-card`, a dark
 * teal, in dark mode — src/app/globals.css's dark-mode override) while the
 * terracotta tokens ARE (declared in the un-gated `:root` block, never
 * overridden per mode) — terracotta-900 text painted directly on a dark
 * `--petrol-card` background would be dark-on-dark, nowhere near 4.5:1.
 * Giving the chip its own explicit, equally mode-invariant terracotta-100
 * backdrop is what keeps this pairing correct regardless of which mode the
 * surrounding `<aside>` is in — the SAME reason `--terracotta-ink`
 * (src/app/globals.css) exists instead of reusing the mode-dependent
 * `--primary-foreground` for the hero's CTA.
 *
 * Neither terracotta-600 (3.78:1 against this fill — round-5 scratch check
 * on terracotta-900-on-terracotta-100's own comment) nor terracotta-500
 * (K3's own forbidden step, regardless of background) is a safe label here;
 * terracotta-900 is the only one of the four steps that clears body text on
 * top of terracotta-100.
 */
const TERRACOTTA_CHIP_CLASS =
  "inline-flex items-center rounded-full bg-terracotta-100 px-2 py-0.5 font-medium text-terracotta-900";

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
 * THE LICENCE (ugcportal-74w.1). When the admin wrote a grant for this item,
 * it is shown under the price, and the site-wide /licence is still linked
 * for everything the grant does not say — which is what that page promises:
 * "unless an item says otherwise, all rights are reserved". With no grant
 * (`licenceTerms === null`, which `publicOffer` also makes of a blank one),
 * nothing about a grant is rendered — no heading, no empty block — and the
 * sentence points at /licence alone.
 *
 * THE GRANT IS A TEXT NODE, NEVER MARKUP. It is admin-written free text
 * rendered to every buyer, so it goes in as a JSX child, which React
 * escapes; `<script>` or `<a href>` typed into it reaches the page as those
 * characters, not as elements. Line breaks the admin typed are kept with
 * `whitespace-pre-line` rather than by turning them into `<br>`s, which
 * would mean building markup out of the text. purchase-offer.test.tsx
 * renders a grant holding `<script>` and `<a href>` and asserts both come
 * out escaped, and src/lib/licence-terms-signal.test.ts asserts no file that
 * names the column, and no file on the buyer's render path, uses
 * `dangerouslySetInnerHTML`.
 */
export function PurchaseOffer({ offer }: { offer: PublicOffer | null }) {
  if (offer === null) return null;
  return (
    <aside
      id={PURCHASE_OFFER_ID}
      className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm"
    >
      {/*
        ugcportal-dmne: the "for sale" marker (this bead's own in-scope
        "'Til salgs' / for-sale badges") — English copy, consistent with
        every other public-facing string in this app (src/components/
        site-header.tsx's own comment on why "For sale" rather than a
        Norwegian label). Own line, ahead of the price sentence: a status
        label reads before the detail it is a status OF, the same ordering
        GalleryItemAdvertisingLabel uses ahead of the photograph it
        discloses against.
      */}
      <span className={TERRACOTTA_CHIP_CLASS} data-sale-badge>
        For sale
      </span>
      <p className="mt-1.5 font-medium">
        Available to licence for{" "}
        <span className={TERRACOTTA_CHIP_CLASS} data-offer-price>
          {formatOfferPrice(offer)}
        </span>
      </p>
      {offer.licenceTerms !== null ? (
        <section className="mt-2" data-licence-grant>
          <h2 className="text-xs font-medium">What this licence grants</h2>
          {/* A text node, escaped by React; see the component comment. */}
          <p className="mt-1 whitespace-pre-line break-words">
            {offer.licenceTerms}
          </p>
        </section>
      ) : null}
      {/*
        text-muted-foreground, not text-ink-muted (ugcportal-6uc2, phase 2):
        this whole panel is unconditionally bg-muted, which now reads the
        paper scale.
      */}
      <p className="mt-1 text-xs text-muted-foreground">
        {offer.licenceTerms !== null
          ? "That is the price for the original file under the grant above. Anything it does not grant stays reserved, as set out on the "
          : "That is the price for the original file under the terms on the "}
        <a className={INLINE_LINK_CLASS} href={LICENCE_PATH}>
          licence page
        </a>
        . There is no checkout yet — get in touch and the terms are agreed in
        writing before anything changes hands.
      </p>
    </aside>
  );
}
