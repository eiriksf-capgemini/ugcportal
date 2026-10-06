import { expect, test } from "@playwright/test";

import { hasHorizontalScroll } from "./has-horizontal-scroll";

/**
 * K1 (ugcportal-qnq9.7): /about and /portfolio both return 200 and render at
 * 320px width without horizontal overflow.
 *
 * Not wired into CI, same as e2e/petrol-theme.spec.ts — this suite needs a
 * running `npm run dev` server (see playwright.config.ts's own comment for
 * why). Run locally with `npm run test:e2e` against a dev server that has
 * CONTACT_EMAIL either unset (falls back to the placeholder — fine for this
 * check, which is about layout, not the address) or set.
 */

const VIEWPORT_320 = { width: 320, height: 720 };

for (const path of ["/about", "/portfolio"] as const) {
  test(`${path} returns 200 and renders at 320px with no horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT_320);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    expect(await hasHorizontalScroll(page)).toBe(false);
  });
}

/** The first `<h2>` /about and /portfolio each carry today (both go through SECTION_HEADING_CLASS — src/components/site/section-heading.ts). */
const FIRST_SECTION_HEADING: Record<"/about" | "/portfolio", string> = {
  "/about": "What we offer",
  "/portfolio": "Samples",
};

/**
 * ugcportal-qqnt.1 K2: /, /about and /portfolio share the same display and
 * section utilities — checked here as the computed font size a browser
 * actually produces, which is the claim src/components/type-scale.test.tsx's
 * source scan cannot make on its own (it checks that the same CONSTANT is
 * imported, not that nothing downstream overrides what it resolves to).
 */
for (const path of ["/about", "/portfolio"] as const) {
  test(`K2: ${path}'s title and first section heading match the home page's sizes`, async ({
    page,
  }) => {
    await page.goto("/");
    const homeH1Size = await page
      .locator("[data-home-hero] h1")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    // This dev database is empty (e2e/front-page.spec.ts's own header
    // comment), so the home page's first <h2> is the living empty state's.
    const homeH2Size = await page
      .locator("[data-home-empty-state] h2")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    await page.goto(path);
    const pageH1Size = await page
      .locator("h1")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const pageH2Size = await page
      .getByRole("heading", { level: 2, name: FIRST_SECTION_HEADING[path] })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    expect(pageH1Size, `home h1: ${homeH1Size}px, ${path} h1: ${pageH1Size}px`).toBe(
      homeH1Size,
    );
    expect(pageH2Size, `home h2: ${homeH2Size}px, ${path} h2: ${pageH2Size}px`).toBe(
      homeH2Size,
    );
  });
}
