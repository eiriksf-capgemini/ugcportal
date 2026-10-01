import { describe, expect, it } from "vitest";

import {
  appendGalleryItems,
  galleryItemAlt,
  galleryItemLabel,
  toGalleryItem,
  toGalleryItems,
  type GalleryItem,
} from "@/lib/gallery-items";
import { MEDIA_PREVIEW_PATH } from "@/lib/routes";

/**
 * The boundary where a feed row becomes something the gallery can draw
 * (ugcportal-71y).
 *
 * Two of its jobs are security-adjacent and are tested as such: the image URL
 * must come from the opaque `previewId` and nothing else, and a row with no
 * usable preview must not be rendered — K2 and K3 re-checked one layer below
 * the markup, so a future component change cannot reintroduce either.
 */

const ROW = {
  id: "media-1",
  previewId: "pv-1",
  publishedAt: "2026-03-04T10:00:00.000Z",
};

function item(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: "media-1",
    previewSrc: `${MEDIA_PREVIEW_PATH}/pv-1`,
    publishedAt: "2026-03-04T10:00:00.000Z",
    // Empty by default, so every existing fixture here exercises the SAME
    // path it always did — the placeholder fallback in `galleryItemAlt`.
    // Tests that care about real alt text / caption pass their own.
    altText: "",
    caption: "",
    tags: [],
    ...overrides,
  };
}

describe("toGalleryItem", () => {
  it("builds the image source from previewId alone", () => {
    expect(toGalleryItem(ROW)).toEqual({
      id: "media-1",
      previewSrc: `${MEDIA_PREVIEW_PATH}/pv-1`,
      publishedAt: "2026-03-04T10:00:00.000Z",
      altText: "",
      caption: "",
      tags: [],
    });
  });

  it("carries no field the anonymous projection withholds", () => {
    // Even handed a row that somehow arrived with owner-only columns on it,
    // the mapped item must not pick them up. `previewKey` is the one that
    // matters: it embeds the uploader's account id.
    const contaminated = {
      ...ROW,
      previewKey: "previews/user-7/secret.webp",
      key: "media/user-7/original.jpg",
      userId: "user-7",
      originalName: "passport.jpg",
    };

    const mapped = toGalleryItem(contaminated);

    expect(mapped).not.toBeNull();
    expect(Object.keys(mapped as GalleryItem).sort()).toEqual([
      "altText",
      "caption",
      "id",
      "previewSrc",
      "publishedAt",
      "tags",
    ]);
    expect(JSON.stringify(mapped)).not.toContain("user-7");
    expect(JSON.stringify(mapped)).not.toContain("previews/");
  });

  it("escapes a previewId that would otherwise climb out of the route", () => {
    const mapped = toGalleryItem({ ...ROW, previewId: "../../etc/passwd" });
    expect(mapped?.previewSrc).toBe(`${MEDIA_PREVIEW_PATH}/..%2F..%2Fetc%2Fpasswd`);
    expect(mapped?.previewSrc).not.toContain("../");
  });

  it.each([
    { label: "null", previewId: null },
    { label: "undefined", previewId: undefined },
    { label: "empty", previewId: "" },
    { label: "a number", previewId: 42 },
  ])("drops a row whose previewId is $label", ({ previewId }) => {
    expect(toGalleryItem({ ...ROW, previewId })).toBeNull();
  });

  it("drops a row with no usable id", () => {
    expect(toGalleryItem({ ...ROW, id: "" })).toBeNull();
    expect(toGalleryItem({ ...ROW, id: undefined })).toBeNull();
  });

  it("reads a Date and an ISO string to the same instant", () => {
    const fromDate = toGalleryItem({
      ...ROW,
      publishedAt: new Date("2026-03-04T10:00:00.000Z"),
    });
    expect(fromDate?.publishedAt).toBe(toGalleryItem(ROW)?.publishedAt);
  });

  it.each([
    { label: "null", publishedAt: null },
    { label: "an unparseable string", publishedAt: "not a date" },
    { label: "an invalid Date", publishedAt: new Date("nonsense") },
  ])("keeps the item but nulls a publishedAt that is $label", ({ publishedAt }) => {
    const mapped = toGalleryItem({ ...ROW, publishedAt });
    // The date decorates a label; a bad one must not delete a photograph from
    // the gallery.
    expect(mapped?.id).toBe("media-1");
    expect(mapped?.publishedAt).toBeNull();
  });
});

/**
 * Alt text and caption at the read boundary (ugcportal-gwr). The write path
 * (POST /api/media) already refuses anything unsafe or over-length, but this
 * is the second end of the same rule — see `sanitizedMediaText`'s own
 * docstring for why that is worth having rather than redundant.
 */
describe("alt text and caption on a mapped item", () => {
  const RTL_OVERRIDE = String.fromCodePoint(0x202e);

  it("carries the uploader's alt text and caption through unchanged", () => {
    const mapped = toGalleryItem({
      ...ROW,
      altText: "A fox crossing a snowy field at dawn",
      caption: "Shot on a walk before sunrise.",
    });
    expect(mapped?.altText).toBe("A fox crossing a snowy field at dawn");
    expect(mapped?.caption).toBe("Shot on a walk before sunrise.");
  });

  it("is an empty string, never undefined or null, when neither was supplied", () => {
    for (const absent of [undefined, null, "", "   ", 7, {}]) {
      const mapped = toGalleryItem({ ...ROW, altText: absent, caption: absent });
      expect(mapped?.altText).toBe("");
      expect(mapped?.caption).toBe("");
    }
  });

  it("drops alt text or a caption carrying a bidi override, rather than stripping it", () => {
    const mapped = toGalleryItem({
      ...ROW,
      altText: `A fox${RTL_OVERRIDE} in a field`,
      caption: `Caught${RTL_OVERRIDE} at dawn`,
    });
    expect(mapped?.altText).toBe("");
    expect(mapped?.caption).toBe("");
  });

  it("keeps text containing HTML, because React escapes it on render", () => {
    // Stripping it here would be the same "text nobody wrote" mistake the
    // tag-name sanitizer avoids. Escaping is this function's co-defender's
    // job (the component), asserted against real markup in the gallery and
    // page test suites.
    const mapped = toGalleryItem({
      ...ROW,
      altText: "A fox <script>alert(1)</script> in a field",
      caption: "<b>Bold</b> claim about a fox",
    });
    expect(mapped?.altText).toBe("A fox <script>alert(1)</script> in a field");
    expect(mapped?.caption).toBe("<b>Bold</b> claim about a fox");
  });

  it("keeps a line break in a caption, rather than wiping it to empty (review round 2 regression)", () => {
    // `validateCaption` (src/lib/media-rules.ts) allows a caption to contain
    // `\n` — the field is a multi-row <textarea> — but this function's own
    // denylist check used to run against the UNMODIFIED string, so a caption
    // written with a real line break came back through `hasUnsafeText`
    // (which still treats `\n` as an unsafe control character on its own)
    // and silently disappeared on every render. The write path allowed it;
    // the read path quietly undid it.
    const mapped = toGalleryItem({
      ...ROW,
      altText: "A fox crossing a snowy field",
      caption: "Line one\nLine two",
    });
    expect(mapped?.caption).toBe("Line one\nLine two");
  });

  it("still refuses a bidi override hiding inside a multi-line caption", () => {
    // The newline exemption must not become a general loophole: everything
    // else in the denylist — the bidi group especially — still applies once
    // the newlines themselves are set aside.
    const mapped = toGalleryItem({
      ...ROW,
      altText: "A fox crossing a snowy field",
      caption: `Line one\nLine two${String.fromCodePoint(0x202e)}reversed`,
    });
    expect(mapped?.caption).toBe("");
  });

  it("does NOT extend the newline exemption to alt text, which stays single-line", () => {
    const mapped = toGalleryItem({
      ...ROW,
      altText: "A fox\ncrossing a field",
    });
    expect(mapped?.altText).toBe("");
  });
});

describe("galleryItemAlt and galleryItemLabel prefer real alt text", () => {
  it("uses the uploader's alt text verbatim, uncapitalized and unchanged", () => {
    const withAlt = item({ altText: "a fox crossing a snowy field" });
    expect(galleryItemAlt(withAlt, 0)).toBe("a fox crossing a snowy field");
  });

  it("prefixes the real alt text with Open for the tile's accessible name", () => {
    const withAlt = item({ altText: "A fox crossing a snowy field" });
    expect(galleryItemLabel(withAlt, 0)).toBe(
      "Open A fox crossing a snowy field",
    );
  });

  it("falls back to the position/date placeholder when alt text is empty (K2)", () => {
    // Published media is never supposed to reach this without real alt text
    // (the publish gate refuses it) — this is the render layer's own net,
    // kept independently of that gate holding.
    const blank = item({ altText: "" });
    expect(galleryItemAlt(blank, 0)).toBe("Photograph 1, published 4 March 2026");
    expect(galleryItemAlt(blank, 0)).not.toBe("");
  });

  it("does NOT disambiguate real alt text by position — two items with the same uploader-supplied text read identically (review round 1, finding 2)", () => {
    // This is the documented, intentional asymmetry with the fallback
    // branch above: the upload form can apply one alt text to a whole batch
    // (ugcportal-hf5u), so two different photographs legitimately carrying
    // the exact same real alt text is expected, not a bug this function
    // should paper over by inventing a position suffix on text someone
    // wrote. See galleryItemAlt's own docstring.
    const shared = "A fox crossing a snowy field at dawn";
    expect(galleryItemAlt(item({ altText: shared }), 0)).toBe(shared);
    expect(galleryItemAlt(item({ altText: shared }), 1)).toBe(shared);
    expect(galleryItemAlt(item({ altText: shared }), 0)).toBe(
      galleryItemAlt(item({ altText: shared }), 1),
    );
  });
});

describe("toGalleryItems", () => {
  it("keeps the renderable rows and drops the rest, preserving order", () => {
    const mapped = toGalleryItems([
      { ...ROW, id: "a", previewId: "pv-a" },
      { ...ROW, id: "b", previewId: null },
      { ...ROW, id: "c", previewId: "pv-c" },
      null,
      "not a row",
    ]);

    expect(mapped.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("drops a row whose id repeats inside the same page", () => {
    /*
     * The round-5 finding, on the half nothing else covers: the
     * server-rendered first page never goes through `appendGalleryItems`, so
     * this is the ONLY place a duplicate inside it can be caught. Two rows
     * with one id is a repeated React key, which React answers by dropping a
     * tile and warning — not by rendering "one tile rather than a crash".
     */
    const mapped = toGalleryItems([
      { ...ROW, id: "a", previewId: "pv-a" },
      { ...ROW, id: "a", previewId: "pv-a-again" },
      { ...ROW, id: "b", previewId: "pv-b" },
    ]);

    expect(mapped.map((entry) => entry.id)).toEqual(["a", "b"]);
    // The FIRST occurrence survives, so the page keeps the order the feed
    // sent. Distinct previewIds are what make that checkable at all — with
    // identical ones the assertion would pass whichever copy was kept.
    expect(mapped[0].previewSrc).toBe(`${MEDIA_PREVIEW_PATH}/pv-a`);
  });

  it("returns an empty page for a body that is not a list", () => {
    for (const payload of [undefined, null, {}, "items", 7]) {
      expect(toGalleryItems(payload)).toEqual([]);
    }
  });
});

describe("appendGalleryItems", () => {
  it("appends new items in order", () => {
    const first = [item({ id: "a" }), item({ id: "b" })];
    const second = [item({ id: "c" })];
    expect(appendGalleryItems(first, second).map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops an id already on screen, so React keys stay unique", () => {
    const first = [item({ id: "a" }), item({ id: "b" })];
    const overlapping = [item({ id: "b" }), item({ id: "c" })];
    expect(
      appendGalleryItems(first, overlapping).map((entry) => entry.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("drops an id repeated WITHIN the incoming page, not only against the screen", () => {
    /*
     * The round-5 finding. `seen` was built from `existing` and never grew, so
     * a page containing the same id twice put both on screen — the duplicate
     * React key this function's comment claimed to be the net for. A broken
     * cursor is as likely to repeat a row inside one page as across two.
     */
    const first = [item({ id: "a" })];
    const page = [item({ id: "b" }), item({ id: "b" }), item({ id: "c" })];

    expect(appendGalleryItems(first, page).map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops a page that is nothing but one id repeated", () => {
    // The identity guarantee has to survive the same fix: a page of
    // duplicates of something already on screen still adds nothing, so the
    // grid must not re-render.
    const first = [item({ id: "a" })];
    expect(appendGalleryItems(first, [item({ id: "a" }), item({ id: "a" })])).toBe(
      first,
    );
  });

  it("returns the same array when a page adds nothing", () => {
    // Identity, not just equality: re-rendering the whole grid because the
    // last page repeated is a visible flicker.
    const first = [item({ id: "a" })];
    expect(appendGalleryItems(first, [item({ id: "a" })])).toBe(first);
    expect(appendGalleryItems(first, [])).toBe(first);
  });
});

describe("galleryItemLabel", () => {
  it("names the position and the publication date", () => {
    expect(galleryItemLabel(item(), 0)).toBe(
      "Open photograph 1, published 4 March 2026",
    );
  });

  it("counts from one, not from zero", () => {
    // "Open photograph 0" is a developer's index leaking into a screen reader.
    expect(galleryItemLabel(item(), 11)).toContain("photograph 12,");
  });

  /*
   * THE REGRESSION THIS FUNCTION WAS CHANGED FOR.
   *
   * The label used to be the publication date alone, and the test that was
   * supposed to prove names differ only ever compared items published on
   * DIFFERENT days. The feed publishes in batches, so the realistic case is
   * the opposite one — and the old fixture could not construct it. Both items
   * here are published at the same instant, which is the shape that used to
   * produce forty identical names in one grid.
   */
  it("gives two items published at the very same instant different names", () => {
    const sameInstant = "2026-03-04T10:00:00.000Z";
    expect(galleryItemLabel(item({ publishedAt: sameInstant }), 0)).not.toBe(
      galleryItemLabel(item({ publishedAt: sameInstant }), 1),
    );
  });

  it("gives every item in a realistic same-day batch a unique name", () => {
    const batch = Array.from({ length: 40 }, (_, position) =>
      galleryItemLabel(item({ publishedAt: "2026-03-04T10:00:00.000Z" }), position),
    );
    expect(new Set(batch).size).toBe(batch.length);
  });

  it("reads the date in UTC rather than the runtime's zone", () => {
    // 23:30 UTC is already the next day in most of Europe. A label that moved
    // with the renderer's zone would be a hydration mismatch.
    expect(
      galleryItemLabel(item({ publishedAt: "2026-03-04T23:30:00.000Z" }), 0),
    ).toBe("Open photograph 1, published 4 March 2026");
  });

  it("still names the control, uniquely, when there is no date", () => {
    const label = galleryItemLabel(item({ publishedAt: null }), 0);
    expect(label).toBe("Open photograph 1");
    expect(label).not.toContain("Invalid Date");
    expect(label).not.toContain("null");
    expect(label).not.toBe(galleryItemLabel(item({ publishedAt: null }), 1));
  });
});

describe("galleryItemAlt", () => {
  it("describes the image without instructing the reader to open it", () => {
    // A tile is a control, so its name is an action. A lightbox slide is an
    // image, and alt text that reads "Open photograph 1" tells a screen-reader
    // user to do something they have already done.
    expect(galleryItemAlt(item(), 0)).toBe("Photograph 1, published 4 March 2026");
    expect(galleryItemAlt(item(), 0)).not.toContain("Open");
  });

  it("agrees with the tile's label on position and date", () => {
    // The same number in the grid and in the viewer, so "photograph 12" means
    // one thing in both places.
    const alt = galleryItemAlt(item(), 11);
    const label = galleryItemLabel(item(), 11);
    expect(label).toBe(`Open ${alt.charAt(0).toLowerCase()}${alt.slice(1)}`);
  });

  it("is unique across a same-day batch too", () => {
    const batch = Array.from({ length: 40 }, (_, position) =>
      galleryItemAlt(item({ publishedAt: "2026-03-04T10:00:00.000Z" }), position),
    );
    expect(new Set(batch).size).toBe(batch.length);
  });
});

/**
 * The tags on a row, at the boundary where a feed row becomes something the
 * gallery draws (ugcportal-jsc).
 *
 * This is the READ side of K5, and it is a second line of defence rather than
 * the fix: src/lib/tags.ts refuses these names at the write path. It is still
 * worth having, because that validator has only ever governed rows written
 * since it existed, any authenticated account can mint a tag row
 * (ugcportal-egp), and this function is the single boundary every rendered
 * row crosses.
 */
describe("the tags on a mapped item", () => {
  /** RIGHT-TO-LEFT OVERRIDE, by code point — see src/lib/tags.test.ts. */
  const RTL_OVERRIDE = String.fromCodePoint(0x202e);

  /** The tags `toGalleryItem` kept, given whatever the feed sent. */
  function mappedTags(tags: unknown): { slug: string; name: string }[] {
    return toGalleryItem({ ...ROW, tags })?.tags ?? [];
  }

  it("carries an ordinary tag list through unchanged", () => {
    expect(
      mappedTags([
        { slug: "books", name: "Books" },
        { slug: "food", name: "Food" },
      ]),
    ).toEqual([
      { slug: "books", name: "Books" },
      { slug: "food", name: "Food" },
    ]);
  });

  it("is an empty list, never undefined, when the feed sent no tags", () => {
    // A `tags` that can be undefined is a `.map` waiting to throw in a
    // component with no reason to check — so every shape of absence has to
    // produce the same empty array.
    for (const absent of [undefined, null, "food", 7, {}]) {
      expect(mappedTags(absent)).toEqual([]);
    }
  });

  it("drops entries that are not a slug-and-name pair", () => {
    expect(
      mappedTags([
        { slug: "food", name: "Food" },
        null,
        "books",
        { slug: "no-name" },
        { name: "No slug" },
        { slug: "", name: "Blank slug" },
        { slug: "blank-name", name: "   " },
      ]),
    ).toEqual([{ slug: "food", name: "Food" }]);
  });

  it("drops a name carrying a bidi override, and keeps the rest (K5)", () => {
    /*
     * DROPPED, NOT STRIPPED. A name with the override removed is a different
     * name that nobody chose, and rendering it asserts the uploader labelled
     * the photograph something they did not.
     *
     * Escaping does not cover this case at all: U+202E is not markup, React
     * passes it through untouched, and it reverses the reading order of
     * everything after it — the chips beside it, the paging message, the
     * heading.
     */
    expect(
      mappedTags([
        { slug: "bidi", name: `Food${RTL_OVERRIDE}skoob` },
        { slug: "food", name: "Food" },
      ]),
    ).toEqual([{ slug: "food", name: "Food" }]);
  });

  it("drops an unsafe SLUG as well as an unsafe name", () => {
    // The slug reaches the DOM too, as `data-gallery-tag` and as the React
    // key. Checking only the name would leave the attribute unguarded.
    expect(
      mappedTags([{ slug: `food${RTL_OVERRIDE}`, name: "Food" }]),
    ).toEqual([]);
  });

  it("keeps a name containing HTML, because React escapes it", () => {
    // The renderer's job, not this function's — and stripping it here would
    // be the same "a name nobody chose" mistake as above. The escaping is
    // asserted against real markup in src/app/page.tags.test.tsx.
    expect(mappedTags([{ slug: "markup", name: "<b>food</b>" }])).toEqual([
      { slug: "markup", name: "<b>food</b>" },
    ]);
  });

  it("drops a repeated slug, which would be a repeated React key", () => {
    expect(
      mappedTags([
        { slug: "food", name: "Food" },
        { slug: "food", name: "FOOD" },
      ]),
    ).toEqual([{ slug: "food", name: "Food" }]);
  });
});
