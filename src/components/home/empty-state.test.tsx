import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GalleryItem } from "@/lib/gallery-items";
import { PORTFOLIO_PATH } from "@/lib/routes";

import { EmptyState } from "./empty-state";

/**
 * `EmptyState` now renders `PortfolioTile` (ugcportal-qqnt.5), whose module
 * graph reaches `@/lib/portfolio` -> `@/lib/media-access` -> `@/lib/auth` at
 * import time — the same reason src/components/portfolio/portfolio-tile.test.tsx
 * mocks this. This file never signs anyone in or out; the stub only exists
 * so importing `EmptyState` does not pull in next-auth's own module graph.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("rendering the empty state must not consult the session");
  },
}));

/**
 * ugcportal-6dvg / ugcportal-qqnt.5: the front page's own "living empty
 * state". The condition under which src/app/page.tsx chooses to render this
 * component instead of `<Gallery>` — and the real `listPortfolioPieces()`
 * query that produces `pieces` — are covered end to end in
 * src/app/page.test.tsx (against a real database); this file only covers
 * what THIS component renders, given an already-chosen, already-resolved
 * `pieces` array, same as GalleryEmpty's own comment on the equivalent
 * split for `<Gallery>`.
 */
function render(pieces: GalleryItem[]): string {
  return renderToStaticMarkup(<EmptyState pieces={pieces} />);
}

/**
 * A minimal, distinct `GalleryItem` fixture — distinct `id`/`previewSrc` per
 * call, so a test asserting "exactly these six, in this order" cannot pass
 * by accident on a fixture that is identical for every piece.
 *
 * `kind: "IMAGE"` always (K3's own premise): src/lib/portfolio.ts's
 * `listPortfolioPieces` is IMAGE-only at the query, so nothing reaching this
 * component should ever need to represent a VIDEO piece — there is no
 * fixture for one here on purpose.
 */
function piece(id: string): GalleryItem {
  return {
    id,
    previewSrc: `/api/media/preview/pv-${id}`,
    kind: "IMAGE",
    publishedAt: "2026-03-04T10:00:00.000Z",
    altText: `Photograph ${id}`,
    caption: "",
    tags: [],
    advertisingLabel: null,
    commercialLinks: [],
  };
}

const SIX_PIECES = ["a", "b", "c", "d", "e", "f"].map(piece);

describe("EmptyState (ugcportal-6dvg, ugcportal-qqnt.5)", () => {
  it("carries the same heading and data-gallery-state GalleryEmpty uses, so the markup stays distinguishable from the error state", () => {
    const markup = render([]);

    expect(markup).toContain("Nothing is published yet.");
    expect(markup).toContain('data-gallery-state="empty"');
  });

  it("the genuinely-empty copy is one short line, with no em-dash", () => {
    const markup = render([]);

    expect(markup).not.toContain("—");
  });

  it("offers an action: a link to the portfolio, on buttonVariants, present whether or not there are any pieces", () => {
    expect(render([])).toContain(`href="${PORTFOLIO_PATH}"`);
    expect(render(SIX_PIECES)).toContain(`href="${PORTFOLIO_PATH}"`);
  });

  describe("K2: zero portfolio pieces", () => {
    it("renders no <img> and no tile row at all", () => {
      const markup = render([]);

      expect(markup).not.toMatch(/<img\b/i);
      expect(markup).not.toContain("data-portfolio-piece");
    });

    it("does not render the 'From the portfolio' section title", () => {
      expect(render([])).not.toContain("From the portfolio");
    });

    /*
     * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
     * temporarily removed the `featured.length > 0` guard so the heading
     * and empty `<ul>` rendered unconditionally; confirmed the
     * "does not render the 'From the portfolio' section title" test above
     * failed, then restored the guard.
     */
  });

  describe("K1: at least one portfolio piece", () => {
    it("renders the 'From the portfolio' section title as an h2", () => {
      const markup = render(SIX_PIECES);

      expect(markup).toMatch(/<h2[^>]*>From the portfolio<\/h2>/);
    });

    it("renders one tile per piece, up to six, each a real portfolio piece and nothing else", () => {
      const markup = render(SIX_PIECES);

      for (const { id } of SIX_PIECES) {
        expect(markup).toContain(`data-portfolio-piece="${id}"`);
      }
      expect(
        [...markup.matchAll(/data-portfolio-piece="([^"]+)"/g)],
      ).toHaveLength(6);
    });

    it("caps the row at six even when more pieces are supplied", () => {
      const sevenPieces = [...SIX_PIECES, piece("g")];
      const markup = render(sevenPieces);

      expect(
        [...markup.matchAll(/data-portfolio-piece="([^"]+)"/g)],
      ).toHaveLength(6);
      expect(markup).not.toContain('data-portfolio-piece="g"');
    });

    it("renders exactly one tile for a single piece (not padded, not a full row of six)", () => {
      const markup = render([piece("only")]);

      expect(
        [...markup.matchAll(/data-portfolio-piece="([^"]+)"/g)],
      ).toHaveLength(1);
      expect(markup).toContain('data-portfolio-piece="only"');
    });

    it("the tiles link to /portfolio", () => {
      const markup = render(SIX_PIECES);

      // Every tile's own anchor resolves to the same destination — see
      // portfolio-tile.tsx's own tests for the per-tile accessible-name and
      // aria-hidden-image detail this component relies on but does not
      // re-assert.
      const hrefs = [...markup.matchAll(/<a[^>]*href="([^"]+)"/g)].map(
        (match) => match[1],
      );
      expect(hrefs.length).toBeGreaterThanOrEqual(6);
      for (const href of hrefs) {
        expect(href).toBe(PORTFOLIO_PATH);
      }
    });

    it("K3: the tile source is the portfolio pieces passed in, not some other media list — a piece this component was never given never appears", () => {
      const markup = render([piece("only-this-one")]);

      expect(markup).toContain('data-portfolio-piece="only-this-one"');
      expect(markup).not.toContain('data-portfolio-piece="a"');
    });
  });

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
