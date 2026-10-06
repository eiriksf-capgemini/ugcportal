import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

/**
 * ugcportal-rw9j round 5: e2e/petrol-theme.spec.ts's K1 test checks the
 * primary-button fill by proxy (the header's own bg-primary/text-primary-
 * foreground skip link, chosen because the gallery's only default-variant
 * Button is conditionally rendered and this repo has no e2e DB-seeding
 * infrastructure yet) rather than by rendering <Button variant="default">
 * itself. That proxy cannot see a regression in button.tsx's own variant
 * map - verified directly: reassigning the `default` variant's background
 * utility leaves the skip-link check, which duplicates the same two
 * utilities independently in app-shell.tsx, completely unaffected. This
 * test closes exactly that gap, cheaply and deterministically, by asserting
 * on the variant map itself rather than a rendered DOM node.
 */
describe("buttonVariants", () => {
  it("default variant fills with the primary petrol token and primary-foreground label", () => {
    // Split into individual class tokens rather than a substring `toContain`:
    // "bg-primary" is itself a substring of "hover:bg-primary-hover", so a
    // naive toContain("bg-primary") can never fail even with the resting
    // fill removed entirely - verified by mutating the fixture (temporarily
    // dropping "bg-primary" from the default variant left a substring
    // toContain check green).
    const classes = buttonVariants({ variant: "default" }).split(/\s+/);
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
  });
});

/**
 * ugcportal-oavb: the base-level guard for the fix itself. A bare
 * `outline-none` with no accompanying forced-colors-visible outline is
 * exactly the regression this bead closes — `outline-none` compiles to
 * `outline-style: none`, which `forced-colors: active` (Windows High
 * Contrast) respects same as anywhere else, so it drops keyboard focus
 * entirely the moment the only OTHER focus indicator is a `box-shadow`-based
 * ring (`focus-visible:ring-3 focus-visible:ring-ring/80`), which
 * forced-colors modes ignore. This can only assert on the CLASS NAMES
 * `buttonVariants` emits, not on what a real browser paints — that pixel-
 * level claim is e2e/front-page.spec.ts's "forced colors: focus stays
 * visible..." suite, run under Playwright's `forcedColors: "active"`
 * emulation against real rendered controls (the hero CTA, the empty-state
 * link, a header sign-in button and an admin-surface button). This test is
 * the cheap, always-on backstop that fails the instant the base class
 * string regresses, independent of any browser.
 *
 * Checked across every variant, not only `default`: the base class (where
 * `outline-none` used to live, and where the fix now lives) is shared by
 * all of them, and a hypothetical per-variant override reintroducing
 * `outline-none` on exactly one variant would not be caught by checking
 * only one.
 */
describe("buttonVariants base: no bare outline-none without a forced-colors-visible outline (ugcportal-oavb)", () => {
  const variants = [
    "default",
    "default-neutral",
    "default-tint",
    "outline",
    "secondary",
    "outline-neutral",
    "ghost",
    "destructive",
    "link",
  ] as const;

  it.each(variants)("%s variant: no bare outline-none token", (variant) => {
    const classes = buttonVariants({ variant }).split(/\s+/);
    expect(
      classes,
      `outline-none would drop forced-colors focus visibility entirely (see this file's own comment); found in: ${classes.join(" ")}`,
    ).not.toContain("outline-none");
  });

  it.each(variants)(
    "%s variant: carries a focus-visible outline that actually SETS outline-style (outline-solid), not a bare outline/outline-2 that only reads it",
    (variant) => {
      const classes = buttonVariants({ variant }).split(/\s+/);
      // `focus-visible:outline`/`focus-visible:outline-2` alone would be a
      // false fix: those utilities only read the shared `--tw-outline-style`
      // custom property in this Tailwind v4 setup, they do not set it, so
      // without `outline-solid` present too they silently stay whatever
      // `outline-style` already resolved to elsewhere (see button.tsx's own
      // base-class comment for the compiled-and-rendered proof). Asserting
      // the presence of `outline-solid` itself, not merely the absence of
      // `outline-none`, is what catches that specific false fix.
      expect(
        classes,
        `expected a real forced-colors-visible outline (focus-visible:outline-solid) in: ${classes.join(" ")}`,
      ).toContain("focus-visible:outline-solid");
    },
  );

  it("the base class carries outline-2, outline-offset-2 and outline-transparent alongside outline-solid, all under focus-visible", () => {
    const classes = buttonVariants({ variant: "default" }).split(/\s+/);
    for (const cls of [
      "focus-visible:outline-solid",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-transparent",
    ]) {
      expect(classes, `missing ${cls} in: ${classes.join(" ")}`).toContain(cls);
    }
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily restored the pre-oavb base class (`outline-none`, no
   * `focus-visible:outline-*` utilities) and confirmed every assertion
   * above failed with the real, non-vacuous message (either an unexpected
   * "outline-none" token present, or a missing "focus-visible:outline-solid"
   * token) — then reverted. Also tried the specific false-fix this bead's
   * own notes call out (a bare `focus-visible:outline focus-visible:outline-2`
   * pair with `outline-none` still present) and confirmed the "carries a
   * focus-visible outline that actually SETS outline-style" assertion still
   * failed, since `outline-solid` was absent; reverted.
   */
});
