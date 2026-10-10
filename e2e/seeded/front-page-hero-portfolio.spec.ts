import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";

import { loadDevEnvFiles } from "../../scripts/lib/env-files.mjs";

/**
 * ugcportal-qqnt.4 K1: "Given at least three portfolio pieces with previews,
 * when / renders at 1440x900, three <img> elements are visible inside the
 * hero and no element with data-home-hero-decoration remains." RETARGETED by
 * ugcportal-a3hj K3: those three `<img>`s now carry an empty `alt` (the
 * collage is decorative, aria-hidden, and duplicates the gallery/portfolio
 * these same photographs already appear in with real alt text) — see this
 * file's own K1 test below, and hero.tsx's own comment on `HeroVisual`.
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

  const srcs = await heroImages.evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")));
  // Every rendered tile really is one of the three seeded pieces — not
  // merely "three <img> elements", which would also pass if three unrelated
  // images rendered.
  for (const id of PIECE_IDS) {
    expect(srcs.some((src) => src?.includes(`${id}-preview`)), JSON.stringify(srcs)).toBe(true);
  }

  await expect(page.locator("[data-home-hero-decoration]")).toHaveCount(0);
  await expect(page.locator("[data-home-hero-visual-fallback]")).toHaveCount(0);
});

/**
 * ugcportal-a3hj K3: the collage is decorative — `aria-hidden="true"` on the
 * container, and every `<img alt>` empty even though each seeded piece has
 * a real, non-empty `altText` (this file's own `ALT_TEXTS`) — these same
 * three photographs already appear, with that real alt text, in the
 * gallery/portfolio this hero sits above.
 */
test("K3: the collage container is aria-hidden and every image alt is empty, despite non-empty source alt text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const container = page.locator("[data-home-hero-visual]");
  await expect(container).toHaveAttribute("aria-hidden", "true");

  const heroImages = page.locator("[data-home-hero-visual] img");
  await expect(heroImages).toHaveCount(3);
  const alts = await heroImages.evaluateAll((imgs) => imgs.map((img) => img.getAttribute("alt")));
  expect(alts).toEqual(["", "", ""]);

  // Guards the guard: the empty alts above are this component's own
  // deliberate choice, not an accident of an empty fixture — every seeded
  // piece really does carry a non-empty altText in the database.
  expect(ALT_TEXTS.every((text) => text.length > 0)).toBe(true);
});

/**
 * ugcportal-a3hj K1: the collage's box matches the mockup's 240px
 * (docs/design/forside.html's `.hero-art`) at `sm` and above — the real,
 * computed pixel size in a browser, which hero.test.tsx's own class-string
 * check (Tailwind is inert there) cannot prove.
 */
test("K1: the collage container computes to 240px square at 1440x900 (sm and above)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const box = await page
    .locator("[data-home-hero-visual]")
    .evaluate((el) => el.getBoundingClientRect());
  expect(box.width, JSON.stringify(box)).toBe(240);
  expect(box.height, JSON.stringify(box)).toBe(240);
});

/**
 * Round-1 review (PR #122), CONFIRMED medium, ORIGINALLY in
 * e2e/front-page.spec.ts: an earlier hero layout positioned the three
 * decorative shapes `absolute`, spanning the WHOLE hero, which put a
 * near-white circle directly behind the `text-ink` lead paragraph at every
 * one of these three widths. MOVED here by ugcportal-a3hj K2: the check
 * needs a rendered tile to mean anything, and the root suite's dev database
 * is assumed genuinely empty (front-page.spec.ts's own header comment), so
 * this geometric guard now runs here instead, against the three real seeded
 * pieces.
 */
type Rect = { x: number; y: number; width: number; height: number };

function intersects(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

for (const width of [360, 768, 1024]) {
  test(`no hero visual tile intersects the hero's text or CTA at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    const { textRects, shapeRects } = await page.evaluate(() => {
      const toRect = (el: Element) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        textRects: [
          ...document.querySelectorAll(
            "[data-home-hero] h1, [data-home-hero] p, [data-home-hero] a",
          ),
        ].map(toRect),
        shapeRects: [
          ...document.querySelectorAll("[data-home-hero-visual] > *"),
        ].map(toRect),
      };
    });

    expect(textRects.length).toBeGreaterThan(0);
    expect(shapeRects.length).toBeGreaterThan(0);

    for (const text of textRects) {
      for (const shape of shapeRects) {
        expect(
          intersects(text, shape),
          `text rect ${JSON.stringify(text)} intersects hero visual tile rect ${JSON.stringify(shape)} at ${width}px`,
        ).toBe(false);
      }
    }
  });
}

/**
 * ugcportal-6dvg K3, MOVED here by ugcportal-a3hj K2 (see the geometric
 * check above for why): with `prefers-reduced-motion: reduce` emulated, no
 * fade-in animation runs on the hero's visual tiles.
 * e2e/front-page-motion.spec.ts carries the equivalent check for every OTHER
 * motion-gated effect on this page (gallery tiles, the empty-state link),
 * which do not depend on the hero collage actually rendering.
 */
test.describe("K3: reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the hero's visual tiles have no computed animation under reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const shapes = page.locator("[data-home-hero-visual] > *");
    await expect(shapes).toHaveCount(3);

    const count = await shapes.count();
    for (let index = 0; index < count; index += 1) {
      const computed = await shapes.nth(index).evaluate((el) => {
        const style = getComputedStyle(el);
        return { animationName: style.animationName, animationDuration: style.animationDuration };
      });
      expect(computed.animationName).toBe("none");
      expect(computed.animationDuration).toBe("0s");
    }
  });
});

/**
 * Positive control (see e2e/front-page-motion.spec.ts's own comment on why
 * this pairing matters): proves the fade-in is a REAL, visible effect under
 * ordinary motion, not merely "stays suppressed under reduce" — the same
 * "weaker implementation that still passes" concern review-standards asks
 * every assertion to be checked against.
 */
test.describe("positive control: the fade-in is real under ordinary motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the hero's visual tiles actually fade in when motion is not reduced", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const shapes = page.locator("[data-home-hero-visual] > *");
    await expect(shapes).toHaveCount(3);

    const count = await shapes.count();
    for (let index = 0; index < count; index += 1) {
      const shape = shapes.nth(index);
      const animationName = await shape.evaluate((el) => getComputedStyle(el).animationName);
      expect(animationName).toBe("home-fade-in");
      await expect(shape).toHaveCSS("opacity", "1");
    }
  });
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
