import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, test } from "@playwright/test";

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
 * ugcportal-qqnt.1 K1: the hero carries the h1, at a computed font size
 * strictly larger than the first <h2> after it — a pixel-level claim the
 * vitest-level class-name checks (src/components/type-scale.test.tsx)
 * cannot make, since nothing there compiles Tailwind.
 */
test("K1: the hero's h1 computes a larger font size than the first h2 after it", async ({
  page,
}) => {
  await page.goto("/");

  const h1 = page.locator("[data-home-hero] h1");
  await expect(h1).toHaveText("Real photos of the things you actually use.");
  // This dev database is empty (this file's own header comment), so the
  // first <h2> after the hero is the living empty state's.
  const h2 = page.locator("[data-home-empty-state] h2");
  await expect(h2).toHaveText("Nothing is published yet.");

  const [h1Size, h2Size] = await Promise.all([
    h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    h2.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ]);
  expect(h1Size, `h1: ${h1Size}px, h2: ${h2Size}px`).toBeGreaterThan(h2Size);
});

/**
 * ugcportal-qqnt.1 K3: no heading level is skipped on the home page, and no
 * second element carries the display utility — axe's `heading-order` rule
 * catches a skip (h1 straight to h3); K3's other half (at most one display
 * title) is the render-based count in src/components/type-scale.test.tsx,
 * since axe has no notion of "this class is the display one".
 */
test("K3: no heading level is skipped on the home page", async ({ page }) => {
  await page.goto("/");

  const results = await new AxeBuilder({ page })
    .withRules(["heading-order"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

/**
 * ugcportal-qqnt.2 K1/K2: one button system — the hero's CTA, the empty
 * state's portfolio link and the header's sign-in controls all resolve to
 * buttonVariants (checked at the vitest level,
 * src/components/ui/button-system.test.tsx), and here, at the pixel level a
 * class-name check cannot reach: the same computed radius on all three, and
 * at most two distinct computed background colours among them (the one
 * filled treatment, and the shared transparent/outline one).
 */
test("K1/K2: the hero CTA, the empty-state link and the header's sign-in buttons share one radius and at most two fill colours", async ({
  page,
}) => {
  await page.goto("/");

  const heroCta = page.getByRole("link", { name: "Sign in to upload" });
  const emptyStateLink = page
    .locator("[data-home-empty-state]")
    .getByRole("link", { name: /portfolio/i });

  // ugcportal-qqnt.3: the header's two provider buttons no longer render
  // until the single "Sign in" control (K1) is activated - see
  // src/components/sign-in-menu.tsx.
  await page.getByRole("button", { name: "Sign in" }).click();
  const headerGoogle = page.getByRole("button", { name: /Google/i });
  const headerFacebook = page.getByRole("button", { name: /Facebook/i });

  const readStyle = (locator: Locator) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return { borderRadius: style.borderRadius, backgroundColor: style.backgroundColor };
    });

  const [hero, emptyState, google, facebook] = await Promise.all([
    readStyle(heroCta),
    readStyle(emptyStateLink),
    readStyle(headerGoogle),
    readStyle(headerFacebook),
  ]);

  const radii = [hero.borderRadius, emptyState.borderRadius, google.borderRadius, facebook.borderRadius];
  expect(new Set(radii).size, JSON.stringify(radii)).toBe(1);

  const fills = [hero.backgroundColor, emptyState.backgroundColor, google.backgroundColor, facebook.backgroundColor];
  expect(new Set(fills).size, JSON.stringify(fills)).toBeLessThanOrEqual(2);
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
          ...document.querySelectorAll(
            "[data-home-hero] h1, [data-home-hero] p, [data-home-hero] a",
          ),
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

/**
 * Round-4 fix, ugcportal-qqnt.2 (round-3 review's one outstanding medium,
 * https://github.com/eiriksf-capgemini/ugcportal/pull/122#issuecomment-6019905606):
 * moving the hero CTA and the empty-state link onto `buttonVariants` gave
 * them the shared `outline-none`-plus-box-shadow-ring focus treatment, which
 * `forced-colors: active` (Windows High Contrast and similar UA modes) drops
 * entirely, so keyboard focus became invisible on exactly these two controls
 * — the only two that had a real CSS outline before this bead touched them.
 * The fix is the scoped `FORCED_COLORS_FOCUS_OUTLINE` override at each call
 * site (hero.tsx, empty-state.tsx), not a change to the shared base — see
 * ugcportal-oavb for that systemic gap, which this override does not close
 * for any other caller.
 *
 * `outlineStyle` is the right thing to assert, not `outlineColor` alone:
 * this repo's own compile-and-render check (this bead's own verification,
 * not asserted here since it needs `@tailwindcss/node`, not Playwright) found
 * that a bare `focus-visible:outline` utility on top of `outline-none`
 * silently stays `outlineStyle: "none"` — only `outline-solid` actually wins,
 * because `outline`/`outline-2` only READ the shared `--tw-outline-style`
 * custom property, they do not SET it. A test that only checked
 * `outlineColor` would have passed on the broken `outline`-only variant too
 * (forced-colors still substitutes a colour for `outline-color: transparent`
 * even while `outline-style` stays `none`, and a `none`-style outline paints
 * nothing regardless of its colour).
 */
test.describe("forced colors: focus stays visible on the hero CTA and the empty-state link", () => {
  test.use({ forcedColors: "active" });

  test("the hero CTA keeps a non-none outline style when focused under forced colors", async ({
    page,
  }) => {
    await page.goto("/");

    const cta = page.getByRole("link", { name: "Sign in to upload" });
    const beforeFocus = await cta.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(beforeFocus, "unfocused — should stay invisible, not permanently ringed").toBe("none");

    await cta.focus();
    const afterFocus = await cta.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(afterFocus, "focused under forced-colors — must not be 'none'").not.toBe("none");
  });

  test("the empty-state portfolio link keeps a non-none outline style when focused under forced colors", async ({
    page,
  }) => {
    await page.goto("/");

    const link = page
      .locator("[data-home-empty-state]")
      .getByRole("link", { name: /portfolio/i });
    const beforeFocus = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(beforeFocus, "unfocused — should stay invisible, not permanently ringed").toBe("none");

    await link.focus();
    const afterFocus = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(afterFocus, "focused under forced-colors — must not be 'none'").not.toBe("none");
  });
});
