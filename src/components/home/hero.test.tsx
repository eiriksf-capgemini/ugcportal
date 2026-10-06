import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GalleryItem } from "@/lib/gallery-items";
import { PORTFOLIO_PATH, UPLOAD_PATH } from "@/lib/routes";

import { Hero } from "./hero";

/**
 * ugcportal-qqnt.4 K2: the hero's one call to action tracks the CURRENT
 * visitor's session state, nothing else — signed out, straight to the
 * portfolio (PORTFOLIO_PATH); signed in, straight to /upload. There is no
 * sign-in link in the hero any more (that control lives in the header only,
 * ugcportal-qqnt.3), so unlike the version this replaces there is no third
 * href to distinguish.
 *
 * `Hero` is a plain, synchronous component taking `signedIn` and
 * `portfolioPieces` as props (see HeroProps's own comment for why), so this
 * is a trivial, un-mocked render — no `vi.mock("@/lib/auth", ...)` or Prisma
 * needed at all, unlike src/components/upload-nav-link.test.tsx and
 * src/components/auth-status.test.tsx, which test components that resolve
 * the session themselves, or src/app/page.test.tsx, which drives the real
 * `listPortfolioPieces()` read against a seeded database. `portfolioPieces`
 * defaults to `[]` here (every three-fallback-tile case, K1's own "zero
 * pieces" shape) so the many pre-existing calls below that only care about
 * the CTA/copy do not all have to spell it out.
 */
function render(signedIn: boolean, portfolioPieces: GalleryItem[] = []): string {
  return renderToStaticMarkup(<Hero signedIn={signedIn} portfolioPieces={portfolioPieces} />);
}

/** Every `href="..."` value in a markup string, in order of appearance. */
function hrefsOf(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

/**
 * A minimal, valid `GalleryItem` fixture (the same shape
 * src/components/portfolio/portfolio-tile.test.tsx's own `piece()` builds,
 * independently, for the same reason: `GalleryItem` carries several fields
 * this component never reads — `caption`, `tags`, `advertisingLabel` — and a
 * test fixture should still be a complete, valid value of the type rather
 * than a partial object that happens to have the fields this file touches).
 */
function piece(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: "piece-1",
    previewSrc: "/api/media/preview/pv-1",
    kind: "IMAGE",
    publishedAt: "2026-03-04T10:00:00.000Z",
    altText: "A flat-lay of a book, a coffee cup and a reading lamp",
    caption: "",
    tags: [],
    advertisingLabel: null,
    commercialLinks: [],
    ...overrides,
  };
}

/** Every `<img ...>` tag in a markup string, as whole-tag strings. */
function imgTags(markup: string): string[] {
  return markup.match(/<img\b[^>]*\/?>/g) ?? [];
}

/** One named attribute's value off a single `<img ...>` (or any) tag string. */
function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

/** How many of the neutral fallback tiles (K1) a markup string carries. */
function fallbackTileCount(markup: string): number {
  return (markup.match(/data-home-hero-visual-fallback/g) ?? []).length;
}

describe("Hero (ugcportal-qqnt.4)", () => {
  it("K2: signed out, the only link in the hero points to the portfolio", () => {
    const markup = render(false);

    expect(hrefsOf(markup)).toEqual([PORTFOLIO_PATH]);
    expect(markup).toContain("See the portfolio");
    expect(markup).not.toContain(`href="${UPLOAD_PATH}"`);
    expect(markup).not.toMatch(/sign in/i);
  });

  it("K2: signed in, the only link in the hero points to /upload", () => {
    const markup = render(true);

    expect(hrefsOf(markup)).toEqual([UPLOAD_PATH]);
    expect(markup).toContain("Upload");
    expect(markup).not.toContain(`href="${PORTFOLIO_PATH}"`);
    expect(markup).not.toMatch(/sign in/i);
  });

  it("renders a title and a lead paragraph", () => {
    const markup = render(false);

    expect(markup).toContain("Real photos of the things you actually use.");
    expect(markup).toMatch(/<p[^>]*>[^<]*growing gallery/);
  });

  /*
   * K2: "at most 25 words" and "no em-dash" — checked against the lead
   * paragraph's own visible text, stripped of markup, not the whole page
   * (which also carries the title and the CTA label).
   */
  function leadText(markup: string): string {
    const match = /<p[^>]*>([^<]*)<\/p>/.exec(markup);
    if (!match) throw new Error(`no <p> lead paragraph found in: ${markup}`);
    return match[1].replace(/\s+/g, " ").trim();
  }

  it("K2: the lead has at most 25 words and contains no em-dash, for both session states", () => {
    for (const signedIn of [false, true]) {
      const lead = leadText(render(signedIn));
      const wordCount = lead.split(" ").filter(Boolean).length;
      expect(wordCount, `lead ("${lead}") has ${wordCount} words`).toBeLessThanOrEqual(25);
      expect(lead).not.toContain("—");
      expect(lead).not.toContain("--");
    }
  });

  /*
   * K4: still no STOCK photo or third-party asset in the hero —
   * ugcportal-qqnt.4 K1 below DOES now render real `<img>`s, but every one
   * is a genuine, already-published portfolio piece served from this app's
   * own origin, never an external URL. Checks both an `<img src>` AND any
   * `url(...)` reference inside a `style` attribute or class name that
   * points outside this app's own origin — a background image set via
   * inline style would not show up as an `<img>` at all.
   */
  it("K4: every <img> src is same-origin, and no url() reference points outside the app's own origin", () => {
    const markup = render(false, [
      piece({ id: "a", previewSrc: "/api/media/preview/a" }),
      piece({ id: "b", previewSrc: "/api/media/preview/b" }),
      piece({ id: "c", previewSrc: "/api/media/preview/c" }),
    ]);

    for (const tag of imgTags(markup)) {
      expect(attr(tag, "src"), tag).toMatch(/^\/(?!\/)/);
    }

    const urls = [...markup.matchAll(/url\(([^)]+)\)/g)].map((match) =>
      match[1].replace(/^['"]|['"]$/g, ""),
    );
    for (const url of urls) {
      expect(
        /^(data:|#|\/(?!\/))/.test(url) || url.startsWith("var("),
        `unexpected external-looking url(): ${url}`,
      ).toBe(true);
    }
  });

  it("K4: zero portfolio pieces renders no <img> at all, only the neutral fallback tiles", () => {
    const markup = render(false, []);

    expect(markup).not.toMatch(/<img\b/i);
  });

  /*
   * ugcportal-qqnt.4 K1: the hero's photographic visual — up to three
   * overlapping real preview images, falling back to a neutral petrol tile
   * for whichever slot(s) have no curated preview, and the old
   * `data-home-hero-decoration` marker gone for good.
   */
  describe("K1: the hero's photographic visual", () => {
    const threePieces = [
      piece({
        id: "a",
        previewSrc: "/api/media/preview/a",
        altText: "A kitchen counter with coffee gear",
      }),
      piece({
        id: "b",
        previewSrc: "/api/media/preview/b",
        altText: "A stack of paperback novels",
      }),
      piece({
        id: "c",
        previewSrc: "/api/media/preview/c",
        altText: "A pair of wine glasses on a shelf",
      }),
    ];

    it("three pieces: three <img> elements with non-empty alt text, no fallback tile, and no decoration marker", () => {
      const markup = render(false, threePieces);
      const imgs = imgTags(markup);

      expect(imgs).toHaveLength(3);
      imgs.forEach((tag, index) => {
        expect(attr(tag, "alt"), tag).toBe(threePieces[index].altText);
        expect(attr(tag, "alt")).not.toBe("");
        expect(attr(tag, "src")).toBe(threePieces[index].previewSrc);
      });
      expect(fallbackTileCount(markup)).toBe(0);
      expect(markup).not.toContain("data-home-hero-decoration");
      expect(markup).toContain("data-home-hero-visual");
    });

    it("one piece: one <img> plus two fallback tiles", () => {
      const markup = render(false, [threePieces[0]]);
      const imgs = imgTags(markup);

      expect(imgs).toHaveLength(1);
      expect(attr(imgs[0], "alt")).toBe(threePieces[0].altText);
      expect(fallbackTileCount(markup)).toBe(2);
      expect(markup).not.toContain("data-home-hero-decoration");
    });

    it("zero pieces: three fallback tiles, no <img>, and still no decoration marker", () => {
      const markup = render(false, []);

      expect(imgTags(markup)).toHaveLength(0);
      expect(fallbackTileCount(markup)).toBe(3);
      expect(markup).not.toContain("data-home-hero-decoration");
      expect(markup).toContain("data-home-hero-visual");
    });

    it("more than three curated pieces: only the first three render", () => {
      const markup = render(false, [
        ...threePieces,
        piece({ id: "d", previewSrc: "/api/media/preview/d", altText: "A fourth photo" }),
      ]);

      expect(imgTags(markup)).toHaveLength(3);
      expect(markup).not.toContain("/api/media/preview/d");
    });

    /*
     * K3's "a hero image loads without width and height (layout shift)"
     * guard: every rendered <img> — not only the fallback-free three-piece
     * case — carries non-empty, numeric width/height HTML attributes.
     */
    it("every <img> carries non-empty, numeric width and height attributes", () => {
      for (const pieces of [threePieces, [threePieces[0]]]) {
        const markup = render(false, pieces);
        for (const tag of imgTags(markup)) {
          const width = attr(tag, "width");
          const height = attr(tag, "height");
          expect(width, tag).toBeTruthy();
          expect(height, tag).toBeTruthy();
          expect(Number.isNaN(Number(width)), tag).toBe(false);
          expect(Number.isNaN(Number(height)), tag).toBe(false);
        }
      }
    });

    /*
     * `galleryItemAlt`'s own fallback (src/lib/gallery-items.ts): an empty
     * `altText` never reaches the rendered `<img alt>` as an empty string —
     * this component relies on that contract rather than re-implementing
     * its own "what if there is no description" branch.
     */
    it("an empty altText still renders a non-empty <img alt>, via galleryItemAlt's own placeholder", () => {
      const markup = render(false, [piece({ altText: "" })]);
      const imgs = imgTags(markup);

      expect(imgs).toHaveLength(1);
      expect(attr(imgs[0], "alt")).toBeTruthy();
    });

    /*
     * FIXTURE MUTATION CHECKS (performed by hand while writing this
     * describe block, not left in the suite): (1) temporarily hardcoded
     * `HeroVisual`'s fallback count to always be `0`, confirmed the "one
     * piece: ... plus two fallback tiles" test above failed on the wrong
     * count, then reverted; (2) temporarily made the `shown` slice keep all
     * four pieces instead of the first three, confirmed the "more than
     * three" test above failed, then reverted; (3) temporarily hardcoded
     * `width`/`height` to `undefined`, confirmed the width/height test
     * above failed on `toBeTruthy()`, then reverted. See the PR description
     * for the full list of these checks across this bead.
     */
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
   * left in the suite): temporarily changed `signedIn` to always route to
   * UPLOAD_PATH regardless of the prop, confirmed the "signed out" test
   * above failed with the real assertion message, then reverted. See the PR
   * description for the full list of these checks across this bead.
   */

  /*
   * ugcportal-oavb: the forced-colors focus-outline fix moved from a scoped
   * `FORCED_COLORS_FOCUS_OUTLINE` override on this component to
   * `buttonVariants`' own shared base (src/components/ui/button.tsx), so
   * there is no longer anything CTA-specific to assert here — the base-level
   * guard (src/components/ui/button.test.ts's "no bare outline-none without
   * a forced-colors-visible outline") and the real e2e coverage
   * (e2e/front-page.spec.ts's "forced colors: focus stays visible..." suite)
   * are what actually prove this now, for every button-like control,
   * including this one. A per-component unit test duplicating that same
   * base-level fact would just be testing `buttonVariants` a second time
   * through an extra layer, not this component.
   */
});
