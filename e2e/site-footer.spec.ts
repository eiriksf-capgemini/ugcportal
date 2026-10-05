import { expect, test } from "@playwright/test";

import { footerLinkHrefs, uniqueFetchTargets } from "./footer-test-support";

/**
 * K1 (ugcportal-akv6): on any page, scrolled to the bottom, the footer is
 * visible with all its links, and every link target answers 200.
 *
 * Not wired into CI, same as the rest of this directory (see
 * playwright.config.ts's own comment) — needs a running `npm run dev`
 * server. Three pages, deliberately different kinds: the home page, a
 * public content page (/about), and a legal page (/privacy) — "any page" in
 * K1's own wording, not just the one the footer's links happen to live on.
 *
 * K3 (never link a draft page in production) is NOT this file's job: this
 * suite runs against `next dev`, which hard-codes NODE_ENV=development and
 * cannot exercise the production branch at all. See
 * e2e/production/site-footer-draft.spec.ts, which boots a real `next start`
 * server to check that.
 */

const PAGES = ["/", "/about", "/privacy"] as const;

for (const path of PAGES) {
  test(`${path}: footer is visible with its links`, async ({ page }) => {
    await page.goto(path);
    const hrefs = await footerLinkHrefs(page);

    // The link SET K1 asks for — every one of these must be present,
    // whichever page we're standing on.
    for (const expected of [
      "/about",
      "/portfolio",
      "/licence",
      "/privacy",
      "/about#contact",
      "/llms.txt",
    ]) {
      expect(hrefs, `${path} footer should link ${expected}`).toContain(expected);
    }
  });

  test(`${path}: every footer link target answers 200`, async ({ page, request }) => {
    await page.goto(path);
    const hrefs = await footerLinkHrefs(page);
    const uniqueTargets = uniqueFetchTargets(hrefs);
    expect(uniqueTargets.length).toBeGreaterThan(0);

    for (const target of uniqueTargets) {
      const response = await request.get(target);
      expect(response.status(), target).toBe(200);
    }
  });
}
