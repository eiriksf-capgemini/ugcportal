// @vitest-environment jsdom
import type PhotoSwipeLightbox from "photoswipe/lightbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  LIGHTBOX_ADVERTISING_LABEL_CLASS,
  LIGHTBOX_MEDIA_CAPTION_CLASS,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { waitUntil } from "@/components/gallery/gallery.test-support";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * The advertising-disclosure label in the viewer (ugcportal-e0jv K1/K3/K4,
 * part B of ugcportal-qnq9.1).
 *
 * Driven through a REAL open of the real library, the same reason
 * lightbox.caption.test.ts and lightbox.media-caption.test.ts are: the
 * label's text is set from PhotoSwipe's own lifecycle events
 * (`uiRegister`/`change`), so asserting against an options object would
 * prove a listener was attached, not that anything ever reaches the DOM.
 */

beforeAll(() => {
  // Copied from lightbox.test.ts / lightbox.media-caption.test.ts: jsdom
  // ships no matchMedia, and PhotoSwipe reads one in its constructor.
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

function advertisingLabel(): HTMLElement | null {
  return document.querySelector(`.${LIGHTBOX_ADVERTISING_LABEL_CLASS}`);
}

function mediaCaption(): HTMLElement | null {
  return document.querySelector(`.${LIGHTBOX_MEDIA_CAPTION_CLASS}`);
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

describe("the advertising-disclosure label (K1)", () => {
  const ITEMS = toGalleryItems([
    {
      id: "labelled",
      previewId: "pv-labelled",
      publishedAt: "2026-03-01T00:00:00.000Z",
      altText: "A camera on a wooden desk",
      caption: "Our new everyday carry.",
      advertisingDisclosure: { label: "Advertisement / Reklame" },
    },
    {
      id: "unlabelled",
      previewId: "pv-unlabelled",
      publishedAt: "2026-03-02T00:00:00.000Z",
      altText: "A heron standing in shallow water",
      caption: "Spotted on a morning walk.",
      // No disclosure at all — the ordinary case.
    },
  ]);

  it("shows the exact canonical label for a labelled slide", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      expect(advertisingLabel()?.textContent).toBe("Advertisement / Reklame");
    } finally {
      await close(lightbox);
    }
  });

  it("K3/K4: hides the label element entirely for an unlabelled slide, rather than leaving it empty", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      lightbox.pswp?.goTo(1);
      await waitUntil(
        () => advertisingLabel()?.hidden === true,
        "hide the label on an unlabelled slide",
      );
      expect(advertisingLabel()?.textContent).toBe("");
    } finally {
      await close(lightbox);
    }
  });

  it("updates the label when the visitor moves to another slide", async () => {
    const lightbox = await open(ITEMS, 1);
    try {
      expect(advertisingLabel()?.hidden).toBe(true);

      lightbox.pswp?.goTo(0);
      await waitUntil(
        () => advertisingLabel()?.textContent === "Advertisement / Reklame",
        "show the label for the newly-current slide",
      );
      expect(advertisingLabel()?.hidden).toBe(false);
    } finally {
      await close(lightbox);
    }
  });

  it("is removed with the viewer", async () => {
    const lightbox = await open(ITEMS, 0);
    expect(advertisingLabel()).not.toBeNull();

    await close(lightbox);

    expect(advertisingLabel()).toBeNull();
  });

  it("builds the label from textContent alone, never innerHTML — same guarantee the caption and tag bars carry", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      const element = advertisingLabel();
      expect(element?.children.length).toBe(0);
    } finally {
      await close(lightbox);
    }
  });

  it("never shows a label for an item with no disclosure, even on a fresh open at that slide", async () => {
    const lightbox = await open(ITEMS, 1);
    try {
      expect(advertisingLabel()?.hidden).toBe(true);
      expect(mediaCaption()?.textContent).toBe("Spotted on a morning walk.");
    } finally {
      await close(lightbox);
    }
  });
});
