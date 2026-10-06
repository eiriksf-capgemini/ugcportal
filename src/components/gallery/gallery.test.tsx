import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Gallery } from "@/components/gallery/gallery";
import {
  GALLERY_GRID_CLASS,
  GALLERY_TILE_ASPECT_CLASS,
  GALLERY_TILE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
  GALLERY_TILE_VIDEO_BADGE_WRAPPER_CLASS,
} from "@/components/gallery/containment";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * The grid's layout contract (ugcportal-71y, K6 and K7).
 *
 * What this file can and cannot prove is worth being exact about, because K6
 * says so itself: "layout correctness only — verifying it in real browser
 * engines is ugcportal-2al". There is no layout engine here. What is checked is
 * the rule the markup asks the browser for — column counts per breakpoint, a
 * fixed tile ratio, a containment mode that scales rather than stretches — and
 * that the rule is the same for every item regardless of the shape of its
 * source image. That is exactly the claim K7 makes, since the previews are
 * aspect-preserving and the grid is the only thing that can make them uniform.
 *
 * Deliberately not asserted here: that a browser produces no horizontal
 * overflow. This checks the property that decides it — every track is a
 * fraction of the container and no tile carries a fixed or minimum width — and
 * leaves the pixels to 2al.
 */

/**
 * Tailwind's default breakpoints, in the order a width resolves through them.
 *
 * Spelled out rather than imported because Tailwind v4 keeps them in CSS, not
 * in a config this test could read. If they are ever customised in
 * globals.css, this list is wrong and the assertions below silently describe a
 * layout that is not shipping — so `resolves every breakpoint this grid uses`
 * checks that every prefix the grid actually writes appears here.
 */
const BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/**
 * The number of grid columns a class list produces at a given viewport width.
 *
 * Min-width media queries cascade, so the winner is the *widest* prefix whose
 * threshold the viewport has reached — not the last one written, and not the
 * first one that matches. Reading it the other way round is the classic way a
 * responsive assertion ends up describing the phone layout at every width.
 */
function columnsAt(className: string, viewportWidth: number): number {
  let winner = { minWidth: -1, columns: 0 };
  for (const token of className.split(/\s+/)) {
    const match = /^(?:([a-z0-9]+):)?grid-cols-(\d+)$/.exec(token);
    if (match === null) continue;
    const [, prefix, count] = match;
    const minWidth = prefix === undefined ? 0 : BREAKPOINTS[prefix];
    if (minWidth === undefined) {
      throw new Error(`unknown breakpoint prefix "${prefix}" in "${token}"`);
    }
    if (viewportWidth >= minWidth && minWidth > winner.minWidth) {
      winner = { minWidth, columns: Number(count) };
    }
  }
  if (winner.columns === 0) {
    throw new Error(`no grid-cols-* applies at ${viewportWidth}px`);
  }
  return winner.columns;
}

/**
 * Three previews of genuinely different shapes.
 *
 * The shapes are only real in the sense that matters to K7: ugcportal-44q
 * resizes with `fit: "inside"`, so a portrait preview really is taller than it
 * is wide, and nothing in the feed reports those dimensions. That is the whole
 * reason uniformity has to come from the grid — and the reason this test
 * asserts the containment rule rather than a measured ratio.
 */
const MIXED_SHAPES = toGalleryItems([
  { id: "portrait", previewId: "pv-portrait", publishedAt: "2026-03-01T00:00:00.000Z" },
  { id: "landscape", previewId: "pv-landscape", publishedAt: "2026-03-02T00:00:00.000Z" },
  { id: "square", previewId: "pv-square", publishedAt: "2026-03-03T00:00:00.000Z" },
]);

function render(
  props: Partial<Parameters<typeof Gallery>[0]> = {},
): string {
  return renderToStaticMarkup(
    <Gallery
      initialItems={MIXED_SHAPES}
      initialCursor={null}
      initialHasMore={false}
      {...props}
    />,
  );
}

/** The opening tag of every tile button. */
function tiles(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*data-gallery-tile="[^"]*"[^>]*>/g)].map(
    (match) => match[0],
  );
}

/** The opening tag of every tile image. */
function images(markup: string): string[] {
  return [...markup.matchAll(/<img[^>]*>/g)].map((match) => match[0]);
}

function classAttribute(tag: string): string {
  return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
}

describe("K6 — the grid reflows across widths", () => {
  it.each([
    { label: "phone", width: 375, columns: 2 },
    { label: "tablet", width: 768, columns: 3 },
    { label: "desktop", width: 1280, columns: 4 },
  ])("shows $columns columns at $label width ($width px)", ({ width, columns }) => {
    expect(columnsAt(GALLERY_GRID_CLASS, width)).toBe(columns);
  });

  it("never drops below one column or repeats a column count", () => {
    const counts = [375, 768, 1280].map((width) =>
      columnsAt(GALLERY_GRID_CLASS, width),
    );
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    // Strictly increasing: a grid that showed the same count at two of the
    // three widths would satisfy "reflows" only by accident of the numbers
    // chosen above.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(counts.length);
  });

  it("resolves every breakpoint the grid actually uses", () => {
    const prefixes = [...GALLERY_GRID_CLASS.matchAll(/([a-z0-9]+):/g)].map(
      (match) => match[1],
    );
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(BREAKPOINTS[prefix], `${prefix} is not a known breakpoint`).toBeDefined();
    }
  });

  it("sizes tracks in fractions, so no tile can push a row past the viewport", () => {
    // `grid-cols-N` compiles to `repeat(N, minmax(0, 1fr))`. What would break
    // that is a tile with its own width floor, so that is what is checked.
    expect(GALLERY_GRID_CLASS).toMatch(/\bgrid\b/);
    for (const tile of tiles(render())) {
      const classes = classAttribute(tile);
      expect(classes).toContain("w-full");
      expect(classes).not.toMatch(/\bmin-w-(?!0\b)/);
      expect(classes).not.toMatch(/\bw-\[/);
    }
  });

  it("defers off-screen tiles instead of requesting a whole page at once", () => {
    // The default page is 50 items and the preview route PROXIES every byte
    // through the Node process (ugcportal-a2l) rather than redirecting to
    // storage, so an eager grid opens up to 50 simultaneous requests against
    // it at first paint — most of them below the fold on a phone. Unlike
    // `srcset`, these two attributes need no new derivatives and so are not
    // ugcportal-dex's to add.
    for (const image of images(render())) {
      expect(image).toContain('loading="lazy"');
      expect(image).toContain('decoding="async"');
    }
  });

  it("gives no image an intrinsic width or height attribute", () => {
    // An `<img>` carrying both attributes and no object-fit is stretched to
    // them — the exact failure K6 names. None are written, and the fit rule
    // below makes it moot either way.
    for (const image of images(render())) {
      expect(image).not.toMatch(/\swidth="/);
      expect(image).not.toMatch(/\sheight="/);
    }
  });
});

describe("K7 — differently shaped previews form one consistent arrangement", () => {
  it("renders a tile for each of the three shapes", () => {
    // Guards every assertion below from passing over an empty list.
    expect(tiles(render())).toHaveLength(3);
    expect(images(render())).toHaveLength(3);
  });

  it("gives every tile the same fixed aspect ratio", () => {
    for (const tile of tiles(render())) {
      const classes = classAttribute(tile).split(/\s+/);
      expect(classes.filter((c) => c === GALLERY_TILE_ASPECT_CLASS)).toHaveLength(1);
      expect(classes).toContain("overflow-hidden");
    }
  });

  it("scales every image to cover its tile rather than stretching it", () => {
    for (const image of images(render())) {
      const classes = classAttribute(image).split(/\s+/);
      expect(classes).toContain("object-cover");
      expect(classes).toContain("h-full");
      expect(classes).toContain("w-full");
      // The two fits that would distort or letterbox instead.
      expect(classes).not.toContain("object-fill");
      expect(classes).not.toContain("object-contain");
    }
  });

  it("renders the identical containment rule for every shape", () => {
    // The containment rule is what makes the arrangement uniform, so it must
    // not vary with the item. If a future change made tile classes depend on
    // the image, this is where it would show up.
    const tileClasses = new Set(tiles(render()).map(classAttribute));
    const imageClasses = new Set(images(render()).map(classAttribute));
    expect(tileClasses.size).toBe(1);
    expect(imageClasses.size).toBe(1);
    expect([...tileClasses][0]).toBe(GALLERY_TILE_CLASS);
    expect([...imageClasses][0]).toBe(GALLERY_TILE_IMAGE_CLASS);
  });
});

describe("ugcportal-dzz — a VIDEO tile gets a play affordance, an IMAGE tile does not", () => {
  const MIXED_KINDS = toGalleryItems([
    { id: "a-photo", previewId: "pv-photo", publishedAt: "2026-03-01T00:00:00.000Z", kind: "IMAGE" },
    { id: "a-video", previewId: "pv-video", publishedAt: "2026-03-02T00:00:00.000Z", kind: "VIDEO" },
  ]);

  it("renders the play badge only on the VIDEO tile's markup", () => {
    const markup = render({ initialItems: MIXED_KINDS });
    const photoTile = tiles(markup).find((tile) => tile.includes('data-gallery-tile="a-photo"'));
    const videoTile = tiles(markup).find((tile) => tile.includes('data-gallery-tile="a-video"'));
    expect(photoTile).toBeDefined();
    expect(videoTile).toBeDefined();

    // tiles() only captures the opening <button> tag, so pull each tile's
    // full markup (button through its matching </button>) to look inside it.
    const photoIndex = markup.indexOf(photoTile as string);
    const videoIndex = markup.indexOf(videoTile as string);
    const photoMarkup = markup.slice(photoIndex, markup.indexOf("</button>", photoIndex));
    const videoMarkup = markup.slice(videoIndex, markup.indexOf("</button>", videoIndex));

    expect(videoMarkup).toContain("svg");
    expect(photoMarkup).not.toContain("svg");
  });

  it("marks the play badge's own wrapper aria-hidden, so the tile announces one accessible name", () => {
    const markup = render({ initialItems: MIXED_KINDS });
    const videoTile = tiles(markup).find((tile) => tile.includes('data-gallery-tile="a-video"')) as string;
    const videoIndex = markup.indexOf(videoTile);
    const videoMarkup = markup.slice(videoIndex, markup.indexOf("</button>", videoIndex));

    // Pinned to the WRAPPER's own opening tag, not merely "two or more
    // aria-hidden="true" somewhere in the tile" — lucide's <svg> carries its
    // own aria-hidden default regardless of this wrapper's, so a looser count
    // check would stay green even if the wrapper span's own attribute were
    // removed (verified: deleting just that attribute still left the <img>'s
    // and the <svg>'s own aria-hidden, so a `>= 2` count never dropped).
    expect(videoMarkup).toContain(
      `<span aria-hidden="true" class="${GALLERY_TILE_VIDEO_BADGE_WRAPPER_CLASS}">`,
    );
    // Nothing inside the button carries its own aria-label — the button's is
    // the only accessible name anything here announces.
    expect(videoMarkup.match(/aria-label="/g)?.length).toBe(1);
  });

  it("names the VIDEO tile's accessible name with 'video', not 'photograph'", () => {
    const markup = render({ initialItems: MIXED_KINDS });
    // "photograph" / "video" is a position-counted placeholder — the photo is
    // first in MIXED_KINDS (position 1), the video second (position 2).
    expect(markup).toContain('aria-label="Open photograph 1, published 1 March 2026"');
    expect(markup).toContain('aria-label="Open video 2, published 2 March 2026"');
  });
});

describe("the states around the grid", () => {
  it("offers a load-more control only when the feed says there is more", () => {
    const withMore = render({ initialCursor: "cursor-1", initialHasMore: true });
    expect(withMore).toContain("Load more");
    expect(withMore).toContain("Showing 3 photographs.");

    const exhausted = render();
    expect(exhausted).not.toContain("Load more");
    expect(exhausted).toContain("Showing all 3 photographs.");
  });

  it("offers no load-more control when hasMore is true but no cursor came with it", () => {
    // The endpoint sets `hasMore: nextCursor !== null`, so the two agree there.
    // A button that could never do anything is the wrong way to render a
    // response where they do not.
    const markup = render({ initialCursor: null, initialHasMore: true });
    expect(markup).not.toContain("Load more");
  });

  /*
   * A gallery with exactly one published photograph is not a corner case: it
   * is what this gallery looks like on its first day, and it announced
   * "Showing all 1 photographs."
   *
   * The three-item fixture the rest of this file uses could never have caught
   * it, so these override it — the same family as the timestamp collision in
   * K4 and the same-day batch in the label tests: a fixture that cannot
   * construct the case the assertion is about.
   */
  const ONE = MIXED_SHAPES.slice(0, 1);
  const TWO = MIXED_SHAPES.slice(0, 2);

  it("counts one photograph in the singular", () => {
    expect(render({ initialItems: ONE })).toContain(
      "Showing the only photograph.",
    );
    expect(render({ initialItems: ONE })).not.toContain("1 photographs");
  });

  it("counts one photograph in the singular mid-list too", () => {
    // The `hasMore` branch has its own sentence and its own chance to be wrong.
    const markup = render({
      initialItems: ONE,
      initialCursor: "cursor-1",
      initialHasMore: true,
    });
    expect(markup).toContain("Showing 1 photograph.");
    expect(markup).not.toContain("1 photographs");
  });

  it("still pluralises everything above one", () => {
    expect(render({ initialItems: TWO })).toContain(
      "Showing all 2 photographs.",
    );
    expect(
      render({ initialItems: TWO, initialCursor: "c", initialHasMore: true }),
    ).toContain("Showing 2 photographs.");
  });

  it("renders the empty state instead of an empty grid", () => {
    const markup = render({ initialItems: [] });
    expect(markup).toContain("Nothing is published yet.");
    expect(tiles(markup)).toHaveLength(0);
  });

  it("does not claim the gallery is empty while a further page is offered", () => {
    // "there is nothing published" and "this page was empty" are different
    // statements. The feed cannot currently produce the second — a cursor is
    // only ever built from an emitted row — but saying the first when a
    // cursor exists would strand the visitor with no way to ask for the rest.
    const markup = render({
      initialItems: [],
      initialCursor: "cursor-1",
      initialHasMore: true,
    });
    expect(markup).not.toContain("Nothing is published yet.");
    expect(markup).toContain("Load more");
  });

  it("announces paging status in a live region", () => {
    expect(render()).toMatch(/<p aria-live="polite"/);
  });

  /*
   * The round-2 finding. `viewerFailed` is cleared only by the next
   * activation, and it used to be the first branch of a single ternary — so
   * one failed open silenced every paging announcement for the rest of the
   * session. The two states now have a live region each, and this asserts they
   * cannot occlude one another.
   */
  it("keeps the viewer error and the paging status in separate live regions", () => {
    const markup = render({ initialCursor: "cursor-1", initialHasMore: true });
    const regions = [...markup.matchAll(/<p aria-live="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(regions).toContain("assertive");
    expect(regions).toContain("polite");
    // Distinct elements, so neither branch can replace the other's text.
    expect(new Set(regions).size).toBe(regions.length);
    // Both present even with nothing wrong: a live region inserted at the
    // same moment as its text is frequently not announced at all.
    expect(markup).toContain("Showing 3 photographs.");
  });

  it("adds no second <main> — the app shell owns the only one", () => {
    expect(render()).not.toContain("<main");
    expect(render({ initialItems: [] })).not.toContain("<main");
  });

  /*
   * app-shell.tsx's skip link moves focus to <main>, and its own comment
   * reasons about landing "past the <h1>" — the shell documents the assumption
   * that a page has one. The gallery shipped without: the empty state kept a
   * heading and the populated state, the one people actually see, had none.
   *
   * <h2>, not <h1> (ugcportal-qqnt.1): `<Gallery>` renders standalone here,
   * without the hero that now supplies the real page-level `<h1>` on every
   * real page it composes with (src/app/page.tsx). Its own heading — "Gallery"
   * with photographs, GalleryEmpty's "Nothing is published yet." when empty —
   * steps down to SECTION_TITLE_CLASS instead.
   */
  it.each([
    { label: "with photographs", props: {} },
    { label: "when empty", props: { initialItems: [] } },
  ])("has exactly one <h2> $label", ({ props }) => {
    const headings = [
      ...render(props).matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g),
    ].map((match) => match[1]);

    expect(headings).toHaveLength(1);
    expect(headings[0].replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
  });

  it("starts its own outline at h2 — the page's h1 is composed above it by the hero", () => {
    // A page whose first heading skips from h1 to h3 is a broken outline;
    // rendered standalone, this component's own first heading is h2, since
    // the h1 it used to render here now lives in the hero composed above it.
    const levels = [...render().matchAll(/<h([1-6])\b/g)].map((match) =>
      Number(match[1]),
    );
    expect(levels[0]).toBe(2);
  });
});

/**
 * ugcportal-3wcd: the genuinely-empty decision now comes from the shared
 * `isGenuinelyEmptyPage` (src/lib/gallery-items.ts) rather than an inline
 * `items.length === 0 && !hasMore` copy — K1 and K2's behaviour table,
 * pinned over the four combinations the two inputs can form. The
 * `items=[]`/`hasMore=false` and `items=[]`/`hasMore=true` rows already
 * existed above ("renders the empty state instead of an empty grid",
 * "does not claim the gallery is empty while a further page is offered");
 * this table adds the two non-empty-items rows so all four are asserted
 * together, in one place, against the one expression.
 */
describe("ugcportal-3wcd — isGenuinelyEmptyPage decides the empty state (K2 behaviour table)", () => {
  const ONE_ITEM = MIXED_SHAPES.slice(0, 1);

  it.each([
    { label: "no items, no further page", items: [], cursor: null, hasMore: false, empty: true },
    { label: "no items, a further page", items: [], cursor: "cursor-1", hasMore: true, empty: false },
    { label: "one item, no further page", items: ONE_ITEM, cursor: null, hasMore: false, empty: false },
    { label: "one item, a further page", items: ONE_ITEM, cursor: "cursor-1", hasMore: true, empty: false },
  ])("renders empty=$empty for $label", ({ items, cursor, hasMore, empty }) => {
    const markup = render({
      initialItems: items,
      initialCursor: cursor,
      initialHasMore: hasMore,
    });
    expect(markup.includes("Nothing is published yet.")).toBe(empty);
  });

  it("calls the shared helper rather than spelling the check out inline", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./gallery.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("items.length === 0 && !hasMore");
    expect(source).toContain("isGenuinelyEmptyPage(items, hasMore)");
  });
});

/**
 * Alt text and captions on gallery tiles (ugcportal-gwr K1/K2).
 *
 * Driven through the real `Gallery` component's SSR markup, not a unit test
 * of `galleryItemAlt` in isolation — K2's "never empty, never the filename"
 * guarantee is a claim about what actually reaches the DOM, and the render
 * layer is a second, independent place that could get it wrong even with
 * `toGalleryItem` and the publish gate both holding.
 */
describe("ugcportal-gwr — alt text and captions", () => {
  it("renders the uploader's real alt text on the tile's <img>, and leaks no filename", () => {
    const items = toGalleryItems([
      {
        id: "a",
        previewId: "pv-a",
        publishedAt: "2026-03-01T00:00:00.000Z",
        altText: "A fox crossing a snowy field at dawn",
        // Not a real field on the public feed — included here only to prove
        // that even if it somehow arrived, nothing downstream would use it.
        originalName: "IMG_4821.HEIC",
      },
    ]);

    const [img] = images(render({ initialItems: items }));

    expect(img).toContain('alt="A fox crossing a snowy field at dawn"');
    expect(img).not.toContain('alt=""');
    expect(render({ initialItems: items })).not.toContain("IMG_4821");
  });

  it("falls back to a non-empty placeholder when alt text is missing (K2 safety net)", () => {
    // Published media is never supposed to reach this without real alt text
    // — the publish gate refuses it — but the render layer keeps its own net
    // independently of that gate holding.
    const items = toGalleryItems([
      { id: "a", previewId: "pv-a", publishedAt: "2026-03-01T00:00:00.000Z" },
    ]);

    const [img] = images(render({ initialItems: items }));

    expect(img).not.toContain('alt=""');
    expect(img).toContain('alt="Photograph 1');
  });

  it("renders the caption as visible text under the tile", () => {
    const items = toGalleryItems([
      {
        id: "a",
        previewId: "pv-a",
        publishedAt: "2026-03-01T00:00:00.000Z",
        altText: "A fox crossing a snowy field",
        caption: "Shot on a walk before sunrise.",
      },
    ]);

    const markup = render({ initialItems: items });

    expect(markup).toContain("Shot on a walk before sunrise.");
    expect(markup).toContain('data-gallery-caption="a"');
  });

  it("renders no caption element at all for an uncaptioned item", () => {
    const items = toGalleryItems([
      {
        id: "a",
        previewId: "pv-a",
        publishedAt: "2026-03-01T00:00:00.000Z",
        altText: "A fox crossing a snowy field",
      },
    ]);

    expect(render({ initialItems: items })).not.toContain(
      "data-gallery-caption",
    );
  });

  it("renders a <script> caption as inert escaped text, never as markup (K2 XSS)", () => {
    const items = toGalleryItems([
      {
        id: "a",
        previewId: "pv-a",
        publishedAt: "2026-03-01T00:00:00.000Z",
        altText: "A fox crossing a snowy field",
        caption: "<script>window.__xss_fired = true</script>",
      },
    ]);

    const markup = render({ initialItems: items });

    expect(markup).not.toContain("<script>window.__xss_fired");
    expect(markup).toContain("&lt;script&gt;window.__xss_fired");
  });
});
