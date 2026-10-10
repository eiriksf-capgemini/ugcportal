import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GalleryItem } from "@/lib/gallery-items";
import { PORTFOLIO_PATH, UPLOAD_PATH } from "@/lib/routes";

import { Hero, HERO_VISUAL_CONTAINER_SM_PX } from "./hero";

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
 * defaults to `[]` here (ugcportal-a3hj K2's "fewer than three" shape, which
 * now renders no collage at all) so the many pre-existing calls below that
 * only care about the CTA/copy do not all have to spell it out.
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
   * own origin, never an external URL.
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

  /**
   * ugcportal-a3hj K2: "Given fewer than three published portfolio pieces,
   * when the hero renders, no placeholder block is shown" — covered here for
   * all three sub-three counts, against the component's own marker rather
   * than against any particular fallback shape, since there is no longer a
   * fallback shape to look for at all: the whole collage is absent.
   *
   * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
   * left in the suite): temporarily changed `HeroVisual`'s guard from
   * `pieces.length < HERO_VISUAL_TILE_POSITION_CLASS.length` to `false`
   * (never hide), confirmed every case below failed (a `data-home-hero-visual`
   * element appeared for 0/1/2 pieces), then reverted. See the PR description
   * for the full list of these checks across this bead.
   */
  describe("K2: fewer than three portfolio pieces hides the collage entirely", () => {
    const cases: Array<[string, GalleryItem[]]> = [
      ["zero pieces", []],
      ["one piece", [piece({ id: "a" })]],
      ["two pieces", [piece({ id: "a" }), piece({ id: "b" })]],
    ];

    for (const [label, pieces] of cases) {
      it(`${label}: no collage element, no <img>, at all`, () => {
        const markup = render(false, pieces);

        expect(markup).not.toContain("data-home-hero-visual");
        expect(imgTags(markup)).toHaveLength(0);
      });
    }
  });

  /*
   * ugcportal-qqnt.4 K1, re-scoped by ugcportal-a3hj K1/K2/K3: the hero's
   * photographic visual — exactly three overlapping real preview images once
   * there are at least three curated pieces, decorative throughout, and the
   * old `data-home-hero-decoration` marker gone for good.
   */
  describe("K1/K3: the hero's photographic visual, once there are enough pieces", () => {
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

    it("three pieces: three <img> elements, every alt empty, no decoration marker", () => {
      const markup = render(false, threePieces);
      const imgs = imgTags(markup);

      expect(imgs).toHaveLength(3);
      imgs.forEach((tag) => {
        expect(attr(tag, "alt"), tag).toBe("");
        expect(attr(tag, "src")).toBeTruthy();
      });
      expect(markup).not.toContain("data-home-hero-decoration");
      expect(markup).toContain("data-home-hero-visual");
    });

    /*
     * K3: the collage container is `aria-hidden`, because these three
     * photographs already appear (with real alt text) in the gallery this
     * hero sits above.
     *
     * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
     * left in the suite): temporarily dropped `aria-hidden="true"` from the
     * container's className/attribute list, confirmed this assertion failed,
     * then reverted.
     */
    it("K3: the collage container carries aria-hidden=\"true\"", () => {
      const markup = render(false, threePieces);

      expect(markup).toMatch(/data-home-hero-visual[^>]*aria-hidden="true"/);
    });

    /*
     * K3: every `altText` on the fixture is non-empty, so an empty rendered
     * `alt` here is this component's own deliberate choice, not an accident
     * of an empty fixture.
     *
     * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
     * left in the suite): temporarily rendered a real `galleryItemAlt(piece,
     * index)` value into `alt` instead of the literal `""`, confirmed this
     * assertion failed (every `<img alt>` became non-empty), then reverted.
     */
    it("K3: alt stays empty even though every fixture altText is non-empty", () => {
      const markup = render(false, threePieces);

      for (const piece_ of threePieces) {
        expect(piece_.altText, "fixture sanity").toBeTruthy();
      }
      for (const tag of imgTags(markup)) {
        expect(attr(tag, "alt")).toBe("");
      }
    });

    it("more than three curated pieces: only the first three render", () => {
      const markup = render(false, [
        ...threePieces,
        piece({ id: "d", previewSrc: "/api/media/preview/d" }),
      ]);

      expect(imgTags(markup)).toHaveLength(3);
      expect(markup).not.toContain("/api/media/preview/d");
    });

    /*
     * K3's "a hero image loads without width and height (layout shift)"
     * guard: every rendered <img> carries non-empty, numeric width/height
     * HTML attributes.
     *
     * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
     * left in the suite): temporarily hardcoded `width`/`height` to
     * `undefined`, confirmed this assertion failed on `toBeTruthy()`, then
     * reverted.
     */
    it("every <img> carries non-empty, numeric width and height attributes", () => {
      const markup = render(false, threePieces);
      for (const tag of imgTags(markup)) {
        const width = attr(tag, "width");
        const height = attr(tag, "height");
        expect(width, tag).toBeTruthy();
        expect(height, tag).toBeTruthy();
        expect(Number.isNaN(Number(width)), tag).toBe(false);
        expect(Number.isNaN(Number(height)), tag).toBe(false);
      }
    });

    /**
     * ugcportal-a3hj K1: the collage's box matches the mockup's 240px
     * (docs/design/forside.html's `.hero-art`) at `sm` and above — asserted
     * against the component's own exported constant, not a second, hand-typed
     * `240` here, so the two cannot silently drift apart. The real, rendered
     * pixel size (not just the class string) is checked separately by
     * e2e/seeded/front-page-hero-portfolio.spec.ts, which runs the actual
     * stylesheet in a browser; Tailwind classes are inert strings under this
     * file's own `renderToStaticMarkup`, so this test can only prove the
     * right class is present, not that it computes to 240px — the e2e check
     * is what closes that gap.
     *
     * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
     * left in the suite): temporarily changed the container's sm: class to
     * `sm:h-[241px] sm:w-[241px]` (one pixel off the exported constant),
     * confirmed this assertion failed, then reverted.
     */
    it("K1: the container's sm-and-above size matches HERO_VISUAL_CONTAINER_SM_PX", () => {
      const markup = render(false, threePieces);

      expect(HERO_VISUAL_CONTAINER_SM_PX).toBe(240);
      expect(markup).toContain(`sm:h-[${HERO_VISUAL_CONTAINER_SM_PX}px]`);
      expect(markup).toContain(`sm:w-[${HERO_VISUAL_CONTAINER_SM_PX}px]`);
    });
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
   * left in the suite): temporarily changed `signedIn` to always route to
   * UPLOAD_PATH regardless of the prop, confirmed the "signed out" test
   * above failed with the real assertion message, then reverted.
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
