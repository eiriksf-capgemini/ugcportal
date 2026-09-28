import { hasUnsafeText } from "@/lib/media-rules";
import { mediaPreviewPath } from "@/lib/routes";

/**
 * The shape the gallery renders (ugcportal-71y), and the one boundary where
 * the public feed's rows become it.
 *
 * There are two sources for those rows and they arrive differently typed: the
 * server-rendered first page gets them straight out of Prisma, with real
 * `Date`s, and every later page arrives as JSON from GET /api/public/media,
 * with ISO strings. Mapping both through this one function is what stops the
 * two halves of the same list disagreeing about what a row is — the failure
 * that shows up as page one rendering fine and page two rendering
 * "Invalid Date", or worse, as a props object React Server Components refuse
 * to serialise.
 *
 * What is deliberately NOT here:
 *
 * `previewKey`, `key`, `userId`, `originalName`, `mimeType`, `sizeBytes` — the
 * anonymous projection never selects any of them (src/lib/media-access.ts), so
 * there is nothing to strip. This type is narrower still: it carries only what
 * the grid and the lightbox actually draw, so a column added to the feed later
 * reaches the DOM only if someone adds it here on purpose.
 *
 * Alt text is not a field. There is no alt-text column yet — ugcportal-gwr
 * owns adding one — and `originalName` is not a substitute even where it is
 * available: it is a filename off someone's disk, withheld from this audience
 * for that reason. See `galleryItemLabel` for what is used instead and why it
 * is a placeholder.
 */
/** One subject label on an item (ugcportal-jsc). */
export type GalleryTag = {
  /** Identity, and the React key. Never put in a URL — there is no tag route. */
  slug: string;
  /** What the chip says. */
  name: string;
};

export type GalleryItem = {
  id: string;
  /** Delivery URL for the watermarked preview, built from `previewId` alone. */
  previewSrc: string;
  /** ISO-8601, or null when the feed sent something that was not a date. */
  publishedAt: string | null;
  /**
   * The item's subject tags, in the order the feed sent them (by slug — see
   * MEDIA_TAGS_SELECT). EMPTY IS ORDINARY, not an error state: most of the
   * library predates tagging and an untagged item renders as a tile with no
   * chips under it rather than as a gap or an empty label.
   */
  tags: GalleryTag[];
};

/**
 * A row as it may arrive: from Prisma (Date) or from JSON (string).
 *
 * Typed loosely on purpose. The network half of this is a parsed JSON body,
 * and giving it the compile-time shape of a Prisma row would be a claim about
 * a response this code has not checked.
 */
export type PublicMediaRowish = {
  id?: unknown;
  previewId?: unknown;
  publishedAt?: unknown;
  tags?: unknown;
};

/**
 * The tags on one row, filtered down to the ones that can safely be drawn.
 *
 * TWO JOBS, and only one of them is about malformed JSON.
 *
 * The first is the ordinary one this module already does for every field:
 * a parsed HTTP body is not a Prisma row, so `slug` and `name` are checked
 * for being non-empty strings rather than destructured and trusted.
 *
 * The second is the one worth reading twice. A tag name is user-supplied text
 * that is rendered next to other text, and the character class that makes
 * that dangerous is not markup — React escapes markup, and a name containing
 * `<b>` draws as the four characters `<b>`. It is the BIDI OVERRIDES. A
 * U+202E inside a tag name reverses the reading order of everything after it,
 * so one chip can make the chips beside it, the paging message and the
 * heading read as something their authors did not write, and no amount of
 * HTML escaping touches it.
 *
 * `hasUnsafeText` is the denylist src/lib/tags.ts refuses those names with at
 * the WRITE path, which is where the real fix lives. This is the second half
 * of the same rule applied at the READ path, and it is not redundant: the
 * write path has only ever governed rows written since it existed, a tag row
 * is reachable by any authenticated account (ugcportal-egp), and this
 * function is the single boundary every rendered row crosses. One denylist,
 * checked at both ends.
 *
 * Dropping is the right answer rather than stripping. A name with the
 * override removed is a DIFFERENT name that nobody chose, and showing it
 * asserts that the uploader labelled the photograph something they did not.
 */
function toGalleryTags(value: unknown): GalleryTag[] {
  if (!Array.isArray(value)) return [];
  const tags: GalleryTag[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { slug, name } = entry as { slug?: unknown; name?: unknown };
    if (typeof slug !== "string" || slug === "") continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    if (hasUnsafeText(name) || hasUnsafeText(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    tags.push({ slug, name });
  }
  return tags;
}

function asIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Converts one feed row, or returns null if it cannot be rendered safely.
 *
 * The only rejection that matters is a missing or non-string `previewId`. The
 * feed's where-clause already excludes preview-less rows and `listMedia`
 * re-checks it, so in a healthy system this never fires — but "never fires"
 * is exactly the assumption that made the previous version of that filter
 * vacuous (`undefined !== null` passes everything). If it did fire and this
 * function shrugged, the tile would render `src="/api/media/preview/undefined"`
 * and the gallery would show a broken frame for a row the feed had promised
 * had a preview. Dropping it keeps K3's guarantee true at the render layer as
 * well as at the query.
 *
 * This is a filter, not a repair: nothing here invents a preview, and nothing
 * here can put back a row the query withheld.
 */
export function toGalleryItem(row: PublicMediaRowish): GalleryItem | null {
  const id = typeof row.id === "string" && row.id !== "" ? row.id : null;
  const previewId =
    typeof row.previewId === "string" && row.previewId !== ""
      ? row.previewId
      : null;
  if (id === null || previewId === null) return null;

  return {
    id,
    previewSrc: mediaPreviewPath(previewId),
    publishedAt: asIsoString(row.publishedAt),
    // Absent tags are an empty list, never a missing field: a row from before
    // tagging existed and a row somebody untagged are the same thing to draw,
    // and a `tags` that can be `undefined` is a `.map` waiting to throw in a
    // component that has no reason to check.
    tags: toGalleryTags(row.tags),
  };
}

/**
 * Converts a page of feed rows. Non-array input yields an empty page rather
 * than throwing: it is reachable from a malformed HTTP response, and an empty
 * "load more" is a better failure than a blank page.
 *
 * A REPEATED ID INSIDE ONE PAGE IS DROPPED HERE, not only across pages. Two
 * rows sharing an id is not a shape the query can produce, but this function
 * is also the boundary a parsed HTTP body crosses, and it is the ONLY place
 * the server-rendered first page crosses at all — `appendGalleryItems` never
 * sees it. Left in, the duplicate is a repeated React key on the grid, which
 * React answers by rendering one of the two and warning, and the tile that
 * disappears is not the one anybody would predict. The first occurrence is the
 * one kept, so the page keeps the order the feed sent.
 */
export function toGalleryItems(rows: unknown): GalleryItem[] {
  if (!Array.isArray(rows)) return [];
  const items: GalleryItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = toGalleryItem(row as PublicMediaRowish);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

/**
 * Appends a page, dropping any id already on screen or already in the page.
 *
 * Read the guarantee here narrowly, because it is easy to overstate. The
 * keyset cursor in src/lib/media-listing.ts is what makes paging produce each
 * item exactly once; that contract is tested against the real endpoint
 * (src/app/page.test.tsx, K4), not here. This function does NOT verify it and
 * cannot: it only sees what it is handed.
 *
 * WHAT IT DOES GUARANTEE is that no id appears twice in the array it returns,
 * whichever of the two ways the repeat arrived — an id already on screen, or
 * an id repeated inside the incoming page. Until round 5 it only covered the
 * first: `seen` was built from `existing` and never grew, so two rows sharing
 * an id within one page both survived, and the comment here claimed a net that
 * was not under that half of the fall. The failure it claimed to catch —
 * duplicate React keys — was therefore exactly the failure it let through.
 *
 * Still a display safety net rather than a proof: it keeps the keys unique if
 * the cursor contract is ever broken, and says nothing about whether it is.
 *
 * It returns the existing array unchanged when there is nothing new, so a
 * repeated final page does not re-render the grid.
 */
export function appendGalleryItems(
  existing: GalleryItem[],
  incoming: GalleryItem[],
): GalleryItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const fresh: GalleryItem[] = [];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    fresh.push(item);
  }
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

/**
 * Fixed locale and time zone, deliberately.
 *
 * This string is rendered on the server and again in the browser, and
 * `toLocaleDateString()` with the runtime default resolves differently in the
 * two places — a hydration mismatch that React reports as a warning and then
 * papers over, leaving whichever one the client produced. Pinning both ends
 * the question. UTC rather than a guess at the visitor's zone for the same
 * reason: the server has no zone to guess with.
 */
const PUBLISHED_ON = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "UTC",
});

/**
 * What a tile and its lightbox slide are called.
 *
 * A PLACEHOLDER, and worth naming as one: neither a position nor a publication
 * date describes a photograph, and a screen-reader user learns nothing about
 * the image from either. Real alt text needs a field the uploader fills in,
 * which is ugcportal-gwr.
 *
 * What it does buy is that every tile has an accessible name and that no two
 * names collide. THE POSITION IS WHAT MAKES THAT TRUE, and it is here because
 * the date alone did not: the first version of this named the publication date
 * and nothing else, and the feed publishes in batches, so a day's uploads all
 * got the identical name — "Open photograph published 4 March 2026", forty
 * times, in a grid whose whole purpose is choosing between them. The test that
 * was supposed to cover it only ever compared items published on *different*
 * days, so the fixture could not construct the collision it existed to rule
 * out.
 *
 * The date stays because it is the only meaningful thing the anonymous feed
 * knows about a row; the position is what disambiguates. `position` is the
 * item's index in the rendered list, which is also its slide index in the
 * viewer — the same number in both places, so a listener who hears
 * "photograph 12" in the grid hears the same in the lightbox.
 */
function describeGalleryItem(item: GalleryItem, position: number): string {
  const subject = `photograph ${position + 1}`;
  if (item.publishedAt === null) return subject;
  return `${subject}, published ${PUBLISHED_ON.format(new Date(item.publishedAt))}`;
}

/** The accessible name of a tile, which is a control that opens the viewer. */
export function galleryItemLabel(item: GalleryItem, position: number): string {
  return `Open ${describeGalleryItem(item, position)}`;
}

/**
 * The lightbox slide's alt text. The same description without "Open", because
 * a slide is an image rather than a control and alt text that reads as an
 * instruction is worse than alt text that reads as a label.
 */
export function galleryItemAlt(item: GalleryItem, position: number): string {
  const description = describeGalleryItem(item, position);
  return description.charAt(0).toUpperCase() + description.slice(1);
}
