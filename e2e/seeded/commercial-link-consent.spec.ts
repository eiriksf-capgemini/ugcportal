import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

import { loadDevEnvFiles } from "../../scripts/lib/env-files.mjs";

/**
 * ugcportal-qnq9.2.2 K3's browser half: with no consent decision stored, a
 * page carrying a commercial link makes no request toward any affiliate host
 * and sets no cookie or storage item for one — proven over the REAL rendered
 * link, not a synthetic page, so this fails the day anything turns the bare
 * `<a href>` (GalleryItemCommercialLinks,
 * src/components/gallery/gallery-item.tsx) into something that fires on load.
 *
 * ITS OWN DIRECTORY AND ITS OWN CONFIG (e2e/seeded/playwright.config.ts), for
 * the reason e2e/seeded/alcohol-commerce.spec.ts's own header gives at
 * length: this spec SEEDS published media, which e2e/front-page.spec.ts's
 * "genuinely empty gallery" assertion cannot tolerate sharing a database
 * with. Run it with `npm run test:e2e:commercial-link-consent`; the root
 * config ignores this directory.
 *
 * THE TECHNIQUE (the same one e2e/cookie-consent.spec.ts uses for K1/K6
 * there, cited in this bead as "3wgp"): `page.on("request", ...)` is wired
 * BEFORE `page.goto`, so a request fired during the very first paint is
 * caught, not merely one fired after the page has settled. A test that only
 * polled network activity after load would miss exactly the failure mode
 * this exists to catch — a tracking pixel or a prefetch that fires once and
 * is gone before any poll runs.
 *
 * SEEDED THROUGH RAW SQL over @libsql/client, not the generated Prisma
 * client, for the identical reason alcohol-commerce.spec.ts gives: Playwright
 * loads spec files through its own CJS transform, and the generated client
 * uses `import.meta`, which fails there before any test is collected.
 *
 * THE DESTINATION HOST IS DELIBERATELY ONE PLAYWRIGHT'S OWN BROWSER CANNOT
 * REACH (`track.e2e-qnq9-2-2.invalid`, a reserved TLD per RFC 2606) — not
 * because the test relies on the request failing, but so that if the bare
 * anchor ever DID start firing a request on load, this spec's own assertion
 * would catch a request to a host that could only come from the commercial
 * link, never from some other legitimate same-origin asset sharing a
 * coincidental substring.
 */

// The same `.env*` precedence `next dev` itself uses, so this writes to the
// file the server under test is reading rather than to Prisma's bare default.
loadDevEnvFiles({ cwd: process.cwd() });

const DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";

const db = createClient({ url: DATABASE_URL });

const OWNER_ID = "e2e-qnq9-2-2-owner";
const MEDIA_ID = "e2e-qnq9-2-2-media";
const BRAND_ID = "e2e-qnq9-2-2-brand";
const LABEL = "Advertisement / Reklame";
const LINK_HOST = "track.e2e-qnq9-2-2.invalid";
const LINK_URL = `https://${LINK_HOST}/t/t?a=1`;
const MARKER_TEXT = "Advertisement link / Annonselenke";

/** Everything this spec created, removed in the order the foreign keys allow.
 * Run before seeding as well as after, so a crashed run does not leave the
 * next one looking at a database it did not build. Every id it names is
 * prefixed `e2e-qnq9-2-2-`, so it can never reach a row it did not write. */
async function cleanup() {
  await db.batch(
    [
      `DELETE FROM "CommercialLink" WHERE "mediaId" = '${MEDIA_ID}'`,
      `DELETE FROM "MediaAdvertisingDisclosure" WHERE "mediaId" = '${MEDIA_ID}'`,
      `DELETE FROM "Media" WHERE "id" = '${MEDIA_ID}'`,
      `DELETE FROM "BenefitSource" WHERE "id" = '${BRAND_ID}'`,
      `DELETE FROM "User" WHERE "id" = '${OWNER_ID}'`,
    ],
    "write",
  );
}

test.beforeAll(async () => {
  // A `file:` datasource, asserted rather than assumed — same guard
  // alcohol-commerce.spec.ts carries, for the identical reason: this suite
  // writes rows and deletes them again, and doing that to a remote database
  // because DATABASE_URL happened to point at one is not a mistake worth
  // leaving available.
  expect(
    DATABASE_URL.startsWith("file:"),
    `this suite only seeds a local file database; DATABASE_URL is ${DATABASE_URL}`,
  ).toBe(true);

  await cleanup();

  const now = new Date().toISOString();

  await db.batch(
    [
      `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
       VALUES ('${OWNER_ID}','${OWNER_ID}@example.test','USER','${now}','${now}')`,
      // A brand cleanly answered on alcohol, so the item publishes at all
      // (alkoholloven § 9-2 is out of scope for this spec — K6 already
      // covers it — this fixture just has to be one the real gates permit).
      `INSERT INTO "BenefitSource"
         ("id","slug","name","alcoholLinked","alcoholAnsweredAt","createdAt","updatedAt")
       VALUES ('${BRAND_ID}','e2e-qnq9-2-2-brand','E2E Brand (e2e)',0,'${now}','${now}','${now}')`,
      `INSERT INTO "Media"
         ("id","userId","kind","key","previewKey","previewId","mimeType","sizeBytes",
          "originalName","altText","createdAt","publishedAt")
       VALUES ('${MEDIA_ID}','${OWNER_ID}','IMAGE',
               'media/${OWNER_ID}/item.png','previews/${OWNER_ID}/item.webp',
               '${MEDIA_ID}-preview','image/png',1024,'item.png',
               'A product photo with a commercial link','${now}','${now}')`,
      `INSERT INTO "MediaAdvertisingDisclosure"
         ("id","mediaId","benefitReceived","benefitKind","benefitSourceId",
          "marketValueOre","label","createdAt","updatedAt")
       VALUES ('${MEDIA_ID}-disclosure','${MEDIA_ID}',1,'FREE_PRODUCT',
               '${BRAND_ID}',49900,'${LABEL}','${now}','${now}')`,
      `INSERT INTO "CommercialLink"
         ("id","mediaId","url","network","networkOther","benefitSourceId","createdAt","updatedAt")
       VALUES ('${MEDIA_ID}-link','${MEDIA_ID}','${LINK_URL}','ADTRACTION',NULL,
               '${BRAND_ID}','${now}','${now}')`,
    ],
    "write",
  );
});

test.afterAll(async () => {
  await cleanup();
  db.close();
});

test("K1 control: the item renders its label, the link and the bilingual marker", async ({
  page,
}) => {
  // The control every negative assertion below leans on: if the link were
  // not really on the page, "no request toward it" would be vacuously true.
  await page.goto("/");

  await expect(page.locator(`[data-gallery-tile="${MEDIA_ID}"]`)).toBeAttached();
  await expect(
    page.locator(`[data-gallery-advertising-label="${MEDIA_ID}"]`),
  ).toBeVisible();

  const link = page.locator(`[data-commercial-link="${MEDIA_ID}-link"]`);
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", LINK_URL);
  await expect(link).toHaveAttribute("rel", "sponsored nofollow noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.getByText(MARKER_TEXT)).toBeVisible();
});

test("K3: no request targets the affiliate host before any consent choice is made", async ({
  page,
}) => {
  const requestUrls: string[] = [];
  // Wired BEFORE goto, same ordering e2e/cookie-consent.spec.ts's own K1/K6
  // technique uses, so a request fired during first paint is caught rather
  // than missed by a poll that started after the fact.
  page.on("request", (request) => requestUrls.push(request.url()));

  await page.goto("/");
  await expect(page.locator(`[data-commercial-link="${MEDIA_ID}-link"]`)).toBeVisible();
  // Give any load-triggered script a chance to have fired if it were
  // (wrongly) present — the same wait e2e/cookie-consent.spec.ts uses.
  await page.waitForLoadState("networkidle");

  const offending = requestUrls.filter((url) => url.includes(LINK_HOST));
  expect(offending, JSON.stringify(offending)).toEqual([]);
});

test("K3: no cookie is set for the affiliate host, before or after the page has loaded", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(`[data-commercial-link="${MEDIA_ID}-link"]`)).toBeVisible();
  await page.waitForLoadState("networkidle");

  const cookies = await page.context().cookies();
  const offending = cookies.filter(
    (cookie) => cookie.domain.includes(LINK_HOST) || cookie.name.toLowerCase().includes("adtraction"),
  );
  expect(offending, JSON.stringify(offending)).toEqual([]);
});

test("K3: no localStorage or sessionStorage entry mentions the affiliate link or its network", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(`[data-commercial-link="${MEDIA_ID}-link"]`)).toBeVisible();
  await page.waitForLoadState("networkidle");

  const storageDump = await page.evaluate(() => ({
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
  }));
  const serialised = JSON.stringify(storageDump);
  expect(serialised).not.toContain(LINK_HOST);
  expect(serialised).not.toContain("adtraction");
});

test("K3: the anchor itself carries no inline handler and is a plain navigable link", async ({
  page,
}) => {
  // The structural guarantee behind every assertion above: this is a bare
  // `<a href>`, so there is nothing attached to it that COULD fire before
  // activation. Checked directly on the live DOM rather than only inferred
  // from "no request happened" above, which an inert, broken link would also
  // satisfy for the wrong reason.
  await page.goto("/");

  const handle = page.locator(`[data-commercial-link="${MEDIA_ID}-link"]`);
  await expect(handle).toBeVisible();

  const attributes = await handle.evaluate((el) =>
    Array.from(el.attributes).map((attr) => attr.name),
  );
  const onAttributes = attributes.filter((name) => name.toLowerCase().startsWith("on"));
  expect(onAttributes).toEqual([]);
});
