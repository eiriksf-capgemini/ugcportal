/**
 * Tag slugs that exist to CURATE an item for an internal purpose (which
 * public page shows it), not to describe its SUBJECT — and so must never
 * reach a visitor, or a direct API consumer, as if they were one.
 *
 * A TINY, DEPENDENCY-FREE MODULE, deliberately. `PORTFOLIO_TAG_SLUG` is
 * read by src/lib/gallery-items.ts (which strips it from every tag list any
 * public surface RENDERS), src/lib/public-media.ts (which strips it from
 * the public feed's own JSON, independently of rendering — round-4 review),
 * and src/lib/portfolio.ts (which queries on it). Defining it in any of
 * those and having the others import it would risk a circular import —
 * portfolio.ts already imports from gallery-items.ts. This module imports
 * nothing and is imported by all three, breaking any such cycle.
 */
export const PORTFOLIO_TAG_SLUG = "portfolio";

/**
 * Every curation-only tag slug, as a set — not a single literal compared by
 * `===` (round-4 review). Today there is exactly one, but a reader checking
 * "is this a curation tag" against one hardcoded literal has to remember to
 * update every such check if a second one is ever added (a sibling-omission
 * risk by construction); checking membership in this set instead means a
 * second slug added here is picked up everywhere this set is already
 * checked, with nothing else to update.
 */
export const CURATION_TAG_SLUGS: ReadonlySet<string> = new Set([
  PORTFOLIO_TAG_SLUG,
]);

/** Whether `slug` exists to curate an item rather than to describe its subject. */
export function isCurationTagSlug(slug: string): boolean {
  return CURATION_TAG_SLUGS.has(slug);
}
