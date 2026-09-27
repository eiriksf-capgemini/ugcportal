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
export type GalleryItem = {
  id: string;
  /** Delivery URL for the watermarked preview, built from `previewId` alone. */
  previewSrc: string;
  /** ISO-8601, or null when the feed sent something that was not a date. */
  publishedAt: string | null;
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
};

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
  };
}

/**
 * Converts a page of feed rows. Non-array input yields an empty page rather
 * than throwing: it is reachable from a malformed HTTP response, and an empty
 * "load more" is a better failure than a blank page.
 */
export function toGalleryItems(rows: unknown): GalleryItem[] {
  if (!Array.isArray(rows)) return [];
  const items: GalleryItem[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = toGalleryItem(row as PublicMediaRowish);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Appends a page, dropping any id already on screen.
 *
 * Read the guarantee here narrowly, because it is easy to overstate. The
 * keyset cursor in src/lib/media-listing.ts is what makes paging produce each
 * item exactly once; that contract is tested against the real endpoint
 * (src/app/page.test.tsx, K4), not here. This function does NOT verify it and
 * cannot: it only sees what it is handed. What it does is keep React's keys
 * unique if the contract is ever broken, so a duplicate shows up as one tile
 * rather than as a crash — a display safety net, not a proof.
 *
 * It returns the existing array unchanged when there is nothing new, so a
 * repeated final page does not re-render the grid.
 */
export function appendGalleryItems(
  existing: GalleryItem[],
  incoming: GalleryItem[],
): GalleryItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const fresh = incoming.filter((item) => !seen.has(item.id));
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
 * The accessible name of a tile, and the lightbox slide's alt text.
 *
 * A PLACEHOLDER, and worth naming as one: a publication date is not a
 * description of a photograph, and a screen-reader user learns nothing about
 * the image from it. Real alt text needs a field the uploader fills in, which
 * is ugcportal-gwr. What this does buy in the meantime is that every tile has
 * *some* accessible name and that the names differ from each other, so the
 * grid does not read as a list of identical unlabelled buttons.
 */
export function galleryItemLabel(item: GalleryItem): string {
  if (item.publishedAt === null) return "Open photograph";
  return `Open photograph published ${PUBLISHED_ON.format(new Date(item.publishedAt))}`;
}
