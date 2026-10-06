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
   * ugcportal-oavb: the forced-colors focus-outline fix moved from a scoped
   * `FORCED_COLORS_FOCUS_OUTLINE` override on this component to
   * `buttonVariants`' own shared base (src/components/ui/button.tsx), so
   * there is no longer anything link-specific to assert here — the
   * base-level guard (src/components/ui/button.test.ts's "no bare
   * outline-none without a forced-colors-visible outline") and the real e2e
   * coverage (e2e/front-page.spec.ts's "forced colors: focus stays
   * visible..." suite) are what actually prove this now, for every
   * button-like control, including this one.
   */
});
