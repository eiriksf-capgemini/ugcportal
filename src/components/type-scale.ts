/**
 * The front page's type scale (ugcportal-qqnt.1): one display size, one
 * section size, shared by every public page so the hierarchy reads the same
 * way on all three of them.
 *
 * Before this bead, the hero's title was deliberately NOT a heading element
 * — src/components/home/hero.tsx's own git history carries the comment that
 * said so — because src/app/page.tags.test.tsx asserted exactly one heading
 * in the whole page, and whichever of Gallery, EmptyState or
 * GalleryUnavailable rendered below it already supplied that one `<h1>` —
 * at `text-2xl sm:text-3xl`, the same size the hero's hand-styled paragraph
 * used at `sm:text-4xl`. Two near-equal serif titles then competed in the
 * first viewport. The fix: the hero is now the page's one real `<h1>` (the
 * DISPLAY size below), and every section heading that used to compete with it
 * steps down to the SECTION size instead.
 *
 * Only `<h1>`/`<h2>` sizing lives here — the two levels every public page's
 * own tests actually pin (`src/app/page.tags.test.tsx`,
 * `src/components/gallery/gallery.test.tsx`,
 * `src/components/type-scale.test.tsx`). "Body" and "small" are not separate
 * exported constants: they are already the existing, consistent idiom across
 * these same pages — a body paragraph is `max-w-prose text-sm sm:text-base`
 * (hero.tsx's lead, intro-section.tsx), and a small/muted line is `text-sm
 * text-muted-foreground` (the supporting copy in
 * src/components/home/empty-state.tsx, and section-heading.ts's siblings) —
 * so naming them here would duplicate a convention rather than introduce one.
 *
 * Deliberately carries no colour or layout (`max-w-*`) utility: those vary by
 * surface (the hero's `text-ink` on its petrol well vs. `text-foreground`
 * everywhere else) and by caller, so each call site adds its own via `cn()`.
 * `font-heading` is likewise left out — every `<h1>`/`<h2>` already gets
 * Fraunces for free from the `h1, h2, h3 { font-heading }` rule in
 * globals.css's `@layer base`, and component-authored classes only ever need
 * to repeat it for a non-heading element (the hero's title no longer is one).
 */
export const DISPLAY_TITLE_CLASS =
  "text-4xl leading-tight font-medium tracking-tight text-balance sm:text-5xl";

/**
 * The section level: every `<h2>` on a public page steps down to this one
 * size, rather than each component choosing its own. Shared, not merely
 * similar, so `src/components/type-scale.test.tsx`'s source scan can assert
 * identity rather than "close enough": `src/components/gallery/gallery.tsx`
 * ("Gallery", and its own internal `GalleryEmpty` — the sibling the main
 * heading's own fix would otherwise have missed, see that file's comment),
 * `src/components/home/empty-state.tsx`,
 * `src/components/gallery/gallery-unavailable.tsx`, and (via
 * `src/components/site/section-heading.ts`'s `SECTION_HEADING_CLASS`)
 * /about and /portfolio's "What we offer", "Get in touch" and "Samples".
 */
export const SECTION_TITLE_CLASS =
  "text-2xl leading-tight font-medium tracking-tight text-balance";
