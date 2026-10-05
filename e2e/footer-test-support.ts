import { expect, type Page } from "@playwright/test";

/**
 * Shared between e2e/site-footer.spec.ts (K1, against `npm run dev`) and
 * e2e/production/site-footer-draft.spec.ts (K3, against a real
 * `next start`) — round-1 review, PR #96: the same "scroll the footer into
 * view, read every link's href" steps were written out three times across
 * those two files before this.
 */

/** Every href the site footer's own <a> elements carry, fragment included. */
export async function footerLinkHrefs(page: Page): Promise<string[]> {
  const footer = page.locator("footer[data-site-footer]");
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeVisible();
  const hrefs = await footer
    .locator("a[href]")
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  // Filter on the href with any "#fragment" STRIPPED, not the raw string
  // (round-2 review): a fragment-only href ("#foo", nothing before the
  // hash) would survive a raw `!== ""` check and then collapse to an empty
  // string in `uniqueFetchTargets` ("#foo".split("#")[0] === ""), which
  // would silently fetch the baseURL itself rather than a real target —
  // passing a 200 check for a link that was never actually a page.
  return hrefs.filter((href) => href.split("#")[0] !== "");
}

/**
 * The same hrefs, deduplicated and with any "#fragment" stripped — a
 * fragment is never sent to the server, so "/about#contact" is a request
 * for "/about", not for a literal (non-existent) path with a "#" in it.
 */
export function uniqueFetchTargets(hrefs: readonly string[]): string[] {
  return [...new Set(hrefs.map((href) => href.split("#")[0]))];
}
