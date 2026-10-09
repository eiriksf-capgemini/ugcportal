import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CurationPriceForm } from "@/app/admin/curation/price-form";
import { MAX_PRICE_CENTS, SUPPORTED_CURRENCIES } from "@/lib/pricing";

/**
 * The price form submits two values and nothing else, and the one that can
 * go wrong silently is the amount (ugcportal-yzo7 K1).
 *
 * The real component, rendered, with the real markup read — the same shape
 * and the same reason as clearance-form.test.tsx next door. The failure this
 * exists to catch is a field that does not round-trip the stored value: an
 * admin opening the form on a priced item, changing the currency and
 * submitting would then silently re-price it at whatever the empty field
 * parsed to, and an empty field means "take it off sale".
 */

function render(
  priceCents: number | null,
  currency = "NOK",
): string {
  return renderToStaticMarkup(
    <CurationPriceForm
      mediaId="media-1"
      priceCents={priceCents}
      currency={currency}
      action={() => undefined}
    />,
  );
}

/** The `value` of a hidden input with the given name, or null. */
function hiddenValue(markup: string, name: string): string | null {
  const match = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(markup);
  if (!match) return null;
  return /value="([^"]*)"/.exec(match[0])?.[1] ?? null;
}

describe("what the price form submits (ugcportal-yzo7 K1)", () => {
  it("carries the media id it was rendered for", () => {
    expect(hiddenValue(render(null), "mediaId")).toBe("media-1");
  });

  it("round-trips a stored amount into the amount field", () => {
    const markup = render(125_000);
    expect(/name="priceCents"[^>]*value="125000"/.test(markup)).toBe(true);
  });

  it("renders an EMPTY amount field for an unpriced item, not a zero", () => {
    /*
      The mutation that matters, and the reason this file exists. A
      `defaultValue={priceCents ?? 0}` renders "0", which the action would
      read as a real price of zero rather than as "not priced" — and zero is
      a value `isStorablePriceCents` accepts. The empty string is what makes
      a blank field mean blank.
    */
    const markup = render(null);
    expect(/name="priceCents"[^>]*value=""/.test(markup)).toBe(true);
    expect(/name="priceCents"[^>]*value="0"/.test(markup)).toBe(false);
  });

  it("offers exactly the currencies the write accepts", () => {
    // A dropdown offering a currency `recordPrice` refuses is one whose
    // every selection fails; one missing a supported currency is a currency
    // nobody can pick. Both directions, off the shared allowlist.
    const markup = render(100, "EUR");
    const offered = [...markup.matchAll(/<option value="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(offered.sort()).toEqual([...SUPPORTED_CURRENCIES].sort());
  });

  it("pre-selects the stored currency rather than the first option", () => {
    const markup = render(100, "USD");
    expect(/<option value="USD"[^>]*selected/.test(markup)).toBe(true);
    expect(/<option value="EUR"[^>]*selected/.test(markup)).toBe(false);
  });

  it("bounds the browser's own field with the same ceiling the write uses", () => {
    // A convenience, not the rule — the write re-checks it — but a form
    // whose max disagreed with the write would refuse an admin after the
    // round trip for a number the field had already accepted.
    expect(render(null)).toContain(`max="${MAX_PRICE_CENTS}"`);
  });

  it("says in the label that blank removes the price", () => {
    // The one destructive thing this form does, and the only one the gate
    // does not stand in front of. It has to be stated where it is done.
    expect(render(125_000)).toContain("blank");
  });
});
