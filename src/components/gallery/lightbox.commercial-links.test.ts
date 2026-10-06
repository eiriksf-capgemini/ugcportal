// @vitest-environment jsdom
import type PhotoSwipeLightbox from "photoswipe/lightbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  LIGHTBOX_COMMERCIAL_LINK_CLASS,
  LIGHTBOX_COMMERCIAL_LINK_MARKER_CLASS,
  LIGHTBOX_COMMERCIAL_LINKS_CLASS,
  openGalleryViewer,
  type PixelSize,
} from "@/components/gallery/lightbox";
import { waitUntil } from "@/components/gallery/gallery.test-support";
import { COMMERCIAL_LINK_MARKER_TEXT } from "@/lib/commercial-link-render";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * The commercial outbound links in the viewer (ugcportal-qnq9.2.2 K1/K2).
 *
 * Driven through a REAL open of the real library, same reason
 * lightbox.advertising-label.test.ts and lightbox.caption.test.ts are: this
 * element is rebuilt by hand on PhotoSwipe's own `change` event, so asserting
 * against an options object would prove a listener was attached, not that
 * anything ever reaches the DOM.
 */

beforeAll(() => {
  // Copied from lightbox.test.ts: jsdom ships no matchMedia, and PhotoSwipe
  // reads one in its constructor.
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
  { width: 1200, height: 1200 },
];

function openInstance(): unknown {
  return (window as unknown as { pswp?: unknown }).pswp;
}

function linksContainer(): HTMLElement | null {
  return document.querySelector(`.${LIGHTBOX_COMMERCIAL_LINKS_CLASS}`);
}

function linkAnchors(): HTMLAnchorElement[] {
  return Array.from(
    document.querySelectorAll(`a.${LIGHTBOX_COMMERCIAL_LINK_CLASS}`),
  );
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

const ITEMS = toGalleryItems([
  {
    id: "one-link",
    previewId: "pv-one-link",
    publishedAt: "2026-03-01T00:00:00.000Z",
    altText: "A camera on a wooden desk",
    advertisingDisclosure: { label: "Advertisement / Reklame" },
    commercialLinks: [
      {
        id: "link-1",
        url: "https://track.adtraction.com/t/t?a=1&c=camera",
        network: "ADTRACTION",
        networkOther: null,
      },
    ],
  },
  {
    id: "no-links",
    previewId: "pv-no-links",
    publishedAt: "2026-03-02T00:00:00.000Z",
    altText: "A heron standing in shallow water",
    // No disclosure at all — the ordinary case, and no links either.
  },
  {
    id: "unlabelled-with-row",
    previewId: "pv-unlabelled-with-row",
    publishedAt: "2026-03-03T00:00:00.000Z",
    altText: "A glass of wine on a table, withdrawn benefit",
    // No disclosure (withdrawn), but the raw row still carries a commercial
    // link — the ugcportal-jain shape. `toGalleryItems` must already have
    // emptied `commercialLinks` on this item before it ever reaches the
    // lightbox; this fixture exists to prove the viewer renders what it was
    // handed, not that it re-derives the gate itself.
    commercialLinks: [
      {
        id: "link-stale",
        url: "https://track.example.com/stale",
        network: "AWIN",
        networkOther: null,
      },
    ],
  },
]);

describe("commercial outbound links (ugcportal-qnq9.2.2 K1)", () => {
  it("renders the link followed immediately by the bilingual marker, as siblings", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      await waitUntil(() => linkAnchors().length === 1, "render the one link");
      const container = linksContainer();
      const li = container?.querySelector("li");
      expect(li?.children.length).toBe(2);

      const [anchor, marker] = Array.from(li?.children ?? []);
      expect(anchor.tagName).toBe("A");
      expect(anchor.textContent).toBe("Adtraction");
      expect((anchor as HTMLAnchorElement).href).toBe(
        "https://track.adtraction.com/t/t?a=1&c=camera",
      );

      expect(marker.tagName).toBe("SPAN");
      expect(marker.textContent).toBe(COMMERCIAL_LINK_MARKER_TEXT);
    } finally {
      await close(lightbox);
    }
  });

  it("K2: carries exactly rel=\"sponsored nofollow noopener noreferrer\" and opens in a new tab", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      await waitUntil(() => linkAnchors().length === 1, "render the one link");
      const anchor = linkAnchors()[0];
      expect(anchor.getAttribute("rel")).toBe(
        "sponsored nofollow noopener noreferrer",
      );
      expect(anchor.getAttribute("target")).toBe("_blank");
    } finally {
      await close(lightbox);
    }
  });

  it("hides the container entirely for a slide with no links, rather than leaving it empty", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      lightbox.pswp?.goTo(1);
      await waitUntil(
        () => linksContainer()?.hidden === true,
        "hide the container on a slide with no links",
      );
      expect(linkAnchors().length).toBe(0);
    } finally {
      await close(lightbox);
    }
  });

  it("ugcportal-jain: renders nothing for an item whose raw row still carries a link but whose label is absent", async () => {
    const lightbox = await open(ITEMS, 2);
    try {
      expect(linksContainer()?.hidden).toBe(true);
      expect(linkAnchors().length).toBe(0);
    } finally {
      await close(lightbox);
    }
  });

  it("rebuilds the element tree when moving back to a slide with a link", async () => {
    const lightbox = await open(ITEMS, 1);
    try {
      expect(linksContainer()?.hidden).toBe(true);

      lightbox.pswp?.goTo(0);
      await waitUntil(() => linkAnchors().length === 1, "rebuild the link for slide 0");
      expect(linksContainer()?.hidden).toBe(false);
    } finally {
      await close(lightbox);
    }
  });

  it("builds every link from textContent alone, never innerHTML", async () => {
    const lightbox = await open(ITEMS, 0);
    try {
      await waitUntil(() => linkAnchors().length === 1, "render the one link");
      const anchor = linkAnchors()[0];
      expect(anchor.children.length).toBe(0);
      const marker = document.querySelector(`.${LIGHTBOX_COMMERCIAL_LINK_MARKER_CLASS}`);
      expect(marker?.children.length).toBe(0);
    } finally {
      await close(lightbox);
    }
  });

  it("is removed with the viewer", async () => {
    const lightbox = await open(ITEMS, 0);
    expect(linksContainer()).not.toBeNull();

    await close(lightbox);

    expect(linksContainer()).toBeNull();
  });
});
