import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";
import { Hero } from "./hero";

/**
 * ugcportal-6dvg K4: "Following should never happen: a stock photo or
 * third-party image in the hero; a Norwegian string in the hero or empty
 * state; the lead naming wine or any alcoholic drink as the subject."
 *
 * Decisions table (docs/ugc-research.md, 4 October 2026): the whole site is
 * in English, and the subject is food, books, home technology and wine
 * ACCESSORIES (glasses, coolers, apps) — never alcohol itself. This file is
 * the automated half of that guardrail; the `FRONT_PAGE_STRINGS` snapshot
 * below is the half for Eirik to read by eye against the decisions table.
 */

/** Every user-visible string the hero and the empty state render, stripped of markup. */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HERO_SIGNED_OUT = visibleText(renderToStaticMarkup(<Hero signedIn={false} />));
const HERO_SIGNED_IN = visibleText(renderToStaticMarkup(<Hero signedIn={true} />));
const EMPTY_STATE = visibleText(renderToStaticMarkup(<EmptyState />));

describe("front page strings (ugcportal-6dvg K4)", () => {
  /*
   * A snapshot, not read by any assertion below — this is the artifact for
   * a HUMAN (Eirik) to review against docs/ugc-research.md's decisions
   * table, per K4's own "Verified by". Also reproduced in the PR
   * description.
   */
  it("snapshot: every string the hero and empty state render, for review", () => {
    expect({
      heroSignedOut: HERO_SIGNED_OUT,
      heroSignedIn: HERO_SIGNED_IN,
      emptyState: EMPTY_STATE,
    }).toMatchSnapshot();
  });

  it("contains no Norwegian characters (æ/ø/å, either case)", () => {
    for (const text of [HERO_SIGNED_OUT, HERO_SIGNED_IN, EMPTY_STATE]) {
      expect(text).not.toMatch(/[æøåÆØÅ]/);
    }
  });

  /*
   * "wine accessories" is the one permitted phrase (the decisions table's
   * own wording for the subject: glasses, coolers, the apps that go with
   * them) — everything else naming wine, beer, spirits or alcohol as the
   * SUBJECT is what this guards against. Matched case-insensitively and with
   * the permitted phrase stripped out FIRST, so "wine accessories" itself
   * cannot trip the bare "wine" check that follows it.
   */
  const FORBIDDEN_WORDS = ["wine", "beer", "spirits", "alcohol", "vin", "øl"];

  it('names no alcoholic drink as the subject, allowing only the phrase "wine accessories"', () => {
    for (const text of [HERO_SIGNED_OUT, HERO_SIGNED_IN, EMPTY_STATE]) {
      const withPermittedPhraseRemoved = text.replace(/wine accessories/gi, "");
      for (const word of FORBIDDEN_WORDS) {
        expect(
          withPermittedPhraseRemoved.toLowerCase(),
          `found forbidden word "${word}" in: ${text}`,
        ).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
      }
    }
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily changed the lead paragraph to read "...and wine, like a
   * nice glass after dinner...", confirmed BOTH the Norwegian-free test
   * (not actually - wrong mutation for that one) and specifically the
   * forbidden-word test above failed with "found forbidden word \"wine\"",
   * then reverted. Separately mutated a character to "æ" and confirmed the
   * Norwegian-character test failed, then reverted. See the PR description
   * for the full list of these checks across this bead.
   */
});
