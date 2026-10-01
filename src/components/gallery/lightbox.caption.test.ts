// @vitest-environment jsdom
import type PhotoSwipeLightbox from "photoswipe/lightbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  LIGHTBOX_TAG_CAPTION_CLASS,
  galleryTagCaptions,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * The subject tags on the open slide (ugcportal-jsc).
 *
 * Driven through a REAL open of the real library, for the same reason
 * lightbox.test.ts is: the caption is registered on PhotoSwipe's `uiRegister`
 * and updated on its `change`, so asserting on an options object would prove
 * a listener was attached, not that anything ever appears on screen.
 *
 * Its own file rather than a block appended to lightbox.test.ts, which is
 * already nine hundred lines about the viewer's lifetime; this is about one
 * element inside it.
 *
 * ONE OF FOUR jsdom FILES IN THE SUITE — the others being lightbox.test.ts,
 * gallery.unmount.test.tsx and lightbox.media-caption.test.ts, and the count
 * is worth keeping accurate because of how jsdom fails here. On the wrong
 * version (30 needs Node >= 22; CI runs Node 20) every file carrying the
 * pragma above stops being COLLECTED, with no failure reported — the run
 * simply comes back smaller and green. jsdom is pinned at ^26 for that
 * reason; do not raise it.
 *
 * What this does NOT claim: that the caption is legible, positioned where it
 * should be, or out of the way of the arrows. jsdom has no layout engine and
 * applies no stylesheet — the rule that places it is in src/app/globals.css,
 * and checking it is ugcportal-2al's and a human's.
 */

beforeAll(() => {
  /*
   * jsdom ships no `matchMedia` and PhotoSwipe reads one in its constructor,
   * so without a stub the open fails inside a promise and the test still
   * PASSES, reporting only an unhandled rejection. Copied from
   * lightbox.test.ts, along with the consequence: reporting a match puts
   * PhotoSwipe on its reduced-motion path, which makes open and close
   * synchronous instead of waiting on a `transitionend` jsdom never fires.
   */
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

/**
 * Three items with DIFFERENT tags each — two, none, and one.
 *
 * The difference is load-bearing. Identical tag sets would make "each slide
 * gets its own caption" pass whichever slide's caption was shown, which is
 * the bug a positional lookup can actually have.
 */
const TAGGED = toGalleryItems([
  {
    id: "one",
    previewId: "pv-one",
    publishedAt: "2026-03-01T00:00:00.000Z",
    tags: [
      { slug: "books", name: "Books" },
      { slug: "food", name: "Food" },
    ],
  },
  {
    id: "two",
    previewId: "pv-two",
    publishedAt: "2026-03-02T00:00:00.000Z",
    tags: [],
  },
  {
    id: "three",
    previewId: "pv-three",
    publishedAt: "2026-03-03T00:00:00.000Z",
    tags: [{ slug: "wine-drink", name: "Wine & drink" }],
  },
]);

const SIZES: PixelSize[] = [
  { width: 800, height: 1200 },
  { width: 1600, height: 900 },
  { width: 1000, height: 1000 },
];

/** The separator the caption joins names with, as one value both ends read. */
const SEPARATOR = String.fromCodePoint(0x00b7);
const BOTH_TAGS = `Books ${SEPARATOR} Food`;

function openInstance(): unknown {
  return (window as unknown as { pswp?: unknown }).pswp;
}

function caption(): HTMLElement | null {
  return document.querySelector(`.${LIGHTBOX_TAG_CAPTION_CLASS}`);
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the caption to ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function open(
  index: number,
  items = TAGGED,
  sizes = SIZES,
): Promise<PhotoSwipeLightbox> {
  const lightbox = await openGalleryViewer(items, sizes, index);
  // Null means "a newer activation superseded this one", which none of these
  // tests arrange — saying so here beats every assertion below failing on a
  // null separately.
  if (lightbox === null) throw new Error("the viewer stood down unexpectedly");
  return lightbox;
}

async function close(lightbox: PhotoSwipeLightbox): Promise<void> {
  lightbox.pswp?.close();
  await waitUntil(() => openInstance() === undefined, "close with the viewer");
}

afterEach(async () => {
  // A test that left the viewer open would fail the NEXT one by leaving
  // window.pswp set, which is maddening to attribute.
  const stale = openInstance() as { destroy?: () => void } | undefined;
  if (stale !== undefined) {
    stale.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  delete (window as unknown as { pswp?: unknown }).pswp;
});

describe("the tag caption in the viewer", () => {
  it("names the tags of the slide the visitor actually opened", async () => {
    /*
     * INDEX 2, NOT 0, and that is the test rather than an incidental choice.
     * PhotoSwipe fires `change` for every slide AFTER the first, so a caption
     * that only listened to `change` would be right everywhere except on the
     * one photograph that was clicked — and opening at 0 is the single case
     * that cannot tell the two implementations apart.
     */
    const lightbox = await open(2);
    try {
      expect(caption()?.textContent).toBe("Wine & drink");
      expect(caption()?.hidden).toBe(false);
    } finally {
      await close(lightbox);
    }
  });

  it("joins several tags, in the order the feed sent them", async () => {
    const lightbox = await open(0);
    try {
      expect(caption()?.textContent).toBe(BOTH_TAGS);
    } finally {
      await close(lightbox);
    }
  });

  it("follows the visitor to another slide", async () => {
    const lightbox = await open(0);
    try {
      expect(caption()?.textContent).toBe(BOTH_TAGS);
      lightbox.pswp?.goTo(2);
      await waitUntil(
        () => caption()?.textContent === "Wine & drink",
        "show the next slide's tags",
      );
    } finally {
      await close(lightbox);
    }
  });

  it("hides itself on an untagged slide instead of leaving an empty bar", async () => {
    const lightbox = await open(0);
    try {
      lightbox.pswp?.goTo(1);
      await waitUntil(
        () => caption()?.hidden === true,
        "hide on an untagged slide",
      );
      expect(caption()?.textContent).toBe("");
    } finally {
      await close(lightbox);
    }
  });

  it("comes back when the visitor moves on to a tagged slide again", async () => {
    // The other half of hiding, and the one a `hidden = true` that is never
    // cleared would fail: after an untagged slide, the next caption must
    // reappear rather than staying hidden for the rest of the session.
    const lightbox = await open(1);
    try {
      expect(caption()?.hidden).toBe(true);
      lightbox.pswp?.goTo(0);
      await waitUntil(() => caption()?.hidden === false, "reappear");
      expect(caption()?.textContent).toBe(BOTH_TAGS);
    } finally {
      await close(lightbox);
    }
  });

  it("puts a tag name in as TEXT, so markup in it stays inert (K5)", async () => {
    const markupNamed = toGalleryItems([
      {
        id: "one",
        previewId: "pv-one",
        publishedAt: "2026-03-01T00:00:00.000Z",
        tags: [{ slug: "markup-tag", name: "<b>food</b>" }],
      },
    ]);

    const lightbox = await open(0, markupNamed, [SIZES[0]]);
    try {
      const element = caption();
      // The characters are all there...
      expect(element?.textContent).toBe("<b>food</b>");
      // ...and no element was made out of them. This node is built by hand,
      // outside React, so nothing else in the path escapes anything —
      // `textContent` being the only assignment is the whole guarantee, and
      // an `innerHTML` version of this code fails exactly here.
      expect(element?.querySelector("b")).toBeNull();
      expect(element?.children.length).toBe(0);
    } finally {
      await close(lightbox);
    }
  });

  it("is removed with the viewer rather than left on the page", async () => {
    const lightbox = await open(0);
    expect(caption()).not.toBeNull();

    await close(lightbox);

    expect(caption()).toBeNull();
  });
});

describe("galleryTagCaptions", () => {
  it("is positional: captions[n] belongs to items[n]", () => {
    expect(galleryTagCaptions(TAGGED)).toEqual([
      BOTH_TAGS,
      // Empty, not "Untagged": there is nothing truthful to say about a
      // photograph nobody has labelled, and the element hides itself for it.
      "",
      "Wine & drink",
    ]);
  });

  it("has one entry per item, including the untagged ones", () => {
    // Filtering the empties out would silently shift every later caption
    // onto the wrong slide, because the viewer indexes this by position.
    const captions = galleryTagCaptions(TAGGED);
    expect(captions).toHaveLength(TAGGED.length);
    expect(captions[2]).toBe("Wine & drink");
  });
});
