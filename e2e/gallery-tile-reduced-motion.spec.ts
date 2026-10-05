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
 * ROUND-1 REVIEW (PR #101): the previous version of this file seeded its
 * own `Media`/`User` row directly via `@libsql/client` SQL in `beforeAll`/
 * `afterAll`, against a dedicated worktree-local database and port. Removed
 * entirely - raw SQL writes against the SAME SQLite file the dev server
 * also had open hit `SQLITE_BUSY` under Playwright's own parallel workers
 * roughly a third of the time, and the row this file seeded (and later
 * deleted) broke two OTHER suites that assume whatever the dev database
 * happens to hold stays put for the duration of a run:
 * `e2e/front-page.spec.ts`'s empty-gallery assertion, and
 * `e2e/front-page-motion.spec.ts`'s own K3 gallery-tile test, which flipped
 * from its documented skip to actually running (and then losing its row
 * mid-run) once this file's seed existed. This file now follows that SAME
 * test's own convention instead: no seeding, no database access at all -
 * skip when the dev database (whatever it holds, from whoever's run it is)
 * has no published tile to check. See that file's own comment for why
 * there is no e2e seeding infrastructure yet (ugcportal-4zgy).
 *
 * Not wired into CI, same reason as every other file in this directory
 * (playwright.config.ts's own comment): no running server, no database.
 */

test.describe("gallery tile hover scale honours prefers-reduced-motion", () => {
  test("the hover scale is a real, visible effect under ordinary motion (positive control)", async ({
    page,
  }) => {
    await page.goto("/");

    const tileImages = page.locator("[data-gallery-tile] img");
    if ((await tileImages.count()) === 0) {
      // Same gap e2e/front-page-motion.spec.ts's own K3 gallery-tile test
      // documents: no e2e seeding infrastructure (ugcportal-4zgy), so
      // whether a tile exists here depends on whatever the dev database
      // happens to hold.
      test.skip(true, "no gallery tile in this dev database to check");
    }

    const tileImage = tileImages.first();
    await tileImage.hover();
    await expect(tileImage).not.toHaveCSS("scale", "none");
  });

  test("K1: hovering a tile under prefers-reduced-motion: reduce leaves the image's computed scale at none", async ({
    page,
  }) => {
    await page.goto("/");

    const tileImages = page.locator("[data-gallery-tile] img");
    if ((await tileImages.count()) === 0) {
      test.skip(true, "no gallery tile in this dev database to check");
    }

    const tileImage = tileImages.first();

    // HOVER WITNESS (round-1 review): proves hovering THIS element, in
    // THIS run's environment, really does register at all and produce a
    // non-none scale - under the default, ordinary-motion emulation this
    // test has not yet touched. Without this, "scale: none" below could
    // just as easily mean "the hover never registered" (a flaky selector,
    // a layout surprise, a browser quirk) as "the reduced-motion guard
    // worked" - this is the SAME assertion the positive-control test above
    // makes independently, repeated here so THIS test cannot pass for the
    // wrong reason.
    await tileImage.hover();
    await expect(tileImage).not.toHaveCSS("scale", "none");

    // Reload under reduce, rather than toggling emulateMedia live on an
    // already-hovered page: a real visitor's reduced-motion preference is
    // already set when they land on the page, not flipped mid-session, so
    // reloading is the more faithful simulation - and it also exercises
    // Next's own SSR output fresh rather than reusing a CSSOM already
    // built under the old media state.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();

    await tileImage.hover();
    await expect(tileImage).toHaveCSS("scale", "none");
  });
});
