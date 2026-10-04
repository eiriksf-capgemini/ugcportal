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
});
