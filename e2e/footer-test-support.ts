import { expect, type Page } from "@playwright/test";

/**
 * Shared between e2e/site-footer.spec.ts (K1, against `npm run dev`) and
 * e2e/production/site-footer-draft.spec.ts (K3, against a real
 * `next start`) — round-1 review, PR #96: the same "scroll the footer into
 * view, read every link's href" steps were written out three times across
 * those two files before this.
 */

/**
 * Every href the site footer's own <a> elements carry, fragment included —
 * this is the RAW list ("every link the footer renders"), not yet filtered
 * down to "things worth fetching"; see `uniqueFetchTargets` for that.
 */
export async function footerLinkHrefs(page: Page): Promise<string[]> {
  const footer = page.locator("footer[data-site-footer]");
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeVisible();
  const hrefs = await footer
    .locator("a[href]")
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  return hrefs.filter((href) => href !== "");
}

/** True for "mailto:...", "https://...", "tel:...", etc — anything with a URI scheme. */
function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * The hrefs that are actually worth fetching as a same-origin page:
 * deduplicated, any "#fragment" stripped (a fragment is never sent to the
 * server, so "/about#contact" is a request for "/about", not a literal
 * non-existent path with a "#" in it), with the fragment-stripped-empty
 * and off-origin cases guarded HERE rather than left to the caller
 * (round-3 review — this function's whole job is "produce fetchable
 * targets", so it should not rely on `footerLinkHrefs` having pre-filtered
 * for it):
 *
 *  - a fragment-only href ("#foo", nothing before the hash) would
 *    otherwise collapse to an empty string after stripping
 *    ("#foo".split("#")[0] === ""), which would silently fetch the
 *    baseURL itself rather than a real target;
 *  - a `mailto:`/`tel:`/etc link, or an absolute off-origin URL (a future
 *    Instagram/Pinterest link, say) is not a same-origin page K1's "every
 *    footer link target answers 200" means to check, and treating it as
 *    a path to request would either behave oddly against this test's
 *    baseURL-relative `request.get` or genuinely reach out to a third
 *    party during a test run.
 */
export function uniqueFetchTargets(hrefs: readonly string[]): string[] {
  const targets = hrefs
    .map((href) => href.split("#")[0])
    .filter((href) => href !== "" && !hasScheme(href) && !href.startsWith("//"));
  return [...new Set(targets)];
}
