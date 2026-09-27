import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseColor } from "./color";
import {
  PAIRINGS,
  RING_ALPHA_MODIFIER,
  SURFACES,
  THRESHOLDS,
  evaluatePairing,
  parseTokenReference,
  type Pairing,
} from "./contrast";
import {
  GLOBALS_CSS_PATH,
  loadThemeTokens,
  parseDeclarations,
  resolveToken,
} from "./tokens";
import { findAlphaColorUtilities, type AlphaUtilityUsage } from "./usage";

const tokens = loadThemeTokens();
const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

/** `--ring/70` (or a bare `--ring`) to `<resolved literal>@<alpha percent>`. */
function tokenAlphaKey(reference: string): string {
  const { property, alpha } = parseTokenReference(reference);
  return `${resolveToken(property, tokens)}@${Math.round(alpha * 100)}`;
}

/**
 * The strongest WCAG threshold any PAIRING has actually verified a given
 * (resolved literal, alpha) combination at, restricted to foreground-role
 * pairings. A decorative pairing proves no ratio at all (no THRESHOLDS entry)
 * and does not contribute.
 *
 * K2 (ugcportal-j4j finding 2): keying coverage by (literal, alpha, role)
 * alone is not enough. `--ring`, `--primary`, `--sidebar-ring` and
 * `--sidebar-primary` all resolve to the same literal, and are all
 * foreground-role, so a pairing that measures one at some alpha used to read
 * as covering ANY of the others at that alpha - including link-on-surface at
 * body's 4.5:1 being "covered" by focus-ring at ui's 3:1. Taking the maximum
 * threshold actually verified per key, and comparing it against what the
 * *usage* needs (see expectedThresholdFor below) rather than merely checking
 * presence, closes that gap without needing every namespace's pairings kept
 * in exact 1:1 lockstep with the tokens they happen to share a literal with.
 */
const FOREGROUND_VERIFIED_THRESHOLD = new Map<string, number>();
for (const pairing of PAIRINGS) {
  if (pairing.requirement === "decorative") continue;
  const key = tokenAlphaKey(pairing.foreground);
  const value = THRESHOLDS[pairing.requirement];
  FOREGROUND_VERIFIED_THRESHOLD.set(
    key,
    Math.max(FOREGROUND_VERIFIED_THRESHOLD.get(key) ?? -Infinity, value),
  );
}

/**
 * Background coverage has no threshold dimension: a surface itself is not
 * independently held to a ratio, only whatever sits on it is, and no shipped
 * PAIRINGS background is alpha-modified. If that stops being true, the
 * background side of this needs the same threshold treatment as the
 * foreground side above.
 */
const MEASURED_BACKGROUND = new Set(
  PAIRINGS.flatMap((pairing) => pairing.background.map(tokenAlphaKey)),
);

/**
 * What a *usage* (as opposed to a PAIRING) needs to clear, inferred from its
 * namespace. `text` renders glyphs directly and this is a static source
 * scan - it cannot tell body text from large text - so it is held to the
 * stricter of WCAG's two text minimums, `body` (4.5:1), rather than risk
 * under-claiming for a usage that turns out to be normal-size. Every other
 * foreground namespace this gate tracks (a ring, a border, a divider) is a
 * non-text UI mark, held to `ui` (3:1) - the same threshold PAIRINGS already
 * uses throughout for exactly these namespaces (focus-ring, control-edge,
 * destructive-edge).
 */
const TEXT_PREFIXES = new Set(["text"]);
function expectedThresholdFor(usage: Pick<AlphaUtilityUsage, "prefix">): number {
  return TEXT_PREFIXES.has(usage.prefix) ? THRESHOLDS.body : THRESHOLDS.ui;
}

/**
 * K1 (ugcportal-axu). Every documented pairing, evaluated against the values
 * actually in src/app/globals.css. Editing a token below its threshold turns
 * this red, which turns CI red, which blocks the merge.
 */
describe("WCAG contrast over the documented palette", () => {
  it.each(
    PAIRINGS.filter((pairing) => pairing.requirement !== "decorative").map(
      (pairing) => [pairing.id, pairing] as const,
    ),
  )("%s", (_id, pairing) => {
    const result = evaluatePairing(pairing, tokens);
    expect(
      result.ratio,
      `${pairing.id}: ${pairing.foreground} (${result.foregroundHex}) on ` +
        `${pairing.background.join(" + ")} (${result.backgroundHex}) is ` +
        `${result.ratio.toFixed(2)}:1, below the ${result.required}:1 required for ` +
        `"${pairing.requirement}". Usage: ${pairing.usage}`,
    ).toBeGreaterThanOrEqual(result.required as number);
  });
});

describe("the gate cannot be routed around", () => {
  it("has a unique id per pairing", () => {
    const ids = PAIRINGS.map((pairing) => pairing.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("checks body text at 4.5:1 and non-text at 3:1", () => {
    // Pinned so a future edit to THRESHOLDS is a visible, deliberate act
    // rather than a quiet relaxation.
    expect(THRESHOLDS).toEqual({ body: 4.5, large: 3, ui: 3 });
  });

  /**
   * The decorative bucket is the only pairing class with no ratio floor, so it
   * is the obvious place to hide a failing pair. Freezing the list here means
   * moving a pairing into it requires editing this test, in the diff, on
   * purpose.
   */
  it("has exactly these decorative exemptions, and no others", () => {
    const decorative = PAIRINGS.filter(
      (pairing) => pairing.requirement === "decorative",
    ).map((pairing) => pairing.id);
    expect(decorative.sort()).toEqual(
      [
        "divider-on-scrim",
        "divider-on-surface-0",
        "divider-on-surface-1",
        "divider-on-surface-2",
        "divider-on-surface-3",
        "divider-on-surface-4",
        "sidebar-border-on-sidebar",
      ].sort(),
    );
  });

  it("requires every decorative exemption to justify itself", () => {
    for (const pairing of PAIRINGS) {
      if (pairing.requirement !== "decorative") {
        expect(pairing.why, `${pairing.id} is not decorative`).toBeUndefined();
        continue;
      }
      expect(pairing.why?.length ?? 0, pairing.id).toBeGreaterThan(40);
    }
  });

  it("never lets a decorative token be the boundary of an interactive control", () => {
    // --color-line is exempt from 3:1 precisely because it is never the thing
    // that tells you a control is there. --input / --color-line-strong is, and
    // is checked at 3:1 above.
    const decorativeTokens = new Set(
      PAIRINGS.filter((pairing) => pairing.requirement === "decorative").map(
        (pairing) => parseTokenReference(pairing.foreground).property,
      ),
    );
    const controlTokens = new Set(
      PAIRINGS.filter(
        (pairing) =>
          pairing.requirement === "ui" &&
          (pairing.id.includes("control-edge") ||
            pairing.id.includes("focus-ring")),
      ).map((pairing) => parseTokenReference(pairing.foreground).property),
    );
    for (const token of controlTokens) {
      expect(decorativeTokens.has(token), token).toBe(false);
    }
  });

  it("documents every surface level the stylesheet declares", () => {
    // Adding --color-surface-5 to globals.css without adding it here fails,
    // so a new level cannot arrive unchecked.
    const declared = [...tokens.keys()].filter((name) =>
      /^--color-surface-\d+$/.test(name),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(SURFACES, `${name} is missing from SURFACES`).toContain(name);
    }
  });

  it("documents every *-foreground token the stylesheet declares", () => {
    const usedAsForeground = new Set(
      PAIRINGS.map((pairing) => parseTokenReference(pairing.foreground).property),
    );
    // A `@theme inline` alias (--color-foreground: var(--foreground)) counts as
    // covered by the token it points at; it is the same colour under a
    // Tailwind-facing name, not a second value that could drift.
    const covered = (name: string) => {
      if (usedAsForeground.has(name)) return true;
      const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(tokens.get(name)?.value ?? "");
      return alias !== null && usedAsForeground.has(alias[1]);
    };
    const declared = [...tokens.keys()].filter((name) =>
      name.endsWith("-foreground"),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(
        covered(name),
        `${name} is declared in globals.css but never contrast-checked`,
      ).toBe(true);
    }
  });

  it("rejects every token that falls outside the sRGB gamut", () => {
    // Browsers clip an out-of-gamut colour, so its measured contrast would be
    // the contrast of the clip, not of the token. evaluatePairing throws
    // instead; this asserts nothing in the shipped set trips it.
    for (const pairing of PAIRINGS) {
      expect(() => evaluatePairing(pairing, tokens), pairing.id).not.toThrow();
    }
  });

  /**
   * Finding 3 of round 1: pinning `outline-ring/80` with a string literal
   * covered exactly one of the six alpha-modified utilities this codebase
   * ships. The other five were free to drift — dropping `ring-ring/80` to
   * `/50` would have taken the real focus indicator to about 2.2:1 with the
   * suite still green. This derives the assertion from the source instead, so
   * coverage follows the components the way the token coverage tests already
   * follow the stylesheet.
   */
  it("measures every alpha-modified colour utility the components ship", () => {
    const used = findAlphaColorUtilities();
    expect(used.length).toBeGreaterThan(0);

    for (const usage of used) {
      // A Tailwind built-in colour (bg-black/50) resolves to no token at all.
      // Caught here with its own advice, because letting resolveToken throw
      // "unknown token --color-black" blames the wrong thing.
      expect(
        tokens.has(usage.property),
        `${usage.file} uses "${usage.utility}", which is not a design token - ` +
          `${usage.property} is not declared in globals.css. Use a token from the ` +
          `surface/ink/petrol scales so the gate can measure it.`,
      ).toBe(true);

      const usageKey = `${resolveToken(usage.property, tokens)}@${usage.alphaPercent}`;

      if (usage.role === "background") {
        expect(
          MEASURED_BACKGROUND.has(usageKey),
          `${usage.file} uses "${usage.utility}", but no pairing in PAIRINGS ` +
            `measures ${usage.property} at ${usage.alphaPercent}% alpha as a ` +
            `background. Add that pairing - a colour measured as a foreground ` +
            `does not cover it, because the two sit against different things.`,
        ).toBe(true);
        continue;
      }

      // Foreground: presence is not enough (K2). The pairing that measures
      // this (literal, alpha) has to have checked it at or above the
      // threshold *this usage's namespace* needs, not merely some threshold.
      const verified = FOREGROUND_VERIFIED_THRESHOLD.get(usageKey) ?? -Infinity;
      const required = expectedThresholdFor(usage);
      expect(
        verified >= required,
        `${usage.file} uses "${usage.utility}", but no pairing in PAIRINGS measures ` +
          `${usage.property} at ${usage.alphaPercent}% alpha as a foreground at or ` +
          `above the ${required}:1 this usage's namespace needs. ` +
          (verified === -Infinity
            ? "It is not measured as a foreground at that alpha at all."
            : `The strongest pairing that measures it there is only checked at ` +
              `${verified}:1 - a different token that happens to share this ` +
              `literal is not proof this one clears the bar.`) +
          " Add a pairing for it.",
      ).toBe(true);
    }
  });

  /**
   * K2 (ugcportal-j4j finding 2), reproduced directly: --ring and --primary
   * resolve to the same literal, and the focus-ring pairing measures
   * --ring/80 only at ui's 3:1. A hypothetical text-primary/80 - link text
   * turned translucent, needing body's 4.5:1 - must not read as covered by
   * that measurement just because the literal and alpha match.
   */
  it("does not let a UI-boundary pairing cover a text usage of the same literal and alpha", () => {
    expect(resolveToken("--ring", tokens)).toBe(resolveToken("--primary", tokens));

    const ringKey = tokenAlphaKey(`--ring/${RING_ALPHA_MODIFIER}`);
    expect(FOREGROUND_VERIFIED_THRESHOLD.get(ringKey)).toBe(THRESHOLDS.ui);

    const hypotheticalTextUsage: AlphaUtilityUsage = {
      file: "synthetic (not shipped)",
      utility: `text-primary/${RING_ALPHA_MODIFIER}`,
      property: "--color-primary",
      alphaPercent: RING_ALPHA_MODIFIER,
      role: "foreground",
      prefix: "text",
    };
    const usageKey = `${resolveToken(hypotheticalTextUsage.property, tokens)}@${hypotheticalTextUsage.alphaPercent}`;
    expect(usageKey, "same literal, same alpha - the collision K2 closes").toBe(
      ringKey,
    );

    const verified = FOREGROUND_VERIFIED_THRESHOLD.get(usageKey) ?? -Infinity;
    expect(verified).toBeLessThan(expectedThresholdFor(hypotheticalTextUsage));
  });

  /**
   * Finding 3 of round 2. The gamut rejection only fires for tokens named in
   * PAIRINGS, and the usage scanner only sees alpha-modified utilities, so
   * `bg-petrol-900` could ship a clipped colour with the suite green. Anything
   * in a @theme block is a utility Tailwind will emit, so that is the right
   * place to draw the line: if it can be used, it has to be real.
   */
  it("emits no out-of-gamut colour as a usable utility", () => {
    const themeColors = parseDeclarations(css).filter(
      (declaration) =>
        declaration.selector.startsWith("@theme") &&
        declaration.property.startsWith("--color-"),
    );
    expect(themeColors.length).toBeGreaterThan(10);

    for (const declaration of themeColors) {
      const value = resolveToken(declaration.property, tokens);
      let color;
      try {
        color = parseColor(value);
      } catch {
        continue; // not a colour literal; nothing to check
      }
      expect(
        color.outOfGamut,
        `${declaration.property} (${value}) is outside the sRGB gamut, but is ` +
          `declared in "${declaration.selector}", so Tailwind emits utilities for ` +
          `it and a component can use a colour the browser will clip. Either bring ` +
          `it into gamut or move it out of @theme so it stays a value without ` +
          `becoming a utility.`,
      ).toBe(false);
    }
  });

  it("still ships the focus ring at the alpha the constant names", () => {
    const rings = findAlphaColorUtilities().filter(
      (usage) => usage.property === "--color-ring",
    );
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring.alphaPercent, ring.file).toBe(RING_ALPHA_MODIFIER);
    }
    expect(css).toContain(`outline-ring/${RING_ALPHA_MODIFIER}`);
  });

  it("evaluates a below-threshold pair as failing", () => {
    // Proves the gate has teeth: a pairing that should fail, does.
    const doomed: Pairing = {
      id: "self-check",
      foreground: "--color-surface-1",
      background: ["--color-surface-0"],
      requirement: "body",
      usage: "Not shipped; exists to prove the assertion can fail.",
    };
    const result = evaluatePairing(doomed, tokens);
    expect(result.ratio).toBeLessThan(THRESHOLDS.body);
    expect(result.passes).toBe(false);
  });

  it("refuses a pairing whose bottom background layer is translucent", () => {
    expect(() =>
      evaluatePairing(
        {
          id: "bad-stack",
          foreground: "--color-ink",
          background: ["--destructive/10", "--color-surface-0"],
          requirement: "body",
          usage: "Not shipped.",
        },
        tokens,
      ),
    ).toThrow(/translucent/);
  });
});

describe("parseTokenReference", () => {
  it("reads a bare token as fully opaque", () => {
    expect(parseTokenReference("--ring")).toEqual({
      property: "--ring",
      alpha: 1,
    });
  });

  it("reads a Tailwind alpha modifier", () => {
    expect(parseTokenReference("--ring/70")).toEqual({
      property: "--ring",
      alpha: 0.7,
    });
    expect(parseTokenReference("--ring/0")).toEqual({
      property: "--ring",
      alpha: 0,
    });
  });

  it.each(["ring", "--ring/70/10", "--ring/abc", "--ring/101", "--ring/"])(
    "throws on %s",
    (reference) => {
      expect(() => parseTokenReference(reference)).toThrow();
    },
  );
});

/**
 * K4 (ugcportal-axu): petrol survives the demotion and still drives at least
 * the focus and link treatments.
 */
describe("petrol is demoted, not removed", () => {
  it("still ships the full --color-petrol-50..950 scale", () => {
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      expect(tokens.has(`--color-petrol-${step}`), `petrol-${step}`).toBe(true);
    }
  });

  it("drives the focus ring", () => {
    expect(tokens.get("--ring")?.value).toMatch(/^var\(--color-petrol-\d+\)$/);
  });

  it("drives link and primary-action colour", () => {
    expect(tokens.get("--primary")?.value).toMatch(
      /^var\(--color-petrol-\d+\)$/,
    );
  });

  it("drives the selection highlight", () => {
    expect(tokens.get("--selection")?.value).toMatch(
      /^var\(--color-petrol-(?:\d+|deep)\)$/,
    );
  });

  it("no longer paints the page, cards, overlays or the neutral hover fill", () => {
    // The demotion, stated as a check: the big areas are all neutral surface.
    for (const token of [
      "--background",
      "--card",
      "--popover",
      "--muted",
      "--accent",
      "--secondary",
      "--sidebar",
    ]) {
      expect(tokens.get(token)?.value, token).toMatch(
        /^var\(--color-(surface-\d+|scrim)\)$/,
      );
    }
  });
});

/**
 * The surface scale's shape, asserted rather than described, so the
 * "perceptually even steps from a near-black canvas" claim in globals.css
 * stays true.
 */
describe("the surface scale", () => {
  const levels = [0, 1, 2, 3, 4].map((index) => {
    const value = tokens.get(`--color-surface-${index}`)?.value ?? "";
    const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
    if (!match) throw new Error(`surface-${index} is not a plain oklch triple`);
    return {
      index,
      lightness: Number(match[1]),
      chroma: Number(match[2]),
      hue: Number(match[3]),
    };
  });

  it("rises monotonically in lightness", () => {
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i].lightness).toBeGreaterThan(levels[i - 1].lightness);
    }
  });

  it("steps evenly, so elevation reads consistently at near-black", () => {
    const steps = levels
      .slice(1)
      .map((level, index) => level.lightness - levels[index].lightness);
    for (const step of steps) {
      expect(step).toBeCloseTo(steps[0], 6);
    }
  });

  it("starts above a photograph's black point and stays out of mid-grey", () => {
    // Below ~0.16 the canvas is indistinguishable from the blacks inside a
    // well-exposed photograph and the image loses its edge; above ~0.25 as a
    // page colour the surround starts reading as a UI panel.
    expect(levels[0].lightness).toBeGreaterThanOrEqual(0.16);
    expect(levels[0].lightness).toBeLessThanOrEqual(0.25);
  });

  it("carries only a trace of petrol's hue, strongest at the bottom", () => {
    for (const level of levels) {
      expect(level.hue).toBe(205);
      expect(level.chroma).toBeLessThanOrEqual(0.01);
    }
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i].chroma).toBeLessThan(levels[i - 1].chroma);
    }
  });

  it("puts the immersive backdrop below the canvas", () => {
    const scrim = /^oklch\(([\d.]+) /.exec(
      tokens.get("--color-scrim")?.value ?? "",
    );
    expect(Number(scrim?.[1])).toBeLessThan(levels[0].lightness);
  });
});
