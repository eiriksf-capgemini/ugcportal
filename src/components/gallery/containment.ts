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
 * The one radius token every rounded shape anchored to a gallery tile
 * shares — `rounded-lg` (`--radius-lg`, 10px, the same figure
 * docs/design/tokens.css names for `--radius-card`), named once so
 * `GALLERY_TILE_BASE_CLASS` below and `GALLERY_ADVERTISING_LABEL_CLASS`
 * (the disclosure badge rendered as the tile's own sibling, immediately
 * before it) derive from the SAME token rather than two independently
 * hand-typed `rounded-lg` literals.
 *
 * THIS IS THE BUG ugcportal-o312 FIXES: before this constant existed,
 * `GALLERY_ADVERTISING_LABEL_CLASS` hand-typed its own `rounded-md`
 * literal, with a comment claiming it matched the tile's radius. PR #122
 * (ugcportal-qqnt.2) moved the tile from `rounded-md` to `rounded-lg` and
 * updated only the one literal it touched, leaving the label's copy — and
 * its now-false comment — behind. containment.radius-parity.test.ts
 * asserts both constants below resolve to this exact token so that kind of
 * silent drift fails a test instead of shipping a labelled tile with two
 * different corner radii on adjacent elements.
 */
export const GALLERY_RADIUS_CLASS = "rounded-lg";

/**
 * The shape and mat every tile shares, whether or not it is interactive.
 * The aspect class above fixes the shape, `overflow-hidden` is what makes
 * the crop a crop, and `bg-surface-1` is the mat visible while the image
 * loads — level 1, because a tile is a raised element on the page canvas.
 *
 * `block` and `w-full`: an inline element (a `<button>`, by default) would
 * leave the tile sized by its content rather than by the grid track.
 *
 * FACTORED OUT (round-5 review) so `GALLERY_TILE_CLASS` below and
 * src/components/portfolio/portfolio-tile.tsx's own `<figure>` compose the
 * SAME base rather than the portfolio tile hand-copying this exact string.
 * Only this shape/mat half is shared — the portfolio tile is deliberately
 * NOT interactive (see that component's own comment for why it carries
 * none of `GALLERY_TILE_CLASS`'s `group`/`cursor-zoom-in`/focus-ring
 * classes below).
 *
 * `GALLERY_RADIUS_CLASS` (`rounded-lg`), not `rounded-md` (ugcportal-qqnt.2):
 * the one radius token the button system now shares
 * (src/components/ui/button.tsx's own header comment, point 6) is
 * `--radius-lg` at 10px — so a tile and a button on the same public page
 * now round by the same amount, rather than the tile's own smaller
 * `rounded-md` (8px) reading as a third, unrelated shape beside them.
 */
export const GALLERY_TILE_BASE_CLASS = `relative block w-full overflow-hidden ${GALLERY_RADIUS_CLASS} bg-surface-1 ${GALLERY_TILE_ASPECT_CLASS}`;

/**
 * One INTERACTIVE tile (gallery.tsx's own `<button>`, which opens the
 * lightbox): the shared base above, plus `group` (so `GALLERY_TILE_IMAGE_
 * CLASS`'s `group-hover: scale-[…]` (space inserted before the utility,
 * same reason as every other bare mention in this file - ugcportal-61pv:
 * this exact spot, with the real value elided to an ellipsis rather than
 * written out, was found compiling a second, ungated `scale: …` rule
 * straight into the real production stylesheet, because this scan's own
 * "space inserted" convention had never been applied here) has an ancestor
 * to key off), the zoom-in cursor, and a focus-visible ring for keyboard
 * navigation — none of which belong on a tile nothing happens when you
 * activate.
 */
export const GALLERY_TILE_CLASS = `group ${GALLERY_TILE_BASE_CLASS} cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

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
 * displaced by a hover.
 *
 * TWO BUGS, not one, were hiding here (ugcportal-ig4g, found in PR #97's
 * round 4, outside that PR's own diff) — fixing only the first still left
 * the tile scaling under reduced motion, confirmed empirically against a
 * real browser (see the mutation-check note below).
 *
 * BUG 1, the property mismatch: Tailwind 4's `scale-*`/`translate-*`/
 * `rotate-*`/`skew-*` utilities compile to the STANDALONE CSS properties
 * `scale`/`translate`/`rotate` — not to `transform` — confirmed empirically
 * the same way PR #97 confirmed it for `empty-state.tsx`'s own hover-lift,
 * by compiling globals.css and reading the generated rule:
 * `.group-hover\: scale-\[1\.04\]…{ scale: 1.04; }` (space inserted after
 * the escaped colon, same reason as every other bare mention in this
 * comment - see BUG 2 below). The guard that used to
 * sit here, `motion-reduce:transform-none`, overrode a property this
 * element never sets, so it changed nothing.
 *
 * BUG 2, the one that survives fixing BUG 1 alone: simply swapping in
 * `motion-reduce:scale-none` is STILL a no-op, for a completely different
 * reason — CSS SPECIFICITY, not property name. Tailwind compiles
 * `group-hover: scale-[1.04]` (space inserted here, and everywhere else in
 * this comment the BARE, un-prefixed combination is named, on purpose —
 * round-5 review: Tailwind's own source scanner reads raw file bytes, not
 * AST-aware JS, so writing that same combination UNBROKEN inside a comment
 * is itself a valid candidate, and got compiled into the real production
 * stylesheet, reintroducing the exact ungated rule this bead fixed —
 * confirmed: removing the space measurably shrank the built CSS; see
 * motion-reduce-pairing.test.ts's own header for the full account and
 * src/app/globals.css's `@source not` exclusion for the OTHER half of
 * this fix, test-fixture classes) to `.group-hover\: scale-\[1\.04\]:is(
 * :where(.group):hover *) { scale: 1.04; }` (space inserted after the
 * escaped colon here too) — `:where()` is specificity-zero, but
 * the compound selector still carries the class (0,1,0) plus the `:is()`
 * pseudo-class's own (0,1,0) from the `:hover` inside it, for a total of
 * (0,2,0). A bare `.motion-reduce\:scale-none { scale: none; }` is only
 * (0,1,0): LOWER specificity, so the hover rule wins on every hover
 * regardless of source order or of `prefers-reduced-motion`. That rule DOES
 * sit inside its own `@media (hover: hover)` — Tailwind's default guard
 * against sticky `:hover` on a touch screen — but that is a DEVICE-
 * CAPABILITY query, unrelated to motion preference: round-1 review,
 * corrected after an earlier version of this comment overclaimed the rule
 * was unconditional with no media gate at all. What it actually has is NO
 * REDUCED-MOTION media context: `(hover: hover)` is true or false the same
 * way regardless of `prefers-reduced-motion`, so a hover-capable mouse
 * user with `reduce` set still matches it. Verified against a real
 * Chromium instance with `reducedMotion: "reduce"` emulated: with only BUG
 * 1 fixed, a hovered tile's computed `scale` still read `"1.04"`, not
 * `"none"`.
 *
 * The actual fix is the one `empty-state.tsx`'s own hover-lift already
 * uses and documents: `motion-safe:` on the TRIGGERING utility itself,
 * not (only) a `motion-reduce:` override on the result. `motion-safe:
 * group-hover: scale-[1.04]` (space inserted before the utility here too,
 * same reason as BUG 2 above - this exact sentence used to wrap across a
 * line break right between `motion-safe:` and `group-hover:`, and
 * Tailwind's scanner reads the two halves as SEPARATE whitespace-delimited
 * candidates, not one reassembled one - so the comment's own line wrap
 * was silently producing the bare, ungated candidate on its own, even
 * with `motion-safe:` sitting right before it) compiles nested inside
 * BOTH `@media (prefers-reduced-motion: no-preference)` and, inside that,
 * `@media (hover:
 * hover)` — so under `reduce` the rule does not exist in the stylesheet AT
 * ALL, for any device: specificity never gets a chance to matter, because
 * there is no competing rule to out-rank. `motion-reduce:scale-none` is
 * kept anyway, same as `empty-state.tsx`'s `motion-reduce:translate-none`:
 * the two `prefers-reduced-motion` media queries (`no-preference` vs
 * `reduce`) are mutually exclusive, so this guard never has anything live
 * to override, but it is a documented, deliberately inert belt-and-braces
 * entry rather than a functioning second guard.
 *
 * ON A USER AGENT WITH NO SUPPORT for the `prefers-reduced-motion` media
 * feature at all (the same no-support case `hero.tsx`'s own
 * `HERO_DECORATIVE_SHAPE_CLASS` comment names for its fade-in): an unknown
 * media feature makes BOTH `no-preference` and `reduce` evaluate false, so
 * NEITHER `motion-safe:group-hover:scale-[1.04]` NOR `motion-reduce:scale-
 * none` ever applies. Unlike the hero's shapes, which have an unconditional
 * `opacity-100` baseline for exactly this case, there is no equivalent
 * fallback here — the practical result is that the hover scale is simply
 * ABSENT on such a browser, which is the fail-safe direction (no motion,
 * rather than unguarded motion) and needs no separate handling.
 *
 * `motion-reduce:transition-none` is real and is kept for the reason it
 * always was, now more completely stated: `transition-transform` compiles
 * (Tailwind 4.3.3) to `transition-property: transform, translate, scale,
 * rotate`, not to `transform` alone, so it already covers the `scale`
 * transition this element actually uses — the guard still matters for
 * anyone whose browser is briefly in `no-preference` and switches, or for
 * any future unconditional `transition-transform` sibling.
 */
export const GALLERY_TILE_IMAGE_CLASS =
  "h-full w-full object-cover transition-transform duration-300 ease-out motion-safe:group-hover:scale-[1.04] motion-reduce:scale-none motion-reduce:transition-none";

/**
 * The play affordance on a VIDEO tile (ugcportal-dzz K1/K2's "a visible play
 * affordance on a VIDEO tile in the grid"), and ONLY that — this bead is
 * about a video being labelled and marked where it is already drawn, not
 * about playing one (ugcportal-s8w owns the player, and must not be
 * pre-empted by a decision made here).
 *
 * `pointer-events-none`, because the badge sits inside the tile's own
 * `<button>` (gallery.tsx) — clicking it must open the lightbox exactly like
 * clicking anywhere else on the tile, not be swallowed by a decorative span.
 * `absolute inset-0 flex items-center justify-center` centres it over
 * whatever the tile shows, the same crop-and-cover frame every tile already
 * has (see this file's own containment-rule comment above).
 *
 * NO ANIMATION, on purpose, not merely by omission: this is a static badge,
 * so there is nothing for `prefers-reduced-motion` to need reducing in the
 * first place, unlike `GALLERY_TILE_IMAGE_CLASS`'s hover scale two
 * declarations up, which has to guard an actual transition. Adding a pulse
 * or any other motion here would be inventing a NEW thing to gate, not
 * reusing an existing one — out of scope for a bead whose K1/K2 ask only for
 * a visible affordance and an accessible name.
 */
export const GALLERY_TILE_VIDEO_BADGE_WRAPPER_CLASS =
  "pointer-events-none absolute inset-0 flex items-center justify-center";

/**
 * The badge itself: a filled circle in the one solid accent colour this
 * system has (see button.tsx's own comment on `default`: "the only solid
 * petrol fill in the system, for the one primary action on a surface").
 *
 * `bg-primary`/`text-primary-foreground` are REUSED, not a new pairing —
 * the exact same two tokens, in the exact same roles, that button.tsx's
 * `default` variant already fills with and already measures against in
 * src/lib/design/contrast.ts ("Label of the filled primary action button").
 * The contrast gate's coverage is per TOKEN, not per component, so this
 * usage rides the same measurement rather than asking for a second one —
 * and a play glyph is non-text iconography (3:1), a lower bar than the
 * 4.5:1 that pairing is already measured against for button TEXT, so it
 * passes with margin to spare.
 */
export const GALLERY_TILE_VIDEO_BADGE_CLASS =
  "flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md";

/**
 * The glyph's own size inside the badge, and the optical nudge a play
 * triangle conventionally gets: a centred equilateral triangle visually
 * reads slightly left-of-centre (its leading edge is a flat side, its
 * trailing edge a point), so a small rightward shift is what every other
 * play button in the wild also applies rather than a defect to fix with a
 * bigger shape.
 */
export const GALLERY_TILE_VIDEO_BADGE_ICON_CLASS = "size-5 translate-x-0.5";

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
 *
 * text-muted-foreground, not text-ink (ugcportal-rw9j review round 5,
 * code-review): this renders directly beside the image tile on the page
 * canvas (--background), the identical sibling regression GALLERY_TAG_CLASS
 * three lines below was already fixed for in round 4 - --color-ink measured
 * 1.10:1 against the new --paper background in light mode. Missed here
 * because this PR and ugcportal-gwr (the caption feature) landed on
 * diverging branches and merged after both shipped; contrast.ts's own
 * muted-foreground-on-background pairing already names "caption" as a
 * usage this token covers (5.03:1).
 */
export const GALLERY_CAPTION_CLASS =
  "mt-1.5 text-sm whitespace-pre-line text-muted-foreground";

/**
 * The advertising-disclosure label (ugcportal-e0jv K1/K4, part B of
 * ugcportal-qnq9.1): "Advertisement / Reklame" or one of the other three
 * permitted forms (src/lib/advertising-disclosure.ts), rendered first on a
 * tile that carries one — see `GalleryItemAdvertisingLabel`
 * (src/components/gallery/gallery-item.tsx), which places it ahead of
 * `GALLERY_CAPTION_CLASS`/`GALLERY_TAG_CLASS` in both the gallery grid and
 * the per-item page.
 *
 * MUST NOT READ AS A TAG OR A CAPTION (K4), which is a real constraint on
 * this string, not a style preference: `GALLERY_TAG_CLASS` just above is
 * quiet, muted, no fill, no border — "a caption, not a label" by its own
 * comment's own words — and `GALLERY_CAPTION_CLASS` is quiet body text.
 * Both are correct for what THEY are (an optional chip, an optional
 * sentence); a compliance disclosure is neither; a visitor must be able to
 * tell at a glance that this line is doing something different from either.
 * So this is a solid, filled badge — the opposite treatment from both of
 * its neighbours — rather than a third shade of muted, quiet text.
 *
 * `bg-primary`/`text-primary-foreground`, REUSED, not a new colour pairing
 * invented for this one badge: the same two tokens, in the same roles,
 * src/components/ui/button.tsx's `default` variant already fills with (the
 * comment there: "the only solid petrol fill in the system, for the one
 * primary action on a surface") and this same file's own
 * `GALLERY_TILE_VIDEO_BADGE_CLASS` (the VIDEO play affordance, ugcportal-dzz,
 * PR #146) already reused for the identical reason — riding the contrast
 * gate's existing `primary-label-on-primary` measurement
 * (src/lib/design/contrast.ts, 4.5:1 body-text threshold) rather than
 * asking it to learn a second pairing. No alpha modifier on either utility,
 * so `src/lib/design/usage.ts`'s alpha-coverage scan has nothing new to
 * resolve either.
 *
 * NO TRANSITION, NO HOVER, NO MOTION UTILITY of any kind (K4's "prefers-
 * reduced-motion unaffected"): this is a static badge of static text, same
 * as the video-play badge's own "nothing here animates" reasoning, so there
 * is nothing for `prefers-reduced-motion` to need reducing in the first
 * place — motion-reduce-pairing.test.ts's project-wide scan has nothing new
 * to flag because nothing here triggers under `hover:`/`group-hover:`/
 * `active:`/`focus:` at all.
 *
 * `GALLERY_RADIUS_CLASS` (`rounded-lg`), matching this file's own tile
 * radius (`GALLERY_TILE_BASE_CLASS`, both deriving from that one shared
 * constant above so they cannot drift apart again the way this exact pair
 * did under ugcportal-qqnt.2 — see `GALLERY_RADIUS_CLASS`'s own comment)
 * rather than a pill (`rounded-full`): a pill reads as a filter/category
 * chip in this design system's own vocabulary (see docs/design — tag chips
 * elsewhere are rounded-full-free already), and a disclosure label is not
 * a category.
 * `w-fit` so the fill hugs the text rather than stretching to the tile's
 * own width, the same reason an inline badge anywhere else in this app
 * never spans its container.
 */
export const GALLERY_ADVERTISING_LABEL_CLASS =
  `mb-1.5 inline-flex w-fit items-center ${GALLERY_RADIUS_CLASS} bg-primary px-2 py-0.5 text-xs font-semibold tracking-wide text-primary-foreground uppercase`;

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
