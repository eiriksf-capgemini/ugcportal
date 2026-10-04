// @vitest-environment jsdom
import type PhotoSwipeLightbox from "photoswipe/lightbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  LIGHTBOX_MEDIA_CAPTION_CLASS,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { waitUntil } from "@/components/gallery/gallery.test-support";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * The photograph's description and caption in the viewer, and the dialog's
 * aria-labelledby/aria-describedby wiring (ugcportal-gwr).
 *
 * Driven through a REAL open of the real library, the same reason
 * lightbox.caption.test.ts is: both the caption text and the dialog's ARIA
 * attributes are set from PhotoSwipe's own lifecycle events
 * (`uiRegister`/`afterInit`/`change`), so asserting against an options object
 * would prove a listener was attached, not that anything ever reaches the
 * DOM.
 *
 * THE FOURTH jsdom FILE IN THE SUITE — see lightbox.caption.test.ts for why
 * the count matters: on the wrong jsdom version every file carrying the
 * `@vitest-environment jsdom` pragma silently stops being collected, with no
 * failure reported. jsdom is pinned at ^26 for that reason; do not raise it.
 */

beforeAll(() => {
  // Copied from lightbox.test.ts / lightbox.caption.test.ts: jsdom ships no
  // matchMedia, and PhotoSwipe reads one in its constructor.
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

const SIZES: PixelSize[] = [
  { width: 800, height: 1200 },
  { width: 1600, height: 900 },
];

function openInstance(): unknown {
  return (window as unknown as { pswp?: unknown }).pswp;
}

function dialogElement(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function mediaCaption(): HTMLElement | null {
  return document.querySelector(`.${LIGHTBOX_MEDIA_CAPTION_CLASS}`);
}

/** The element the dialog's aria-labelledby points at, or null. */
function labelElement(): HTMLElement | null {
  const id = dialogElement()?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id) : null;
}

/** The element the dialog's aria-describedby points at, or null. */
function describedByElement(): HTMLElement | null {
  const id = dialogElement()?.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
}

async function open(
  items: ReturnType<typeof toGalleryItems>,
  index = 0,
): Promise<PhotoSwipeLightbox> {
  const lightbox = await openGalleryViewer(
    items,
    items.map(() => SIZES[0]),
    index,
  );
  if (lightbox === null) throw new Error("the viewer stood down unexpectedly");
  return lightbox;
}

async function close(lightbox: PhotoSwipeLightbox): Promise<void> {
  lightbox.pswp?.close();
  await waitUntil(() => openInstance() === undefined, "close with the viewer");
}

afterEach(async () => {
  const stale = openInstance() as { destroy?: () => void } | undefined;
  if (stale !== undefined) {
    stale.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  delete (window as unknown as { pswp?: unknown }).pswp;
});

describe("the dialog's accessible name and description (ugcportal-gwr)", () => {
  const ITEMS = toGalleryItems([
    {
      id: "one",
      previewId: "pv-one",
      publishedAt: "2026-03-01T00:00:00.000Z",
      altText: "A fox crossing a snowy field at dawn",
      caption: "Shot on a walk before sunrise.",
    },
    {
      id: "two",
      previewId: "pv-two",
      publishedAt: "2026-03-02T00:00:00.000Z",
      altText: "A heron standing in shallow water",
      // No caption.
    },
  ]);

  it("points aria-labelledby at an element carrying the open slide's alt text", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      expect(labelElement()?.textContent).toBe(
        "A fox crossing a snowy field at dawn",
      );
    } finally {
      await close(lightbox);
    }
  });

  it("points aria-describedby at the visible caption element", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      const described = describedByElement();
      expect(described).not.toBeNull();
      expect(described).toBe(mediaCaption());
      expect(described?.textContent).toBe("Shot on a walk before sunrise.");
    } finally {
      await close(lightbox);
    }
  });

  it("marks the dialog as modal", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      expect(dialogElement()?.getAttribute("aria-modal")).toBe("true");
    } finally {
      await close(lightbox);
    }
  });

  it("hides the caption element on an uncaptioned slide instead of leaving an empty bar", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      lightbox.pswp?.goTo(1);
      await waitUntil(
        () => mediaCaption()?.hidden === true,
        "hide on an uncaptioned slide",
      );
      expect(mediaCaption()?.textContent).toBe("");
      // The label keeps following the slide regardless.
      await waitUntil(
        () => labelElement()?.textContent === "A heron standing in shallow water",
        "update the label for the new slide",
      );
    } finally {
      await close(lightbox);
    }
  });

  it("updates both ids' targets' text when the visitor moves to another slide, without re-wiring the ids", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      const labelId = dialogElement()?.getAttribute("aria-labelledby");
      const describedId = dialogElement()?.getAttribute("aria-describedby");

      lightbox.pswp?.goTo(1);
      await waitUntil(
        () => labelElement()?.textContent === "A heron standing in shallow water",
        "update the label",
      );

      // Same ids throughout — only the targets' content changed.
      expect(dialogElement()?.getAttribute("aria-labelledby")).toBe(labelId);
      expect(dialogElement()?.getAttribute("aria-describedby")).toBe(
        describedId,
      );
    } finally {
      await close(lightbox);
    }
  });

  it("is removed with the viewer", async () => {
    const lightbox = await open(ITEMS, 0);
    expect(mediaCaption()).not.toBeNull();

    await close(lightbox);

    expect(mediaCaption()).toBeNull();
  });
});

describe("the media caption renders hostile text as inert (K2 XSS)", () => {
  it("puts a <script> caption in as TEXT, so it never executes", async () => {
    const hostile = toGalleryItems([
      {
        id: "one",
        previewId: "pv-one",
        publishedAt: "2026-03-01T00:00:00.000Z",
        altText: "A fox crossing a snowy field at dawn",
        caption: "<script>window.__xss_fired = true</script>",
      },
    ]);

    const lightbox = await open(hostile, 0);
    try {
      const element = mediaCaption();
      // The characters are all there as text...
      expect(element?.textContent).toBe(
        "<script>window.__xss_fired = true</script>",
      );
      // ...and no <script> element was created out of them. This node is
      // built by hand, outside React, so `textContent` being the only
      // assignment this module makes is the whole guarantee — an
      // `innerHTML` version of this code fails exactly here.
      expect(element?.querySelector("script")).toBeNull();
      expect(element?.children.length).toBe(0);
      expect(
        (window as unknown as { __xss_fired?: boolean }).__xss_fired,
      ).toBeUndefined();
    } finally {
      await close(lightbox);
    }
  });

  it("falls back to the non-empty placeholder for the label when alt text is missing (K2 safety net)", async () => {
    const blank = toGalleryItems([
      { id: "one", previewId: "pv-one", publishedAt: "2026-03-01T00:00:00.000Z" },
    ]);

    const lightbox = await open(blank, 0);
    try {
      expect(labelElement()?.textContent).not.toBe("");
      expect(labelElement()?.textContent).toContain("Photograph 1");
    } finally {
      await close(lightbox);
    }
  });
});
