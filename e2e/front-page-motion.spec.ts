import { expect, test } from "@playwright/test";

/**
 * ugcportal-6dvg K3: with `prefers-reduced-motion: reduce` emulated, no
 * fade-in or hover-lift animation runs on the hero's decorative surfaces —
 * and, where a gallery tile actually exists to check, its own pre-existing
 * hover-scale transition (src/components/gallery/containment.ts,
 * untouched by this bead) still resolves to the same "nothing computed
 * transitions" state. The "positive controls" describe block further down
 * this file proves the other half of that claim — that both effects are
 * real, visible ones under ORDINARY motion — under its own
 * `reducedMotion: "no-preference"` override.
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
   * hovering cannot fail — this link's base (non-`:hover`) style never
   * moves it at all, only a hover does, so the computed value would
   * already read inert either way. Hovering first is what actually
   * exercises something: under ordinary motion this same hover would
   * compute a real translate offset (see the positive-control test below,
   * which proves exactly that), and asserting it is suppressed here, WHILE
   * hovered, under `reducedMotion: "reduce"`, is the claim this test
   * exists to make.
   *
   * `translate`, NOT `transform` (round-3 review: caught while fixing the
   * finding above). Tailwind v4's `-translate-y-*` utilities compile to
   * the standalone CSS `translate` property, confirmed by compiling
   * globals.css and reading the generated rule — `transform` is a
   * completely different property this utility never touches, and
   * empty-state.tsx's own comment on this link records the same discovery
   * for the production code's `motion-reduce:` override, which had the
   * identical bug.
   *
   * WHAT ACTUALLY SUPPRESSES THE OFFSET HERE (round-4 review, low finding
   * — an earlier version of this comment claimed it was
   * `motion-reduce:translate-none`; that is wrong, confirmed the hard way):
   * the hover utility itself is `motion-safe:hover:-translate-y-0.5` — the
   * `motion-safe:` prefix means Tailwind only emits that rule inside
   * `@media (prefers-reduced-motion: no-preference)` at all, so under
   * `reduce` the rule does not exist regardless of hover, and
   * `motion-reduce:translate-none` (inside the OTHER, mutually exclusive
   * media query) never has anything to override — deleting it leaves this
   * assertion passing exactly as before. What this test is actually a
   * regression guard for is the `motion-safe:` GATE on the hover utility
   * itself — see empty-state.tsx's own comment on that class list for why
   * the `motion-reduce:` class is kept anyway, as a documented, inert
   * belt-and-braces entry rather than a functioning second guard.
   */
  await link.hover();
  const hovered = await link.evaluate((el) => {
    const style = getComputedStyle(el);
    return { transitionProperty: style.transitionProperty, translate: style.translate };
  });
  expect(hovered.transitionProperty).toBe("none");
  expect(hovered.translate).toBe("none");
});

/**
 * Positive controls (round-4/round-5 review, low findings): nothing in this
 * file previously proved either reduced-motion-gated effect is a REAL,
 * visible one under ordinary motion — only that each stays suppressed under
 * `reduce`. Without these, every assertion in the two tests above this
 * block could pass just as happily if the underlying `motion-safe:`
 * utilities were deleted outright (no effect ever, under any motion
 * preference), which is exactly the "weaker implementation that still
 * passes" shape review-standards asks every assertion to be checked
 * against.
 *
 * A separate `test.describe` with its own `test.use({ reducedMotion:
 * "no-preference" })`, overriding this file's own top-level
 * `reducedMotion: "reduce"` for just this block — Playwright scopes
 * `test.use()` to the nearest enclosing `describe`, so the tests above are
 * unaffected.
 */
test.describe("positive controls: the motion-safe effects are real under ordinary motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the empty state's portfolio link actually lifts on hover when motion is not reduced", async ({
    page,
  }) => {
    await page.goto("/");

    const link = page
      .locator("[data-home-empty-state]")
      .getByRole("link", { name: /portfolio/i });
    if ((await link.count()) === 0) {
      test.skip(true, "gallery is not empty in this dev database");
    }

    await link.hover();
    /*
     * Waits for the 200ms transition (motion-safe:duration-200) to settle
     * at its end value, rather than racing it, via Playwright's own
     * auto-retrying `toHaveCSS` — `-translate-y-0.5` is `calc(var(--spacing)
     * * -.5)`, and `--spacing` itself is `.25rem` (confirmed against the
     * generated CSS), NOT `-2px` (round-5 review, low finding — an earlier
     * version of this comment attributed the pixel value to `--spacing`
     * directly). `.25rem * -.5` is `-.125rem`, which is `-2px` only at the
     * browser's DEFAULT root font size of 16px (`1rem = 16px`) — this
     * suite never sets a custom root font size, so that default is what is
     * actually in effect here, but the hard-coded "0px -2px" literal below
     * depends on it rather than on `--spacing` alone.
     */
    await expect(link).toHaveCSS("translate", "0px -2px");
  });

  /**
   * Round-5 review, low finding: the sibling of the hover-lift control
   * above, for the hero's OTHER `motion-safe:`-gated effect — the
   * decorative shapes' fade-in. Nothing previously proved
   * `motion-safe:animate-[home-fade-in_700ms_ease-out_both]` actually
   * applies the keyframe at all under ordinary motion: deleting it from
   * hero.tsx left every one of this suite's other checks (and all 2584
   * unit tests) green, while under `no-preference` the three shapes would
   * stay at `opacity: 0` forever (their own base, no-motion-preference-
   * expressed value — see `HeroDecoration`'s own comment) with nothing
   * ever animating them to `opacity: 1`.
   */
  test("the hero's decorative shapes actually fade in when motion is not reduced", async ({
    page,
  }) => {
    await page.goto("/");

    const shapes = page.locator("[data-home-hero-decoration] span");
    const count = await shapes.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const shape = shapes.nth(index);
      const animationName = await shape.evaluate(
        (el) => getComputedStyle(el).animationName,
      );
      expect(animationName).toBe("home-fade-in");
      // Waits for the animation (up to 700ms, plus each shape's own
      // staggered 0/150/300ms delay) to actually finish and settle at its
      // `to` keyframe (`opacity: 1`), via the same auto-retrying assertion
      // as the hover-lift control above, rather than a fixed sleep.
      await expect(shape).toHaveCSS("opacity", "1");
    }
  });
});
