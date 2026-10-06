import { expect, test } from "@playwright/test";

/**
 * K4 (ugcportal-qnq9.12): Search Console and Pinterest verification must
 * render as inert `<meta>` tags only — never a third-party `<script>` and
 * never a network request before consent, the same "no third-party script
 * runs and no non-essential storage is written" standard
 * e2e/cookie-consent.spec.ts holds the analytics gate to (ugcportal-3wgp).
 * src/lib/site-verification.test.ts covers the pure function that builds the
 * `Metadata["verification"]` object this depends on.
 *
 * Not wired into the `quality` CI job, same reasoning as every other spec in
 * this directory (see playwright.config.ts's own comment) — needs a running
 * `npm run dev` server. GOOGLE_SITE_VERIFICATION/PINTEREST_SITE_VERIFICATION
 * are both optional (env.example) and unset by default, so the "tag present"
 * assertions below are conditional on whichever is actually configured for
 * the server this suite is run against; the "never a script, never a
 * request" assertions hold unconditionally either way.
 */

test("no request targets a Google or Pinterest site-verification endpoint", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const offending = urls.filter((url) => /google[^/]*site[^/]*verif|pinterest[^/]*verif/i.test(url));
  expect(offending, JSON.stringify(offending)).toEqual([]);
});

test("no <script> element references Google or Pinterest site verification", async ({ page }) => {
  await page.goto("/");

  const scriptSrcs = await page.evaluate(() =>
    [...document.querySelectorAll("script[src]")].map((el) => el.getAttribute("src") ?? ""),
  );
  const offending = scriptSrcs.filter((src) =>
    /google[^/]*site[^/]*verif|pinterest[^/]*verif/i.test(src),
  );
  expect(offending, JSON.stringify(offending)).toEqual([]);
});

test("whichever verification tag is configured renders as a <meta> with real content", async ({ page }) => {
  await page.goto("/");

  const meta = await page.evaluate(() => ({
    google: document
      .querySelector('meta[name="google-site-verification"]')
      ?.getAttribute("content") ?? null,
    pinterest: document
      .querySelector('meta[name="p:domain_verify"]')
      ?.getAttribute("content") ?? null,
  }));

  if (meta.google !== null) expect(meta.google.trim()).not.toBe("");
  if (meta.pinterest !== null) expect(meta.pinterest.trim()).not.toBe("");
});
