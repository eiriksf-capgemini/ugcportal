import { expect, test } from "@playwright/test";

/**
 * ugcportal-6dvg K3: with `prefers-reduced-motion: reduce` emulated, no
 * fade-in or hover-lift animation runs on the hero's decorative surfaces —
 * and, where a gallery tile actually exists to check, its own pre-existing
 * hover-scale transition (src/components/gallery/containment.ts,
 * untouched by this bead) still resolves to the same "nothing computed
 * transitions" state.
 *
 * Not wired into CI, same as e2e/petrol-theme.spec.ts — see
 * playwright.config.ts's own comment.
 */
test.use({ reducedMotion: "reduce" });

test("K3: the hero's decorative surfaces have no computed animation under reduced motion", async ({
  page,
}) => {
  await page.goto("/");

  // `[data-home-hero-decoration] span` (round-2 review, low finding), not
  // the structural `div[aria-hidden='true'] > span` this used to select by:
  // the same selector front-page.spec.ts's own geometry check already uses
  // for these shapes, so a future markup change to HeroDecoration's wrapper
  // cannot silently desync the two checks from each other.
  const shapes = page.locator("[data-home-hero-decoration] span");
  const count = await shapes.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const computed = await shapes.nth(index).evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
      };
    });
    expect(computed.animationName).toBe("none");
    // Round-2 review, low finding: this value was captured but never
    // actually asserted before — decoration, not coverage. "none" as the
    // animation name is already enough on its own to mean nothing animates,
    // but the CSS-initial duration confirms it from the other side too.
    expect(computed.animationDuration).toBe("0s");
  }
});

test("K3: a gallery tile's own hover transition still resolves to no transition under reduced motion, where a tile exists", async ({
  page,
}) => {
  await page.goto("/");

  const tileImages = page.locator("[data-gallery-tile] img");
  const count = await tileImages.count();
  if (count === 0) {
    // No published media in this dev database (see front-page.spec.ts's own
    // comment on the lack of e2e seeding infrastructure) — nothing to check
    // here; front-page.spec.ts's own K1 test already covers the empty case
    // this environment actually produces.
    test.skip(true, "no gallery tile in this dev database to check");
  }

  const computed = await tileImages.first().evaluate((el) => {
    const style = getComputedStyle(el);
    return { transitionProperty: style.transitionProperty };
  });
  expect(computed.transitionProperty).toBe("none");
});

test("K3: the empty state's portfolio link has no computed transition under reduced motion", async ({
  page,
}) => {
  await page.goto("/");

  const link = page
    .locator("[data-home-empty-state]")
    .getByRole("link", { name: /portfolio/i });
  if ((await link.count()) === 0) {
    test.skip(true, "gallery is not empty in this dev database");
  }

  const computed = await link.evaluate((el) => {
    const style = getComputedStyle(el);
    return { transitionProperty: style.transitionProperty, transform: style.transform };
  });
  expect(computed.transitionProperty).toBe("none");
  // Round-2 review, low finding: captured but never asserted before — this
  // link's `motion-reduce:transform-none` is the explicit, belt-and-braces
  // half (see empty-state.tsx's own class list), parallel to hero.tsx's
  // `motion-reduce:animate-none` on its decorative shapes.
  expect(computed.transform).toBe("none");
});
