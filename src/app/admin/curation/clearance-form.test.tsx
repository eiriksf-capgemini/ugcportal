import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CurationClearanceForm } from "@/app/admin/curation/clearance-form";
import { RightsLayer } from "@/generated/prisma/enums";
import { CLEARABLE_LAYERS, TRIAGE_FACTS } from "@/lib/resale-rights";

/**
 * The clearance form carries the one value that decides WHICH layer a
 * justification settles (ugcportal-qfy9 K1). Everything else on the screen
 * is prose; this hidden field is the mechanism.
 *
 * So this renders the real component and reads the real markup rather than
 * asserting a helper was called — the same shape, and the same reason, as
 * triage-form.test.tsx next door. The failure it exists to catch is a form
 * that submits a layer other than the one the admin was reading about,
 * which no amount of care in the write path can undo: the write would
 * record a perfectly valid clearance against the wrong question.
 */

const QUESTIONS = new Map(
  TRIAGE_FACTS.map((fact) => [fact.layer, fact.question]),
);

function render(layer: RightsLayer): string {
  return renderToStaticMarkup(
    <CurationClearanceForm
      mediaId="media-1"
      layer={layer}
      question={QUESTIONS.get(layer) ?? ""}
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

describe("the layer the form submits", () => {
  it("carries exactly the layer it was rendered for, for every clearable layer", () => {
    /*
      The whole table, not one example. A component that hard-coded a layer,
      or that read it from somewhere other than its prop, passes a
      single-layer test for whichever layer the test happened to pick.
    */
    for (const layer of CLEARABLE_LAYERS) {
      const markup = render(layer);
      expect(hiddenValue(markup, "layer"), layer).toBe(layer);
      expect(hiddenValue(markup, "mediaId"), layer).toBe("media-1");
    }
  });

  it("carries exactly ONE layer field", () => {
    // Two would make which one wins a question about form serialisation
    // order rather than about what the admin decided.
    const markup = render(RightsLayer.MUSIC);
    expect(markup.match(/name="layer"/g)).toHaveLength(1);
  });

  it("asks the registry's own question for that layer", () => {
    // The wording the gate blocks on, not a second copy of it written here:
    // an admin clearing MUSIC has to be reading the question MUSIC is
    // registered against.
    const markup = render(RightsLayer.MINORS);
    expect(markup).toContain(QUESTIONS.get(RightsLayer.MINORS));
    expect(markup).not.toContain(QUESTIONS.get(RightsLayer.MUSIC));
  });

  it("says in the markup that it settles this layer and no other", () => {
    // The screen's own statement of the invariant. An admin who thinks one
    // justification covers the upload will write one that reads as if it
    // does.
    const markup = render(RightsLayer.MUSIC);
    // The sentence, not a word out of it: "every" on its own matches almost
    // any prose, so it would go on passing after the clause was rewritten
    // to say the opposite.
    expect(markup).toContain(
      "This justification covers MUSIC and nothing else",
    );
    expect(markup).toContain("every other layer still blocks");
  });

  it("names a reason field, required, and renders no stored value in it", () => {
    /*
      NOT AN EDIT FORM. A textarea pre-filled with an existing reason would
      invite an overwrite the write path refuses, and the admin would lose
      what they typed to a `clearance_already_recorded`. The component takes
      no stored reason at all, which is what makes that unexpressible —
      asserted here as "the rendered textarea is empty".
    */
    const markup = render(RightsLayer.MUSIC);
    const textarea = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(markup);
    expect(textarea).not.toBeNull();
    expect(textarea?.[0]).toContain('name="reason"');
    expect(textarea?.[0]).toContain("required");
    expect(textarea?.[1]).toBe("");
  });

  it("gives the reason box a label bound to it, per layer", () => {
    // Several of these render on one page, one per blocking layer. A label
    // whose `for` pointed at a shared id would attach every label to the
    // first box — an a11y failure and, here, a way to type a MUSIC
    // justification into the PEOPLE form.
    const ids = CLEARABLE_LAYERS.map((layer) => {
      const markup = render(layer);
      // `for=`, not `htmlFor=`: React renders the DOM attribute, and a
      // regex looking for the JSX prop name would find nothing and report
      // a missing label on a form that has one.
      const forAttr = /<label[^>]*\sfor="([^"]*)"/.exec(markup)?.[1] ?? null;
      const id = /<textarea[^>]*id="([^"]*)"/.exec(markup)?.[1] ?? null;
      expect(forAttr, layer).not.toBeNull();
      expect(id, layer).toBe(forAttr);
      return id;
    });
    expect(new Set(ids).size).toBe(CLEARABLE_LAYERS.length);
  });
});
