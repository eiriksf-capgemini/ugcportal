import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * K1/K5/K6 browser verification for the cookie-consent gate (ugcportal-3wgp).
 *
 * K1 and K6 both ask for the same evidence from a different angle: K1 wants
 * no analytics request on first load with the banner visible; K6 wants that
 * proven "across every public route", which here means both routes the bead
 * names explicitly — "/" and "/auth/error", the latter because it is the one
 * page that MUST stay reachable and ungated even for a refused sign-in (see
 * src/lib/routes.ts's AUTH_ERROR_PATH comment), so it is exactly the page a
 * careless gate placed "near" auth rather than globally would miss.
 *
 * NEXT_PUBLIC_UMAMI_SRC/NEXT_PUBLIC_UMAMI_WEBSITE_ID are unset in every
 * environment this suite runs in today (Umami deployment is ugcportal-8at,
 * integration is ugcportal-9w0, neither shipped yet) — so the request-
 * interception assertions below are a real check today (nothing loads full
 * stop) but cannot yet prove the *gated* case (something would load once
 * granted) the way a later run, after 9w0 sets real values, could. The DOM
 * script-src check and the repo-grep test (src/components/consent/
 * analytics-host.grep.test.ts) are what actually pin "umami" as the forbidden
 * string in the meantime.
 */

const ANALYTICS_HOST_MARKER = /umami/i;

async function collectRequestUrls(page: Page): Promise<string[]> {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

const ROUTES = ["/", "/auth/error"] as const;

for (const route of ROUTES) {
  test.describe(`${route} on first load (no stored choice)`, () => {
    test(`K1/K6: no request targets the analytics host`, async ({ page }) => {
      const urls = await collectRequestUrls(page);
      await page.goto(route);
      // Give any afterInteractive script a chance to have fired if it were
      // (wrongly) present.
      await page.waitForLoadState("networkidle");

      const offending = urls.filter((url) => ANALYTICS_HOST_MARKER.test(url));
      expect(offending, JSON.stringify(offending)).toEqual([]);
    });

    test(`K6: no <script> element references the analytics host`, async ({ page }) => {
      await page.goto(route);
      const scriptSrcs = await page.evaluate(() =>
        [...document.querySelectorAll("script[src]")].map(
          (el) => el.getAttribute("src") ?? "",
        ),
      );
      const offending = scriptSrcs.filter((src) => ANALYTICS_HOST_MARKER.test(src));
      expect(offending, JSON.stringify(offending)).toEqual([]);
    });

    test(`K1: the banner is visible with both choices present and focusable`, async ({
      page,
    }) => {
      await page.goto(route);
      const banner = page.getByRole("region", { name: "Cookies" });
      await expect(banner).toBeVisible();

      const accept = banner.getByRole("button", { name: "Accept optional cookies" });
      const onlyNecessary = banner.getByRole("button", { name: "Only necessary" });
      await expect(accept).toBeVisible();
      await expect(onlyNecessary).toBeVisible();

      await accept.focus();
      await expect(accept).toBeFocused();
      await onlyNecessary.focus();
      await expect(onlyNecessary).toBeFocused();
    });
  });
}

test.describe("accepting optional cookies (K2)", () => {
  test("hides the banner and it does not reappear on the next navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("region", { name: "Cookies" })
      .getByRole("button", { name: "Accept optional cookies" })
      .click();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();

    await page.reload();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();
  });
});

test.describe("choosing only necessary (K3)", () => {
  test("hides the banner and it does not reappear on a later visit", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("region", { name: "Cookies" })
      .getByRole("button", { name: "Only necessary" })
      .click();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();

    await page.reload();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();
  });
});

test.describe("the 'Cookies' control (K4)", () => {
  test("reopens the choice after one was already made", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("region", { name: "Cookies" })
      .getByRole("button", { name: "Only necessary" })
      .click();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();

    await page.getByRole("button", { name: "Cookies", exact: true }).click();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeVisible();
  });
});

/*
 * Both color schemes, matching petrol-theme.spec.ts's own convention
 * (ugcportal-rw9j) rather than checking only Playwright's default: the
 * banner's first review round shipped on `bg-popover`, which measured
 * 1.81:1 in dark mode specifically while looking fine by inspection in
 * light — exactly the sibling this loop exists to not omit.
 */
const COLOR_SCHEMES = ["light", "dark"] as const;

for (const scheme of COLOR_SCHEMES) {
  test.describe(`accessibility with the banner open (K5, ${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test("has no automatically detectable axe violations", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("region", { name: "Cookies" })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  });
}
