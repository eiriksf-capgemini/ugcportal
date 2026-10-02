import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * K1/K2 browser verification for the petrol palette (ugcportal-rw9j).
 *
 * In scope for this PR (phase 1): the home page, in both colour-scheme
 * emulations, at desktop and at 320px.
 *
 * Also run here, deliberately, as this bead's "held-back check": /upload and
 * an admin settings page — pages this PR does NOT change — specifically to
 * catch a cross-page regression from the global token change (K2's own
 * framing). Neither renders its authenticated content to an unauthenticated
 * visitor, but NOT the same way (round 5, code-review: the comment here
 * previously claimed both redirect to sign-in — false for the admin page).
 * /upload's own auth gate (`getSession()` + `redirect(signInPath(...))`,
 * src/app/upload/page.tsx) really does redirect to sign-in, so that half of
 * this held-back check scans the sign-in redirect target. The three admin
 * settings pages (rights/users/instagram) instead call `requireAdmin()` and,
 * on failure, Next's `notFound()` (src/app/admin/settings/rights/page.tsx)
 * — a 404, not a redirect - so what the "admin settings" half of this check
 * actually scans is Next's built-in not-found page (this app ships no
 * custom not-found.tsx), not a sign-in page at all. The authenticated-page
 * findings in the PR description were computed analytically (exact token
 * contrast math) rather than observed live here either way — see the PR
 * body for that reasoning and the numbers.
 */

const MODES = ["light", "dark"] as const;
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile320: { width: 320, height: 720 },
};

for (const mode of MODES) {
  test.describe(`home page (${mode})`, () => {
    test.use({ colorScheme: mode });

    test(`has no automatically detectable axe violations at desktop`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto("/");
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });

    test(`has no automatically detectable axe violations at 320px`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.mobile320);
      await page.goto("/");
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });

    test("K1: page background and primary-button fill render at the adopted token", async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.desktop);
      await page.goto("/");
      const bodyBackground = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );

      /*
       * round 5: this test's own title has claimed to check the primary
       * button's fill since round 1, but the body below it never queried a
       * button element at all - a family-3 defect (an assertion that reads
       * as coverage but cannot fail on the thing it names).
       *
       * The header's "Skip to content" link (src/components/app-shell.tsx)
       * is used as the live DOM target instead of the gallery's own
       * default-variant Button: `bg-primary text-primary-foreground` is the
       * exact utility pair button.tsx's `default` variant ships
       * (src/components/ui/button.tsx), so the two resolve to the same
       * computed colours, and the skip link is the only place in this app's
       * chrome where that pair is guaranteed to render regardless of
       * database content. The gallery's own default-variant Button ("Load
       * more") only renders when a second page exists (hasMore), which this
       * suite has no fixture/seeding to guarantee - there is no e2e
       * database-seeding infrastructure in this repo yet (tracked
       * separately, ugcportal-4zgy). `sr-only` positions the link off-screen
       * but does not touch background-color/color, so the computed values
       * below are real regardless of focus state.
       */
      const skipLink = page.locator('a[href="#main-content"]');
      const primaryFill = await skipLink.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      const primaryLabel = await skipLink.evaluate(
        (el) => getComputedStyle(el).color,
      );

      if (mode === "light") {
        // #FAF7F2
        expect(bodyBackground).toBe("rgb(250, 247, 242)");
        // --primary: --petrol-700 (#14555F), --primary-foreground: #ffffff
        expect(primaryFill).toBe("rgb(20, 85, 95)");
        expect(primaryLabel).toBe("rgb(255, 255, 255)");
      } else {
        // #0B2E33
        expect(bodyBackground).toBe("rgb(11, 46, 51)");
        // --primary: --petrol-200 (#9FC5C8), --primary-foreground: --petrol-900 (#0B2E33)
        expect(primaryFill).toBe("rgb(159, 197, 200)");
        expect(primaryLabel).toBe("rgb(11, 46, 51)");
      }
    });
  });
}

for (const mode of MODES) {
  test.describe(`held-back cross-page check (${mode})`, () => {
    test.use({ colorScheme: mode, viewport: VIEWPORTS.mobile320 });

    test("/upload (unauthenticated -> sign-in redirect target) has no axe violations at 320px", async ({
      page,
    }) => {
      await page.goto("/upload");
      const results = await new AxeBuilder({ page })
        // image-alt excluded: Auth.js's own built-in provider-picker page
        // (authjs.dev's provider icons ship with no alt text) — pre-existing,
        // not rendered by this app's code, and not a colour/contrast issue,
        // so out of scope for this bead. Confirmed present before this PR
        // too (it is Auth.js's default template, independent of the palette).
        .disableRules(["image-alt"])
        .analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });

    test("/admin/settings/rights (unauthenticated -> Next's not-found page, not a redirect) has no axe violations at 320px", async ({
      page,
    }) => {
      await page.goto("/admin/settings/rights");
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  });
}
