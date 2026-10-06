import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

import { loadDevEnvFiles } from "../../scripts/lib/env-files.mjs";

/**
 * ugcportal-qnq9.3 K6's browser half: the RENDERED public gallery carries no
 * commercial affordance on an item that shows alcohol.
 *
 * ITS OWN DIRECTORY AND ITS OWN CONFIG (e2e/seeded/playwright.config.ts), for
 * the reason e2e/production has the same: this spec SEEDS published media, and
 * e2e/front-page.spec.ts asserts the gallery is empty ("K1: the living empty
 * state offers an action, on a genuinely empty gallery", plus a
 * `data-gallery-tile` count of 0). The root config runs `fullyParallel`, so
 * leaving this file beside that one would make the two suites fight over one
 * database and fail each other depending on worker order. Run it with
 * `npm run test:e2e:alcohol-commerce`; the root config ignores this directory.
 *
 * Not wired into CI, same as every other spec here — see
 * playwright.config.ts's own comment.
 *
 * WHAT THIS ADDS OVER `npm test`. The vitest guardrail
 * (src/lib/alcohol-commerce.guardrail.test.ts) drives the real write paths and
 * then reads the TABLES. It cannot see the page: the advertising label is
 * rendered by four different components (ugcportal-e0jv), and a tile that
 * rendered one on the wrong item would satisfy every assertion in that file.
 * This one asks the browser.
 *
 * SEEDED THROUGH RAW SQL over @libsql/client rather than through the generated
 * Prisma client, and not by choice: Playwright loads spec files through its own
 * CJS transform, and `src/generated/prisma/client.ts` uses `import.meta`, which
 * fails there with "Cannot use 'import.meta' outside a module" before any test
 * is collected. @libsql/client is the driver the application itself runs on
 * (via @prisma/adapter-libsql), and src/lib/media.test.ts already reaches for
 * it directly for its own version of this problem.
 *
 * THE TWO ITEMS ARE EXACTLY THE STATES THE GATES PERMIT, not arbitrary
 * fixtures, and that is what keeps this honest:
 *
 *   - the ACCESSORY — an empty glass, alcohol answered `no`, a benefit from a
 *     brand recorded as not alcohol-linked, a permitted label. The write path
 *     and the publish gate both allow this, and it is ugcportal-qnq9.3 K1. Its
 *     tile MUST carry the label.
 *   - the DRINK — a glass of wine, alcohol answered `yes`, published with NO
 *     disclosure, which is the only way the publish gate lets an
 *     alcohol-showing item become public (it is then personal content, not
 *     advertising). Its tile must carry no label, no price and no buy control.
 *
 * The first item is the reason the second assertion means something: without a
 * tile that really does render a label, "no label here" would hold against a
 * selector that matches nothing.
 */

// The same `.env*` precedence `next dev` itself uses, so this writes to the
// file the server under test is reading rather than to Prisma's bare default.
loadDevEnvFiles({ cwd: process.cwd() });

const DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";

const db = createClient({ url: DATABASE_URL });

const OWNER_ID = "e2e-qnq9-3-owner";
const ACCESSORY_ID = "e2e-qnq9-3-accessory";
const DRINK_ID = "e2e-qnq9-3-drink";
const BRAND_ID = "e2e-qnq9-3-brand";
const LABEL = "Advertisement / Reklame";

/** Everything this spec created, removed in the order the foreign keys allow.
 * Run before seeding as well as after, so a crashed run does not leave the
 * next one looking at a database it did not build. Every id it names is
 * prefixed `e2e-qnq9-3-`, so it can never reach a row it did not write. */
async function cleanup() {
  await db.batch(
    [
      `DELETE FROM "MediaAdvertisingDisclosure" WHERE "mediaId" IN ('${ACCESSORY_ID}','${DRINK_ID}')`,
      `DELETE FROM "MediaListing" WHERE "mediaId" IN ('${ACCESSORY_ID}','${DRINK_ID}')`,
      `DELETE FROM "Media" WHERE "id" IN ('${ACCESSORY_ID}','${DRINK_ID}')`,
      `DELETE FROM "BenefitSource" WHERE "id" = '${BRAND_ID}'`,
      `DELETE FROM "User" WHERE "id" = '${OWNER_ID}'`,
    ],
    "write",
  );
}

test.beforeAll(async () => {
  // A `file:` datasource, asserted rather than assumed: this spec writes rows
  // and deletes them again, and doing that to a remote database because
  // DATABASE_URL happened to point at one is not a mistake worth leaving
  // available.
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
      // A brand somebody checked and found clean: a glassmaker. An UNCHECKED
      // brand could not carry a benefit at all, which is K4.
      `INSERT INTO "BenefitSource"
         ("id","slug","name","alcoholLinked","alcoholAnsweredAt","createdAt","updatedAt")
       VALUES ('${BRAND_ID}','e2e-qnq9-3-riedel','Riedel (e2e)',0,'${now}','${now}','${now}')`,

      // The accessory: an empty glass, published, with a benefit and a label.
      `INSERT INTO "Media"
         ("id","userId","kind","key","previewKey","previewId","mimeType","sizeBytes",
          "originalName","altText","createdAt","publishedAt")
       VALUES ('${ACCESSORY_ID}','${OWNER_ID}','IMAGE',
               'media/${OWNER_ID}/accessory.png','previews/${OWNER_ID}/accessory.webp',
               '${ACCESSORY_ID}-preview','image/png',1024,'accessory.png',
               'An empty wine glass on a windowsill','${now}','${now}')`,
      `INSERT INTO "MediaListing"
         ("id","mediaId","currency","depictsPeople","depictsMinors","containsMusic",
          "thirdPartyCreator","sponsoredContent","depictsAlcohol","wineAccessory",
          "triagedByUserId","triagedAt","createdAt","updatedAt")
       VALUES ('${ACCESSORY_ID}-listing','${ACCESSORY_ID}','NOK',0,0,0,0,0,0,1,
               '${OWNER_ID}','${now}','${now}','${now}')`,
      `INSERT INTO "MediaAdvertisingDisclosure"
         ("id","mediaId","benefitReceived","benefitKind","benefitSourceId",
          "marketValueOre","label","createdAt","updatedAt")
       VALUES ('${ACCESSORY_ID}-disclosure','${ACCESSORY_ID}',1,'FREE_PRODUCT',
               '${BRAND_ID}',49900,'${LABEL}','${now}','${now}')`,

      // The drink: a full glass, published, with NOTHING commercial attached —
      // the only shape the publish gate lets an alcohol-showing item take.
      `INSERT INTO "Media"
         ("id","userId","kind","key","previewKey","previewId","mimeType","sizeBytes",
          "originalName","altText","createdAt","publishedAt")
       VALUES ('${DRINK_ID}','${OWNER_ID}','IMAGE',
               'media/${OWNER_ID}/drink.png','previews/${OWNER_ID}/drink.webp',
               '${DRINK_ID}-preview','image/png',1024,'drink.png',
               'A glass of red wine, photographed as wine','${now}','${now}')`,
      `INSERT INTO "MediaListing"
         ("id","mediaId","currency","depictsPeople","depictsMinors","containsMusic",
          "thirdPartyCreator","sponsoredContent","depictsAlcohol","wineAccessory",
          "triagedByUserId","triagedAt","createdAt","updatedAt")
       VALUES ('${DRINK_ID}-listing','${DRINK_ID}','NOK',0,0,0,0,0,1,0,
               '${OWNER_ID}','${now}','${now}','${now}')`,
    ],
    "write",
  );
});

test.afterAll(async () => {
  await cleanup();
  db.close();
});

test("K1: the accessory tile renders its advertising label", async ({ page }) => {
  // The control. Every negative assertion below is about the drink's tile not
  // having something THIS tile demonstrably does have on the same page.
  await page.goto("/");

  await expect(
    page.locator(`[data-gallery-tile="${ACCESSORY_ID}"]`),
  ).toBeAttached();

  const label = page.locator(
    `[data-gallery-advertising-label="${ACCESSORY_ID}"]`,
  );
  await expect(label).toBeVisible();
  await expect(label).toHaveText(LABEL);
});

test("K6: the tile showing the drink carries no advertising label", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator(`[data-gallery-tile="${DRINK_ID}"]`)).toBeAttached();
  await expect(
    page.locator(`[data-gallery-advertising-label="${DRINK_ID}"]`),
  ).toHaveCount(0);
});

test("K6: no tile on the public gallery carries a price or a buy control", async ({
  page,
}) => {
  /*
   * A claim about the whole public surface rather than about one tile, and
   * about the affordances the bead names that this schema can express.
   *
   * The public gallery renders no price and no purchase control TODAY — a
   * price lives on MediaListing and is never projected into the public feed,
   * and checkout is ugcportal-p3v. So this case is the one that notices when
   * that stops being true: when a buy button arrives it will appear on every
   * tile, including the drink's, and this fails rather than shipping.
   *
   * Written over the whole page rather than scoped to the drink's tile on
   * purpose. A price control on the accessory's tile would be lawful; one on
   * the drink's would not; and the cheapest honest assertion while neither
   * exists is that neither does.
   */
  await page.goto("/");

  // Non-vacuous: the gallery really is rendering tiles.
  expect(await page.locator("[data-gallery-tile]").count()).toBeGreaterThan(0);

  await expect(
    page.getByText(/\b(NOK|kr)\s?\d|Buy now|Add to basket/i),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /buy|basket|checkout|purchase/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /buy|basket|checkout|purchase/i }),
  ).toHaveCount(0);
});

test("K6: the drink's tile carries no commercial outbound link", async ({
  page,
}) => {
  /*
   * The fourth affordance the criterion names. There is no commercial-link
   * column yet (ugcportal-qnq9.2), so this asserts the shape rather than a
   * field: every link inside the tile stays on this origin. An affiliate link
   * is by definition off-origin, so the day one is rendered without a gate
   * this fails.
   */
  await page.goto("/");

  const tile = page.locator(`[data-gallery-tile="${DRINK_ID}"]`);
  await expect(tile).toBeAttached();

  const hrefs = await tile
    .locator("a[href]")
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  const offOrigin = hrefs.filter(
    (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("/"),
  );

  expect(offOrigin).toEqual([]);
});
