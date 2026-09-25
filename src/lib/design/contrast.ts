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
 * The focus-ring alpha the components actually ship (`outline-ring/70` in the
 * base layer, `ring-ring/70` on buttons). Checked at that alpha, not at full
 * opacity, because the alpha is what the user sees.
 */
export const RING_ALPHA_MODIFIER = 70;

/**
 * The alpha the destructive border ships at (`border-destructive/60`). The
 * stock shadcn /40 measures 2.79:1 on the lightest surface, i.e. it fails
 * 1.4.11 as the boundary of a destructive control; /60 clears it with room.
 */
export const DESTRUCTIVE_EDGE_ALPHA_MODIFIER = 60;

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
  ...onEverySurface(
    "link",
    "--primary",
    "body",
    "Petrol as link text and as the `link` button variant; also the fill of the single primary action, whose boundary this same ratio covers.",
  ),
  ...onEverySurface(
    "control-edge",
    "--input",
    "ui",
    "The boundary that identifies an interactive control: input borders, outline-button borders.",
  ),
  ...onEverySurface(
    "focus-ring",
    `--ring/${RING_ALPHA_MODIFIER}`,
    "ui",
    "The focus indicator, at the alpha it is rendered with.",
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
  {
    id: "accent-foreground-on-accent",
    foreground: "--accent-foreground",
    background: ["--accent"],
    requirement: "body",
    usage: "Text of a hovered or selected menu item / list row.",
  },
  {
    id: "secondary-foreground-on-secondary",
    foreground: "--secondary-foreground",
    background: ["--secondary"],
    requirement: "body",
    usage: "Label of the secondary button variant.",
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
          id: `ink-on-destructive-surface${state}`,
          foreground: "--foreground",
          background: [well],
          requirement: "body",
          usage: `Body copy inside an error well${state ? ", hovered" : ""}.`,
        },
        {
          id: `muted-foreground-on-destructive-surface${state}`,
          foreground: "--muted-foreground",
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

export type TokenReference = { property: string; alpha: number };

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
  if (parts.length === 1) return { property, alpha: 1 };
  const modifier = parts[1].trim();
  if (!/^\d{1,3}$/.test(modifier)) {
    throw new Error(
      `[design/contrast] alpha modifier in "${reference}" must be an integer 0-100`,
    );
  }
  const alpha = Number(modifier);
  if (alpha > 100) {
    throw new Error(
      `[design/contrast] alpha modifier in "${reference}" must be an integer 0-100`,
    );
  }
  return { property, alpha: alpha / 100 };
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
