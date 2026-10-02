/**
 * The gallery's containment rule (ugcportal-71y, K6 and K7), in one place so a
 * test can assert the rule rather than a screenshot of it.
 *
 * THE DECISION, AND WHY.
 *
 * ugcportal-44q's previews are aspect-PRESERVING: sharp resizes with
 * `fit: "inside"` inside PREVIEW_MAX_DIMENSION, so a panorama stays a panorama
 * and a portrait stays a portrait. Nothing upstream makes two previews the
 * same shape, and nothing here is allowed to make one — a cropped
 * uniform-ratio derivative is ugcportal-r5s's bead, not this one. So the only
 * place uniformity can come from is the grid.
 *
 * Three options were real:
 *
 *   1. A fixed square tile with `object-fit: cover`. One rhythm at every
 *      breakpoint; the image is scaled, never stretched; the overflow is
 *      clipped by the tile.
 *   2. A fixed tile with `object-fit: contain` on a mat. Nothing is hidden,
 *      but every non-square photograph gets letterboxed, and a grid of
 *      differently-sized images floating in identical boxes reads as *more*
 *      ragged than no grid at all — the pillarboxing draws attention to the
 *      inconsistency rather than resolving it.
 *   3. Masonry (CSS `columns`). Nothing is hidden and nothing is letterboxed,
 *      but CSS multi-column fills top-to-bottom per column, so item 2 of a
 *      strictly chronological feed lands under item 1 rather than beside it.
 *      Reading order stops matching the feed's order, which is the one thing
 *      the ordering comment in GET /api/public/media went out of its way to
 *      keep stable.
 *
 * Option 1 is what ships. The cost is honest and worth stating: the grid shows
 * a centre crop, so the edges of a wide photograph are not visible until the
 * lightbox opens — and the lightbox is one activation away, showing the whole
 * frame. Two things make the crop safe rather than merely tidy:
 *
 *   - The watermark is a tiled, rotated pattern across the ENTIRE preview
 *     (buildWatermarkOverlaySvg in src/lib/watermark.ts emits an SVG
 *     `<pattern>` repeated over the whole frame, and watermark.test.ts asserts
 *     that coverage), not a corner mark. A centre crop cannot remove it. A
 *     corner watermark would have made this choice a leak, which is why it was
 *     checked rather than assumed.
 *   - Nothing is re-encoded. `object-fit` is a display rule; the bytes served
 *     are still 44q's aspect-preserving preview, so r5s can change its mind
 *     about cropping later without anything here having pre-empted it.
 */

/**
 * The grid. Column counts change at `sm` and `lg`; the tracks are `1fr`, so
 * each column takes an equal share of whatever width is available and no tile
 * has a minimum width that could push the row past the viewport.
 *
 * Two columns at phone width rather than one: a single-column feed of squares
 * on a 375px screen shows one photograph per screenful and turns browsing into
 * scrolling. Two is the smallest count that still reads as a gallery.
 */
export const GALLERY_GRID_CLASS =
  "grid w-full grid-cols-2 gap-1.5 sm:grid-cols-3 sm:gap-2 lg:grid-cols-4 lg:gap-3";

/**
 * The fixed tile shape, named separately so the containment test asserts the
 * same string the component renders rather than a copy of it. A copy is how a
 * uniformity test keeps passing after the uniformity is gone.
 */
export const GALLERY_TILE_ASPECT_CLASS = "aspect-square";

/**
 * One tile. The aspect class above fixes the shape, `overflow-hidden` is what
 * makes the crop a crop, and `bg-surface-1` is the mat visible while the image
 * loads — level 1, because a tile is a raised element on the page canvas.
 *
 * `block` and `w-full`: a `<button>` is inline-block by default, which would
 * leave the tile sized by its content rather than by the grid track.
 */
export const GALLERY_TILE_CLASS = `group relative block w-full cursor-zoom-in overflow-hidden rounded-md bg-surface-1 ${GALLERY_TILE_ASPECT_CLASS} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

/**
 * The image inside a tile.
 *
 * `h-full w-full` fills the tile and `object-cover` decides what happens to
 * the difference: the image is scaled uniformly until it covers the box and
 * the overflow is clipped. It is never stretched — that would be
 * `object-fill`, which is exactly what K6 forbids and is the default for an
 * `<img>` given both dimensions, so naming `object-cover` is load-bearing
 * rather than decorative.
 *
 * The hover scale is the one micro-interaction here (the bead leaves these to
 * this bead's own judgement). It is on the image, not the tile, so the tile's
 * footprint in the grid never changes and neighbouring tiles cannot be
 * displaced by a hover. `motion-reduce:` opts the whole thing out for anyone
 * who has asked for less motion.
 */
export const GALLERY_TILE_IMAGE_CLASS =
  "h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transform-none motion-reduce:transition-none";

/**
 * The caption under one tile (ugcportal-gwr). Quiet body text — unlike the
 * tag chips below it, a caption is a sentence the uploader wrote, not a
 * label, so it is neither small-caps nor muted to the same degree: it needs
 * to read as a sentence someone would actually read.
 *
 * `whitespace-pre-line`, because a caption may legitimately contain a line
 * break (`validateCaption` allows one — review round 1, finding 6, the
 * caption field is a multi-row `<textarea>`). The default `normal` collapses
 * `\n` to a single space, which would silently undo a line break the
 * uploader typed on purpose; `pre-line` keeps it while still collapsing
 * runs of ordinary spaces, same as any other paragraph of text.
 */
export const GALLERY_CAPTION_CLASS = "mt-1.5 text-sm whitespace-pre-line text-ink";

/**
 * SUBJECT TAGS (ugcportal-jsc), and the three decisions behind where they sit.
 *
 * WHY UNDER THE TILE AND NOT OVER IT. An overlay reads better on a
 * photography-first page, and it was the first thing tried. It is wrong for
 * this content: a centre-cropped square already hides the edges of a wide
 * photograph (see the containment note above), and putting a label on top
 * covers a second piece of it. A hover-only overlay is worse still — on a
 * touch screen there is no hover, so the labels would be invisible on the
 * device most of this grid is looked at on, and "visible on all elements" is
 * the requirement.
 *
 * WHY NOT INSIDE THE <button>. The tile's accessible name comes from its
 * `aria-label`, and an `aria-label` REPLACES the element's contents for
 * assistive technology — so tags rendered inside the button would be visible
 * and simultaneously unreadable to a screen reader. As a sibling they are
 * ordinary content in the list item, announced once, in the reading order
 * they appear in.
 *
 * WHY NOT A SECTION PER TAG. Because that is the thing ugcportal-jsc was
 * rescoped to avoid. The grid is one continuous list whatever tags are
 * present; a tag is a property of an item, not a bucket items are sorted
 * into. What keeps it that way when somebody later reaches for the obvious
 * refactor is the K4 block in src/app/page.tags.test.tsx — "has no page whose
 * path is a tag" walks src/app for page files, and "emits one continuous item
 * set however many distinct tags are present" asserts the order stays
 * chronological rather than clustering.
 *
 * The chips are quiet on purpose — small, muted, no background fill, no
 * border. They are a caption, and the photograph is the thing on the page.
 */
export const GALLERY_TAG_LIST_CLASS =
  "mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5";

/**
 * One chip. Not a link and not a button: clicking a tag does nothing, which
 * is a decision rather than an omission — see the bead's note on filtering,
 * and ugcportal-8rm for the follow-up. Styling it as interactive when it is
 * not would be the worse half of both options.
 *
 * text-muted-foreground, not text-ink-muted (ugcportal-rw9j review round 4):
 * this renders directly beside the image tile on the page canvas
 * (--background), not inside any near-black well - --color-ink-muted
 * measured ~1.9:1 against the new --paper background in light mode, the
 * same regression class as the /upload fixes in this same round, just on
 * the home page itself. Caught by review, not by this PR's own axe run,
 * because the local dev database it ran against had no tagged published
 * items to render.
 */
export const GALLERY_TAG_CLASS =
  "text-[0.6875rem] leading-4 font-medium tracking-wide text-muted-foreground uppercase";

/**
 * The centred, single-column layout shared by the gallery's two whole-page
 * states (ugcportal-71y's "nothing published", ugcportal-0dh's "could not
 * load") — `GalleryEmpty` in gallery.tsx and `GalleryUnavailable` in
 * gallery-unavailable.tsx. Named once, here rather than in either of those
 * modules, specifically so BOTH can import a shared value without either
 * importing the other: `GalleryEmpty` lives in a `"use client"` file and
 * `GalleryUnavailable` deliberately does not (see that module's own
 * docstring for why), and this file is a plain module neither of those
 * boundaries has any reason to object to. A layout tweak to one of the two
 * states (say, `py-24`) cannot silently drift from the other, because there
 * is only one string to change.
 */
export const GALLERY_STATE_CONTAINER_CLASS =
  "mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-24 sm:px-6";
