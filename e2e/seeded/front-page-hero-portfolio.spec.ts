import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

import { loadDevEnvFiles } from "../../scripts/lib/env-files.mjs";

/**
 * ugcportal-qqnt.4 K1: "Given at least three portfolio pieces with previews,
 * when / renders at 1440x900, three <img> elements with non-empty alt text
 * are visible inside the hero and no element with data-home-hero-decoration
 * remains."
 *
 * ITS OWN FILE, THE SAME DIRECTORY AS e2e/seeded/alcohol-commerce.spec.ts,
 * for the identical reason that file's own config comment gives: this spec
 * SEEDS published media (three portfolio-tagged photographs), and the root
 * suite's e2e/front-page.spec.ts asserts a genuinely empty gallery down to a
 * `data-gallery-tile` count of 0 — a seeding spec sitting beside it under the
 * root config's `fullyParallel: true` would make the two fail each other
 * nondeterministically. Run with `npm run test:e2e:hero-portfolio`; the root
 * config already ignores this whole directory (`**\/seeded/**`).
 *
 * SEEDED THROUGH RAW SQL over @libsql/client, not the generated Prisma
 * client, for the same reason alcohol-commerce.spec.ts gives: Playwright
 * loads spec files through its own CJS transform, and the generated Prisma
 * client (src/generated/prisma/, not committed) uses `import.meta`, which
 * fails there before any test is collected.
 *
 * THE PORTFOLIO TAG ROW ALREADY EXISTS, seeded by migration
 * 20261004150000_seed_portfolio_tag (id `tagseed00portfolio`, slug
 * `portfolio`) — this spec links to that row via `_MediaToTag` rather than
 * inserting a second one, the same "do not mint what a migration already
 * seeded" discipline src/lib/portfolio.ts's own comment on
 * `PORTFOLIO_TAG_SLUG` describes for every reader of that constant.
 */

// The same `.env*` precedence `next dev` itself uses, so this writes to the
// file the server under test is reading rather than to Prisma's bare default.
loadDevEnvFiles({ cwd: process.cwd() });

const DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";

const db = createClient({ url: DATABASE_URL });

const OWNER_ID = "e2e-qqnt4-owner";
const PORTFOLIO_TAG_ID = "tagseed00portfolio";
const PIECE_IDS = ["e2e-qqnt4-piece-a", "e2e-qqnt4-piece-b", "e2e-qqnt4-piece-c"];
const ALT_TEXTS = [
  "A kitchen counter with a coffee grinder and two mugs",
  "A stack of paperback novels beside a reading lamp",
  "A pair of wine glasses drying on a dish rack",
];

/** Removed in the order the foreign keys allow, and run before seeding too,
 * so a crashed run does not leave the next one looking at a half-seeded
 * database. Every id this spec writes is prefixed `e2e-qqnt4-`, so cleanup
 * can never reach a row it did not create — the one exception, the
 * portfolio TAG row, is never deleted, only unlinked from these media rows,
 * since that row is a migration's, not this spec's, to own. */
async function cleanup() {
  await db.batch(
    [
      `DELETE FROM "_MediaToTag" WHERE "A" IN (${PIECE_IDS.map((id) => `'${id}'`).join(",")})`,
      `DELETE FROM "Media" WHERE "id" IN (${PIECE_IDS.map((id) => `'${id}'`).join(",")})`,
      `DELETE FROM "User" WHERE "id" = '${OWNER_ID}'`,
    ],
    "write",
  );
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
      ...PIECE_IDS.map(
        (id, index) => `
        INSERT INTO "Media"
          ("id","userId","kind","key","previewKey","previewId","mimeType","sizeBytes",
           "originalName","altText","createdAt","publishedAt")
        VALUES ('${id}','${OWNER_ID}','IMAGE',
                'media/${OWNER_ID}/${id}.png','previews/${OWNER_ID}/${id}.webp',
                '${id}-preview','image/png',1024,'${id}.png',
                '${ALT_TEXTS[index]}','${now}','${now}')`,
      ),
      ...PIECE_IDS.map(
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

test("K1: three portfolio pieces with previews render as three <img> elements in the hero, with no decoration marker left", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const heroImages = page.locator("[data-home-hero-visual] img");
  await expect(heroImages).toHaveCount(3);

  const altTexts = await heroImages.evaluateAll((imgs) =>
    imgs.map((img) => img.getAttribute("alt")),
  );
  for (const alt of altTexts) {
    expect(alt, `alt text: ${JSON.stringify(altTexts)}`).toBeTruthy();
  }
  // The three curated alt texts, in the newest-first order
  // `listPortfolioPieces` orders by — not merely "three non-empty strings",
  // which would also pass if the wrong three images rendered.
  expect(altTexts).toEqual([...ALT_TEXTS].reverse());

  await expect(page.locator("[data-home-hero-decoration]")).toHaveCount(0);
  await expect(page.locator("[data-home-hero-visual-fallback]")).toHaveCount(0);
});

test("K3: every hero <img> carries non-empty width and height attributes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const heroImages = page.locator("[data-home-hero-visual] img");
  await expect(heroImages).toHaveCount(3);

  const dimensions = await heroImages.evaluateAll((imgs) =>
    imgs.map((img) => ({
      width: img.getAttribute("width"),
      height: img.getAttribute("height"),
    })),
  );
  for (const { width, height } of dimensions) {
    expect(width, JSON.stringify(dimensions)).toBeTruthy();
    expect(height, JSON.stringify(dimensions)).toBeTruthy();
  }
});
