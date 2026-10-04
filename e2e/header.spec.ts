import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * K1/K2/K3 browser verification for the header (ugcportal-14k9).
 *
 * Follows e2e/petrol-theme.spec.ts's conventions: a real browser against
 * `npm run dev` (playwright.config.ts's webServer), axe-core for automated
 * a11y violations, and explicit viewport sizes rather than device presets.
 *
 * K1 names exactly 375/768/1440; `mobile320` (PR #94 review round 1, low
 * finding 3) is additional coverage, not a replacement — the narrowest
 * width e2e/petrol-theme.spec.ts already checks elsewhere in this app, and
 * the one most likely to reveal a layout squeeze the three named widths
 * happen to miss.
 */

const VIEWPORTS = {
  mobile320: { width: 320, height: 720 },
  mobile375: { width: 375, height: 800 },
  tablet768: { width: 768, height: 1024 },
  desktop1440: { width: 1440, height: 900 },
} as const;

/**
 * Tailwind's default `md` breakpoint (PR #94 review round 2, low finding
 * 4) — the width `mobile-nav-toggle.tsx`'s own `md:hidden`/`hidden md:flex`
 * pair switches on. Named once here rather than left as the literal `768`
 * three separate times below: a future change to that breakpoint (in
 * either the component or this file) now only has one number to update
 * instead of three that could silently stop agreeing with each other.
 */
const MD_BREAKPOINT = 768;

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`header at ${name} (${viewport.width}px)`, () => {
    test.use({ viewport });

    test("K1: wordmark, tagline and navigation are visible with no horizontal scroll", async ({
      page,
    }) => {
      await page.goto("/");

      await expect(page.getByRole("link", { name: "UGC Portal" })).toBeVisible();
      await expect(
        page.getByText("Original photography of food, wine accessories, technology and books."),
      ).toBeVisible();

      // Below md (768px), the nav lives behind the mobile menu toggle - see
      // mobile-nav-toggle.tsx's own comment for why it collapsed rather than
      // staying inline: at 375px, alongside two sign-in buttons and up to
      // two nav links, the row no longer fit without a long email also
      // being present (app-shell.tsx's pre-existing narrow-viewport
      // tuning). "Visible" there means what's rendered without
      // interaction is the toggle itself, not nothing - the nav items
      // become visible the moment it is activated, checked below.
      if (viewport.width < MD_BREAKPOINT) {
        const toggle = page.getByRole("button", { name: "Open menu" });
        await expect(toggle).toBeVisible();
        await toggle.click();
      }

      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await expect(nav.getByRole("link", { name: "Gallery" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "About" })).toBeVisible();

      expect(await hasHorizontalScroll(page)).toBe(false);
    });

    test("K1: every navigation item can be reached and activated with the keyboard", async ({
      page,
    }) => {
      await page.goto("/");

      // A real Tab walk from document start, not `.focus()` - K1 asks for
      // Tab/Enter specifically, and `.focus()` would not prove the item
      // sits in the natural tab order at all (a `tabindex`-less, visually
      // hidden element can still be `.focus()`-ed programmatically).
      await page.keyboard.press("Tab"); // skip link
      await page.keyboard.press("Tab"); // wordmark
      await page.keyboard.press("Tab"); // menu toggle (mobile) or "Gallery" (desktop)

      if (viewport.width < MD_BREAKPOINT) {
        // Below md the nav is hidden entirely (see mobile-nav-toggle.tsx)
        // until the toggle - the next, and only other, focusable element at
        // this width - is activated with the keyboard.
        await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
        await page.keyboard.press("Enter");
        // Activating a button with Enter leaves focus ON the button; the
        // panel it just revealed is the very next thing in DOM order.
        await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
        await page.keyboard.press("Tab");
      }

      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await expect(nav.getByRole("link", { name: "Gallery" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(nav.getByRole("link", { name: "About" })).toBeFocused();

      // K3: ugcportal-qnq9.7 (the About page) is being built concurrently
      // and does not exist in this worktree yet, so activating this link is
      // expected to 404 rather than prove a destination page - this test
      // only claims the nav ITEM is keyboard-activatable, which K1 asks for,
      // not that the destination renders.
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/about$/);
    });

    test("has no automatically detectable axe violations, including the skip-link and bypass rules", async ({
      page,
    }) => {
      await page.goto("/");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  });
}

test.describe("K2: document language", () => {
  test('<html lang="en">', async ({ page }) => {
    await page.goto("/");
    expect(await page.getAttribute("html", "lang")).toBe("en");
  });
});

test.describe("K3: sticky header never hides the skip link's target", () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`at ${name} (${viewport.width}px), "Skip to content" lands focus clear of the sticky header`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");

      // Forces the page scrollable regardless of how much real content the
      // gallery happens to have (an empty-gallery dev/test run, like this
      // worktree's own un-seeded database, is shorter than the viewport and
      // would otherwise never scroll at all) - confirmed empirically: this
      // check initially passed with scroll-mt-24 deleted from app-shell.tsx,
      // because `page.mouse.wheel()` alone was a no-op against a page with
      // nothing to scroll, so scrollY stayed 0 and the header never actually
      // became "stuck" in the sense this test means to exercise.
      await page.evaluate(() => {
        const filler = document.createElement("div");
        filler.style.height = "2000px";
        filler.setAttribute("data-testid", "e2e-scroll-filler");
        document.body.appendChild(filler);
      });

      // Scroll down - the regression this guards against only shows up once
      // the header is actually stuck to the top rather than sitting in its
      // natural document position. `window.scrollTo`, not `page.mouse.wheel`:
      // confirmed empirically that wheel-event scrolling was unreliable
      // here (returned scrollY 0 even against the 2000px filler above, in
      // this same headless Chromium), where a direct scroll position change
      // was not - and this test cares about the resulting scroll position
      // and the sticky header's behaviour at it, not about simulating the
      // input device.
      await page.evaluate(() => window.scrollTo(0, 600));
      expect(await page.evaluate(() => window.scrollY), "page did not actually scroll").toBeGreaterThan(0);

      const skipLink = page.locator('a[href="#main-content"]');
      await skipLink.focus();
      await page.keyboard.press("Enter");

      const main = page.locator("#main-content");
      await expect(main).toBeFocused();

      const headerBox = await page.locator("header").boundingBox();
      const mainBox = await main.boundingBox();
      expect(headerBox, "header has no box").not.toBeNull();
      expect(mainBox, "main has no box").not.toBeNull();

      // The real relationship this bead's K3 cares about, measured directly
      // rather than assumed from the scroll-mt-24 arithmetic documented in
      // app-shell.tsx: the focused element's top must be at or below the
      // sticky header's own bottom edge, so no part of it sits underneath
      // the header.
      expect(mainBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
    });
  }
});

test.describe("K3: no sales link in the navigation", () => {
  test("the rendered nav contains no link to a sales route", async ({ page }) => {
    await page.goto("/");
    if ((await page.viewportSize())!.width < MD_BREAKPOINT) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }

    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const hrefs = await nav.getByRole("link").evaluateAll((links) =>
      links.map((l) => l.getAttribute("href")),
    );

    expect(hrefs).toEqual(["/", "/about"]);
    for (const href of hrefs) {
      expect(href).not.toMatch(/sale|salgs|shop/i);
    }
  });
});
