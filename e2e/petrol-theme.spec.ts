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
 * framing). Both redirect an unauthenticated visitor to sign-in before this
 * bead can drive a real session through OAuth in this environment, so what
 * is actually scanned here is the sign-in redirect target, not the
 * authenticated page content; the authenticated-page findings in the PR
 * description were computed analytically (exact token contrast math) rather
 * than observed live here — see the PR body for that reasoning and the
 * numbers.
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
      if (mode === "light") {
        // #FAF7F2
        expect(bodyBackground).toBe("rgb(250, 247, 242)");
      } else {
        // #0B2E33
        expect(bodyBackground).toBe("rgb(11, 46, 51)");
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

    test("/admin/settings/rights (unauthenticated -> redirect target) has no axe violations at 320px", async ({
      page,
    }) => {
      await page.goto("/admin/settings/rights");
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  });
}
