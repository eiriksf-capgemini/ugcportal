import type { Page } from "@playwright/test";

/**
 * Shared between e2e/header.spec.ts and e2e/about-portfolio.spec.ts (PR #94
 * review round 4, reuse finding): each used to carry its own copy of this
 * check, and the two had already drifted — header.spec.ts's own version
 * compared `scrollWidth > clientWidth` with zero tolerance, while about-
 * portfolio.spec.ts's inline version allowed 2px, for sub-pixel layout
 * rounding a real horizontal scrollbar is not. One function, the tolerant
 * version, used by both, so neither can drift from the other again.
 *
 * A real horizontal scrollbar is visible overflow; one stray pixel from
 * sub-pixel layout rounding is not. Two points of tolerance is tight enough
 * to still catch a tile grid, a long word, or a fixed-width element pushing
 * the layout wider than the viewport.
 */
export async function hasHorizontalScroll(page: Page, tolerancePx = 2): Promise<boolean> {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  return widths.scrollWidth > widths.clientWidth + tolerancePx;
}
