import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResaleRightsDecisionForm,
  type DecisionFormReview,
} from "@/app/admin/settings/instagram/decision-form";
import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";

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
  checklistVersion: CURRENT_CHECKLIST_VERSION,
  clearedOwnerUserId: "owner-1",
};

const RIGHTS_HOLDERS = [
  { id: "owner-1", name: "Owner One", email: "owner@example.com" },
  { id: "owner-2", name: null, email: "second@example.com" },
];

function render(review: DecisionFormReview | null): string {
  return renderToStaticMarkup(
    <ResaleRightsDecisionForm
      instagramAccountId="acc-1"
      review={review}
      rightsHolders={RIGHTS_HOLDERS}
      action="/api/admin/instagram/rights-decision"
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

  it("posts multipart to the route handler, not a server action", () => {
    // Without encType the browser sends urlencoded and the evidence file
    // arrives as a bare filename. And it has to be a route handler at all
    // because a server action's body limit is global (see next.config.ts).
    const markup = render(EXISTING);
    const form = /<form[^>]*>/.exec(markup)![0];

    expect(form).toContain('method="post"');
    // React emits the JSX spelling, `encType`. HTML attribute names are
    // ASCII case-insensitive so browsers read it the same, but the
    // assertion has to be.
    expect(form).toMatch(/enctype="multipart\/form-data"/i);
    expect(form).toContain('action="/api/admin/instagram/rights-decision"');
  });
});

describe("every field on the form is classified", () => {
  /**
   * Both fail-opens found in review were the same shape: a form field that
   * did not round-trip its stored value. This locks the field list so a new
   * one has to be classified here — and, if it is stored, covered by the
   * whole-row round-trip in decision-round-trip.test.tsx.
   *
   *   instagramAccountId — identity, from props, not stored by the action
   *   clearedOwnerUserId — round-trips (defaultValue); blank clears, on purpose
   *   status             — round-trips (defaultValue)
   *   route              — round-trips (defaultValue)
   *   validUntil         — round-trips (defaultValue); blank clears, on purpose
   *   conditions         — round-trips (defaultValue); blank clears, on purpose
   *   reason             — intentionally blank: an assertion about this decision
   *   evidence           — intentionally blank: absent means "keep what's stored"
   *   restampChecklist   — intentionally unticked: absent means "don't re-stamp"
   */
  it("renders exactly the fields listed above", () => {
    const names = new Set(
      [...render(EXISTING).matchAll(/\bname="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );

    expect([...names].sort()).toEqual([
      "clearedOwnerUserId",
      "conditions",
      "evidence",
      "instagramAccountId",
      "reason",
      "restampChecklist",
      "route",
      "status",
      "validUntil",
    ]);
  });
});

describe("the checklist re-stamp is an assertion, not a default", () => {
  // The sibling of the validUntil fail-open: checklistVersion decides which
  // checklist a clearance was granted under, and retiring a version is how a
  // revised legal process forces re-review. It must not move because someone
  // edited the conditions text.
  it("offers the re-stamp unticked", () => {
    const markup = render(EXISTING);
    const checkbox = /<input[^>]*name="restampChecklist"[^>]*>/.exec(markup);

    expect(checkbox).not.toBeNull();
    expect(checkbox![0]).toContain('value="yes"');
    // Unticked: an unticked checkbox submits nothing, so the stored version
    // is preserved by default.
    expect(checkbox![0]).not.toContain("checked");
  });

  it("shows which version the account currently stands on", () => {
    expect(render(EXISTING)).toContain(CURRENT_CHECKLIST_VERSION);
  });

  it("says plainly when the recorded version has been retired", () => {
    const markup = render({ ...EXISTING, checklistVersion: "2019-01-01.0" });

    expect(markup).toContain("2019-01-01.0");
    expect(markup).toContain("retired version");
  });

  it("does not offer a re-stamp for an account with no review yet", () => {
    // Nothing to preserve, and the first decision is necessarily made
    // against the current checklist.
    expect(render(null)).not.toContain('name="restampChecklist"');
  });
});
