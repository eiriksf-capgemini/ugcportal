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
 * NOT tolerant of `tags` not being an array (ugcportal-qnq9.16, item 3 of
 * the lows deferred from PR #93's round-6 review). An earlier version
 * returned `tags` unchanged whenever it was not an array — not for any
 * caller's real contract, but solely because
 * src/app/api/public/media/route.test.ts's hand-rolled Prisma mock predates
 * the `tags` relation (ugcportal-jsc) and its `Row` fixture never set one,
 * so every row that mock produced had `tags: undefined` and would otherwise
 * have thrown here. That mock now seeds `tags: []` like every other fixture
 * in this codebase (src/lib/test-support/media-fixtures.ts), so there is
 * nothing left to tolerate: every real caller reads a Prisma `tags`
 * relation, which Prisma always projects as an array, and a non-array value
 * reaching here is a genuine contract violation — `MEDIA_ANONYMOUS_SELECT`'s
 * `tags` relation dropped from a real query, say — that should fail loudly
 * rather than silently pass the bad value to every renderer downstream.
 */
export function stripCurationTags<T extends { slug: string }>(tags: T[]): T[] {
  return tags.filter((tag) => !isCurationTagSlug(tag.slug));
}
