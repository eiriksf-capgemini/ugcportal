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
