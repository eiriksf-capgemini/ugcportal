import { describe, expect, it } from "vitest";

import { designSystem } from "@/lib/design/usage";

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

/**
 * ugcportal-ei5c K1/K3: default-neutral used to name `text-petrol-900` - a
 * class that compiles to NO Tailwind rule at all, because `--color-petrol-900`
 * is declared in globals.css's near-black `:root` block, deliberately
 * outside `@theme`, specifically so Tailwind does not emit `bg-`/`text-`
 * utilities for it (see that block's own "stopping Tailwind emitting
 * bg-petrol-900 and friends" comment). The label therefore rendered in
 * whatever colour it happened to inherit, never petrol-900, while
 * contrast.ts's `petrol-900-on-petrol-400` pairing (now `surface-0-on-
 * petrol-400`, retargeted at the token the variant actually paints today)
 * documented a measured ratio for a colour nothing painted - a false claim
 * of coverage. Nothing in this repo's existing scanners would have caught
 * it: findBareColorUtilities (src/lib/design/usage.ts) deliberately EXCLUDES
 * a non-compiling bare candidate rather than flagging it (a candidate that
 * fails to compile might be a `border-style`/`background-size` keyword
 * utility sharing the namespace, not an undeclared colour - see that
 * function's own doc comment), so this family of bug is invisible to the
 * contrast gate's normal coverage sweep. This describe block is the
 * dedicated guard K1/K3 ask for instead.
 *
 * Compiles every bare (non-alpha-modified) `bg-`/`text-`/`border-` utility
 * each variant's REAL `buttonVariants` output names against `designSystem` -
 * the real Tailwind design system loaded from this repo's own globals.css
 * (src/lib/design/usage.ts's `__unstable__loadDesignSystem` call) - the same
 * mechanism `isBareColorUtility`/`findBareColorUtilities` already use to ask
 * "does this candidate compile to a real rule", and the same one the bead's
 * own premise used by hand ("compiling globals.css through
 * @tailwindcss/postcss with @source inline(...) appended") to first confirm
 * the bug empirically. Run over every variant (K3's sibling sweep), not only
 * `default-neutral` - the one variant this bead actually fixes - so a
 * sibling shipping the identical mistake in the future cannot hide behind
 * only one variant being checked.
 */
describe("buttonVariants K1/K3 (ugcportal-ei5c): every bare colour utility a variant names actually compiles", () => {
  const ALL_VARIANTS = [
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

  /**
   * `token` is one whitespace-separated class from a variant's compiled
   * class string, possibly with a chain of leading `variant:` prefixes
   * (`hover:bg-primary-hover`, `aria-expanded:bg-accent`) - Tailwind compiles
   * the base utility identically regardless of which variant triggers it,
   * the same simplification findBareColorUtilities's own BOUNDARY regex
   * relies on. Returns the bare `bg-`/`text-`/`border-` candidate at the end
   * of that chain, with NO alpha modifier (a trailing `/NN` breaks the
   * match, same as findBareColorUtilities's own bare-vs-alpha split - an
   * alpha-modified utility like destructive's `border-destructive/75` is
   * findAlphaColorUtilities's question, not this one), or null if `token`
   * names neither of the three bare colour namespaces this bug shape can
   * occur in.
   */
  function bareColorCandidate(token: string): string | null {
    const match = /(?:^|:)((?:bg|text|border)-(?:\[[^\]]+\]|\([^)]+\)|[a-zA-Z][\w-]*))$/.exec(
      token,
    );
    return match ? match[1] : null;
  }

  it.each(ALL_VARIANTS)(
    "%s variant: every bare bg-/text-/border- utility compiles to a real Tailwind rule",
    (variant) => {
      const classes = buttonVariants({ variant }).split(/\s+/);
      for (const token of classes) {
        const candidate = bareColorCandidate(token);
        if (candidate === null) continue;
        const [css] = designSystem.candidatesToCss([candidate]);
        expect(
          css,
          `"${variant}" variant's "${token}" names "${candidate}", which compiles to no Tailwind ` +
            `rule at all - the exact ugcportal-ei5c bug shape (a token declared outside @theme on ` +
            `purpose, e.g. --color-petrol-900). A contrast.ts pairing for this colour would document ` +
            `a ratio for a colour the browser never paints.`,
        ).not.toBeNull();
      }
    },
  );

  /**
   * Proves the guard above actually bites, the same "mutate and assert it
   * fails" discipline K1 itself asks for - without mutating the real
   * button.tsx (contrast.test.ts's own tmpdir-based mutation checks use the
   * identical discipline, a synthetic fixture rather than editing real
   * source at test time): default-neutral's literal PRE-ei5c class string,
   * checked directly through the same bare-candidate extraction and
   * compile step the `it.each` above runs.
   */
  it("catches the exact pre-fix default-neutral string (bg-petrol-400 text-petrol-900 hover:brightness-95) as shipping a non-compiling bare utility", () => {
    const preFixClasses = "bg-petrol-400 text-petrol-900 hover:brightness-95".split(/\s+/);
    const candidates = preFixClasses
      .map(bareColorCandidate)
      .filter((candidate): candidate is string => candidate !== null);
    expect(candidates).toEqual(["bg-petrol-400", "text-petrol-900"]);

    const [fillCss] = designSystem.candidatesToCss([candidates[0]]);
    const [labelCss] = designSystem.candidatesToCss([candidates[1]]);
    expect(fillCss, "bg-petrol-400 compiles - the fill was never the bug").not.toBeNull();
    expect(
      labelCss,
      "text-petrol-900 must compile to NO rule - that is the exact bug this bead fixes",
    ).toBeNull();
  });

  it("the real, current default-neutral variant no longer ships that non-compiling candidate", () => {
    const classes = buttonVariants({ variant: "default-neutral" }).split(/\s+/);
    expect(classes).not.toContain("text-petrol-900");
    expect(classes).toContain("text-surface-0");
    const [css] = designSystem.candidatesToCss(["text-surface-0"]);
    expect(css, "text-surface-0 must compile to a real rule").not.toBeNull();
  });
});
