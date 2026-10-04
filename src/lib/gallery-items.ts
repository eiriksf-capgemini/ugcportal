import { stripCurationTags } from "@/lib/curation-tags";
import { hasUnsafeText, validateAltText, validateCaption } from "@/lib/media-rules";
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
 * `altText` and `caption` (ugcportal-gwr) ARE here, and are the one pair of
 * fields on this type that come straight off the row rather than being
 * derived or withheld. `originalName` is still not a substitute for either,
 * for the reason given below `toGalleryTags`: it is a filename off someone's
 * disk. Published media is never without alt text — POST
 * /api/media/[id]/publish refuses to set `publishedAt` otherwise (K1) — but
 * `toGalleryItem` still does not trust that invariant blindly; see its own
 * comment for the defence-in-depth fallback.
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
   * The uploader's own description of the photograph (ugcportal-gwr), or
   * `""` when none was supplied or what was supplied failed sanitisation —
   * the same "absence is the empty string" contract `caption` below has.
   *
   * NOT what reaches `<img alt>` directly: this field is the sanitized
   * INPUT to that decision, and `galleryItemAlt(item, position)` is the
   * function that turns it into the string actually rendered, falling back
   * to a non-empty placeholder built from the item's position when this is
   * `""`. Reading `item.altText` directly anywhere a render needs real alt
   * text is the bug `galleryItemAlt` exists to be the one place that can't
   * have.
   */
  altText: string;
  /**
   * The uploader's optional caption (ugcportal-gwr), rendered as visible text
   * in the gallery tile and the lightbox. Empty string means none was
   * supplied — the ordinary case for anything uploaded before this bead — and
   * both render sites hide the element entirely for it, the same rule the
   * subject-tag caption already follows in the lightbox.
   */
  caption: string;
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
  altText?: unknown;
  caption?: unknown;
  tags?: unknown;
};

/**
 * A user-supplied string, cleaned by calling the EXACT SAME validator the
 * write path uses (`validateAltText`/`validateCaption`, src/lib/media-rules.ts)
 * rather than a second, hand-written copy of its rules. Returns `""` for
 * "nothing safe to show" — whether that's because nothing was supplied or
 * because what was supplied failed validation — never a partially repaired
 * string nobody wrote.
 *
 * THIS USED TO BE A SEPARATE IMPLEMENTATION, and that cost a real bug
 * (review round 2): it re-ran `hasUnsafeText` by hand without the caption
 * newline exemption `validateCaption` has, so a caption written with a real
 * `\n` validated fine at write time and then silently lost its line breaks
 * on every render — the write path and the read path's independent copies
 * had drifted apart. Round 3 found the fix for that still had two remaining
 * gaps from the same root cause: the hand-written copy never enforced
 * `MAX_ALT_TEXT_LENGTH`/`MAX_CAPTION_LENGTH` at all (so an oversized value
 * from any future writer that bypasses POST /api/media's own validation
 * would have rendered in full), and the two copies could drift again the
 * next time either validator's rules changed. Calling the real function
 * removes the second copy instead of fixing it a third time: there is
 * nothing left here that can disagree with what was actually validated at
 * write time.
 */
function sanitizedMediaText(value: unknown, allowNewlines = false): string {
  const result = allowNewlines ? validateCaption(value) : validateAltText(value);
  return result.ok ? result.value : "";
}

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
 * is reachable by any account permitted to sign in (ugcportal-egp), and this
 * function is the single boundary every rendered row crosses. One denylist,
 * checked at both ends.
 *
 * Dropping is the right answer rather than stripping. A name with the
 * override removed is a DIFFERENT name that nobody chose, and showing it
 * asserts that the uploader labelled the photograph something they did not.
 *
 * THIRD JOB (round-2 review of ugcportal-qnq9.7): any curation-only tag
 * (`stripCurationTags`, src/lib/curation-tags.ts — today just drops
 * `PORTFOLIO_TAG_SLUG`) is dropped here too, unconditionally, for EVERY
 * caller of this function — not only the portfolio page. That tag exists
 * to CURATE an item for the portfolio page, not to describe its subject,
 * and this function is the boundary a published item's tags cross on
 * their way to any RENDERED public surface: the main gallery feed
 * (src/app/page.tsx) just as much as src/lib/portfolio.ts's own render.
 * Filtering it only in the portfolio-specific code (round 1's fix) left a
 * real gap: a photo tagged both "portfolio" and a real subject like "food"
 * would still show a "Portfolio" chip to every visitor of the ordinary
 * home-page gallery, leaking the internal curation mechanism exactly
 * where K6's "never imply something about this item that isn't true"
 * reasoning applies just as much as it does on the dedicated page.
 *
 * Applied once, AFTER the loop below builds the sanitised list, rather
 * than as a per-entry `continue` inside it (round-5 review: the two used
 * to be interleaved, so sharing the actual filter with `public-media.ts`
 * meant pulling it out to its own call first). Equivalent either way — a
 * curation-only entry still safely passing the other checks changes
 * nothing about whether it ends up in the final list — but a filter
 * applied once, as its own step, is the one that can be the same function
 * call both places need.
 *
 * NOT the whole story any more (round 4): GET /api/public/media
 * (src/app/api/public/media/route.ts) serialises `listPublicMedia`'s
 * result straight to JSON without ever calling this function, so a direct
 * API consumer could still see the raw tag — fixed separately, in
 * `listPublicMedia` itself (src/lib/public-media.ts), which is the
 * boundary for THAT surface. Round 5 unified the two onto the SAME
 * exported `stripCurationTags`, so they cannot disagree about which slugs
 * are curation-only or how they are removed.
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
  return stripCurationTags(tags);
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
    altText: sanitizedMediaText(row.altText),
    caption: sanitizedMediaText(row.caption, true),
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
 * THE SAFETY NET, not the primary source any more. Before ugcportal-gwr this
 * WAS the tile's alt text — a placeholder built from a position and a
 * publication date, because there was no field for a real description. That
 * field exists now (`GalleryItem.altText`), and `galleryItemAlt` below reaches
 * for this only when it is empty: published media is never supposed to lack
 * alt text at all — POST /api/media/[id]/publish refuses to set
 * `publishedAt` otherwise (K1) — but "never supposed to" is exactly the
 * assumption that made earlier invariants in this codebase vacuous when they
 * turned out to be wrong, so K2's "never empty alt text" is kept true here
 * too, independently of the publish gate holding.
 *
 * THE POSITION IS WHAT MAKES TWO FALLBACKS NOT COLLIDE. The first version of
 * this named only the publication date, and the feed publishes in batches, so
 * a day's uploads all got the identical name — "Open photograph published
 * 4 March 2026", forty times. `position` is the item's index in the rendered
 * list, which is also its slide index in the viewer — the same number in both
 * places, so a listener who hears "photograph 12" in the grid hears the same
 * in the lightbox.
 */
function fallbackDescription(item: GalleryItem, position: number): string {
  const subject = `photograph ${position + 1}`;
  if (item.publishedAt === null) return subject;
  return `${subject}, published ${PUBLISHED_ON.format(new Date(item.publishedAt))}`;
}

/**
 * The accessible name of a tile, which is a control that opens the viewer.
 *
 * NOT built from `galleryItemAlt` below, even though both ultimately choose
 * between the same two sources — real alt text, or the fallback — because
 * `galleryItemAlt` capitalizes the fallback (it stands alone, as `<img alt>`)
 * and this one does not (it reads as the tail of "Open …"). Delegating would
 * either capitalize mid-sentence ("Open Photograph 1…") or require this
 * function to re-lowercase a string the other one just capitalized.
 */
export function galleryItemLabel(item: GalleryItem, position: number): string {
  const text = item.altText !== "" ? item.altText : fallbackDescription(item, position);
  return `Open ${text}`;
}

/**
 * The lightbox slide's alt text, and the gallery tile's `<img alt>` (ugcportal-gwr).
 *
 * THE UPLOADER'S OWN WORDS, first. `item.altText` is sanitized but otherwise
 * verbatim — not capitalized, not reworded — because it is a sentence someone
 * wrote on purpose and rewriting a person's own description is not this
 * function's place.
 *
 * The placeholder is reached only when that is empty, which K1 means should
 * never happen for a published item; see `fallbackDescription` for why the
 * net is kept anyway. Capitalized there and not on the real value, because the
 * placeholder is a phrase this function builds in lower case ("photograph 12,
 * published...") and real alt text is not this function's to re-case.
 *
 * `position` DISAMBIGUATES ONLY ON THE FALLBACK BRANCH, and that asymmetry is
 * deliberate rather than a gap this function should close (review round 1,
 * finding 2). The placeholder needed it because the SAME synthetic string
 * (a position and a date) was otherwise handed to every item in a batch, with
 * nothing else to tell them apart. Real alt text does not have that problem
 * in the same way — it is the uploader's own words — but it is not immune
 * to it either: this product's upload form applies one alt text to an entire
 * batch of files (ugcportal-gwr's known limitation, tracked as
 * ugcportal-hf5u), so several items CAN legitimately carry the identical
 * string today, and nothing here makes them unique. That is intentional: a
 * screen-reader user hearing the same real description on three photographs
 * from the same batch is hearing an honest (if unhelpful) fact about how
 * they were described, not a bug this function invented — inventing a
 * position suffix ("…, photo 2 of 3") on text someone wrote would put words
 * in their caption that are not theirs. The actual fix for the underlying
 * limitation is per-file alt text (hf5u), not a disambiguator bolted onto
 * the read side.
 */
export function galleryItemAlt(item: GalleryItem, position: number): string {
  if (item.altText !== "") return item.altText;
  const description = fallbackDescription(item, position);
  return description.charAt(0).toUpperCase() + description.slice(1);
}
