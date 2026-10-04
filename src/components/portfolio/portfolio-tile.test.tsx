import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PortfolioTile } from "@/components/portfolio/portfolio-tile";
import { SPEC_SAMPLE_LABEL, type PortfolioPiece } from "@/lib/portfolio";

/**
 * K2/K3 (ugcportal-qnq9.7): the spec/concept marker and the advertising
 * label are mutually exclusive, and the right one renders for each case.
 *
 * `@/lib/auth` is mocked for the same reason src/lib/portfolio.test.ts mocks
 * it: `@/lib/portfolio`'s `PortfolioPiece` type (imported here for the test
 * fixture) comes from a module that imports `@/lib/media-access`, which
 * imports `@/lib/auth` at module scope — real next-auth config this node
 * test run has no business loading.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("rendering a portfolio tile must not consult the session");
  },
}));

function piece(overrides: Partial<PortfolioPiece> = {}): PortfolioPiece {
  return {
    id: "piece-1",
    previewSrc: "/api/media/preview/pv-1",
    publishedAt: "2026-03-04T10:00:00.000Z",
    altText: "A flat-lay of a book, a coffee cup and a reading lamp",
    caption: "Flat-lay photo set, 6 images",
    tags: [{ slug: "books", name: "Books" }],
    isSpec: true,
    advertisingLabel: null,
    ...overrides,
  };
}

describe("PortfolioTile", () => {
  it("K2: shows the spec marker for a self-made sample with no brand involved", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece({ isSpec: true, advertisingLabel: null })} position={0} />
      </ul>,
    );
    expect(markup).toContain('data-portfolio-marker="spec"');
    expect(markup).toContain(SPEC_SAMPLE_LABEL);
    expect(markup).not.toContain('data-portfolio-marker="advertisement"');
  });

  it("K3: shows the advertising label instead of the spec marker for a commissioned job", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile
          piece={piece({
            isSpec: false,
            advertisingLabel: "Advertisement / Reklame",
          })}
          position={0}
        />
      </ul>,
    );
    expect(markup).toContain('data-portfolio-marker="advertisement"');
    expect(markup).toContain("Advertisement / Reklame");
    expect(markup).not.toContain('data-portfolio-marker="spec"');
    expect(markup).not.toContain(SPEC_SAMPLE_LABEL);
  });

  it("K3: the advertising label wins even if isSpec is also true (fail-safe direction)", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile
          piece={piece({
            isSpec: true,
            advertisingLabel: "Advertisement / Annonse",
          })}
          position={0}
        />
      </ul>,
    );
    expect(markup).toContain('data-portfolio-marker="advertisement"');
    expect(markup).not.toContain('data-portfolio-marker="spec"');
  });

  it("renders neither marker for a piece that is somehow neither (not a state real data can reach)", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile
          piece={piece({ isSpec: false, advertisingLabel: null })}
          position={0}
        />
      </ul>,
    );
    expect(markup).not.toContain('data-portfolio-marker="advertisement"');
    expect(markup).not.toContain('data-portfolio-marker="spec"');
  });

  it("renders the one-line caption", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece({ caption: "Wine glasses, 8 images" })} position={0} />
      </ul>,
    );
    expect(markup).toContain('data-portfolio-caption="piece-1"');
    expect(markup).toContain("Wine glasses, 8 images");
  });

  it("renders no caption element when the caption is empty", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece({ caption: "" })} position={0} />
      </ul>,
    );
    expect(markup).not.toContain("data-portfolio-caption");
  });

  it("renders the visible subject tags", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile
          piece={piece({ tags: [{ slug: "wine-drink", name: "Wine & drink" }] })}
          position={0}
        />
      </ul>,
    );
    expect(markup).toContain('data-gallery-tag="wine-drink"');
    expect(markup).toContain("Wine &amp; drink");
  });

  it("never renders the portfolio curation tag as a visible subject (defence in depth, besides the lib-level strip)", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile
          piece={piece({ tags: [{ slug: "portfolio", name: "Portfolio" }] })}
          position={0}
        />
      </ul>,
    );
    expect(markup).not.toContain('data-gallery-tag="portfolio"');
  });
});
