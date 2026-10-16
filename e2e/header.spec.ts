import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { MD_BREAKPOINT_PX } from "../src/lib/breakpoints";
import { hasHorizontalScroll } from "./has-horizontal-scroll";
import { signedInTest } from "./signed-in-fixture";

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

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`header at ${name} (${viewport.width}px)`, () => {
    test.use({ viewport });

    test("K1: wordmark and navigation are visible with no horizontal scroll", async ({
      page,
    }) => {
      await page.goto("/");

      // ugcportal-6uxr K2: scoped to the header's own banner landmark, not
      // the whole page — see this file's header comment for why an
      // unscoped `getByRole("link", { name: "UGC Portal" })` is unsafe.
      const banner = page.getByRole("banner");
      await expect(banner.getByRole("link", { name: "UGC Portal" })).toBeVisible();

      // Below md (768px), the nav lives behind the mobile menu toggle - see
      // mobile-nav-toggle.tsx's own comment for why it collapsed rather than
      // staying inline: at 375px, alongside the sign-in control and up to
      // two nav links, the row no longer fit without a long email also
      // being present (app-shell.tsx's pre-existing narrow-viewport
      // tuning). "Visible" there means what's rendered without
      // interaction is the toggle itself, not nothing - the nav items
      // become visible the moment it is activated, checked below.
      if (viewport.width < MD_BREAKPOINT_PX) {
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

      if (viewport.width < MD_BREAKPOINT_PX) {
        // Below md the nav is hidden entirely (see mobile-nav-toggle.tsx)
        // until the toggle - the next, and only other, focusable element at
        // this width - is activated with the keyboard.
        await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
        await page.keyboard.press("Enter");
        // `@base-ui/react/popover`'s own default `initialFocus` (PR #94
        // review round 3/4): opening via any NON-TOUCH interaction - a
        // click or, as here, Enter on the trigger - moves focus straight
        // to the first tabbable element inside the panel; touch is the
        // one documented exception (it focuses the popup itself instead,
        // to avoid opening the virtual keyboard). Not "keyboard only", and
        // not left on the toggle button the way the hand-rolled version
        // this replaced did - one fewer Tab press to reach "Gallery" below.
      }

      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await expect(nav.getByRole("link", { name: "Gallery" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(nav.getByRole("link", { name: "About" })).toBeFocused();

      // ugcportal-qnq9.7 (the About page) shipped in #93 — this just proves
      // the nav ITEM is keyboard-activatable and navigates, which is all K1
      // asks for; the page's own content is e2e/about-portfolio.spec.ts's
      // claim, not this file's.
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

/**
 * ugcportal-qqnt.3 K1, exactly as the bead names it: "Given a signed-out
 * visitor at 1440x900, when the header renders, it is one row no taller
 * than 64px, the wordmark's computed font-size is larger than the nav
 * links', and exactly one sign-in control is present."
 */
test.describe("ugcportal-qqnt.3 K1: header hierarchy at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the header is one row no taller than 64px", async ({ page }) => {
    await page.goto("/");

    const headerBox = await page.locator("header").boundingBox();
    expect(headerBox, "header has no box").not.toBeNull();
    expect(headerBox!.height).toBeLessThanOrEqual(64);
  });

  test("the wordmark's computed font-size is larger than the nav links'", async ({ page }) => {
    await page.goto("/");

    // ugcportal-6uxr K2: scoped to the banner landmark — see K1 test above.
    const wordmarkSize = await page
      .getByRole("banner")
      .getByRole("link", { name: "UGC Portal" })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const navLinkSize = await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Gallery" })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    expect(wordmarkSize, `wordmark: ${wordmarkSize}px, nav: ${navLinkSize}px`).toBeGreaterThan(
      navLinkSize,
    );
  });

  test("exactly one control's accessible name starts with 'Sign in'", async ({ page }) => {
    await page.goto("/");

    const signInControls = await page.getByRole("button", { name: /^Sign in/ }).count();
    expect(signInControls).toBe(1);
  });

  /**
   * K2: "Given the one sign-in control, when activated, both providers
   * remain reachable" - clicked through here, not completed (there is no
   * reachable Google/Facebook IdP in this test environment).
   */
  test("K2: activating Sign in reveals both provider choices", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("button", { name: /Google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Facebook/i })).toBeVisible();
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
    if ((await page.viewportSize())!.width < MD_BREAKPOINT_PX) {
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

/**
 * ugcportal-0wh6 K1/K2: the same header, SIGNED IN. Everything above this
 * block runs signed out; these tests request the `signedIn` fixture
 * (e2e/signed-in-fixture.ts), which seeds a real database session and sets
 * its cookie before the page loads.
 *
 * 320 and 390 are the widths ugcportal-i7lr K4 and ugcportal-ry6w ask about
 * (390 is the signed-in view ry6w's wordmark report is about); 1440 is the
 * desktop layout, where Upload sits in the inline nav instead of behind the
 * menu toggle. The assertions that would read the same signed out ("Sign in"
 * absent, "Sign out" and "Upload" present) are deliberately the ones a
 * signed-out page fails: a fixture that quietly stopped signing the test in
 * turns every one of these red, rather than leaving a page that has no
 * signed-in content to check.
 */
const SIGNED_IN_VIEWPORTS = {
  mobile320: { width: 320, height: 720 },
  mobile390: { width: 390, height: 844 },
  desktop1440: { width: 1440, height: 900 },
} as const;

for (const [name, viewport] of Object.entries(SIGNED_IN_VIEWPORTS)) {
  signedInTest.describe(`signed-in header at ${name} (${viewport.width}px)`, () => {
    signedInTest.use({ viewport });

    signedInTest("K1: renders the signed-in header, including the Upload entry", async ({
      page,
      signedIn,
    }) => {
      expect(signedIn.userId).toMatch(/^e2e-0wh6-/);
      await page.goto("/");

      const banner = page.getByRole("banner");
      await expect(banner.getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(banner.getByRole("button", { name: /^Sign in/ })).toHaveCount(0);

      if (viewport.width < MD_BREAKPOINT_PX) {
        await banner.getByRole("button", { name: "Open menu" }).click();
      }
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await expect(nav.getByRole("link", { name: "Upload" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Upload" })).toHaveAttribute("href", "/upload");
    });

    if (viewport.width < MD_BREAKPOINT_PX) {
      signedInTest("K2: axe scans the signed-in header, menu closed and open, with no violations", async ({
        page,
        signedIn,
      }) => {
        expect(signedIn.userId).toMatch(/^e2e-0wh6-/);
        await page.goto("/");
        const banner = page.getByRole("banner");
        // Signed in BEFORE axe runs, so the scan below is of a signed-in page.
        await expect(banner.getByRole("button", { name: "Sign out" })).toBeVisible();

        const closed = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(closed.violations, JSON.stringify(closed.violations, null, 2)).toEqual([]);

        // Below md the Upload entry exists only inside the opened menu, so a
        // closed-menu scan never sees it. Open it and scan again.
        //
        // EXCLUDED from that second scan: @base-ui/react/popover's own focus
        // guards (`<span aria-hidden="true" tabindex="0"
        // data-base-ui-focus-guard>`), which axe flags as aria-hidden-focus.
        // That violation is not about being signed in — it reproduces signed
        // out with the menu open at 390px — and is tracked as ugcportal-bmst,
        // whose fix removes this exclude. Only those spans are excluded; every
        // other node, the menu's links included, is still scanned.
        await banner.getByRole("button", { name: "Open menu" }).click();
        await expect(
          page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Upload" }),
        ).toBeVisible();
        const open = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .exclude("[data-base-ui-focus-guard]")
          .analyze();
        expect(open.violations, JSON.stringify(open.violations, null, 2)).toEqual([]);

        // Evidence the second scan's TARGET included the signed-in entries,
        // not just that it ran: axe reports the nodes each passing rule
        // checked (by selector), and both the visible Upload link and the
        // Sign out button must be among them. Resolved in the page rather
        // than by matching axe's `html` strings: tried first, those did not
        // carry the Sign out button's text, so that check failed on a page
        // that was signed in. The Upload link must be the RENDERED one (the
        // desktop nav's copy is in the DOM but not laid out below md).
        const targets = open.passes.flatMap((rule) =>
          rule.nodes.map((node) => String(node.target[0])),
        );
        const reached = await page.evaluate((selectors) => {
          const elements = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
          return {
            upload: elements.some(
              (el) => el.matches('a[href="/upload"]') && el.getClientRects().length > 0,
            ),
            signOut: elements.some(
              (el) => el.tagName === "BUTTON" && el.textContent?.trim() === "Sign out",
            ),
          };
        }, targets);
        expect(reached).toEqual({ upload: true, signOut: true });
      });
    }
  });
}
