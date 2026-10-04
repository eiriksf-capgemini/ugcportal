import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PortfolioTile } from "@/components/portfolio/portfolio-tile";
import type { GalleryItem } from "@/lib/gallery-items";
import { SPEC_SAMPLE_LABEL } from "@/lib/portfolio";

/**
 * K2 (ugcportal-qnq9.7): the spec/concept marker renders on a portfolio
 * piece. K3 (an advertising-disclosure label instead) is deferred to
 * ugcportal-qnq9.1 (round-1 review) — see SPEC_SAMPLE_LABEL's own comment in
 * src/lib/portfolio.ts for why there is nothing to test here yet.
 *
 * `@/lib/auth` is mocked for the same reason src/lib/portfolio.test.ts mocks
 * it: `PortfolioTile` imports `SPEC_SAMPLE_LABEL` from `@/lib/portfolio`,
 * whose module graph includes `@/lib/media-access` (for
 * `MEDIA_ANONYMOUS_SELECT`), which imports `@/lib/auth` at module scope — a
 * real import even though this file only uses the one named export.
 * `GalleryItemCaption`/`GalleryItemTags` themselves come from
 * src/components/gallery/gallery-item.tsx, a plain module with no such
 * dependency (round-2 review moved them out of gallery.tsx specifically so
 * importing them would not pull in the interactive gallery's own client
 * bundle — see that file's comment).
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("rendering a portfolio tile must not consult the session");
  },
}));

function piece(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: "piece-1",
    previewSrc: "/api/media/preview/pv-1",
    publishedAt: "2026-03-04T10:00:00.000Z",
    altText: "A flat-lay of a book, a coffee cup and a reading lamp",
    caption: "Flat-lay photo set, 6 images",
    tags: [{ slug: "books", name: "Books" }],
    ...overrides,
  };
}

describe("PortfolioTile", () => {
  it("K2: shows the spec marker", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece()} position={0} />
      </ul>,
    );
    expect(markup).toContain('data-portfolio-marker="spec"');
    expect(markup).toContain(SPEC_SAMPLE_LABEL);
  });

  it("renders the one-line caption", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece({ caption: "Wine glasses, 8 images" })} position={0} />
      </ul>,
    );
    expect(markup).toContain('data-gallery-caption="piece-1"');
    expect(markup).toContain("Wine glasses, 8 images");
  });

  it("renders no caption element when the caption is empty", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece({ caption: "" })} position={0} />
      </ul>,
    );
    expect(markup).not.toContain("data-gallery-caption");
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

  it("does not add the gallery's hover-scale utility to its own image (no viewer opens on activation)", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece()} position={0} />
      </ul>,
    );
    expect(markup).not.toContain("group-hover:scale");
  });
});
