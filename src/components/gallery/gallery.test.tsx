import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Gallery } from "@/components/gallery/gallery";
import {
  GALLERY_GRID_CLASS,
  GALLERY_TILE_ASPECT_CLASS,
  GALLERY_TILE_CLASS,
  GALLERY_TILE_IMAGE_CLASS,
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

  it("adds no second <main> — the app shell owns the only one", () => {
    expect(render()).not.toContain("<main");
    expect(render({ initialItems: [] })).not.toContain("<main");
  });
});
