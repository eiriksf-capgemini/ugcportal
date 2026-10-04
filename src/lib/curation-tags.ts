/**
 * Tag slugs that exist to CURATE an item for an internal purpose (which
 * public page shows it), not to describe its SUBJECT — and so must never
 * reach a visitor as if they were one.
 *
 * A TINY, DEPENDENCY-FREE MODULE, deliberately. `PORTFOLIO_TAG_SLUG` is
 * read by both src/lib/gallery-items.ts (which strips it from every tag
 * list any public surface renders — the main gallery feed included, not
 * only the portfolio page) and src/lib/portfolio.ts (which queries on it).
 * Defining it in either of those two files and having the other import it
 * would be a circular import: portfolio.ts already imports `GalleryItem`
 * and `toGalleryItems` from gallery-items.ts. This module imports nothing
 * and is imported by both, breaking the cycle.
 */
export const PORTFOLIO_TAG_SLUG = "portfolio";
