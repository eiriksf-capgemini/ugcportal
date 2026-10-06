import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PORTFOLIO_PATH } from "@/lib/routes";

import { EmptyState } from "./empty-state";

/**
 * ugcportal-6dvg: the front page's own "living empty state". The condition
 * under which src/app/page.tsx chooses to render this component instead of
 * `<Gallery>` is covered end to end in src/app/page.test.tsx (K1, against a
 * real database); this file only covers what THIS component renders, given
 * that it has already been chosen.
 */
function render(): string {
  return renderToStaticMarkup(<EmptyState />);
}

describe("EmptyState (ugcportal-6dvg)", () => {
  it("carries the same heading and data-gallery-state GalleryEmpty uses, so the markup stays distinguishable from the error state", () => {
    const markup = render();

    expect(markup).toContain("Nothing is published yet.");
    expect(markup).toContain('data-gallery-state="empty"');
  });

  it("offers an action: a link to the portfolio", () => {
    const markup = render();

    expect(markup).toContain(`href="${PORTFOLIO_PATH}"`);
  });

  it("renders no <img>", () => {
    expect(render()).not.toMatch(/<img\b/i);
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily removed the `<Link>` from the component, confirmed the
   * "offers an action" test above failed, then restored it. See the PR
   * description for the full list of these checks across this bead.
   */

  /*
   * Round-4 fix, ugcportal-qqnt.2: a cheap guard for the scoped forced-colors
   * focus-outline override (this file's own `FORCED_COLORS_FOCUS_OUTLINE`,
   * see its comment, and hero.tsx's matching one for the full derivation) —
   * a unit-level backstop for a property real e2e coverage lives for in
   * e2e/front-page.spec.ts ("the portfolio link keeps a visible outline
   * under forced colors, on focus"), not a replacement for it.
   *
   * FIXTURE MUTATION CHECK: temporarily removed `FORCED_COLORS_FOCUS_OUTLINE`
   * from the `cn(...)` call below, confirmed this test fails (none of the
   * four classes appear), then restored it.
   */
  it("K-forced-colors: the portfolio link carries the forced-colors focus-outline override", () => {
    const markup = render();
    const link = markup.match(/<a[^>]*>See what is already finished, in the portfolio<\/a>/)?.[0] ?? "";

    expect(link).not.toBe("");
    for (const cls of [
      "focus-visible:outline-solid",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-transparent",
    ]) {
      expect(link, `expected the portfolio link's class list to contain ${cls}`).toContain(cls);
    }
  });
});
