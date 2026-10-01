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
   * against the untouched near-black --card/--popover surfaces in light mode
   * - scoping this to --background is what's actually true post-rw9j, not a
   * narrowing for its own sake. See globals.css's --ring comment for the one
   * place that gap is real today (text-primary links on
   * admin/settings/{rights,instagram}, which sit on --card) and why fixing it
   * is fase 2's job.
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
   * to --color-petrol-400 on every element that also carries one of the old
   * near-black surface background classes (bg-surface-*, bg-muted, bg-card,
   * ...) - resolveToken/loadThemeTokens has no notion of a class-scoped CSS
   * override, so this checks the literal token that override points at
   * directly (the same reason primary-hover-fill and friends check a literal
   * step of the petrol scale rather than a semantic alias elsewhere in this
   * file), restoring the "every surface" coverage focus-ring-on-background
   * above gave up when --ring started tracking --primary.
   */
  ...onEverySurface(
    "focus-ring-on-old-surface",
    `--color-petrol-400/${RING_ALPHA_MODIFIER}`,
    "ui",
    "The focus indicator on a control that still lives on the near-black surface scale (the resale-rights decision form's inputs, the upload page's file dropzone, ...), via the --ring override scoped to these surface classes in globals.css.",
  ),
  ...onEverySurface(
    "divider",
    "--color-line",
    "decorative",
    "Row dividers, card edges and section rules.",
    "Purely ornamental separation. WCAG 1.4.11 covers the parts of a control that identify it, not decoration; a 3:1 hairline on every row would draw a bright grid across a page whose job is to disappear behind photographs. Controls use --color-line-strong (--input), which is checked at 3:1 above.",
  ),

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
   * ugcportal-rw9j: --color-ink-muted, not --muted-foreground, for these two.
   * --muted/--card stay on the untouched near-black surface scale this
   * phase, and --muted-foreground now means "secondary text as this app
   * actually renders it on the page canvas" (see muted-foreground-on-
   * background below) - a page-canvas-specific token, the same split applied
   * to --foreground vs --color-ink for the destructive well above.
   *
   * Review round 1 found this matters for real, not just in principle: this
   * comment originally claimed nothing in the shipped app renders
   * text-muted-foreground directly on bg-muted - false. src/app/admin/
   * settings/rights/page.tsx rendered exactly that (an uploader's blocker
   * message and review metadata, inside the same div as bg-muted/
   * bg-destructive-surface), which measured 3.18:1 against the new
   * --muted-foreground in light mode. Fixed there by switching those two
   * elements to text-ink-muted - the token this pairing (and
   * muted-foreground-on-destructive-surface below) actually measures - so
   * the claim below is enforced by that page's own markup now, not merely
   * documented here.
   */
  {
    id: "muted-foreground-on-muted",
    foreground: "--color-ink-muted",
    background: ["--muted"],
    requirement: "body",
    usage: "Secondary text on a muted fill.",
  },
  {
    id: "muted-foreground-on-card",
    foreground: "--color-ink-muted",
    background: ["--card"],
    requirement: "body",
    usage: "Caption under an image, metadata line in a list row.",
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
   * reason --color-petrol-600..950 are kept despite not driving a current
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
