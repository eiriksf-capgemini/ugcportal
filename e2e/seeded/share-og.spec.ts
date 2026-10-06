import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

import { ANALYTICS_MARKER } from "../../src/lib/analytics-marker";
import { mediaItemPath } from "../../src/lib/routes";
import { loadDevEnvFiles } from "../../scripts/lib/env-files.mjs";

/**
 * ugcportal-lju K2's browser half: clicking the item page's share control
 * loads no third-party script and writes no non-essential storage.
 *
 * ITS OWN SPEC FILE under e2e/seeded, not e2e/cookie-consent.spec.ts itself —
 * same reasoning as e2e/seeded/alcohol-commerce.spec.ts's own comment: this
 * needs a seeded, PUBLISHED Media row to have a real `/media/[previewId]`
 * page to load at all, and the root suite's config forbids seeding (see
 * e2e/seeded/playwright.config.ts). Run with `npm run test:e2e:share-og`.
 *
 * Seeded through raw SQL over @libsql/client, not the generated Prisma
 * client, for the identical reason alcohol-commerce.spec.ts gives: Playwright
 * loads this file through its own CJS transform, and the generated Prisma
 * client uses `import.meta`, which fails there.
 *
 * `navigator.share` is not implemented in Playwright's bundled Chromium (no
 * OS share sheet to hand off to), so every run here deterministically
 * exercises ShareControl's CLIPBOARD-FALLBACK branch — the one K2 actually
 * worries about today, since the native-share branch calls a browser API
 * directly and loads nothing either way.
 */

loadDevEnvFiles({ cwd: process.cwd() });

const DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";

const db = createClient({ url: DATABASE_URL });

const OWNER_ID = "e2e-lju-owner";
const ITEM_ID = "e2e-lju-item";
const PREVIEW_ID = "e2e-lju-item-preview";

async function cleanup() {
  await db.batch(
    [
      `DELETE FROM "Media" WHERE "id" = '${ITEM_ID}'`,
      `DELETE FROM "User" WHERE "id" = '${OWNER_ID}'`,
    ],
    "write",
  );
}

test.beforeAll(async () => {
  // Same guard as alcohol-commerce.spec.ts: this suite seeds and deletes
  // rows through a direct SQL connection, which must never point at a
  // remote database.
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
      `INSERT INTO "Media"
         ("id","userId","kind","key","previewKey","previewId","mimeType","sizeBytes",
          "originalName","altText","caption","createdAt","publishedAt")
       VALUES ('${ITEM_ID}','${OWNER_ID}','IMAGE',
               'media/${OWNER_ID}/share-og.png','previews/${OWNER_ID}/share-og.webp',
               '${PREVIEW_ID}','image/png',1024,'share-og.png',
               'A cup of coffee beside an open notebook','A quiet morning coffee.',
               '${now}','${now}')`,
    ],
    "write",
  );
});

test.afterAll(async () => {
  await cleanup();
  db.close();
});

test("K2: clicking the share control loads no third-party script and writes no non-essential storage", async ({
  page,
  context,
}) => {
  // Clipboard access needs an explicit grant in Chromium; without it
  // `navigator.clipboard.writeText` rejects and ShareControl's own "failed"
  // branch would run instead of the one this test means to exercise.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  await page.goto(mediaItemPath(PREVIEW_ID));
  await page.waitForLoadState("networkidle");

  const shareButton = page.locator("[data-share-control]");
  await expect(shareButton).toBeVisible();

  // Storage snapshot taken AFTER the page has settled but BEFORE the click,
  // so this is a before/after comparison across the one action K2 asks
  // about — not an assertion that the page carries no storage at all ever
  // (a consent cookie, written only on an explicit choice, would be
  // legitimate and is not what this click does).
  const storageBefore = await page.evaluate(() => ({
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
    cookies: document.cookie,
  }));

  await shareButton.click();
  // Give the clipboard-fallback branch's own async write a moment to settle.
  await expect(page.getByText("Link copied")).toBeVisible();

  const offendingRequests = requestUrls.filter((url) => ANALYTICS_MARKER.test(url));
  expect(offendingRequests, JSON.stringify(offendingRequests)).toEqual([]);

  const scriptSrcs = await page.evaluate(() =>
    [...document.querySelectorAll("script[src]")].map(
      (el) => el.getAttribute("src") ?? "",
    ),
  );
  const offendingScripts = scriptSrcs.filter((src) => ANALYTICS_MARKER.test(src));
  expect(offendingScripts, JSON.stringify(offendingScripts)).toEqual([]);

  const storageAfter = await page.evaluate(() => ({
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
    cookies: document.cookie,
  }));
  expect(storageAfter).toEqual(storageBefore);

  // The fallback really did write the item's own URL to the clipboard —
  // not just show a success message — so this is the clipboard API, not a
  // decorative label that would say "Link copied" regardless of outcome.
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(page.url());
});
