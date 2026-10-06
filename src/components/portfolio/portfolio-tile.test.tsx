import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GALLERY_TILE_BASE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
} from "@/components/gallery/containment";
import { PortfolioTile } from "@/components/portfolio/portfolio-tile";
import { galleryItemAlt, type GalleryItem } from "@/lib/gallery-items";
import { SPEC_SAMPLE_LABEL } from "@/lib/portfolio";
import { PORTFOLIO_PATH } from "@/lib/routes";

/**
 * K2 (ugcportal-qnq9.7): the spec/concept marker renders on a portfolio
 * piece. K3 (an advertising-disclosure label instead, ugcportal-e0jv) is
 * covered by its own describe block below, which also pins the two
 * markers' mutual exclusivity — see SPEC_SAMPLE_LABEL's own comment in
 * src/lib/portfolio.ts for why they never coexist.
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
    // The portfolio page is IMAGE-only for v0.5.0 (src/lib/portfolio.ts's own
    // query filters on it) — see that file's comment for why ugcportal-dzz's
    // VIDEO handling does not reach this surface yet.
    kind: "IMAGE",
    publishedAt: "2026-03-04T10:00:00.000Z",
    altText: "A flat-lay of a book, a coffee cup and a reading lamp",
    caption: "Flat-lay photo set, 6 images",
    tags: [{ slug: "books", name: "Books" }],
    // null by default — no disclosure row, the ordinary case (ugcportal-
    // e0jv). The describe block below passes its own for a labelled piece.
    advertisingLabel: null,
    // Empty by default (ugcportal-qnq9.2.2) — the describe block below
    // passes its own for a piece carrying a commercial link.
    commercialLinks: [],
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

  // Round-5 review: the figure's shape/mat classes come from the SAME
  // GALLERY_TILE_BASE_CLASS constant gallery.tsx's own interactive tile
  // composes (src/components/gallery/containment.ts), not a hand-copied
  // string — this is the one place that would catch the two drifting
  // apart again.
  it("reuses GALLERY_TILE_BASE_CLASS for the figure's shape and mat", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <PortfolioTile piece={piece()} position={0} />
      </ul>,
    );
    expect(markup).toContain(`<figure class="${GALLERY_TILE_BASE_CLASS}">`);
  });

  describe("the optional `href` (ugcportal-qqnt.5): the empty state's linked row", () => {
    it("with no href, renders a plain <figure>, unchanged from before this bead", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} />
        </ul>,
      );
      expect(markup).toContain(`<figure class="${GALLERY_TILE_BASE_CLASS}">`);
      expect(markup).not.toContain("<a ");
    });

    it("with an href, wraps the image in a link to it instead of a <figure>", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} href={PORTFOLIO_PATH} />
        </ul>,
      );
      expect(markup).not.toContain("<figure");
      expect(markup).toContain(`href="${PORTFOLIO_PATH}"`);
    });

    it("gives the link the photo's own accessible name, and hides the image from assistive tech, so the two never both announce it", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} href={PORTFOLIO_PATH} />
        </ul>,
      );
      const expectedName = galleryItemAlt(piece(), 0);
      expect(markup).toContain(`aria-label="${expectedName}"`);
      expect(markup).toMatch(/<img[^>]*alt=""/);
      expect(markup).toMatch(/<img[^>]*aria-hidden="true"/);
    });

    it("reuses GALLERY_TILE_IMAGE_CLASS (the hover-scale, prefers-reduced-motion-guarded class) only when linked", () => {
      const linked = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} href={PORTFOLIO_PATH} />
        </ul>,
      );
      const unlinked = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} />
        </ul>,
      );
      expect(linked).toContain(GALLERY_TILE_IMAGE_CLASS);
      expect(unlinked).not.toContain("motion-reduce:scale-none");
    });

    /*
     * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
     * temporarily removed the `href ? ... : ...` branch's `<Link>` arm,
     * rendering the plain `<figure>` unconditionally; confirmed the
     * "wraps the image in a link" test above failed (no `<a>` in the
     * markup), then restored it.
     */
  });

  describe("the advertising-disclosure label (K3, ugcportal-e0jv)", () => {
    it("renders the exact canonical label, FIRST, for a labelled piece", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile
            piece={piece({ advertisingLabel: "Advertisement / Reklame" })}
            position={0}
          />
        </ul>,
      );
      expect(markup).toContain('data-gallery-advertising-label="piece-1"');
      expect(markup).toContain("Advertisement / Reklame");
      expect(markup.indexOf("data-gallery-advertising-label")).toBeLessThan(
        markup.indexOf("<figure"),
      );
    });

    it("never shows the spec marker alongside the advertising label — the two are opposite claims", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile
            piece={piece({ advertisingLabel: "Reklame" })}
            position={0}
          />
        </ul>,
      );
      expect(markup).not.toContain('data-portfolio-marker="spec"');
      expect(markup).not.toContain(SPEC_SAMPLE_LABEL);
    });

    it("shows the spec marker, not the advertising label, for an ordinary unlabelled piece", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} />
        </ul>,
      );
      expect(markup).toContain('data-portfolio-marker="spec"');
      expect(markup).not.toContain("data-gallery-advertising-label");
    });
  });

  describe("the commercial outbound links (ugcportal-qnq9.2.2)", () => {
    it("renders a link, with its marker, on a curated piece that carries one", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile
            piece={piece({
              advertisingLabel: "Advertisement / Reklame",
              commercialLinks: [
                { id: "l1", url: "https://track.adtraction.com/t/t?a=1", text: "Adtraction" },
              ],
            })}
            position={0}
          />
        </ul>,
      );
      expect(markup).toContain('data-commercial-link="l1"');
      expect(markup).toContain('rel="sponsored nofollow noopener noreferrer"');
      expect(markup).toContain("Advertisement link / Annonselenke");
    });

    it("renders nothing for an ordinary piece with no commercial links", () => {
      const markup = renderToStaticMarkup(
        <ul>
          <PortfolioTile piece={piece()} position={0} />
        </ul>,
      );
      expect(markup).not.toContain("data-commercial-link");
    });
  });
});
