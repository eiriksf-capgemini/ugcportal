import { expect, test } from "@playwright/test";

/**
 * ugcportal-6dvg K1: the front page's hero and living empty state, against a
 * real running dev server.
 *
 * Not wired into CI, same as e2e/petrol-theme.spec.ts and
 * e2e/about-portfolio.spec.ts — see playwright.config.ts's own comment.
 *
 * This repo has no e2e database-seeding infrastructure yet (noted in
 * e2e/petrol-theme.spec.ts's own comment, tracked separately as
 * ugcportal-4zgy), so a freshly `prisma db push`'d local dev database has no
 * published media in it — which is exactly the K1 scenario this bead needs
 * to check (an anonymous visitor, an empty gallery) rather than something
 * this suite has to contrive a fixture for. If a real dev database already
 * has published items when this runs, the "empty state" test below will
 * correctly fail — seed-free is this file's assumption, not a guarantee it
 * enforces.
 */

test("the hero renders for an anonymous visitor, above whatever the gallery shows", async ({
  page,
}) => {
  await page.goto("/");

  const hero = page.locator("[data-home-hero]");
  await expect(hero).toBeVisible();
  await expect(hero).toContainText("Real photos of the things you actually use.");
  // Anonymous (no sign-in cookie in this browser context): K1's signed-out case.
  await expect(hero.getByRole("link", { name: "Sign in to upload" })).toBeVisible();
});

test("K1: the living empty state offers an action, on a genuinely empty gallery", async ({
  page,
}) => {
  await page.goto("/");

  const emptyState = page.locator("[data-home-empty-state]");
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText("Nothing is published yet.");
  await expect(
    emptyState.getByRole("link", { name: /portfolio/i }),
  ).toBeVisible();

  // K2's other half, checked negatively here: no gallery tile exists either.
  await expect(page.locator("[data-gallery-tile]")).toHaveCount(0);
});

/**
 * Round-1 review, CONFIRMED medium: an earlier hero layout positioned the
 * three decorative shapes `absolute`, spanning the WHOLE hero, which put the
 * near-white `bg-petrol-100` circle directly behind the `text-ink` lead
 * paragraph at every one of these three widths — contrast collapsing to
 * roughly 1:1 wherever the two actually overlapped. src/lib/design/
 * contrast.ts could not catch this (it checks declared token pairs, not
 * what two elements happen to composite to at a given breakpoint); only
 * measuring real client rects in a browser found it. The fix
 * (src/components/home/hero.tsx's `HeroDecoration`) confines the shapes to
 * their own flex-sibling box, which this test checks geometrically rather
 * than trusting the structure to hold.
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
  test(`no decorative shape intersects the hero's text or CTA at ${width}px`, async ({
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
          ...document.querySelectorAll("[data-home-hero] p, [data-home-hero] a"),
        ].map(toRect),
        shapeRects: [
          ...document.querySelectorAll("[data-home-hero-decoration] span"),
        ].map(toRect),
      };
    });

    expect(textRects.length).toBeGreaterThan(0);
    expect(shapeRects.length).toBeGreaterThan(0);

    for (const text of textRects) {
      for (const shape of shapeRects) {
        expect(
          intersects(text, shape),
          `text rect ${JSON.stringify(text)} intersects decorative shape rect ${JSON.stringify(shape)} at ${width}px`,
        ).toBe(false);
      }
    }
  });
}
