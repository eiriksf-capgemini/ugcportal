import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "./empty-state";
import { Hero } from "./hero";

/**
 * `EmptyState` now renders `PortfolioTile` (ugcportal-qqnt.5), whose module
 * graph reaches `@/lib/portfolio` -> `@/lib/media-access` -> `@/lib/auth` at
 * import time — the same reason src/components/portfolio/portfolio-tile.test.tsx
 * mocks this. This file never signs anyone in or out; the stub only exists
 * so importing `EmptyState` does not pull in next-auth's own module graph.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("rendering these components must not consult the session");
  },
}));

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

/*
 * `portfolioPieces={[]}` on the hero (ugcportal-qqnt.4): the same reasoning
 * as `pieces={[]}` on the empty state below — zero curated pieces still
 * renders every string the component can ever show except the tile
 * row/images themselves, which carry no visible copy of their own (the
 * hero's are `<img>`s with an `alt`, not on-screen text; see hero.test.tsx).
 */
const HERO_SIGNED_OUT = visibleText(
  renderToStaticMarkup(<Hero signedIn={false} portfolioPieces={[]} />),
);
const HERO_SIGNED_IN = visibleText(
  renderToStaticMarkup(<Hero signedIn={true} portfolioPieces={[]} />),
);
/*
 * `pieces={[]}` (ugcportal-qqnt.5): this guardrail is about the component's
 * OWN authored copy — the heading, the one-line fallback, the portfolio
 * link's label — not about an uploader's free-text caption, which is
 * neither fixed copy nor something this file's fixtures control. The
 * zero-pieces branch renders every string this component can ever show
 * except the portfolio tile row, which carries no text of its own (the
 * tiles are images with an aria-label, not visible copy — see
 * portfolio-tile.test.tsx).
 */
const EMPTY_STATE = visibleText(renderToStaticMarkup(<EmptyState pieces={[]} />));

describe("front page strings (ugcportal-6dvg K4)", () => {
  /*
   * A snapshot, not read by any assertion below — this is the artifact for
   * a HUMAN (Eirik) to review against docs/ugc-research.md's decisions
   * table, per K4's own "Verified by". The snapshot FILE
   * (src/components/home/__snapshots__/front-page-strings.test.tsx.snap)
   * is the one place this is guaranteed current (round-4 review, low
   * finding: an earlier version of this comment also claimed the PR
   * description reproduces it, which the PR body cannot keep in step with
   * every wording change this file's own strings go through — the snapshot
   * file is already current by construction, since this test fails the
   * moment it is not).
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
        /*
         * NOT `\b` (round-1 review, LOW finding — confirmed, not assumed):
         * JavaScript's `\b` is defined purely over `[A-Za-z0-9_]`, so "ø" is
         * itself a non-word character to it. Between two non-word
         * characters (a space and "ø") there is no `\w`-`\W` transition for
         * `\b` to match AT ALL, which means `new RegExp("\\bøl\\b")` could
         * never match "øl" however it was surrounded — a dead check for
         * exactly the one entry this list added for the Norwegian word, the
         * opposite of coverage while reading like it. `(?<!\p{L})`/`(?!\p{L})`
         * with the `u` flag treats any Unicode LETTER as the boundary input
         * instead, so "øl" between spaces (or at a string edge) is
         * correctly flagged. Confirmed with a fixture mutation — see this
         * file's own note below.
         */
        const pattern = new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, "giu");
        expect(
          withPermittedPhraseRemoved,
          `found forbidden word "${word}" in: ${text}`,
        ).not.toMatch(pattern);
      }
    }
  });

  /*
   * FIXTURE MUTATION CHECKS (performed by hand, not left in the suite):
   * temporarily changed the lead paragraph to read "...and wine, like a
   * nice glass after dinner...", confirmed the forbidden-word test above
   * failed with "found forbidden word \"wine\"", then reverted. Separately
   * mutated a character to "æ" and confirmed the Norwegian-character test
   * failed, then reverted. Separately again (round-1 review): injected
   * "øl" into the lead paragraph surrounded by spaces, confirmed the FIXED
   * `\p{L}`-lookaround pattern above catches it (and, in a node -e
   * one-liner, confirmed the PREVIOUS `\b`-based pattern could not —
   * `/\bøl\b/i.test("and øl and wine")` is `false`, proving that version
   * was dead code rather than merely untested), then reverted. See the PR
   * description for the full list of these checks across this bead.
   */
});
