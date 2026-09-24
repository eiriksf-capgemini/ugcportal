import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResaleRightsDecisionForm,
  toDateInputValue,
  type DecisionFormReview,
} from "@/app/admin/settings/instagram/decision-form";

/**
 * This form is an *edit* form over a security-relevant record: submitting it
 * writes every field, so a field rendered without its current value clears
 * that value. For `validUntil` that is the one way this feature can fail
 * OPEN — a time-limited clearance silently becoming perpetual because an
 * admin edited the conditions text.
 *
 * So the test renders the real component and reads the real markup, rather
 * than asserting that some helper was called.
 */

const EXISTING: DecisionFormReview = {
  status: "CLEARED",
  route: "CONTRACT",
  validUntil: new Date("2027-06-01T00:00:00.000Z"),
  conditions: "Editorial use only.",
};

function render(review: DecisionFormReview | null): string {
  return renderToStaticMarkup(
    <ResaleRightsDecisionForm
      instagramAccountId="acc-1"
      review={review}
      action={() => {}}
    />,
  );
}

/** The `value="..."` of the named input, or null when it has none. */
function inputValue(markup: string, name: string): string | null {
  const match = new RegExp(
    `<input[^>]*name="${name}"[^>]*>|<input[^>]*name="${name}"[^>]*/>`,
  ).exec(markup);
  if (!match) {
    throw new Error(`no input named ${name} in the rendered form`);
  }
  return /value="([^"]*)"/.exec(match[0])?.[1] ?? null;
}

describe("toDateInputValue", () => {
  it("formats a date the way <input type=date> requires", () => {
    expect(toDateInputValue(new Date("2027-06-01T00:00:00.000Z"))).toBe(
      "2027-06-01",
    );
    // UTC, not local: the action parses the value back as midnight UTC, so
    // formatting in local time would move the expiry by a day either way.
    expect(toDateInputValue(new Date("2027-06-01T23:30:00.000Z"))).toBe(
      "2027-06-01",
    );
  });

  it("gives an empty string for no date, so the input renders blank", () => {
    expect(toDateInputValue(null)).toBe("");
    expect(toDateInputValue(new Date("nonsense"))).toBe("");
  });
});

describe("the decision form round-trips the existing review", () => {
  // The regression this file exists for.
  it("renders the current validUntil, so an unrelated edit cannot clear it", () => {
    expect(inputValue(render(EXISTING), "validUntil")).toBe("2027-06-01");
  });

  it("renders a blank date when the clearance has no end", () => {
    expect(
      inputValue(render({ ...EXISTING, validUntil: null }), "validUntil"),
    ).toBe("");
  });

  it("pre-selects the current status and route", () => {
    const markup = render(EXISTING);
    // React renders defaultValue on a <select> as `selected` on the option.
    expect(markup).toMatch(/<option selected[^>]*value="CLEARED"|value="CLEARED" selected/);
    expect(markup).toMatch(/<option selected[^>]*value="CONTRACT"|value="CONTRACT" selected/);
  });

  it("pre-fills the current conditions", () => {
    expect(render(EXISTING)).toContain("Editorial use only.");
  });

  it("never pre-fills the reason", () => {
    // Every decision states its own justification; inheriting the last one
    // would put words in the reviewer's mouth in an audit record.
    const markup = render({
      ...EXISTING,
      conditions: "Editorial use only.",
    });
    const reason = /<textarea[^>]*name="reason"[^>]*>([\s\S]*?)<\/textarea>/.exec(
      markup,
    );
    expect(reason?.[1] ?? "").toBe("");
  });

  it("offers every status in the schema, so no state is unreachable", () => {
    const markup = render(null);
    for (const status of [
      "UNREVIEWED",
      "IN_REVIEW",
      "CLEARED",
      "REJECTED",
      "REVOKED",
      "EXPIRED",
    ]) {
      expect(markup).toContain(`value="${status}"`);
    }
  });

  it("carries the account id it was rendered for", () => {
    expect(inputValue(render(null), "instagramAccountId")).toBe("acc-1");
  });
});
