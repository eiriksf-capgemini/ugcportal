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
