/**
 * The documented contrast surface of the design system (ugcportal-axu).
 *
 * Every text-on-surface and accent-on-surface pairing the UI actually renders
 * is listed here with the WCAG threshold it has to clear. src/lib/design/
 * contrast.test.ts evaluates all of them against the real values parsed out of
 * src/app/globals.css and fails the suite — and therefore CI, and therefore the
 * merge — on any pair below its threshold.
 *
 * Two coverage tests keep this list honest, but only for the shapes they name:
 * adding a `--color-surface-<n>` level, or any `--*-foreground` token, without
 * listing it here fails the suite. A token under some other name (a third ink
 * level, say) is not caught automatically and has to be added here by hand.
 */

import {
  contrastRatio,
  compositeOver,
  parseColor,
  toHex,
  type Srgb,
} from "./color";
import { resolveToken, type Declaration } from "./tokens";

/**
 * WCAG 2.2 minimums.
 *
 * `body` — 1.4.3 normal-size text.
 * `large` — 1.4.3 large text (>=18.66px bold or >=24px).
 * `ui` — 1.4.11 non-text contrast: the parts of an interactive control that
 *        identify it, and its focus indicator.
 * `decorative` — out of scope for 1.4.11 (a purely ornamental boundary). Every
 *        such pairing must say why in `why`, and the set of them is frozen by a
 *        test so a failing pair cannot be reclassified into this bucket.
 */
export const THRESHOLDS = {
  body: 4.5,
  large: 3,
  ui: 3,
} as const;

export type Requirement = keyof typeof THRESHOLDS | "decorative";

export type Pairing = {
  id: string;
  /** Token reference, optionally with a Tailwind-style alpha modifier: `--ring/60`. */
  foreground: string;
  /** Background stack, bottom first. The bottom layer must be opaque. */
  background: string[];
  requirement: Requirement;
  /** Where this pairing actually appears in the product. */
  usage: string;
  /** Required for, and only for, `decorative`. */
  why?: string;
};

/**
 * Every surface a foreground can land on. The scale is five levels plus the
 * opaque immersive backdrop; a test asserts this list covers every
 * `--color-surface-*` token declared in the stylesheet.
 */
export const SURFACES = [
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
  "--color-surface-4",
  "--color-scrim",
] as const;

/**
 * ugcportal-rw9j review round 4: the distinct, resolved-token list behind
 * globals.css's --ring-on-old-surfaces rule (`.bg-surface-0, ... .bg-sidebar
 * { --ring: var(--color-fjord-400); }`) - --color-surface-0..4 cover
 * .bg-surface-0..4 directly; --color-surface-1 also covers .bg-sidebar
 * and --color-surface-2 also covers .bg-popover/.bg-accent/.bg-secondary
 * (all already in this list via their shared resolved token, so no separate
 * entries are needed for them); --color-danger-surface is
 * .bg-destructive-surface's resolved value, the one member SURFACES above
 * does not include. See the focus-ring-on-old-surface comment below for why
 * this is its own list rather than SURFACES.
 *
 * ugcportal-6uc2 (phase 2): `.bg-muted` and `.bg-card` used to also resolve
 * to --color-surface-1 and are no longer in globals.css's selector list at
 * all - both now paint a light, paper-toned fill (--paper-card), so forcing
 * the near-black-tuned ring back on there would be wrong, not merely
 * redundant. This list needs no change for that: --color-surface-1 stays
 * covered by `.bg-surface-1` and `.bg-sidebar` regardless, so the RESOLVED
 * set below is unaffected by two selectors leaving the CSS rule.
 *
 * Exported (round 5, code-review): nothing enforced this list staying in
 * sync with globals.css's own selector list until contrast.test.ts's
 * "RING_OVERRIDE_SURFACES matches globals.css's own selector list" gained a
 * test that resolves both independently and compares them.
 */
export const RING_OVERRIDE_SURFACES = [
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
  "--color-surface-4",
  "--color-danger-surface",
] as const;

function onEverySurface(
  idPrefix: string,
  foreground: string,
  requirement: Requirement,
  usage: string,
  why?: string,
): Pairing[] {
  return SURFACES.map((surface) => ({
    id: `${idPrefix}-on-${surface.replace("--color-", "")}`,
    foreground,
    background: [surface],
    requirement,
    usage,
    why,
  }));
}

/**
 * The focus-ring alpha the components ship (`outline-ring/80` in the base
 * layer; `ring-ring/80`, `ring-destructive/80` on buttons). Checked at that
 * alpha, not at full opacity, because the alpha is what the user sees.
 *
 * 80, not the shadcn default and not the 70 this bead first pushed: with
 * compositing done the way browsers actually do it (see compositeOver), 70
 * measures 3.15:1 on the lightest surface. That passes, but by less than the
 * margin worth keeping — so 80, at 3.65:1.
 */
export const RING_ALPHA_MODIFIER = 80;

/**
 * The alpha the destructive border ships at. The stock shadcn /40 measures
 * 2.19:1 on the lightest surface and /60 measures 2.97:1 — both fail 1.4.11
 * as the boundary of a destructive control. /75 clears it at 3.79:1.
 */
export const DESTRUCTIVE_EDGE_ALPHA_MODIFIER = 75;

export const PAIRINGS: Pairing[] = [
  ...onEverySurface(
    "ink",
    "--color-ink",
    "body",
    "Body copy, headings and captions on every surface level.",
  ),
  ...onEverySurface(
    "ink-muted",
    "--color-ink-muted",
    "body",
    "Secondary text: metadata, helper text, image captions, table sub-labels.",
  ),
  /*
   * ugcportal-rw9j: this used to be onEverySurface, back when --background
   * was one of SURFACES and --primary (petrol) had one value good on all of
   * them. Now --primary has a light and a dark derivation chosen for the
   * page canvas specifically (see globals.css), and measures only 1.3-2.4:1
   * against the untouched near-black surface scale in light mode - scoping
   * this to --background is what's actually true post-rw9j, not a narrowing
   * for its own sake.
   *
   * review round 4: every real text-primary usage (admin/settings/rights,
   * users, instagram pages) was traced and confirmed to sit on the plain
   * page canvas, not inside any well - at the time this codebase had no
   * Card/Popover component and no bg-card/bg-popover usage anywhere (see
   * globals.css's round-3 --ring comment). The focus ring is the one
   * control that genuinely reaches the untouched near-black surfaces (the
   * resale-rights decision form's inputs, the upload page's dropzone),
   * fixed by the --ring-on-old-surfaces override and focus-ring-on-old-
   * surface above - not by anything here.
   *
   * ugcportal-6uc2 (phase 2) makes "no bg-card usage anywhere" no longer
   * true - TEXT_INPUT_CLASS renders `bg-card` now - but it still renders no
   * `text-primary`, so this entry's own scoping is unaffected; see
   * control-edge-on-card/focus-ring-on-card below for what DID need a new
   * entry once bg-card became a real surface.
   */
  {
    id: "link-on-background",
    foreground: "--primary",
    background: ["--background"],
    requirement: "body",
    usage:
      "Petrol as link text, the `link` button variant, and the petrol outline/secondary button's border and label; also the fill of the single primary action, whose boundary this same ratio covers.",
  },
  ...onEverySurface(
    "control-edge",
    "--input",
    "ui",
    "The boundary that identifies an interactive control: input borders, outline-button borders.",
  ),
  /*
   * ugcportal-6uc2 (phase 2): the upload dropzone's resting-state border
   * (src/app/upload/upload-form.tsx, `border-line-strong bg-surface-1`) is
   * the one real usage of `--color-line-strong` that did NOT go through
   * `--input` - before this bead `--input: var(--color-line-strong)` made
   * the two interchangeable, so the dropzone rode along on control-edge-*
   * above for free. Phase 2 repoints `--input` onto the paper scale, which
   * breaks that equivalence: `--input` no longer resolves to the same
   * literal `--color-line-strong` does, so the dropzone's border needs its
   * OWN entry now, or it ships uncovered. Same requirement (`ui`, 3:1 - it
   * is the boundary of the dropzone's own interactive region, the same role
   * an input border plays) and the same near-black surfaces it has always
   * rendered on (bg-surface-1 resting, bg-surface-2 dragging - both already
   * in SURFACES).
   */
  ...onEverySurface(
    "line-strong-edge",
    "--color-line-strong",
    "ui",
    "The upload dropzone's own border (src/app/upload/upload-form.tsx), now that --input no longer aliases this token (ugcportal-6uc2).",
  ),
  /*
   * ugcportal-rw9j: scoped to --background rather than onEverySurface, for a
   * reason distinct from link-on-background and primary-hover-fill-on-
   * background above - --ring applies globally (`* { outline-ring/80 }` in
   * globals.css), so it is not a component this phase chose to move, it is a
   * token this phase could not avoid touching once the page canvas changed
   * (see globals.css's long comment on --ring for why).
   */
  {
    id: "focus-ring-on-background",
    foreground: `--ring/${RING_ALPHA_MODIFIER}`,
    background: ["--background"],
    requirement: "ui",
    usage: "The focus indicator, at the alpha it is rendered with, on the page canvas.",
  },
  /*
   * ugcportal-rw9j review round 3: globals.css scopes a --ring override back
   * to --color-fjord-400 on every element that also carries one of the old
   * near-black surface background classes (bg-surface-*, bg-muted, bg-card,
   * ...) - resolveToken/loadThemeTokens has no notion of a class-scoped CSS
   * override, so this checks the literal token that override points at
   * directly (the same reason primary-hover-fill and friends check a literal
   * step of the petrol scale rather than a semantic alias elsewhere in this
   * file), restoring the "every surface" coverage focus-ring-on-background
   * above gave up when --ring started tracking --primary.
   *
   * review round 4 (MAJOR): this used to be `...onEverySurface(...)`, i.e.
   * SURFACES (--color-surface-0..4 plus --color-scrim). That list was built
   * for a different question ("every surface a foreground can land on") and
   * both omitted a real member of the --ring override - .bg-destructive-
   * surface resolves to --color-danger-surface, not any --color-surface-N,
   * so the override's actual effect there (measured 4.66:1 - safe, but
   * unverified by this gate) was never checked - and included one that does
   * not apply: no component anywhere uses a literal bg-scrim class, so
   * --color-scrim's membership in SURFACES never corresponded to anything
   * the --ring override actually touches. RING_OVERRIDE_SURFACES below is
   * restated directly from globals.css's own selector list instead of reused
   * from an unrelated enumeration, so the two cannot independently drift
   * again the way they already had.
   */
  ...RING_OVERRIDE_SURFACES.map((surface) => ({
    id: `focus-ring-on-old-surface-${surface.replace("--color-", "")}`,
    foreground: `--color-fjord-400/${RING_ALPHA_MODIFIER}`,
    background: [surface],
    requirement: "ui" as const,
    usage:
      "The focus indicator on a control that still lives on the near-black surface scale (the resale-rights decision form's inputs, the upload page's file dropzone, a destructive well's own controls, ...), via the --ring override scoped to these surface classes in globals.css.",
  })),
  /*
   * ugcportal-rw9j review round 5 (code-review): --color-fjord-400 at FULL
   * opacity (not the RING_ALPHA_MODIFIER-alpha ring above) against the same
   * old-surface list - button.tsx's default-neutral variant and the upload
   * queue's per-row progress-bar fill both paint it solid on one of these
   * surfaces, and neither was checked by any existing pairing before this
   * round (focus-ring-on-old-surface only ever checked the alpha-modified
   * ring use). Same surfaces, different use of the same token, so its own
   * entry rather than folded into the one above.
   */
  ...RING_OVERRIDE_SURFACES.map((surface) => ({
    id: `fjord-400-fill-on-old-surface-${surface.replace("--color-", "")}`,
    foreground: "--color-fjord-400",
    background: [surface],
    requirement: "ui" as const,
    usage:
      "default-neutral's fill and the upload queue's progress-bar fill, both solid --color-fjord-400 on a control that still lives on the near-black surface scale.",
  })),
  /*
   * ugcportal-rw9j review round 5 (code-review): the label on top of that
   * same fill, chosen to mirror dark mode's own --primary (a light fill
   * with a dark label). Originally written as `--petrol-900` (this entry
   * was called `petrol-900-on-petrol-400`) - but `--petrol-900` is the hex
   * reference-palette token (see globals.css's own petrol-hex comment;
   * ugcportal-uo15 later renamed the OTHER, OKLCH `--color-petrol-900` to
   * `--color-fjord-900` so the two can no longer be confused by name),
   * declared outside `@theme`, so `text-petrol-900` never compiled to a Tailwind utility at all:
   * button.tsx's default-neutral variant painted this label in whatever
   * colour it happened to inherit from the page's ambient
   * `--foreground` - confirmed by rendering both colour schemes
   * (ugcportal-ei5c): `rgb(11, 46, 51)` in light mode, which happens to
   * equal `--petrol-900`'s own value only because light mode's
   * `--foreground` IS `--petrol-900` (coincidence, not the utility
   * painting it), but `rgb(250, 247, 242)` (`--paper`, near-white) in dark
   * mode - nothing like petrol-900 there. This entry documented a ratio
   * for a colour nothing reliably painted. `--color-surface-0` is the
   * fix: the same fill-light/label-dark shape, a genuine near-black, and
   * - unlike `--petrol-900` - actually declared in `@theme`, so
   * `text-surface-0` is a real, compiling utility that paints the same
   * colour in both schemes, not an inherited one that happens to match in
   * one and not the other.
   *
   * UPDATE (ugcportal-z1nh): the upload dropzone's "Choose files" label
   * (src/app/upload/upload-form.tsx) was NOT a caller of this variant - it
   * pasted `bg-fjord-400 text-petrol-900` directly, the identical
   * never-compiles bug, disclosed but left out of ugcportal-ei5c's stated
   * scope. Fixed now, onto this same `text-surface-0`/`--color-fjord-400`
   * pair rather than through buttonVariants (see that file's own comment on
   * why it stays a hand-styled label) - so this entry's `usage` below now
   * names both real callers, and button.test.ts's hand-pasted-pair guard
   * (ugcportal-z1nh) scans upload-form.tsx (and the rest of src/, button.tsx
   * and src/lib/design/ excepted) for a future reintroduction of the same
   * non-compiling candidate.
   */
  {
    id: "surface-0-on-fjord-400",
    foreground: "--color-surface-0",
    background: ["--color-fjord-400"],
    requirement: "body",
    usage: "Label on default-neutral's fill (button.tsx) - the upload queue's \"Sign in\" link shown on a failed upload that needs re-authentication - and, directly (not through buttonVariants), the upload dropzone's \"Choose files\" label (src/app/upload/upload-form.tsx).",
  },
  ...onEverySurface(
    "divider",
    "--color-line",
    "decorative",
    "Row dividers, card edges and section rules.",
    "Purely ornamental separation. WCAG 1.4.11 covers the parts of a control that identify it, not decoration; a 3:1 hairline on every row would draw a bright grid across a page whose job is to disappear behind photographs. Controls use --color-line-strong, which is checked at 3:1 via line-strong-edge-on-* and control-edge-* below.",
  ),
  /*
   * ugcportal-rw9j review round 5, superseded by ugcportal-6uc2 (phase 2):
   * this entry used to measure --color-line (not --border) against
   * --background, because at the time --border still read --color-line
   * directly and this was documented as a phase-1-exempt MEASUREMENT, not a
   * gate - "kort, kantlinjer, skjemafelt" (cards, BORDERS, form fields) was
   * named as a future bead's scope, not phase 1's.
   *
   * ugcportal-6uc2 IS that bead. --border now reads `--paper-line` (light)
   * / `--petrol-line` (dark) - see globals.css's own --border declarations -
   * so this entry's foreground changes from the literal `--color-line` to
   * the semantic `--border`, which is what the real, rendered header/footer
   * hairline (`* { @apply border-border }`) has always tracked. Still
   * `decorative` (WCAG 1.4.11 does not cover ornamental separation - nothing
   * about that classification changed), so there is still no ratio floor
   * here; this is K1's own computed-style check, not a new gate. Measured at
   * the new values: 1.40:1 light (`--paper-line` #d8d3c8 on `--paper`
   * #faf7f2), 1.48:1 dark (`--petrol-line` #1f4a50 on `--petrol-900`
   * #0b2e33) - both LOWER than the old, incidental 11.6:1/1.16:1 this same
   * entry used to report, and deliberately so: the old ratios were an
   * accident of a near-black line sitting on a canvas it was never tuned
   * for, not a target to preserve. Low-but-decorative is what a subtle
   * hairline on a light canvas is supposed to measure, by the reference
   * file's own design.
   */
  {
    id: "divider-on-background",
    foreground: "--border",
    background: ["--background"],
    requirement: "decorative",
    usage: "The header/footer hairline rule against the page canvas - K1's own acceptance criterion.",
    why: "Ornamental separation (WCAG 1.4.11 does not cover it), same reasoning as --color-line's own onEverySurface entries above - a 3:1 hairline on every row would draw a bright grid across a page whose job is to disappear behind photographs. Measured at the paper-scale values: 1.40:1 light, 1.48:1 dark.",
  },

  {
    id: "primary-label-on-primary",
    foreground: "--primary-foreground",
    background: ["--primary"],
    requirement: "body",
    usage: "Label of the filled primary action button.",
  },
  {
    id: "primary-label-on-primary-hover",
    foreground: "--primary-foreground",
    background: ["--primary-hover"],
    requirement: "body",
    usage: "Label of the filled primary action button, hovered.",
  },
  /*
   * ugcportal-rw9j: scoped to --background rather than onEverySurface, same
   * reasoning as link-on-background above - the primary button lives on the
   * page canvas in this phase, not inside the untouched card/popover
   * surfaces.
   */
  {
    id: "primary-hover-fill-on-background",
    foreground: "--primary-hover",
    background: ["--background"],
    requirement: "ui",
    usage: "The hovered primary button's fill, as the boundary that identifies it against the page.",
  },
  {
    id: "selection-text-on-selection",
    foreground: "--selection-foreground",
    background: ["--selection"],
    requirement: "body",
    usage: "Text inside a ::selection highlight.",
  },

  // Semantic aliases, checked as wired rather than as intended: a mis-pointed
  // alias (--muted moved up a level, say) fails here even though the raw scale
  // is untouched.
  {
    id: "foreground-on-background",
    foreground: "--foreground",
    background: ["--background"],
    requirement: "body",
    usage: "Default body text on the page canvas.",
  },
  {
    id: "card-foreground-on-card",
    foreground: "--card-foreground",
    background: ["--card"],
    requirement: "body",
    usage: "Text inside a card / raised panel.",
  },
  {
    id: "popover-foreground-on-popover",
    foreground: "--popover-foreground",
    background: ["--popover"],
    requirement: "body",
    usage: "Text inside a popover, menu or dialog.",
  },
  /*
   * ugcportal-rw9j: originally --color-ink-muted, not --muted-foreground,
   * for these two - --muted/--card stayed on the untouched near-black
   * surface scale that phase, and --muted-foreground meant "secondary text
   * as this app actually renders it on the page canvas" (see muted-
   * foreground-on-background below) - a page-canvas-specific token, the
   * same split applied to --foreground vs --color-ink for the destructive
   * well above.
   *
   * Review round 1 (phase 1) found that mattered for real, not just in
   * principle: src/app/admin/settings/rights/page.tsx rendered text-muted-
   * foreground directly on bg-muted (an uploader's blocker message and
   * review metadata, inside the same div as bg-muted/bg-destructive-
   * surface), which measured 3.18:1 against --muted-foreground at the time.
   * Fixed there by switching those two elements to text-ink-muted.
   *
   * ugcportal-6uc2 (phase 2) reverses this entry's foreground back to
   * --muted-foreground, because --muted/--card themselves have now moved
   * onto the paper scale - see globals.css's own --muted/--card
   * declarations. --color-ink-muted (tuned for the near-black scale: light
   * text meant to sit on a dark fill) would read as near-invisible on the
   * new, light --muted/--card (confirmed: it is the identical failure
   * shape muted-foreground-on-background's own comment below describes for
   * --color-ink-muted against --paper, just against --muted/--card instead
   * of --background). The round-1 fix above is reversed in the same
   * direction, at every real call site this bead found: see
   * src/lib/design/dual-meaning-usage.test.ts's AUDITED_USAGE for the
   * (file, token, count) pins, and globals.css's own --muted-foreground
   * comment for which text-ink-muted usages correctly stayed put (the ones
   * genuinely still rendering against an untouched near-black fill).
   */
  {
    id: "muted-foreground-on-muted",
    foreground: "--muted-foreground",
    background: ["--muted"],
    requirement: "body",
    usage: "Secondary text on a muted fill.",
  },
  {
    id: "muted-foreground-on-card",
    foreground: "--muted-foreground",
    background: ["--card"],
    requirement: "body",
    usage: "Caption under an image, metadata line in a list row.",
  },
  /*
   * ugcportal-6uc2 (phase 2): --input (border-input) and --ring (the focus
   * indicator) can now both land on --card/--muted, which did not exist as
   * a real background before this bead moved those two off the near-black
   * scale. control-edge-on-card/-on-muted mirror control-edge-on-* above
   * for the two new surfaces (TEXT_INPUT_CLASS's own border, now bg-card);
   * focus-ring-on-card/-on-muted mirror focus-ring-on-background for the
   * same reason focus-ring-on-old-surface exists for the near-black scale -
   * a real caller (the curation screens' Button, default variant, rendered
   * inside the "Rights layers"/price bg-muted wells) can focus there, and
   * the plain, unscoped --ring is what it gets now that `.bg-muted`/
   * `.bg-card` are removed from globals.css's --ring-on-old-surfaces
   * override (see that rule's own comment).
   */
  /*
   * Round-1 review of ugcportal-6uc2, CONFIRMED medium: sign-in-menu.tsx
   * and mobile-nav-toggle.tsx both float a popover panel over
   * `bg-background` - the SAME fill the page behind it uses - with a
   * `border-border`/`border-X` edge as the only thing that identifies the
   * open panel. Before this bead, `--border` was `--color-line` (11.62:1
   * there, plenty), so the real 3:1 requirement was met by accident; once
   * `--border` moved to the decorative `--paper-line` (1.40:1, correct for
   * an ornamental hairline, wrong for a control boundary), both panels
   * silently dropped below K3's floor with no pairing to catch it - this
   * file had `control-edge-on-card`/`-on-muted` for the other two new
   * surfaces `--input` can land on, but no entry at all for `--background`
   * itself. Fixed at the component level (both now read `border-input`,
   * the token this pairing verifies) and at the gate level (this entry),
   * so a future floating panel reaching for `border-border` the same way
   * has somewhere to fail.
   */
  {
    id: "control-edge-on-background",
    foreground: "--input",
    background: ["--background"],
    requirement: "ui",
    usage: "The boundary of a floating panel that sits over the same --background fill as the page behind it (the sign-in menu and the mobile nav popover) - the border is the only thing identifying the open panel's edge.",
  },
  {
    id: "control-edge-on-card",
    foreground: "--input",
    background: ["--card"],
    requirement: "ui",
    usage: "TEXT_INPUT_CLASS's own border, now that its field renders on bg-card (ugcportal-6uc2).",
  },
  {
    id: "control-edge-on-muted",
    foreground: "--input",
    background: ["--muted"],
    requirement: "ui",
    usage: "An input or outline-button border inside a bg-muted well (e.g. the curation screens' callout panels).",
  },
  {
    id: "focus-ring-on-card",
    foreground: `--ring/${RING_ALPHA_MODIFIER}`,
    background: ["--card"],
    requirement: "ui",
    usage: "The focus indicator on a control inside a bg-card fill, e.g. TEXT_INPUT_CLASS's own field.",
  },
  {
    id: "focus-ring-on-muted",
    foreground: `--ring/${RING_ALPHA_MODIFIER}`,
    background: ["--muted"],
    requirement: "ui",
    usage: "The focus indicator on a control inside a bg-muted well, e.g. the curation screens' Button inside the Rights layers/price panels.",
  },
  /*
   * ugcportal-rw9j K1: this is the pairing that actually matches reality.
   * --muted-foreground renders directly on --background in real, shipped
   * components today - the footer (src/components/app-shell.tsx), the empty-
   * gallery and loading-status copy (src/components/gallery/*), the signed-in
   * user's email (auth-status.tsx), and supporting paragraphs across
   * auth/error and the admin settings pages. A live axe run against the home
   * page caught exactly this: --color-ink-muted (unchanged, designed for the
   * old near-black canvas) measured 1.9:1 against the new --paper background
   * before this pairing existed to catch it in the gate too.
   */
  {
    id: "muted-foreground-on-background",
    foreground: "--muted-foreground",
    background: ["--background"],
    requirement: "body",
    usage:
      "Secondary/caption text directly on the page canvas: footer, empty-state copy, loading status, supporting paragraphs.",
  },
  {
    id: "accent-foreground-on-accent",
    foreground: "--accent-foreground",
    background: ["--accent"],
    requirement: "body",
    usage: "Text of a hovered or selected menu item / list row.",
  },
  /*
   * ugcportal-rw9j review round 1: the shadcn `secondary` button variant no
   * longer renders --secondary/--secondary-foreground at all - it reuses the
   * petrol outline treatment (src/components/ui/button.tsx), covered by
   * link-on-background above - so as of this bead nothing in src renders
   * this pairing. Kept, not deleted: --secondary-foreground is still a
   * declared `-foreground` token (the "documents every *-foreground token"
   * test below requires it to be covered by some pairing), and --secondary
   * itself is untouched, documented, near-black-scale coverage for the same
   * reason --color-fjord-600..950 are kept despite not driving a current
   * utility - available if something reaches for it, not proof that
   * something does today.
   */
  {
    id: "secondary-foreground-on-secondary",
    foreground: "--secondary-foreground",
    background: ["--secondary"],
    requirement: "body",
    usage: "Label of the secondary button variant, if something renders it (unused as of ugcportal-rw9j).",
  },
  {
    id: "sidebar-foreground-on-sidebar",
    foreground: "--sidebar-foreground",
    background: ["--sidebar"],
    requirement: "body",
    usage: "Navigation labels in a sidebar.",
  },
  {
    id: "sidebar-primary-foreground-on-sidebar-primary",
    foreground: "--sidebar-primary-foreground",
    background: ["--sidebar-primary"],
    requirement: "body",
    usage: "Label of the active/primary item in a sidebar.",
  },
  {
    id: "sidebar-accent-foreground-on-sidebar-accent",
    foreground: "--sidebar-accent-foreground",
    background: ["--sidebar-accent"],
    requirement: "body",
    usage: "Label of a hovered or selected sidebar item.",
  },
  {
    id: "sidebar-ring-on-sidebar",
    foreground: `--sidebar-ring/${RING_ALPHA_MODIFIER}`,
    background: ["--sidebar"],
    requirement: "ui",
    usage: "Focus indicator inside a sidebar.",
  },
  {
    id: "sidebar-border-on-sidebar",
    foreground: "--sidebar-border",
    background: ["--sidebar"],
    requirement: "decorative",
    usage: "Rule separating a sidebar from content.",
    why: "Same reasoning as --color-line: ornamental separation, not the boundary of a control.",
  },

  // Destructive, in the places it appears: as text on a surface, as the
  // boundary of a destructive control, and inside its own error well.
  ...onEverySurface(
    "destructive-text",
    "--destructive",
    "body",
    "Inline error text and the destructive button label.",
  ),
  ...onEverySurface(
    "destructive-edge",
    `--destructive/${DESTRUCTIVE_EDGE_ALPHA_MODIFIER}`,
    "ui",
    "Border of the error callout and of the destructive button.",
  ),
  ...onEverySurface(
    "destructive-focus-ring",
    `--destructive/${RING_ALPHA_MODIFIER}`,
    "ui",
    "Focus indicator on a destructive control.",
  ),
  ...(["--destructive-surface", "--destructive-surface-hover"] as const).flatMap(
    (well): Pairing[] => {
      const state = well.endsWith("-hover") ? "-hover" : "";
      return [
        {
          id: `destructive-text-on-destructive-surface${state}`,
          foreground: "--destructive",
          background: [well],
          requirement: "body",
          usage: `Error text inside its own well${state ? ", hovered" : ""}.`,
        },
        {
          /*
           * --color-ink, not --foreground (ugcportal-rw9j): the error well
           * stays on the untouched near-black surface scale (see globals.css's
           * phase-1-mandate comment), and --foreground now means "whatever
           * pairs with --background", which this well deliberately is not.
           * --color-ink is the neutral scale's own body-text token - what
           * "foreground" meant here before this bead decoupled the two.
           */
          id: `ink-on-destructive-surface${state}`,
          foreground: "--color-ink",
          background: [well],
          requirement: "body",
          usage: `Body copy inside an error well${state ? ", hovered" : ""}.`,
        },
        {
          // --color-ink-muted, not --muted-foreground: same reasoning as
          // ink-on-destructive-surface above.
          id: `muted-foreground-on-destructive-surface${state}`,
          foreground: "--color-ink-muted",
          background: [well],
          requirement: "body",
          usage: `Supporting detail inside an error well${state ? ", hovered" : ""}.`,
        },
        {
          id: `control-edge-on-destructive-surface${state}`,
          foreground: "--input",
          background: [well],
          requirement: "ui",
          usage: `An input or outline button inside an error well${state ? ", hovered" : ""}.`,
        },
        {
          id: `destructive-edge-on-destructive-surface${state}`,
          foreground: `--destructive/${DESTRUCTIVE_EDGE_ALPHA_MODIFIER}`,
          background: [well],
          requirement: "ui",
          usage: `Border of the destructive button against its own fill${state ? ", hovered" : ""}.`,
        },
        /*
         * ugcportal-rw9j review round 5: destructive-focus-ring above
         * (onEverySurface) only ever checked --destructive/${RING_ALPHA_
         * MODIFIER} against SURFACES, never against the well its own focus
         * ring actually has to render on - the same shape as
         * focus-ring-on-old-surface's round-4 gap, just for the destructive
         * ring instead of the neutral one. Passes today (measured ~5.33:1,
         * same value on both well states since --destructive itself doesn't
         * change), but was entirely unmonitored before this entry.
         */
        {
          id: `destructive-focus-ring-on-destructive-surface${state}`,
          foreground: `--destructive/${RING_ALPHA_MODIFIER}`,
          background: [well],
          requirement: "ui",
          usage: `Focus indicator on a destructive control inside its own well${state ? ", hovered" : ""}.`,
        },
      ];
    },
  ),

  // Chart tokens are declared but not yet consumed; they are checked against
  // the two surfaces a chart could sit on so they cannot ship unreadable.
  ...(["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const).flatMap(
    (chart): Pairing[] =>
      (["--color-surface-0", "--color-surface-1"] as const).map((surface) => ({
        id: `${chart.slice(2)}-on-${surface.replace("--color-", "")}`,
        foreground: chart,
        background: [surface],
        requirement: "ui" as const,
        usage: "Chart series mark on the canvas or inside a card.",
      })),
  ),

  /*
   * ugcportal-6dvg: the front page hero's own fixed petrol-gradient well
   * (`.home-hero-surface`, src/app/globals.css; src/components/home/hero.tsx)
   * — a surface this phase did not have before, so a new pairing rather than
   * a reuse of onEverySurface's near-black scale.
   *
   * Checked against `--petrol-700` only, the LIGHTER of the gradient's two
   * stops and so the worse case for a light foreground; the gradient only
   * gets darker toward `--petrol-900`, which can only improve this ratio,
   * never worsen it.
   *
   * `--color-ink`, not `--color-ink-muted`, for BOTH the title and the lead
   * paragraph: `--color-ink-muted` measures only 4.15:1 here (below body
   * text's 4.5:1) — it is tuned for the darker near-black surface scale
   * (surface-0..4, L 0.185-0.345), which this gradient's lighter stop
   * (petrol-700, L ~0.42) is not. See src/components/home/hero.tsx's own
   * comment on its lead paragraph.
   */
  {
    id: "ink-on-hero-petrol",
    foreground: "--color-ink",
    background: ["--petrol-700"],
    requirement: "body",
    usage: "The hero's title and lead paragraph, on the front page's petrol gradient surface.",
  },
  /*
   * The hero's own call-to-action: a light petrol-tint fill with a dark
   * label, mirroring the fill-light/label-dark pairing already established
   * for default-neutral / the upload dropzone — but spelled, from the
   * start, with a LABEL token that actually compiles to a Tailwind utility.
   * At the time this was written, default-neutral's own label was
   * `text-petrol-900`, which has no `bg-`/`text-petrol-900` utility at all:
   * `--color-fjord-900` is declared in the OKLCH near-black `:root` block,
   * not `@theme` (see that block's own "stopping Tailwind emitting
   * bg-fjord-900 and friends" comment) — confirmed empirically by
   * compiling globals.css and checking the generated utilities, not
   * assumed. Filed as a pre-existing issue rather than silently reused: see
   * the PR description. (ugcportal-ei5c later fixed default-neutral's own
   * label to this same `text-surface-0` token, for the identical reason —
   * see button.tsx's and `surface-0-on-fjord-400`'s own comments — so the
   * two variants now share a label token, just against two different
   * fills.) `--color-surface-0` IS in `@theme` (so `text-surface-0` is
   * real), is a genuine near-black, and is not one of this file's existing
   * surface entries' FOREGROUND uses — only its background ones — so this
   * is a new foreground use of an existing token, not a new token.
   *
   * `--color-petrol-100`, NOT `--petrol-100` (round-3 review, CONFIRMED
   * medium — an earlier version of this entry checked the wrong one): at
   * the time, this app had TWO separately-declared, DIFFERENTLY-VALUED
   * petrol-100 tokens — `--petrol-100` the hex reference-palette value
   * (`#cfe8e7`), declared in `:root` and never exposed as a Tailwind
   * utility, and `--color-petrol-100` an independently-authored OKLCH value
   * (`oklch(0.95 0.028 205)`) inside `@theme`, which is what `bg-petrol-100`
   * — the actual class on hero.tsx's CTA — resolved to. Checking the hex
   * one verified a ratio for a colour this button never painted.
   *
   * ugcportal-uo15 closed that particular gap generally rather than only
   * here: `--color-petrol-100` (and `-200`/`-500`) is now declared as
   * `var(--petrol-100)` in globals.css's `@theme` block, so the two no
   * longer diverge at all — checking either resolves to the identical
   * `#cfe8e7`. This entry still checks `--color-petrol-100` specifically,
   * not because the values differ anymore but because that is the literal
   * property `bg-petrol-100` resolves through, which is what this pairing
   * claims to verify. The sibling `fjord-400-fill-on-old-surface-*` pairing
   * above checks the analogous `--color-fjord-400`, not `--petrol-400` —
   * step 400 has no hex counterpart at all, so that pair was never at risk
   * of this particular confusion, only of the general one ugcportal-uo15's
   * rename now forecloses for every step.
   */
  {
    id: "surface-0-on-petrol-100",
    foreground: "--color-surface-0",
    background: ["--color-petrol-100"],
    requirement: "body",
    usage: "The hero's call-to-action label, on its light petrol-tint fill.",
  },
  {
    id: "surface-0-on-petrol-100-hover",
    foreground: "--color-surface-0",
    background: ["--color-petrol-200"],
    requirement: "body",
    usage: "The hero's call-to-action label, on its light petrol-tint fill, hovered (hover:bg-petrol-200).",
  },
];

export type TokenReference = {
  property: string;
  /** The alpha modifier as a 0-1 multiplier, for the colour-compositing math. */
  alpha: number;
  /**
   * The alpha modifier exactly as Tailwind would print the percentage, e.g.
   * `80`, or `12.5` for a fractional alpha - not `alpha * 100`.
   *
   * ugcportal-j4j round 2 finding 3: usage.ts learned to scan a fractional
   * alpha (`bg-primary/12.5`) without this field existing, and the coverage
   * key in contrast.test.ts recovered a percentage from `alpha` via
   * `Math.round(alpha * 100)` to compare against it. That round-trips
   * through a division and a rounding a usage's own `alphaPercent` never
   * goes through, so equal alphas parsed on the two sides could print as
   * different numbers (`ring-ring/80.5` parsed here as `0.805`, and
   * `Math.round(0.805 * 100)` is `81` or `80` depending on floating-point
   * rounding, never reliably `80.5`) - a fractional alpha the scanner could
   * see but the coverage check could never match, which is a worse state
   * than the silent skip it replaced. Keeping the originally-written
   * percentage instead of re-deriving it means both sides always agree.
   */
  alphaPercent: number;
};

/** Splits `--ring/70` into its token and its alpha multiplier. */
export function parseTokenReference(reference: string): TokenReference {
  const parts = reference.split("/");
  if (parts.length > 2) {
    throw new Error(`[design/contrast] malformed token reference "${reference}"`);
  }
  const property = parts[0].trim();
  if (!property.startsWith("--")) {
    throw new Error(
      `[design/contrast] "${reference}" is not a custom-property reference`,
    );
  }
  if (parts.length === 1) return { property, alpha: 1, alphaPercent: 100 };
  const modifier = parts[1].trim();
  // Mirrors usage.ts's ALPHA_UTILITY numeric branch: Tailwind alpha modifiers
  // can be fractional (`/12.5`), not just integer.
  if (!/^\d+(?:\.\d+)?$/.test(modifier)) {
    throw new Error(
      `[design/contrast] alpha modifier in "${reference}" must be a number 0-100`,
    );
  }
  const alphaPercent = Number(modifier);
  if (alphaPercent > 100) {
    throw new Error(
      `[design/contrast] alpha modifier in "${reference}" must be a number 0-100`,
    );
  }
  return { property, alpha: alphaPercent / 100, alphaPercent };
}

function resolveReference(
  reference: string,
  tokens: Map<string, Declaration>,
): Srgb {
  const { property, alpha } = parseTokenReference(reference);
  const color = parseColor(resolveToken(property, tokens));
  if (color.outOfGamut) {
    throw new Error(
      `[design/contrast] ${property} is outside the sRGB gamut, so the browser clips it ` +
        `and its real contrast is whatever the clip produces. Pick an in-gamut value.`,
    );
  }
  return { ...color, alpha: color.alpha * alpha };
}

export type PairingResult = {
  pairing: Pairing;
  ratio: number;
  required: number | null;
  passes: boolean;
  foregroundHex: string;
  backgroundHex: string;
};

/** Evaluates one pairing against the tokens parsed from the stylesheet. */
export function evaluatePairing(
  pairing: Pairing,
  tokens: Map<string, Declaration>,
): PairingResult {
  if (pairing.background.length === 0) {
    throw new Error(`[design/contrast] ${pairing.id} has no background layers`);
  }
  const layers = pairing.background.map((reference) =>
    resolveReference(reference, tokens),
  );
  if (layers[0].alpha !== 1) {
    throw new Error(
      `[design/contrast] ${pairing.id}: the bottom background layer ` +
        `"${pairing.background[0]}" is translucent, so the pairing has no ` +
        `defined contrast ratio.`,
    );
  }
  const background = layers.reduce((beneath, layer) =>
    compositeOver(layer, beneath),
  );
  const foreground = resolveReference(pairing.foreground, tokens);
  const ratio = contrastRatio(foreground, background);

  const required =
    pairing.requirement === "decorative"
      ? null
      : THRESHOLDS[pairing.requirement];

  return {
    pairing,
    ratio,
    required,
    // A decorative pairing has no threshold, so it cannot fail on ratio. It is
    // constrained instead by the frozen decorative-id list in the test file.
    passes: required === null || ratio >= required,
    foregroundHex: toHex(compositeOver(foreground, background)),
    backgroundHex: toHex(background),
  };
}

/**
 * ugcportal-uo15 K3: "following should never happen - two live scales again
 * share a step name across `@theme` and `:root`, in either direction".
 *
 * Written against the INVARIANT, not against petrol specifically (bd memory
 * `source-text-guards-are-specified-by-invariant`): this bead's bug was one
 * instance of a general shape - a `--color-<name>-<step>` custom property
 * (the kind `@theme` can turn into a Tailwind utility) and a bare
 * `--<name>-<step>` property (the kind a reference palette like
 * docs/design/tokens.css declares) sharing a NAME while resolving to
 * DIFFERENT colours. Any future scale that does this - petrol again, or a
 * brand-new one nobody has named yet - trips this the same way, because the
 * check is "do these two specific properties disagree", not "is this
 * specific string 'petrol'".
 *
 * Deliberately permissive about the other direction: a `--color-X-N` with NO
 * bare `--X-N` counterpart (most of `--color-surface-*`, `--color-danger-*`,
 * the renamed `--color-fjord-*` ramp) is not a collision - there is only one
 * value for that name, so there is nothing to disagree. Likewise a
 * `--color-X-N` whose bare counterpart happens to be a `var()` ALIAS of it
 * (`--color-petrol-200: var(--petrol-200)`, this bead's own fix) resolves
 * both sides to the identical final colour and is correctly not flagged -
 * that is K1's goal state, not K3's failure state.
 */
export type ScaleNameCollision = {
  /** The `@theme`-shaped property, e.g. `--color-petrol-200`. */
  colorProperty: string;
  /** The bare property sharing its name and step, e.g. `--petrol-200`. */
  bareProperty: string;
  colorHex: string;
  bareHex: string;
};

/**
 * Matches a scale-token-shaped custom property: `--color-<name>-<step>`,
 * where `<step>` is a run of digits (`50`, `200`, `950`, ...) or the literal
 * `deep` (this app's one non-numeric step). `<name>` itself may contain
 * hyphens (`danger-surface` does not end in a step, so it never matches;
 * `chart-1` does, deliberately - see the function doc comment on why a
 * perfect alias there is fine, not a false negative).
 */
const SCALE_STEP_PROPERTY = /^--color-([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d+|deep)$/;

/**
 * Finds every `--color-<name>-<step>` / `--<name>-<step>` pair that both
 * exist in `tokens` and resolve to different colours. Empty means K3 holds.
 *
 * Takes a plain token map, not a file path: contrast.test.ts's own
 * fixture-mutation check (K3's own "re-add a colliding pair and confirm the
 * guard fails" instruction) constructs a synthetic map with a deliberate
 * collision and feeds it straight in, without writing a throwaway CSS file.
 */
export function findColorScaleNameCollisions(
  tokens: Map<string, Declaration>,
): ScaleNameCollision[] {
  const collisions: ScaleNameCollision[] = [];
  for (const colorProperty of tokens.keys()) {
    const match = SCALE_STEP_PROPERTY.exec(colorProperty);
    if (!match) continue;
    const [, name, step] = match;
    const bareProperty = `--${name}-${step}`;
    if (!tokens.has(bareProperty)) continue;

    const colorHex = toHex(parseColor(resolveToken(colorProperty, tokens)));
    const bareHex = toHex(parseColor(resolveToken(bareProperty, tokens)));
    if (colorHex !== bareHex) {
      collisions.push({ colorProperty, bareProperty, colorHex, bareHex });
    }
  }
  return collisions;
}

/**
 * K4 (ugcportal-6uc2): "following should never happen - the phase-1 holding
 * comment in globals.css is deleted while any of --border, --input, --card
 * or --muted still reads from the near-black scale, leaving the file
 * claiming a migration it did not finish."
 *
 * The marker is a literal substring of the comment's own prose
 * (PHASE_2_HOLDING_COMMENT_MARKER below), not a structural parse of CSS
 * comments - this file already has a real CSS-comment stripper
 * (stripComments in tokens.ts/scan-source.ts) for places that need one;
 * this check only needs to know whether a SPECIFIC sentence survives, which
 * a substring test answers directly. If a future edit rewords the comment
 * without preserving this sentence, this guard fails too (an unknown
 * marker reads as "absent", the same as a deleted comment), which is the
 * conservative direction to fail in - better to require editing this
 * constant too than to let the comment drift wording and quietly lose its
 * own guard.
 *
 * PHASE_2_MOVED_TOKENS is the four tokens this bead's own K1-K3 move, named
 * directly rather than derived - there is no general "which tokens moved"
 * fact in the stylesheet to derive this from; it is this bead's own list.
 */
const PHASE_2_HOLDING_COMMENT_MARKER =
  "Phase 2 (ugcportal-6uc2) is that approval acted on";

export const PHASE_2_MOVED_TOKENS = ["--border", "--input", "--card", "--muted"] as const;

/**
 * A resolved declaration shaped like one of the near-black scale's own
 * members: `var(--color-surface-<n>)` / `var(--color-scrim)` (the pre-bead
 * values of --card and --muted) or `var(--color-line)` /
 * `var(--color-line-strong)` (the pre-bead values of --border and --input).
 *
 * Round-1 review (PR #209), CONFIRMED medium: the first version of this
 * pattern only matched the surface-\d+/scrim half - exactly the two tokens
 * (--card, --muted) that happened to share a pre-bead value with each
 * other, and not the other two (--border read --color-line, --input read
 * --color-line-strong, neither of which this pattern recognised at all). A
 * mutation test that reverted --card to its pre-bead value therefore
 * passed, and happened to be the one fixture mutation this file originally
 * shipped with - the guard was never exercised against --border/--input at
 * all, which is why the gap survived the "mutate the fixture" discipline
 * rather than being caught by it. contrast.test.ts's K4 describe block now
 * parameterises its fixture mutation over all four of PHASE_2_MOVED_TOKENS,
 * each reverted to ITS OWN documented pre-bead value, specifically so this
 * class of "the guard only covers the tokens the author happened to test"
 * gap cannot recur silently.
 */
const NEAR_BLACK_SCALE_REFERENCE =
  /^var\(--color-(surface-\d+|scrim|line-strong|line)\)$/;

export type Phase2MigrationClaimCheck = {
  commentPresent: boolean;
  /**
   * Which of PHASE_2_MOVED_TOKENS still resolves to the near-black scale,
   * OR is not declared at all (see checkPhase2MigrationClaim's own comment
   * on why a missing token counts the same way a near-black one does).
   * Empty when the migration is genuinely finished.
   */
  stillNearBlack: string[];
  /** True in exactly the state K4 forbids: the comment is gone AND the migration is not actually finished. */
  claimsUnfinishedMigrationAsDone: boolean;
};

/**
 * Takes the raw CSS text (for the comment) and a resolved token map (for the
 * four values) separately, rather than re-parsing both from one string:
 * contrast.test.ts's own fixture-mutation check constructs a synthetic
 * token map and a mutated copy of the real CSS text independently, the same
 * shape findColorScaleNameCollisions's own fixture tests already use.
 */
export function checkPhase2MigrationClaim(
  css: string,
  tokens: Map<string, Declaration>,
): Phase2MigrationClaimCheck {
  const commentPresent = css.includes(PHASE_2_HOLDING_COMMENT_MARKER);
  const stillNearBlack = PHASE_2_MOVED_TOKENS.filter((token) => {
    const declaration = tokens.get(token);
    /*
     * Round-1 review (PR #209), CONFIRMED medium: `tokens.get(token)?.value
     * ?? ""` let a DELETED token (not declared at all, the shape a botched
     * refactor could leave behind as easily as reverting a value) read as
     * "not near-black", because the empty string matches no pattern - the
     * wrong default for a guard whose entire job is proving the migration
     * finished, not merely failing to find evidence that it did not. A
     * token this resolver cannot find is not proven to be on the paper
     * scale either, so it is treated the same as one still reading the
     * near-black scale: present in `stillNearBlack`, explicitly, rather
     * than silently passing through a fallback that was never chosen for
     * this reason.
     */
    if (!declaration) return true;
    return NEAR_BLACK_SCALE_REFERENCE.test(declaration.value);
  });
  return {
    commentPresent,
    stillNearBlack,
    claimsUnfinishedMigrationAsDone: !commentPresent && stillNearBlack.length > 0,
  };
}
