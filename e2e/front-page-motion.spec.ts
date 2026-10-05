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

  const resting = await link.evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(resting).toBe("none");

  /*
   * Round-3 review, low finding: reading the computed style WITHOUT ever
   * hovering cannot fail regardless of `motion-reduce:translate-none` —
   * this link's base (non-`:hover`) style never moves it at all, only
   * `motion-safe:hover:-translate-y-0.5` does, so the computed value would
   * already read inert even if that reduced-motion override were deleted
   * outright. Hovering first is what actually exercises it: under ordinary
   * motion this same hover would compute a real translate offset, and
   * asserting it is suppressed here, WHILE hovered, under
   * `reducedMotion: "reduce"`, is the claim this test exists to make.
   *
   * `translate`, NOT `transform` (round-3 review: caught while fixing the
   * finding above — checking `.transform` here would have stayed vacuous
   * even hovered, for a different reason than "never hovered"). Tailwind
   * v4's `-translate-y-*` utilities compile to the standalone CSS
   * `translate` property, confirmed by compiling globals.css and reading
   * the generated rule — `transform` is a completely different property
   * this utility never touches, and empty-state.tsx's own comment on this
   * link records the same discovery for the production code's
   * `motion-reduce:` override, which had the identical bug.
   */
  await link.hover();
  const hovered = await link.evaluate((el) => {
    const style = getComputedStyle(el);
    return { transitionProperty: style.transitionProperty, translate: style.translate };
  });
  expect(hovered.transitionProperty).toBe("none");
  expect(hovered.translate).toBe("none");
});
