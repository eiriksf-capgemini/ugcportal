import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

/**
 * K1 (ugcportal-ig4g): a gallery tile's hover scale must actually stay at
 * `scale: none` under `prefers-reduced-motion: reduce` - the bug this bead
 * fixes was that `motion-reduce:transform-none` (the guard that used to sit
 * next to `group-hover:scale-[1.04]` in
 * src/components/gallery/containment.ts's `GALLERY_TILE_IMAGE_CLASS`)
 * overrides the `transform` property, while Tailwind 4 compiles
 * `scale-[1.04]` to the STANDALONE `scale` property - so the override never
 * touched the property the hover utility actually sets, and the tile still
 * scaled 4% on hover, instantly, under reduce.
 *
 * e2e/front-page-motion.spec.ts's own K3 gallery-tile test (ugcportal-6dvg)
 * checks a DIFFERENT, narrower claim - that `transitionProperty` resolves to
 * `none` under reduce - and is SKIPPED whenever the dev database has no
 * published media, because this repo ships no e2e seeding infrastructure
 * (ugcportal-4zgy). This file does not rely on that gap staying open: it
 * seeds its own published row directly in `beforeAll`/`afterAll`, against
 * whichever DATABASE_URL the running dev server was started with (see
 * playwright.config.ts's own comment on `PORT` - the two have to agree,
 * and do, because both are read from the same environment at the command
 * line: `PORT=3800 DATABASE_URL=file:./e2e-dev.db npx playwright test
 * e2e/gallery-tile-reduced-motion.spec.ts`).
 *
 * RAW SQL via `@libsql/client` (already a devDependency), NOT the app's own
 * Prisma client (`@/lib/prisma`, and the `seedMedia` fixture
 * src/lib/test-support/media-fixtures.ts shares with
 * src/lib/portfolio.test.ts and src/app/page.test.tsx): tried first, and
 * reverted. Playwright Test's own module loader transforms every file -
 * including every module a spec imports - to CommonJS, and Prisma 7's
 * generated client (src/generated/prisma/client.ts) uses `import.meta`
 * somewhere in its own module graph, same as it does when loaded by
 * Next.js or Vitest (both of which run it as real ESM and never hit this).
 * Under Playwright's loader that throws `SyntaxError: Cannot use
 * 'import.meta' outside a module` before a single test runs. `@libsql/
 * client` is a plain CommonJS-compatible package with no such dependency,
 * so it loads cleanly in this runner. The duplication this trades for - a
 * second, SQL-shaped description of one `Media`/`User` row rather than
 * reusing `seedMedia` - is bounded to this one file and does not touch the
 * schema: both tables have no `@@map`/`@map` renames (confirmed against
 * prisma/schema.prisma and the actual sqlite_master `CREATE TABLE`), so the
 * column names below are exactly the Prisma field names.
 *
 * Not wired into CI, same reason as every other file in this directory
 * (playwright.config.ts's own comment): no running server, no database.
 */

const SEED_USER_ID = "e2e-ig4g-user";
const SEED_MEDIA_ID = "e2e-ig4g-tile";

const db = createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" });

test.beforeAll(async () => {
  // Idempotent cleanup first: a previous run that crashed before its own
  // afterAll could leave this row behind, and a UNIQUE `key`/`previewKey`/
  // `previewId` collision would then fail this run's insert with a
  // confusing error that has nothing to do with reduced motion.
  await db.execute({ sql: "DELETE FROM Media WHERE id = ?", args: [SEED_MEDIA_ID] });
  await db.execute({ sql: "DELETE FROM User WHERE id = ?", args: [SEED_USER_ID] });

  await db.execute({
    sql: 'INSERT INTO User (id, email, name, "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
    args: [SEED_USER_ID, "ig4g-e2e@example.invalid", "ugcportal-ig4g e2e fixture"],
  });

  // Shape matches seedMedia's own default (src/lib/test-support/media-
  // fixtures.ts): published, with a preview, real (if fake) alt text - the
  // one real difference being no tags, which this test does not need.
  await db.execute({
    sql: `INSERT INTO Media
            (id, "userId", kind, key, "previewKey", "previewId", "mimeType",
             "sizeBytes", "originalName", "altText", "createdAt", "publishedAt")
          VALUES (?, ?, 'IMAGE', ?, ?, ?, 'image/jpeg', 4096, ?, ?, ?, ?)`,
    args: [
      SEED_MEDIA_ID,
      SEED_USER_ID,
      `media/${SEED_USER_ID}/${SEED_MEDIA_ID}-original.jpg`,
      `previews/${SEED_USER_ID}/${SEED_MEDIA_ID}.webp`,
      `pv-${SEED_MEDIA_ID}`,
      `${SEED_MEDIA_ID}.jpg`,
      "A photograph seeded for ugcportal-ig4g's reduced-motion check",
      "2026-10-05T09:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
    ],
  });
});

test.afterAll(async () => {
  await db.execute({ sql: "DELETE FROM Media WHERE id = ?", args: [SEED_MEDIA_ID] });
  await db.execute({ sql: "DELETE FROM User WHERE id = ?", args: [SEED_USER_ID] });
  db.close();
});

test.describe("reduced motion: the gallery tile's hover scale is actually neutralised", () => {
  test.use({ reducedMotion: "reduce" });

  test("K1: hovering a tile under prefers-reduced-motion: reduce leaves the image's computed scale at none", async ({
    page,
  }) => {
    await page.goto("/");

    const tileImage = page.locator(`[data-gallery-tile="${SEED_MEDIA_ID}"] img`);
    await expect(tileImage).toBeVisible();

    await tileImage.hover();

    // Playwright's own auto-retrying `toHaveCSS`, not a one-shot read: this
    // is a hover effect, and the assertion should settle on whatever the
    // browser actually computes once the hover has registered - the same
    // reasoning front-page-motion.spec.ts's own positive control already
    // uses for its translate check.
    await expect(tileImage).toHaveCSS("scale", "none");
  });
});

test.describe("positive control: the hover scale is a real, visible effect under ordinary motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the same tile's hover scale is NOT none when motion is not reduced", async ({ page }) => {
    await page.goto("/");

    const tileImage = page.locator(`[data-gallery-tile="${SEED_MEDIA_ID}"] img`);
    await expect(tileImage).toBeVisible();

    await tileImage.hover();

    await expect
      .poll(() => tileImage.evaluate((el) => getComputedStyle(el).scale))
      .not.toBe("none");
  });
});
