import { Button } from "@/components/ui/button";
import { MAX_PRICE_CENTS, SUPPORTED_CURRENCIES } from "@/lib/pricing";

/**
 * The price form on the curation screen (ugcportal-yzo7 K1).
 *
 * THE AMOUNT IS IN MINOR UNITS, and the field says so rather than accepting
 * kroner and multiplying. A major-unit field would mean parsing "1 250,50"
 * in a browser locale and turning it into an integer here, which is a float
 * in the middle of a money path — the one thing `priceCents` exists to
 * avoid. An admin pricing something at NOK 1 250 types 125000, the label
 * says so, and nothing between this field and the column divides anything.
 *
 * BLANK REMOVES THE PRICE, and the label says that too. Un-pricing is the
 * one operation on this screen the sale gate does not stand in front of (see
 * `recordPrice`), so it has to be reachable even when the gate refuses
 * everything else about the row — which is exactly the situation an admin is
 * in when a clearance has just been revoked.
 *
 * `step={1}`/`min`/`max` are a convenience, not the rule. The action
 * re-parses the field and `recordPrice` re-checks the bounds
 * (`price_amount_invalid`), because a browser attribute is not enforcement:
 * a server action is reachable by POSTing its id with no form at all.
 *
 * A separate module from page.tsx so it can be rendered on its own in a
 * test, the same reason the triage and clearance forms give.
 */

const FIELD_CLASS =
  "mt-1 block w-full rounded-md border border-input bg-surface-3 p-2 text-sm text-ink";

export function CurationPriceForm({
  mediaId,
  priceCents,
  currency,
  action,
}: {
  /** The upload being priced. Identity from the page, not a choice the form offers. */
  mediaId: string;
  /** What is stored today, so the field round-trips rather than clearing on every visit. */
  priceCents: number | null;
  /** The stored currency, pre-selected. */
  currency: string;
  /**
   * The server action that records the price. Passed in rather than imported
   * here so this module can be rendered in a test without a running action
   * runtime, and so the test can observe exactly what the form submits.
   */
  action: (formData: FormData) => void | Promise<void>;
}) {
  const amountId = `price-cents-${mediaId}`;
  const currencyId = `price-currency-${mediaId}`;
  return (
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="mediaId" value={mediaId} />
      <label className="block text-xs font-medium" htmlFor={amountId}>
        Price, in minor units
        {/*
          text-muted-foreground, not text-ink-muted (ugcportal-6uc2, phase
          2): this form renders inside page.tsx's "price" bg-muted well,
          which now reads the paper scale, not the near-black one this label
          used to assume.
        */}
        <span className="mt-1 block font-normal text-muted-foreground">
          Whole øre or cents — 125000 is NOK 1 250.00. Leave it blank to take
          this upload off sale; that is the one change here the rights gate
          does not stand in front of.
        </span>
      </label>
      <input
        id={amountId}
        name="priceCents"
        type="number"
        inputMode="numeric"
        step={1}
        min={0}
        max={MAX_PRICE_CENTS}
        defaultValue={priceCents ?? ""}
        className={FIELD_CLASS}
      />
      <label className="block text-xs font-medium" htmlFor={currencyId}>
        Currency
      </label>
      <select
        id={currencyId}
        name="currency"
        defaultValue={currency}
        className={FIELD_CLASS}
      >
        {/*
          From the shared allowlist, not a hand-written list: a currency
          offered here that `recordPrice` refuses would be a dropdown whose
          every selection fails, and one missing from here is a currency
          nobody can pick. Sorted so the order is stable across renders
          rather than whatever the Set happened to iterate in.
        */}
        {[...SUPPORTED_CURRENCIES].sort().map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm">
        Save the price
      </Button>
    </form>
  );
}
