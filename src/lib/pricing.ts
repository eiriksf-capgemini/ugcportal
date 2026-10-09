/**
 * WHAT A PRICE IS, WITH NO OPINION ABOUT WHETHER ANYTHING MAY BE SOLD
 * (ugcportal-yzo7).
 *
 * Bounds, the currency allowlist and the display format — four values and
 * three pure functions, and deliberately not one line more. Nothing here
 * reads a row, asks the sale gate or touches Prisma, and that absence is the
 * module's whole reason to exist in a repo that otherwise puts a price's
 * rules beside the write.
 *
 * WHY IT IS SEPARATE FROM `curation-price-write.ts` AND `sellable-media.ts`,
 * stated as the failure rather than the preference. Both of those import
 * `@/lib/prisma`, which builds its libsql adapter from `DATABASE_URL` AT
 * IMPORT TIME. Two React components need the bounds and the formatter —
 * src/app/admin/curation/price-form.tsx and
 * src/components/media/purchase-offer.tsx — and a component that reaches for
 * either of those modules drags a database client into its own module graph.
 * That is not theoretical: it was MEASURED here. A first draft had
 * `purchase-offer.tsx` import `formatOfferPrice` from `sellable-media.ts`,
 * and src/app/media/[previewId]/page.test.tsx then failed its whole suite
 * with `SQLITE_ERROR: table "User" already exists` — the client had bound to
 * the ambient database before `createTemporaryDatabase()` could point it at
 * a temp file. The same hazard src/lib/routes.ts's own comment describes for
 * the gallery's client components.
 *
 * NOT A SELLABILITY SIGNAL, and src/lib/sellability-signal.test.ts names this
 * file in its allowlist for exactly that reason: it answers "is this amount
 * storable" and "how does this amount read", never "may this be sold". The
 * one place that answers the second is `isSellable` (src/lib/resale-rights.ts),
 * and the one render path that pairs the two is
 * `publicOffer` (src/lib/sellable-media.ts).
 */

/**
 * Ceiling on a stored price, in minor units — 10 000 000 øre, NOK 100 000.
 *
 * One copy, shared by the HTTP endpoint, the admin form and the write: a
 * bound enforced at one of three places is not a bound. The number itself is
 * a placeholder for whatever ugcportal-p3v settles on, as the price route's
 * own comment has always said.
 */
export const MAX_PRICE_CENTS = 10_000_000;

/**
 * Currencies a price may be recorded in — the ones the checkout work
 * (ugcportal-p3v) will actually support, so a price cannot be stored in a
 * currency nothing can charge.
 *
 * EVERY MEMBER HAS AN ISO-4217 MINOR UNIT OF 2, which `formatOfferPrice`
 * below depends on and src/lib/sellable-media.test.ts asserts. Adding JPY
 * (0) or KWD (3) here fails that test rather than rendering a price a
 * hundred times too small.
 */
export const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
  "NOK",
  "EUR",
  "USD",
]);

/**
 * True for a value that may be stored in `MediaListing.priceCents`.
 *
 * `Number.isSafeInteger` rather than a null or NaN check: money is integer
 * minor units, and a float here becomes a rounding argument later. Rejects
 * NaN, Infinity, 19.99 and "1000" alike.
 *
 * ZERO IS ACCEPTED, deliberately, and is not the same decision as offering
 * something for nothing — `publicOffer` (src/lib/sellable-media.ts) treats a
 * stored zero as "no price set" rather than as free, because "free" is a
 * licensing decision nobody has taken. This function answers only whether
 * the column may hold the value.
 */
export function isStorablePriceCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PRICE_CENTS
  );
}

/** True for a value that may be stored in `MediaListing.currency`. */
export function isSupportedCurrency(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_CURRENCIES.has(value);
}

/**
 * What a visitor may be told about buying one item: an amount and the
 * currency it is in. Nothing else — in particular no licence terms, because
 * there is no per-item licence to carry (ugcportal-74w.1); the licence that
 * applies is the site-wide one at /licence, which every renderer links to
 * from the route constant rather than from a field here.
 */
export type PublicOffer = {
  /** Integer minor units, exactly as stored. No float ever touches money. */
  priceCents: number;
  /** An ISO-4217 code from {@link SUPPORTED_CURRENCIES}. */
  currency: string;
};

/**
 * The amount as a visitor reads it, e.g. `NOK 1,250.00`.
 *
 * DIVIDES BY 100 FOR EVERY CURRENCY, which is true of the three
 * `SUPPORTED_CURRENCIES` allows and is not true of ISO-4217 generally.
 * Stated rather than solved: the allowlist is the control, and the exponent
 * of every member of it is asserted in src/lib/sellable-media.test.ts.
 *
 * FORMATTING ONLY. It is never the thing that decides whether to render an
 * offer at all — `publicOffer` is — so there is no path on which a
 * formatting failure becomes a sale.
 */
export function formatOfferPrice(offer: PublicOffer, locale = "en-GB"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: offer.currency,
    currencyDisplay: "code",
  }).format(offer.priceCents / 100);
}
