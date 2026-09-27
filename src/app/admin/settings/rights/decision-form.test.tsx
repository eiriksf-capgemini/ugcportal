import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResaleRightsDecisionForm,
  type DecisionFormReview,
} from "@/app/admin/settings/rights/decision-form";
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
};

function render(review: DecisionFormReview | null): string {
  return renderToStaticMarkup(
    <ResaleRightsDecisionForm
      uploaderUserId="uploader-1"
      review={review}
      action="/api/admin/rights/decision"
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

  it("carries the uploader id it was rendered for", () => {
    expect(inputValue(render(null), "uploaderUserId")).toBe("uploader-1");
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
    expect(form).toContain('action="/api/admin/rights/decision"');
  });
});

describe("every field on the form is classified", () => {
  /**
   * Both fail-opens found in review were the same shape: a form field that
   * did not round-trip its stored value. This locks the field list so a new
   * one has to be classified here — and, if it is stored, covered by the
   * whole-row round-trip in decision-round-trip.test.tsx.
   *
   *   uploaderUserId   — identity, from props, not stored by the handler
   *   status           — round-trips (defaultValue)
   *   route            — round-trips (defaultValue); blank clears, on purpose
   *   validUntil       — round-trips (defaultValue); blank clears, on purpose
   *   conditions       — round-trips (defaultValue); blank clears, on purpose
   *   reason           — intentionally blank: an assertion about this decision
   *   evidence         — intentionally blank: absent means "keep what's stored"
   *   restampChecklist — intentionally unticked: absent means "don't re-stamp"
   *
   * ugcportal-0ss also had `clearedOwnerUserId` here, and it produced two of
   * the round-trip bugs on its own. ugcportal-vsm removed the field rather
   * than fixing it a third time: the gate reaches a clearance through the
   * file's own uploader, so there is nothing for a human to pick.
   */
  it("renders exactly the fields listed above", () => {
    const names = new Set(
      [...render(EXISTING).matchAll(/\bname="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );

    expect([...names].sort()).toEqual([
      "conditions",
      "evidence",
      "reason",
      "restampChecklist",
      "route",
      "status",
      "uploaderUserId",
      "validUntil",
    ]);
  });
});

/**
 * The generic form of "a field that does not round-trip its stored value" —
 * the family that produced four separate bugs in ugcportal-0ss, the last of
 * which was a select whose *option list* was lossy rather than the field.
 *
 * Deliberately not a list of select names: the names are read off the
 * rendered markup, so a select added later inherits the assertion without
 * anyone remembering to add it.
 */
describe("no select can silently drop its stored value", () => {
  /** `{ name -> { selected, values } }` for every select in the markup. */
  function selects(markup: string) {
    const found = new Map<string, { selected?: string; values: string[] }>();
    for (const match of markup.matchAll(
      /<select\b([^>]*)>([\s\S]*?)<\/select>/g,
    )) {
      const name = /\bname="([^"]+)"/.exec(match[1])?.[1];
      if (!name) continue;
      const options = [...match[2].matchAll(/<option\b([^>]*)>/g)].map(
        (option) => option[1],
      );
      found.set(name, {
        selected: /\bvalue="([^"]*)"/.exec(
          options.find((option) => /\bselected\b/.test(option)) ?? "",
        )?.[1],
        values: options.map(
          (option) => /\bvalue="([^"]*)"/.exec(option)?.[1] ?? "",
        ),
      });
    }
    return found;
  }

  it("offers, and selects, the stored value of every select", () => {
    const stored = { status: "REJECTED", route: "EXPLICIT_CONSENT" };
    const rendered = selects(
      render({ ...EXISTING, ...stored, validUntil: null, conditions: null }),
    );

    // Read off the form rather than hand-listed, so a select added later is
    // covered whether or not anyone updates this test.
    expect(rendered.size).toBe(2);
    for (const [name, select] of rendered) {
      const expected = stored[name as keyof typeof stored];
      expect(select.values).toContain(expected);
      expect(select.selected).toBe(expected);
    }
  });

  it("renders both selects from the full generated enums", () => {
    // Which is why neither can lose a stored value the way the old
    // rights-holder select did: the option list is the whole domain, not a
    // capped slice of a table.
    const rendered = selects(render(EXISTING));

    expect(rendered.get("status")!.values.sort()).toEqual([
      "CLEARED",
      "EXPIRED",
      "IN_REVIEW",
      "REJECTED",
      "REVOKED",
      "UNREVIEWED",
    ]);
    expect(rendered.get("route")!.values.sort()).toEqual([
      "",
      "CONTRACT",
      "EXPLICIT_CONSENT",
      "OWN_TERMS_ACCEPTANCE",
    ]);
  });

  it("selects the blank option when nothing is recorded", () => {
    const route = selects(render({ ...EXISTING, route: null })).get("route")!;

    expect(route.selected ?? "").toBe("");
  });
});

/**
 * A <label>'s content IS its control's accessible name. Explanatory prose
 * parked inside one is read out as the name of the combobox or the checkbox
 * it sits next to, which is invisible to anyone looking at the rendered page
 * and obvious to anyone using a screen reader.
 *
 * That is not hypothetical here: the paragraph explaining the uploader/upload
 * split was left inside the Route label when the rights-holder field it
 * originally belonged to was deleted, so the route combobox announced four
 * lines of unrelated text as its name.
 *
 * The rule asserted is the one that actually distinguishes the two cases,
 * rather than a length limit that would flag the legitimate long checkbox
 * label: a label's text sits on ONE side of its control. Text before it (a
 * name, as on every select and textarea here) or text after it (a checkbox's
 * label) are both fine; both at once means the second part is a description
 * that does not belong inside the label at all.
 *
 * Labels are read out of the rendered markup, so a field added later
 * inherits the assertion.
 */
describe("no label smuggles prose into a control's accessible name", () => {
  const CONTROL = "\u0000";

  /** The label's text with its control replaced by a marker. */
  function labelParts(inner: string): { before: string; after: string } | null {
    const withMarker = inner
      .replace(/<select\b[^>]*>[\s\S]*?<\/select>/g, CONTROL)
      .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g, CONTROL)
      .replace(/<input\b[^>]*\/?>/g, CONTROL);
    if (!withMarker.includes(CONTROL)) {
      return null;
    }
    const [before, ...rest] = withMarker.split(CONTROL);
    const text = (part: string) => part.replace(/<[^>]*>/g, "").trim();
    return { before: text(before), after: text(rest.join(" ")) };
  }

  it("keeps each label's text on one side of its control", () => {
    const labels = [
      ...render(EXISTING).matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g),
    ].map((match) => match[1]);

    // Guards the scan: a markup change that stopped matching would make
    // every assertion below vacuously true.
    expect(labels.length).toBeGreaterThan(4);

    for (const inner of labels) {
      const parts = labelParts(inner);
      if (!parts) continue;
      // Keyed so a failure prints the offending text rather than `false`.
      expect({
        bothSides: Boolean(parts.before && parts.after),
        text: `${parts.before} | ${parts.after}`.slice(0, 120),
      }).toMatchObject({ bothSides: false });
    }
  });

  it("still carries the explanation, outside every label", () => {
    // The prose is useful and must not simply have been deleted: it is what
    // tells a reviewer that clearing an uploader is not clearing their files.
    const markup = render(EXISTING);
    const outsideLabels = markup.replace(
      /<label\b[^>]*>[\s\S]*?<\/label>/g,
      "",
    );

    expect(outsideLabels).toContain("triaged and cleared per upload");
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

  it("shows which version the uploader currently stands on", () => {
    expect(render(EXISTING)).toContain(CURRENT_CHECKLIST_VERSION);
  });

  it("says plainly when the recorded version has been retired", () => {
    const markup = render({ ...EXISTING, checklistVersion: "2019-01-01.0" });

    expect(markup).toContain("2019-01-01.0");
    expect(markup).toContain("retired version");
  });

  it("does not offer a re-stamp for an uploader with no review yet", () => {
    // Nothing to preserve, and the first decision is necessarily made
    // against the current checklist.
    expect(render(null)).not.toContain('name="restampChecklist"');
  });
});
