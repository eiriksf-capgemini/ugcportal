import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

import { loadDevEnvFiles } from "../../scripts/lib/env-files.mjs";

/**
 * ugcportal-qnq9.11 K4 (ii): an item recorded as showing alcohol
 * (`depictsAlcohol = true`) is served on NO public surface, and the page never
 * learned it was withheld.
 *
 * OPTION (a), TRUE-ONLY (decided 2026-10-14, ugcportal-6yrd). The withholding
 * is a widening of the read arm in src/lib/alcohol-commerce.ts, so this spec is
 * about what the BROWSER is given: the alcohol-recorded item's previewId is
 * absent from the front page, from the gallery after scrolling, from the open
 * lightbox walked in both directions past its ends (three slides are served,
 * the fewest on which photoswipe loops), and from /portfolio.
 *
 * FOUR ITEMS, all portfolio-tagged so /portfolio has something to show:
 *
 *   - the COMMERCIAL item: an empty glass, alcohol answered `no`, a benefit
 *     from a clean brand, a permitted label. Served. It is the control that
 *     makes every absence below mean something (a page that rendered nothing
 *     would pass the absences alone), and it is the tile the lightbox opens.
 *   - a second COMMERCIAL item and a PERSONAL item (alcohol answered `no`,
 *     nothing commercial). Served. They exist so the gallery serves three
 *     items: photoswipe loops only with more than two slides
 *     (`canLoop()` checks `getNumItems() > 2`), so with fewer the lightbox
 *     walk would stop at its ends and never wrap.
 *   - the ALCOHOL item: a glass of wine, `depictsAlcohol = 1`, nothing
 *     commercial. Withheld.
 *
 * Seeded as published rows (raw SQL, for the reason alcohol-commerce.spec.ts
 * gives: Playwright's CJS transform cannot load the generated Prisma client).
 * The e2e harness seeds published, attested, preview-complete rows directly
 * because it has no login session; the publish route is exercised in the
 * vitest read-path test (src/lib/alcohol-commerce.read-path.test.ts), against
 * a real database. This spec therefore exercises the read arm and the
 * rendered pages only.
 *
 * Run with `npm run test:e2e:withhold-alcohol-recorded`. Not wired into CI,
 * like every spec in this directory.
 */

loadDevEnvFiles({ cwd: process.cwd() });

const DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";
const db = createClient({ url: DATABASE_URL });

const OWNER_ID = "e2e-qnq9-11-owner";
const COMMERCIAL_ID = "e2e-qnq9-11-commercial";
const COMMERCIAL_TWO_ID = "e2e-qnq9-11-commercial-two";
const PERSONAL_ID = "e2e-qnq9-11-personal";
const ALCOHOL_ID = "e2e-qnq9-11-alcohol";
const BRAND_ID = "e2e-qnq9-11-brand";
// src/lib/attestation.ts CURRENT_ATTESTATION_VERSION, copied rather than
// imported for the reason this file seeds with raw SQL at all. The public
// scope serves only a row attested at the current version, so a seed without
// this serves nothing and every presence assertion below fails.
const ATTESTATION_VERSION = "2026-10-08.1";
const PORTFOLIO_TAG_ID = "tagseed00portfolio";
const COMMERCIAL_PREVIEW = `${COMMERCIAL_ID}-preview`;
const ALCOHOL_PREVIEW = `${ALCOHOL_ID}-preview`;
const SERVED_IDS = [COMMERCIAL_ID, COMMERCIAL_TWO_ID, PERSONAL_ID];

async function cleanup() {
  const ids = [...SERVED_IDS, ALCOHOL_ID].map((id) => `'${id}'`).join(",");
  await db.batch(
    [
      `DELETE FROM "_MediaToTag" WHERE "A" IN (${ids})`,
      `DELETE FROM "MediaAttestation" WHERE "mediaId" IN (${ids})`,
      `DELETE FROM "MediaAdvertisingDisclosure" WHERE "mediaId" IN (${ids})`,
      `DELETE FROM "MediaListing" WHERE "mediaId" IN (${ids})`,
      `DELETE FROM "Media" WHERE "id" IN (${ids})`,
      `DELETE FROM "BenefitSource" WHERE "id" = '${BRAND_ID}'`,
      `DELETE FROM "User" WHERE "id" = '${OWNER_ID}'`,
    ],
    "write",
  );
}

function mediaInsert(id: string, alt: string, now: string): string {
  return `INSERT INTO "Media"
      ("id","userId","kind","key","previewKey","previewId","mimeType","sizeBytes",
       "originalName","altText","createdAt","publishedAt")
    VALUES ('${id}','${OWNER_ID}','IMAGE',
            'media/${OWNER_ID}/${id}.png','previews/${OWNER_ID}/${id}.webp',
            '${id}-preview','image/png',1024,'${id}.png','${alt}','${now}','${now}')`;
}

function listingInsert(id: string, depictsAlcohol: 0 | 1, now: string): string {
  return `INSERT INTO "MediaListing"
      ("id","mediaId","currency","depictsPeople","depictsMinors","containsMusic",
       "thirdPartyCreator","sponsoredContent","depictsAlcohol","wineAccessory",
       "triagedByUserId","triagedAt","createdAt","updatedAt")
    VALUES ('${id}-listing','${id}','NOK',0,0,0,0,0,${depictsAlcohol},${depictsAlcohol ? 0 : 1},
            '${OWNER_ID}','${now}','${now}','${now}')`;
}

function attestationInsert(id: string): string {
  return `INSERT INTO "MediaAttestation"
      ("id","mediaId","attestedByUserId","attestationVersion","authorship",
       "ownOriginalNotFromWeb","showsIdentifiablePeople","showsMinors",
       "containsMusicNotOwned","otherCreativeContributor","brandOrSponsorship",
       "aiGenerated","uploaderIsAdult")
    VALUES ('${id}-attestation','${id}','${OWNER_ID}',
            '${ATTESTATION_VERSION}','AUTHOR',1,0,0,0,0,1,0,1)`;
}

function disclosureInsert(id: string, now: string): string {
  return `INSERT INTO "MediaAdvertisingDisclosure"
      ("id","mediaId","benefitReceived","benefitKind","benefitSourceId",
       "marketValueOre","label","createdAt","updatedAt")
    VALUES ('${id}-disclosure','${id}',1,'FREE_PRODUCT',
            '${BRAND_ID}',49900,'Advertisement / Reklame','${now}','${now}')`;
}

test.beforeAll(async () => {
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
      `INSERT INTO "BenefitSource"
         ("id","slug","name","alcoholLinked","alcoholAnsweredAt","createdAt","updatedAt")
       VALUES ('${BRAND_ID}','e2e-qnq9-11-riedel','Riedel (e2e)',0,'${now}','${now}','${now}')`,

      mediaInsert(COMMERCIAL_ID, "An empty wine glass on a windowsill", now),
      `INSERT INTO "MediaAttestation"
         ("id","mediaId","attestedByUserId","attestationVersion","authorship",
          "ownOriginalNotFromWeb","showsIdentifiablePeople","showsMinors",
          "containsMusicNotOwned","otherCreativeContributor","brandOrSponsorship",
          "aiGenerated","uploaderIsAdult")
       VALUES ('${COMMERCIAL_ID}-attestation','${COMMERCIAL_ID}','${OWNER_ID}',
               '${ATTESTATION_VERSION}','AUTHOR',1,0,0,0,0,1,0,1)`,
      listingInsert(COMMERCIAL_ID, 0, now),
      `INSERT INTO "MediaAdvertisingDisclosure"
         ("id","mediaId","benefitReceived","benefitKind","benefitSourceId",
          "marketValueOre","label","createdAt","updatedAt")
       VALUES ('${COMMERCIAL_ID}-disclosure','${COMMERCIAL_ID}',1,'FREE_PRODUCT',
               '${BRAND_ID}',49900,'Advertisement / Reklame','${now}','${now}')`,

      mediaInsert(ALCOHOL_ID, "A glass of red wine, photographed as wine", now),
      `INSERT INTO "MediaAttestation"
         ("id","mediaId","attestedByUserId","attestationVersion","authorship",
          "ownOriginalNotFromWeb","showsIdentifiablePeople","showsMinors",
          "containsMusicNotOwned","otherCreativeContributor","brandOrSponsorship",
          "aiGenerated","uploaderIsAdult")
       VALUES ('${ALCOHOL_ID}-attestation','${ALCOHOL_ID}','${OWNER_ID}',
               '${ATTESTATION_VERSION}','AUTHOR',1,0,0,0,0,1,0,1)`,
      listingInsert(ALCOHOL_ID, 1, now),

      mediaInsert(COMMERCIAL_TWO_ID, "A second empty wine glass on a shelf", now),
      attestationInsert(COMMERCIAL_TWO_ID),
      listingInsert(COMMERCIAL_TWO_ID, 0, now),
      disclosureInsert(COMMERCIAL_TWO_ID, now),

      mediaInsert(PERSONAL_ID, "A bookshelf by the window", now),
      attestationInsert(PERSONAL_ID),
      listingInsert(PERSONAL_ID, 0, now),

      ...[...SERVED_IDS, ALCOHOL_ID].map(
        (id) =>
          `INSERT INTO "_MediaToTag" ("A","B") VALUES ('${id}','${PORTFOLIO_TAG_ID}')`,
      ),
    ],
    "write",
  );
});

test.afterAll(async () => {
  await cleanup();
  db.close();
});

async function expectNoAlcoholItem(page: import("@playwright/test").Page) {
  expect(await page.content()).not.toContain(ALCOHOL_PREVIEW);
  expect(await page.content()).not.toContain(ALCOHOL_ID);
  await expect(page.locator(`[data-gallery-tile="${ALCOHOL_ID}"]`)).toHaveCount(0);
}

test("front page and scrolled gallery: the commercial item is served, the alcohol-recorded item is not anywhere", async ({
  page,
}) => {
  await page.goto("/");

  // The control: the commercial tile is really there, so the absences below
  // are not a page that rendered nothing.
  await expect(
    page.locator(`[data-gallery-tile="${COMMERCIAL_ID}"]`),
  ).toBeAttached();
  expect(await page.content()).toContain(COMMERCIAL_PREVIEW);
  await expectNoAlcoholItem(page);

  // Scrolled to the bottom, where the next page would be requested.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForLoadState("networkidle");
  await expectNoAlcoholItem(page);
});

test("the feed API the gallery pages through never returns the alcohol-recorded item", async ({
  request,
}) => {
  const response = await request.get("/api/public/media");
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain(COMMERCIAL_ID);
  expect(body).not.toContain(ALCOHOL_ID);
  expect(body).not.toContain(ALCOHOL_PREVIEW);
  // The feed response carries no `depictsAlcohol` field (K4); asserted here.
  expect(body).not.toContain("depictsAlcohol");
});

test("lightbox: three served slides, walked past both ends so it really wraps, and the alcohol-recorded item never appears", async ({
  page,
}) => {
  await page.goto("/");
  // The three served tiles are all on the page, the alcohol-recorded one is
  // not: the lightbox is built from these tiles.
  for (const id of SERVED_IDS) {
    await expect(page.locator(`[data-gallery-tile="${id}"]`)).toBeAttached();
  }
  await expect(page.locator(`[data-gallery-tile="${ALCOHOL_ID}"]`)).toHaveCount(0);

  await page.locator(`[data-gallery-tile="${COMMERCIAL_ID}"]`).click();
  const lightbox = page.locator(".pswp");
  await expect(lightbox).toBeAttached();
  const counter = lightbox.locator(".pswp__counter");

  // The lightbox's own slide counter is the evidence the walk wraps: the total
  // is exactly the three served items (the withheld one is not a fourth), and
  // photoswipe loops only with more than two slides, so ArrowRight from the
  // last slide lands on the first and ArrowLeft from the first on the last.
  // The slide DOM carries no preview id here (the images do not load without
  // object storage), so what the walk asserts about the withheld item is its
  // id, preview id and alt text never appearing in the lightbox, with the
  // tile assertions above as the presence control.
  const positions: string[] = [];
  const collect = async () => {
    const html = await lightbox.innerHTML();
    expect(html).not.toContain(ALCOHOL_PREVIEW);
    expect(html).not.toContain(ALCOHOL_ID);
    expect(html).not.toContain("photographed as wine");
    positions.push(((await counter.textContent()) ?? "").trim());
  };
  await collect();
  for (const key of [
    ...Array<string>(4).fill("ArrowRight"),
    ...Array<string>(4).fill("ArrowLeft"),
  ]) {
    await page.keyboard.press(key);
    // Let the slide transition settle before reading the counter.
    await page.waitForTimeout(400);
    await collect();
  }
  expect(new Set(positions.map((p) => p.split("/")[1]?.trim()))).toEqual(
    new Set(["3"]),
  );
  // Four steps right then four left from wherever the click landed cover every
  // position, and a wrap is a step between positions two apart (3 to 1 going
  // right, 1 to 3 going left); a non-looping ring only ever moves by one.
  expect(new Set(positions.map((p) => p.split("/")[0]?.trim()))).toEqual(
    new Set(["1", "2", "3"]),
  );
  const wrapped = positions.some((p, i) => {
    const prev = positions[i - 1];
    if (prev === undefined) return false;
    const n = (x: string) => Number(x.split("/")[0]);
    return Math.abs(n(p) - n(prev)) === 2;
  });
  expect(wrapped, `counter sequence ${positions.join(", ")}`).toBe(true);
  expect(await page.content()).not.toContain(ALCOHOL_PREVIEW);
});

test("portfolio: the commercial item is listed, the alcohol-recorded item is not", async ({
  page,
}) => {
  await page.goto("/portfolio");
  expect(await page.content()).toContain(COMMERCIAL_PREVIEW);
  expect(await page.content()).not.toContain(ALCOHOL_PREVIEW);
  expect(await page.content()).not.toContain(ALCOHOL_ID);
});
