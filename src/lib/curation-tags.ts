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

/**
 * `tags`, with every curation-only entry removed — the ONE exported
 * function both `src/lib/gallery-items.ts#toGalleryTags` (the main gallery
 * feed and every other renderer) and `src/lib/public-media.ts` (the raw
 * public JSON feed, independently of rendering) now call, rather than each
 * keeping its own copy of the same one-line filter (round-5 review).
 *
 * Generic over `T extends { slug: string }` rather than importing either
 * caller's own tag type (`GalleryTag`, `MediaTagLabel`) — both are already
 * `{ slug, name }`, and importing one would make this module depend on a
 * caller's type, which is exactly the kind of coupling the module's own
 * "dependency-free" comment above exists to avoid.
 *
 * Tolerant of `tags` not being an array — the same defensive instinct
 * `toGalleryTags` already applies to its own `unknown` input. Only
 * `public-media.ts` has ever needed this in practice, for a reason specific
 * to IT, not to this function: its own route test's hand-rolled Prisma mock
 * predates the `tags` relation entirely (ugcportal-jsc) and returns rows
 * with no `tags` property at all, so passing that straight through here
 * would otherwise throw. Keeping the tolerance in the shared function,
 * rather than asking each caller to guard before calling it, means neither
 * caller has to remember to.
 */
export function stripCurationTags<T extends { slug: string }>(tags: T[]): T[] {
  if (!Array.isArray(tags)) return tags;
  return tags.filter((tag) => !isCurationTagSlug(tag.slug));
}
