import { readFileSync } from "node:fs";

import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { parseColor } from "./color";
import {
  PAIRINGS,
  RING_ALPHA_MODIFIER,
  RING_OVERRIDE_SURFACES,
  SURFACES,
  THRESHOLDS,
  evaluatePairing,
  parseTokenReference,
  type Pairing,
} from "./contrast";
import {
  DARK_MEDIA_SELECTOR,
  GLOBALS_CSS_PATH,
  loadThemeTokens,
  parseDeclarations,
  resolveToken,
  type Declaration,
  type ThemeMode,
} from "./tokens";
import {
  designSystem,
  discoverColorNamespaces,
  findAlphaColorUtilities,
  findBareColorUtilities,
  type AlphaUtilityUsage,
} from "./usage";

/**
 * ugcportal-rw9j: this app now resolves to one of two token sets depending on
 * `prefers-color-scheme` (see globals.css's "ONE THEME PER MODE" comment).
 * K1/K2 apply in both, so everything below that evaluates PAIRINGS or scans
 * component usage against a resolved value does it once per mode rather than
 * once, against `tokens` alone, the way this file worked before dual-mode
 * theming existed.
 */
const THEME_MODES: readonly ThemeMode[] = ["light", "dark"];
const tokens = loadThemeTokens();
const tokensByMode: Record<ThemeMode, Map<string, Declaration>> = {
  light: tokens,
  dark: loadThemeTokens(GLOBALS_CSS_PATH, "dark"),
};
const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

/** `--ring/70` (or a bare `--ring`) to `<resolved literal>@<alpha percent>`. */
function tokenAlphaKey(
  reference: string,
  mode: Map<string, Declaration> = tokens,
): string {
  const { property, alphaPercent } = parseTokenReference(reference);
  return `${resolveToken(property, mode)}@${alphaPercent}`;
}

/**
 * The strongest WCAG threshold any PAIRING *reference* actually proves for a
 * given (resolved literal, alpha) combination, restricted to foreground-role
 * pairings. A decorative pairing contributes 0 - it proves the colour exists
 * at that alpha, but proves no ratio - rather than being left out entirely.
 *
 * Two aggregation steps, over two different things that can share a key, for
 * two different reasons:
 *
 * 1. MIN within every PAIRING sharing the exact same `foreground` reference
 *    string (ugcportal-j4j round 3 finding 4). `onEverySurface` generates
 *    one PAIRING per surface for a single reference like `--ring/80`, and a
 *    usage in source carries no information about which surface it renders
 *    against - it cannot be matched to one specific PAIRING among several
 *    that share that reference. MIN gives the weakest guarantee actually
 *    declared across all of them for that one reference, the conservative
 *    reading given that ambiguity.
 * 2. MAX across every *distinct* reference that happens to resolve to the
 *    same key (ugcportal-j4j round 4 finding 2). `--ring` and `--primary`
 *    resolve to the same literal but are unrelated design intents, not the
 *    same mark measured against different surfaces - collapsing step 1's
 *    per-reference result with another MIN here reintroduced K2 in reverse:
 *    once any decorative pairing existed at a shared key, the map pinned at
 *    0 forever, and no stronger pairing *for a different reference* at that
 *    same key could ever be added to fix it, because MIN cannot rise. A
 *    text/placeholder usage sharing that key would then be permanently
 *    unsatisfiable even though a genuine body-level PAIRING for it exists -
 *    latent today only because no shipped decorative pairing happens to
 *    share a literal+alpha with a text pairing. MAX across references is
 *    exactly K2's original reasoning restored one level up: coverage asks
 *    "does *some* declared measurement justify this usage", and a stronger
 *    reference existing must not be defeated by a weaker, unrelated one
 *    that happens to collide on colour value alone.
 */
/**
 * Pure, so the two-step aggregation itself - not just its result over the
 * real PAIRINGS - can be exercised directly with synthetic pairings that
 * deliberately collide, the same way K2's fix was proved against a
 * synthetic collision rather than only trusted against real data.
 */
function buildForegroundVerifiedThreshold(
  pairings: readonly Pairing[],
  mode: Map<string, Declaration> = tokens,
): Map<string, number> {
  const perReference = new Map<string, number>();
  for (const pairing of pairings) {
    const value = pairing.requirement === "decorative" ? 0 : THRESHOLDS[pairing.requirement];
    perReference.set(
      pairing.foreground,
      Math.min(perReference.get(pairing.foreground) ?? Infinity, value),
    );
  }

  const perKey = new Map<string, number>();
  for (const pairing of pairings) {
    const key = tokenAlphaKey(pairing.foreground, mode);
    const value = perReference.get(pairing.foreground)!;
    perKey.set(key, Math.max(perKey.get(key) ?? -Infinity, value));
  }
  return perKey;
}

const FOREGROUND_VERIFIED_THRESHOLD = buildForegroundVerifiedThreshold(PAIRINGS);

/**
 * ugcportal-rw9j: the same two coverage maps as above, computed once per
 * theme mode, because --primary (and therefore --ring, which tracks it)
 * resolves to a different literal in each one. A component's alpha-modified
 * usage (`ring-ring/80`) has to be proven safe under BOTH resolutions, not
 * just the light one these two module-level constants were built from before
 * dual-mode theming existed - see "measures every alpha-modified colour
 * utility" below, which is the one test that actually walks this per mode.
 */
const COVERAGE_BY_MODE: Record<
  ThemeMode,
  { foregroundVerified: Map<string, number>; measuredBackground: Set<string> }
> = Object.fromEntries(
  THEME_MODES.map((mode) => {
    const modeTokens = tokensByMode[mode];
    return [
      mode,
      {
        foregroundVerified: buildForegroundVerifiedThreshold(PAIRINGS, modeTokens),
        measuredBackground: new Set(
          PAIRINGS.flatMap((pairing) =>
            pairing.background.map((reference) => tokenAlphaKey(reference, modeTokens)),
          ),
        ),
      },
    ];
  }),
) as Record<ThemeMode, { foregroundVerified: Map<string, number>; measuredBackground: Set<string> }>;

/**
 * What a *usage* (as opposed to a PAIRING) needs to clear, inferred from its
 * namespace. `text` and `placeholder` both render glyphs directly, and this
 * is a static source scan - it cannot tell body text from large text - so
 * both are held to the stricter of WCAG's two text minimums, `body` (4.5:1),
 * rather than risk under-claiming for a usage that turns out to be
 * normal-size.
 *
 * Every other namespace defaults to needing only *something* measured at
 * that (literal, alpha) - decorative included, i.e. 0 - not a numeric floor.
 *
 * ugcportal-j4j round 3 finding 1 (MAJOR, a regression against `main`): the
 * first version of this defaulted every non-text namespace to `ui` (3:1).
 * That is not something a static scan can know - a `border`, `outline`,
 * `shadow`, `fill`, `stroke`, `mask-*` or `scrollbar-*` usage is at least as
 * often purely decorative (a hairline, a drop shadow, an illustrative icon)
 * as it is a control boundary, and there is no reliable way to tell which
 * from the class name alone. `divide` was special-cased back to 0 because
 * it is the one namespace this codebase's PAIRINGS happens to use
 * exclusively decoratively today, but that only patched the one namespace a
 * reviewer had a concrete example for - a decorative `border-border/50`
 * hairline, or any `outline`/`fill`/`stroke`/`shadow`/`mask-*`/`scrollbar-*`
 * usage, was left requiring a 3:1 pairing that, being genuinely decorative,
 * cannot exist (the K1 WCAG block would fail it) and is blocked from being
 * reclassified (the frozen decorative-id test) - unsatisfiable, and
 * strictly worse than `main`, where presence alone always sufficed.
 *
 * `text`/`placeholder` are the only namespaces this scan can be certain
 * about: rendering glyphs is unconditional on WCAG 1.4.3 regardless of
 * where or how a component uses them. Everything else keeps the weaker,
 * `main`-equivalent floor of "measured at all" - the K2 protection above
 * still applies in full for text, which is where the bug it fixes actually
 * lived.
 *
 * Which namespaces those are is derived, not hand-written, for the same
 * reason usage.ts derives its own sets rather than curating them
 * (ugcportal-j4j round 5): compiling `${namespace}-red-500/50` and checking
 * whether the declared CSS property is the bare `color` property - not
 * `background-color`, `border-color`, `--tw-ring-color`, `fill`, `stroke`,
 * or any of the other colour-bearing properties every other namespace
 * compiles to - identifies exactly `text` and `placeholder` (confirmed
 * against every namespace `discoverColorNamespaces` currently finds) without
 * naming either one. A namespace that starts rendering glyphs some other
 * way in a future Tailwind version would be picked up automatically; one
 * that stops would drop out the same way.
 */
const TEXT_PREFIXES = new Set(
  discoverColorNamespaces(designSystem).filter((prefix) => {
    const [css] = designSystem.candidatesToCss([`${prefix}-red-500/50`]);
    if (css === null) return false;
    let isColorProperty = false;
    postcss.parse(css).walkDecls((decl) => {
      if (decl.prop === "color") isColorProperty = true;
    });
    return isColorProperty;
  }),
);
function expectedThresholdFor(usage: Pick<AlphaUtilityUsage, "prefix">): number {
  return TEXT_PREFIXES.has(usage.prefix) ? THRESHOLDS.body : 0;
}

/**
 * K1 (ugcportal-axu), run under both modes (ugcportal-rw9j). Every documented
 * pairing, evaluated against the values actually in src/app/globals.css, for
 * light AND for dark. Editing a token below its threshold in either mode
 * turns this red, which turns CI red, which blocks the merge.
 */
describe.each(THEME_MODES)("WCAG contrast over the documented palette (%s)", (mode) => {
  const modeTokens = tokensByMode[mode];
  it.each(
    PAIRINGS.filter((pairing) => pairing.requirement !== "decorative").map(
      (pairing) => [pairing.id, pairing] as const,
    ),
  )("%s", (_id, pairing) => {
    const result = evaluatePairing(pairing, modeTokens);
    expect(
      result.ratio,
      `[${mode}] ${pairing.id}: ${pairing.foreground} (${result.foregroundHex}) on ` +
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
        "divider-on-background",
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
  // Hoisted out of the it.each below (review round 1): which alpha-modified
  // utilities the components ship is a fact about the source tree, not about
  // which theme mode is active, so scanning it once and sharing the result
  // across both mode runs is correct, not just faster - a second scan would
  // have had to find the exact same answer or something else is broken.
  const usedAlphaUtilities = findAlphaColorUtilities();

  /**
   * ugcportal-5gca: the same "never just skip" discipline, for the utility
   * shape the alpha scanner was never built to see - a bare `bg-X`/`text-X`/
   * `border-X` with no modifier at all. Hoisted beside usedAlphaUtilities for
   * the same reason: a fact about the source tree, not about which theme mode
   * is active.
   */
  const usedBareUtilities = findBareColorUtilities();

  /**
   * ugcportal-5gca K2's "excluded with a derived reason" half, for a bare
   * background-role usage with no PAIRINGS entry - which is not automatically
   * an oversight the way an uncovered foreground is: a purely decorative
   * surface with nothing ever painted on top of it has no contrast ratio to
   * measure at all, and PAIRINGS has no entry shape for "nothing sits here"
   * (its decorative bucket is for a foreground WCAG 1.4.11 does not cover,
   * not for a background with no foreground). Audited one (file, utility)
   * pair at a time, the same discipline dual-meaning-usage.test.ts holds its
   * own audited allowlist to: a genuinely new, unreviewed usage still fails
   * loudly here until someone looks at it and adds the entry.
   *
   * The one entry today: hero.tsx's `HeroDecoration` renders three
   * `aria-hidden`, childless `<span>` shapes, confined to their own
   * `overflow-hidden` box and confirmed (not assumed) geometrically isolated
   * from the hero's text column by e2e/front-page.spec.ts's "no decorative
   * shape intersects hero text" - see that component's own comment. Two of
   * its three bare fills (`bg-petrol-400`, `bg-petrol-100`) already appear as
   * a PAIRINGS background for unrelated reasons (the old-surface fill and the
   * CTA pill respectively) and need no entry here; `bg-petrol-300` does not
   * share a literal with any existing pairing, which is what surfaced this
   * gap in the first place.
   */
  const AUDITED_DECORATIVE_BACKGROUND_USAGES = new Set<string>([
    "src/components/home/hero.tsx:bg-petrol-300",
  ]);

  it("has exactly this audited decorative-background allowlist, and no others", () => {
    // Pinned so a silent addition is a visible diff, the same reason
    // PAIRINGS' own decorative-id list is frozen above.
    expect([...AUDITED_DECORATIVE_BACKGROUND_USAGES].sort()).toEqual(
      ["src/components/home/hero.tsx:bg-petrol-300"].sort(),
    );
  });

  it.each(THEME_MODES)(
    "measures every colour utility the components ship, alpha-modified or bare (%s)",
    (mode) => {
      const modeTokens = tokensByMode[mode];
      const { foregroundVerified, measuredBackground } = COVERAGE_BY_MODE[mode];
      const used = [...usedAlphaUtilities, ...usedBareUtilities];
      expect(used.length).toBeGreaterThan(0);

      for (const usage of used) {
        // A Tailwind built-in colour (bg-black/50) resolves to no token at all.
        // Caught here with its own advice, because letting resolveToken throw
        // "unknown token --color-black" blames the wrong thing.
        expect(
          modeTokens.has(usage.property),
          `[${mode}] ${usage.file} uses "${usage.utility}", which is not a design token - ` +
            `${usage.property} is not declared in globals.css. Use a token from the ` +
            `surface/ink/petrol scales so the gate can measure it.`,
        ).toBe(true);

        const usageKey = `${resolveToken(usage.property, modeTokens)}@${usage.alphaPercent}`;

        if (usage.role === "background") {
          if (AUDITED_DECORATIVE_BACKGROUND_USAGES.has(`${usage.file}:${usage.utility}`)) {
            continue;
          }
          expect(
            measuredBackground.has(usageKey),
            `[${mode}] ${usage.file} uses "${usage.utility}", but no pairing in PAIRINGS ` +
              `measures ${usage.property} at ${usage.alphaPercent}% alpha as a ` +
              `background. Add that pairing - a colour measured as a foreground ` +
              `does not cover it, because the two sit against different things - ` +
              `or, if nothing is ever painted on top of it, add it to ` +
              `AUDITED_DECORATIVE_BACKGROUND_USAGES with why.`,
          ).toBe(true);
          continue;
        }

        // Foreground: presence is not enough for text (K2). The pairing that
        // measures this (literal, alpha) has to have checked it at or above
        // the threshold *this usage's namespace* needs (0 - mere presence -
        // for everything except text/placeholder; see expectedThresholdFor).
        const verified = foregroundVerified.get(usageKey) ?? -Infinity;
        const required = expectedThresholdFor(usage);
        expect(
          verified >= required,
          `[${mode}] ${usage.file} uses "${usage.utility}", but no pairing in PAIRINGS measures ` +
            `${usage.property} at ${usage.alphaPercent}% alpha as a foreground` +
            (required > 0 ? ` at or above the ${required}:1 this usage's namespace needs. ` : ". ") +
            (verified === -Infinity
              ? "It is not measured as a foreground at that alpha at all."
              : `The weakest pairing that measures it there is only checked at ` +
                `${verified}:1 - a different token that happens to share this ` +
                `literal is not proof this one clears the bar.`) +
            " Add a pairing for it.",
        ).toBe(true);
      }
    },
  );

  /**
   * ugcportal-5gca K3: "a PAIRINGS entry deleted while the usage it measures
   * is still in the source, with no test failing" was the exact mutation
   * round 5 of PR #79 let through - bg-petrol-400 and text-petrol-900 shipped
   * on button.tsx's default-neutral and the upload dropzone's "Choose files"
   * label with no coverage check able to see either. This proves the two
   * round-5 entries (petrol-400-fill-on-old-surface-*, petrol-900-on-petrol-400)
   * are each load-bearing for the coverage they were added to provide,
   * directly, rather than only recording the mutation as a one-off manual
   * note.
   *
   * Each sub-test below builds its OWN isolated coverage map from a single
   * entry (or none), rather than mutating the real, full PAIRINGS array the
   * way "measures every colour utility..." above does its real check. That
   * isolation is load-bearing, not a style choice: `--sidebar-primary` and
   * `--sidebar-ring` alias to the identical `--color-petrol-400` literal and
   * already supply an UNRELATED background entry of their own
   * (sidebar-primary-foreground-on-sidebar-primary) - confirmed by running
   * this exact mutation against the full PAIRINGS array first, which stayed
   * green for the wrong reason. That is the same "two different tokens
   * resolve to the same literal" collision K2's own synthetic tests below
   * exist to prove, encountered here with a real pair instead of a
   * synthetic one, and isolating each entry sidesteps it the same way those
   * tests do: by not depending on what the rest of PAIRINGS happens to
   * contain today.
   */
  describe("K3: the round-5 PAIRINGS entries this bead's premise depends on are load-bearing", () => {
    const petrol900OnPetrol400 = PAIRINGS.find((p) => p.id === "petrol-900-on-petrol-400");
    const petrol400FillOnOldSurface = PAIRINGS.filter((p) =>
      p.id.startsWith("petrol-400-fill-on-old-surface-"),
    );

    it("both round-5 entries this bead's premise names are still in PAIRINGS to mutate", () => {
      expect(petrol900OnPetrol400, "petrol-900-on-petrol-400").toBeDefined();
      expect(petrol400FillOnOldSurface.length, "petrol-400-fill-on-old-surface-*").toBeGreaterThan(0);
    });

    /**
     * petrol-900-on-petrol-400's OWN background reference (`--color-petrol-400`)
     * is what a real, shipped `bg-petrol-400` usage's coverage (this bare
     * scanner's "background role" check) actually depends on - NOT
     * petrol-400-fill-on-old-surface-*, which measures petrol-400 the other
     * way around (as a foreground UI-boundary mark against the surfaces
     * behind it - see the next test). This bare scanner classifies every
     * `bg-*` utility as background role unconditionally (isBackgroundRole),
     * so a real `bg-petrol-400` usage is never checked against
     * petrol-400-fill-on-old-surface-* at all.
     */
    it.each(THEME_MODES)(
      "petrol-900-on-petrol-400's background reference covers a real bg-petrol-400 usage, in isolation (%s)",
      (mode) => {
        const modeTokens = tokensByMode[mode];
        const petrol400Fill = usedBareUtilities.find(
          (usage) => usage.property === "--color-petrol-400" && usage.role === "background",
        );
        expect(
          petrol400Fill,
          "bg-petrol-400 is still shipped as a background somewhere in src",
        ).toBeDefined();
        const usageKey = `${resolveToken(petrol400Fill!.property, modeTokens)}@${petrol400Fill!.alphaPercent}`;

        const withEntry = new Set(
          [petrol900OnPetrol400!].flatMap((pairing) =>
            pairing.background.map((reference) => tokenAlphaKey(reference, modeTokens)),
          ),
        );
        expect(withEntry.has(usageKey), `[${mode}] covered with the entry present`).toBe(true);

        const withoutEntry = new Set<string>();
        expect(withoutEntry.has(usageKey), `[${mode}] uncovered once the entry is removed`).toBe(
          false,
        );
      },
    );

    /**
     * petrol-400-fill-on-old-surface-*'s own half: petrol-400 as a FOREGROUND
     * UI-boundary mark (the button fill / progress-bar fill's own visibility)
     * against the old near-black surface scale as background. This bare
     * scanner's role convention never generates a usage on this axis for a
     * `bg-*` utility (see above), so a synthetic usage stands in for the real
     * shape (`AlphaUtilityUsage`'s own type, not a scanner result).
     */
    it.each(THEME_MODES)(
      "petrol-400-fill-on-old-surface-* covers petrol-400 as a UI-boundary foreground, in isolation (%s)",
      (mode) => {
        const modeTokens = tokensByMode[mode];
        const syntheticFillUsage: AlphaUtilityUsage = {
          file: "synthetic - this bare scanner's bg=background-role convention never classifies a fill this way",
          utility: "bg-petrol-400",
          property: "--color-petrol-400",
          alphaPercent: 100,
          role: "foreground",
          prefix: "bg",
        };
        const usageKey = `${resolveToken(syntheticFillUsage.property, modeTokens)}@${syntheticFillUsage.alphaPercent}`;

        const withEntries = buildForegroundVerifiedThreshold(petrol400FillOnOldSurface, modeTokens);
        expect(withEntries.get(usageKey), `[${mode}] covered with the entries present`).toBe(
          THRESHOLDS.ui,
        );

        const withoutEntries = buildForegroundVerifiedThreshold([], modeTokens);
        expect(
          withoutEntries.get(usageKey) ?? -Infinity,
          `[${mode}] uncovered once removed`,
        ).toBeLessThan(THRESHOLDS.ui);
      },
    );

    /**
     * petrol-900-on-petrol-400's other half: text-petrol-900 as a foreground
     * on the fill, at body's 4.5:1. ugcportal-ei5c: `--color-petrol-900` is
     * declared outside `@theme`, so `text-petrol-900` compiles to no
     * Tailwind utility at all and findBareColorUtilities correctly never
     * reports it as a shipped usage (see that function's own doc comment on
     * why a non-compiling bare candidate is excluded, not flagged) - a
     * synthetic usage stands in for the one Tailwind itself refuses to
     * generate. Closing that compile gap is ugcportal-ei5c's job, not this
     * bead's.
     */
    it.each(THEME_MODES)(
      "petrol-900-on-petrol-400 covers text-petrol-900 as a foreground on the fill, in isolation (%s)",
      (mode) => {
        const modeTokens = tokensByMode[mode];
        const syntheticLabelUsage: AlphaUtilityUsage = {
          file: "synthetic - ugcportal-ei5c: text-petrol-900 compiles to no Tailwind utility",
          utility: "text-petrol-900",
          property: "--petrol-900",
          alphaPercent: 100,
          role: "foreground",
          prefix: "text",
        };
        const usageKey = `${resolveToken(syntheticLabelUsage.property, modeTokens)}@${syntheticLabelUsage.alphaPercent}`;

        const withEntry = buildForegroundVerifiedThreshold([petrol900OnPetrol400!], modeTokens);
        expect(withEntry.get(usageKey), `[${mode}] covered with the entry present`).toBe(
          THRESHOLDS.body,
        );

        const withoutEntry = buildForegroundVerifiedThreshold([], modeTokens);
        expect(
          withoutEntry.get(usageKey) ?? -Infinity,
          `[${mode}] uncovered once removed`,
        ).toBeLessThan(THRESHOLDS.body);
      },
    );
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
   * ugcportal-j4j round 2 finding 3. usage.ts's scanner learned to see a
   * fractional alpha in round 1, but this file's own `parseTokenReference`
   * still required an integer, and its coverage key recovered a percentage
   * via `Math.round(alpha * 100)`. `Math.round(80.5)` is `81`, not `80.5`, so
   * a PAIRING declared at `--primary/80.5` and a usage scanned as
   * `ring-primary/80.5` keyed as "…@81" and "…@80.5" respectively - never
   * equal, so the fractional usage's coverage check could never pass, no
   * matter what pairing was added. "Add a pairing for it" was advice that
   * could not be followed. This proves the two sides now key identically.
   */
  it("keys a fractional-alpha pairing and a fractional-alpha usage identically", () => {
    const syntheticPairing: Pairing = {
      id: "synthetic-fractional",
      foreground: "--primary/80.5",
      background: ["--color-surface-0"],
      requirement: "ui",
      usage: "Not shipped; proves a fractional-alpha pairing can be declared and evaluated at all.",
    };
    // Would have thrown before the fix: parseTokenReference required
    // /^\d{1,3}$/, an integer only.
    expect(() => evaluatePairing(syntheticPairing, tokens)).not.toThrow();

    const pairingKey = tokenAlphaKey(syntheticPairing.foreground);

    const usage: AlphaUtilityUsage = {
      file: "synthetic (not shipped)",
      utility: "ring-primary/80.5",
      property: "--color-primary",
      alphaPercent: 80.5,
      role: "foreground",
      prefix: "ring",
    };
    const usageKey = `${resolveToken(usage.property, tokens)}@${usage.alphaPercent}`;

    expect(
      usageKey,
      "a fractional-alpha usage and the pairing meant to cover it must key identically",
    ).toBe(pairingKey);
  });

  /**
   * ugcportal-j4j round 2 finding 4, and round 3 finding 1 in the same test.
   * The first version of FOREGROUND_VERIFIED_THRESHOLD (round 2) skipped
   * decorative pairings entirely rather than contributing 0, which meant a
   * divider - the one namespace this codebase's own PAIRINGS treats as
   * exclusively decorative - could never be satisfied. The fix for that
   * (contributing 0) only helps if *usages of a decorative-only namespace*
   * also only need 0 - and the round-2 fix's expectedThresholdFor still
   * defaulted every non-text namespace to `ui` (3), so a decorative
   * `border-border/50` hairline, or an `outline`/`fill`/`stroke`/`shadow`/
   * `mask-*`/`scrollbar-*` usage, was left needing a 3:1 pairing that a
   * genuinely decorative one cannot be (K1 would fail it) and cannot be
   * promoted to (the frozen decorative-id test) - unsatisfiable, and worse
   * than `main`, where presence alone always sufficed.
   *
   * This proves a real decorative pairing's literal+alpha now satisfies
   * usages under several different non-text namespaces - not only `divide`,
   * the one namespace a concrete example happened to name - while a text
   * usage of that same key still is not satisfied (K2's protection, which
   * only ever needed to apply to text, is untouched).
   */
  it("lets a decorative pairing satisfy any non-text usage, without letting it satisfy a text usage", () => {
    const dividerPairing = PAIRINGS.find(
      (pairing) => pairing.requirement === "decorative",
    );
    expect(dividerPairing, "at least one decorative pairing ships").toBeDefined();

    const key = tokenAlphaKey(dividerPairing!.foreground);
    expect(FOREGROUND_VERIFIED_THRESHOLD.get(key)).toBe(0);

    // dividerPairing's foreground is already a bare `--color-<name>`
    // reference (e.g. "--color-line"), the same shape usage.ts's `property`
    // field uses, so it doubles directly as a synthetic usage of that token.
    const { property, alphaPercent } = parseTokenReference(dividerPairing!.foreground);
    const baseUsage: Omit<AlphaUtilityUsage, "prefix" | "utility"> = {
      file: "synthetic (not shipped)",
      property,
      alphaPercent,
      role: "foreground",
    };

    // divide, plus a spread of namespaces finding 1 named as unsatisfiable:
    // a real decorative pairing's key now covers all of them.
    for (const prefix of ["divide", "border", "outline", "fill", "stroke", "shadow"]) {
      const usage: AlphaUtilityUsage = { ...baseUsage, prefix, utility: `${prefix}-x/${alphaPercent}` };
      const usageKey = `${resolveToken(usage.property, tokens)}@${usage.alphaPercent}`;
      expect(usageKey, prefix).toBe(key);
      expect(expectedThresholdFor(usage), prefix).toBe(0);
      expect(
        FOREGROUND_VERIFIED_THRESHOLD.get(usageKey) ?? -Infinity,
        prefix,
      ).toBeGreaterThanOrEqual(expectedThresholdFor(usage));
    }

    // The same 0 does not satisfy a text usage of that same key.
    const textUsage: AlphaUtilityUsage = { ...baseUsage, prefix: "text", utility: `text-x/${alphaPercent}` };
    expect(0).toBeLessThan(expectedThresholdFor(textUsage));
  });

  /**
   * ugcportal-j4j round 4 finding 2. Aggregating by MIN across every PAIRING
   * sharing a *key* (rather than only within pairings sharing the same
   * *reference*, round 3's actual concern) meant one decorative pairing at a
   * key pinned the whole key at 0 forever - a stronger PAIRING for a
   * different, unrelated reference that happened to resolve to the same
   * literal+alpha could never raise it, because MIN cannot rise. A synthetic
   * collision proves the fix directly, the way K2's own fix was proved,
   * rather than relying on today's real PAIRINGS happening not to trigger it
   * (they do not - this is why the bug was latent).
   */
  it("does not let a decorative pairing at a shared key suppress a stronger pairing for a different reference", () => {
    const decorativeReference: Pairing = {
      id: "synthetic-decorative",
      // --ring resolves to the same literal as --primary in this codebase
      // (both var(--color-petrol-400)) - the same real collision K2's own
      // test uses, reused here as a synthetic decorative pairing.
      foreground: "--ring",
      background: ["--color-surface-0"],
      requirement: "decorative",
      usage: "Not shipped; a synthetic collision partner.",
      why: "Synthetic - exists only to prove the aggregation fix, not a real exemption.",
    };
    const bodyReference: Pairing = {
      id: "synthetic-body",
      foreground: "--primary",
      background: ["--color-surface-0"],
      requirement: "body",
      usage: "Not shipped; a synthetic collision partner.",
    };
    // Precondition: these two really do share a key, or the test proves nothing.
    expect(tokenAlphaKey(decorativeReference.foreground)).toBe(
      tokenAlphaKey(bodyReference.foreground),
    );

    const map = buildForegroundVerifiedThreshold([decorativeReference, bodyReference]);
    const key = tokenAlphaKey(bodyReference.foreground);
    expect(map.get(key), "the stronger reference's guarantee must survive the collision").toBe(
      THRESHOLDS.body,
    );

    // Order must not matter either.
    const reversed = buildForegroundVerifiedThreshold([bodyReference, decorativeReference]);
    expect(reversed.get(key)).toBe(THRESHOLDS.body);
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
    const rings = usedAlphaUtilities.filter(
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

describe("TEXT_PREFIXES (derived, not curated)", () => {
  it("finds exactly text and placeholder, not any other colour-bearing namespace", () => {
    // Pins the derivation's result, not just that it runs: caret, accent,
    // fill and stroke all compile a colour too (caret-color, accent-color,
    // fill, stroke), but none of them compile to the bare `color` property,
    // so none should be in this set.
    expect([...TEXT_PREFIXES].sort()).toEqual(["placeholder", "text"]);
  });
});

describe("parseTokenReference", () => {
  it("reads a bare token as fully opaque", () => {
    expect(parseTokenReference("--ring")).toEqual({
      property: "--ring",
      alpha: 1,
      alphaPercent: 100,
    });
  });

  it("reads a Tailwind alpha modifier", () => {
    expect(parseTokenReference("--ring/70")).toEqual({
      property: "--ring",
      alpha: 0.7,
      alphaPercent: 70,
    });
    expect(parseTokenReference("--ring/0")).toEqual({
      property: "--ring",
      alpha: 0,
      alphaPercent: 0,
    });
  });

  /**
   * ugcportal-j4j round 2 finding 3: this used to require an integer
   * (`/^\d{1,3}$/`), so a fractional alpha usage.ts had already learned to
   * scan (`bg-primary/12.5`) could never be declared as a PAIRING at all -
   * "measured" advice the author could not actually follow. `alphaPercent`
   * preserves the written percentage exactly (not `alpha * 100`, which would
   * round-trip through a division a usage's own alphaPercent never goes
   * through), so a coverage key built from a PAIRING and one built from a
   * scanned usage agree even for a fractional value.
   */
  it("reads a fractional Tailwind alpha modifier", () => {
    expect(parseTokenReference("--ring/12.5")).toEqual({
      property: "--ring",
      alpha: 0.125,
      alphaPercent: 12.5,
    });
  });

  it.each([
    "ring",
    "--ring/70/10",
    "--ring/abc",
    "--ring/101",
    "--ring/100.5",
    "--ring/",
  ])("throws on %s", (reference) => {
    expect(() => parseTokenReference(reference)).toThrow();
  });
});

/**
 * K4 (ugcportal-axu): petrol survives the demotion and still drives at least
 * the focus and link treatments. Updated by ugcportal-rw9j: --ring, --primary
 * and --selection now drive off the NEW `--petrol-*`/`--paper` palette
 * (docs/design/tokens.css's naming) rather than the old OKLCH
 * `--color-petrol-*` scale, which is why the three assertions below changed
 * shape rather than just value - see the petrol-palette comment near the top
 * of globals.css for why these are a separate set of tokens, not a renamed
 * version of the old one.
 */
describe("petrol is demoted, not removed", () => {
  it("still ships the full --color-petrol-50..950 scale", () => {
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      expect(tokens.has(`--color-petrol-${step}`), `petrol-${step}`).toBe(true);
    }
  });

  it("drives the focus ring", () => {
    // --ring tracks --primary by indirection (see globals.css), so this is
    // the same assertion as "drives link and primary-action colour" below,
    // confirmed via resolution rather than restating the literal.
    expect(resolveToken("--ring", tokens)).toBe(resolveToken("--primary", tokens));
  });

  it("drives link and primary-action colour", () => {
    expect(tokens.get("--primary")?.value).toMatch(/^var\(--petrol-\d+\)$/);
  });

  it("drives the selection highlight", () => {
    expect(tokens.get("--selection")?.value).toMatch(/^var\(--petrol-\d+\)$/);
  });

  it("no longer paints cards, overlays, the secondary button or the neutral hover fill", () => {
    // The demotion, stated as a check: the big areas are all neutral surface.
    // --background is deliberately NOT in this list any more (ugcportal-rw9j):
    // painting the page canvas with the petrol/paper palette is this bead's
    // entire point, not a regression of the demotion K4 originally checked.
    for (const token of ["--card", "--popover", "--muted", "--accent", "--secondary", "--sidebar"]) {
      expect(tokens.get(token)?.value, token).toMatch(
        /^var\(--color-(surface-\d+|scrim)\)$/,
      );
    }
  });

  it("paints the page canvas with the petrol/paper palette, in both modes", () => {
    expect(tokens.get("--background")?.value).toBe("var(--paper)");
    expect(tokens.get("--foreground")?.value).toBe("var(--petrol-900)");
    const darkTokens = tokensByMode.dark;
    expect(darkTokens.get("--background")?.value).toBe("var(--petrol-900)");
    expect(darkTokens.get("--foreground")?.value).toBe("var(--paper)");
  });
});

/**
 * ugcportal-rw9j K1: a direct, literal check of the bytes K1 names, plus a
 * broader snapshot of the whole resolved palette (light and dark) so any
 * future edit to a token value is a visible, deliberate diff in review rather
 * than a silent drift the ratio-only checks above might not catch (two colours
 * can swap and still clear the same ratio).
 */
describe("K1: the exact palette docs/design/tokens.css adopted", () => {
  it("renders the light-mode canvas and primary button at the exact adopted bytes", () => {
    expect(resolveToken("--background", tokens)).toBe("#FAF7F2".toLowerCase());
    expect(resolveToken("--primary", tokens)).toBe("#14555F".toLowerCase());
    expect(resolveToken("--primary-foreground", tokens)).toBe("#ffffff");
  });

  it("declares a dark-mode override for exactly the tokens this phase touches", () => {
    const darkOnly = parseDeclarations(css).filter((declaration) =>
      DARK_MEDIA_SELECTOR.test(declaration.selector),
    );
    const declaredProperties = new Set(darkOnly.map((declaration) => declaration.property));
    expect(declaredProperties).toEqual(
      new Set([
        "--background",
        "--foreground",
        "--muted-foreground",
        "--primary",
        "--primary-hover",
        "--primary-foreground",
      ]),
    );
  });

  it("matches the known-good snapshot of the resolved palette in both modes", () => {
    const snapshotTokens = [
      "--background",
      "--foreground",
      "--primary",
      "--primary-hover",
      "--primary-foreground",
      "--ring",
      "--selection",
      "--selection-foreground",
    ];
    const resolved = Object.fromEntries(
      THEME_MODES.map((mode) => [
        mode,
        Object.fromEntries(
          snapshotTokens.map((name) => [name, resolveToken(name, tokensByMode[mode])]),
        ),
      ]),
    );
    expect(resolved).toMatchSnapshot();
  });
});

/**
 * ugcportal-rw9j review round 5 (code-review): RING_OVERRIDE_SURFACES
 * (contrast.ts) hand-duplicates globals.css's own `.bg-surface-0, ...
 * .bg-sidebar { --ring: var(--color-petrol-400); }` selector list, with
 * nothing tying the two together before this test - exactly the kind of
 * two-list drift this repo's own review history keeps finding (round 4's
 * MAJOR finding against the predecessor of this same override). Resolves
 * both independently: the CSS selector's classes through their real
 * semantic aliases (`.bg-muted` -> `--muted` -> `--color-surface-1`, etc,
 * the same mapping documented on RING_OVERRIDE_SURFACES's own comment), and
 * RING_OVERRIDE_SURFACES's own tokens through resolveToken - then compares
 * the two resolved sets rather than the raw names, since one is literal
 * CSS classes and the other is TypeScript's --color-surface-N tokens.
 */
describe("RING_OVERRIDE_SURFACES matches globals.css's own selector list", () => {
  /** `.bg-foo` -> the `--color-foo` custom property Tailwind's `bg-foo` utility resolves to, by this app's own `@theme inline` naming convention. */
  function classToColorToken(className: string): string {
    return `--color-${className.replace(/^\.bg-/, "")}`;
  }

  it("resolves to the identical set of literal colours in both modes", () => {
    const ringOverride = parseDeclarations(css).find(
      (declaration) =>
        declaration.property === "--ring" && declaration.selector.startsWith(".bg-surface-0"),
    );
    if (!ringOverride) {
      throw new Error(
        "could not find globals.css's .bg-surface-0, ... { --ring: ... } override - has its selector changed?",
      );
    }
    const classes = ringOverride.selector.split(",").map((part) => part.trim());

    for (const mode of THEME_MODES) {
      const modeTokens = tokensByMode[mode];
      const fromCss = new Set(
        classes.map((className) => resolveToken(classToColorToken(className), modeTokens)),
      );
      const fromTsList = new Set(
        RING_OVERRIDE_SURFACES.map((token) => resolveToken(token, modeTokens)),
      );
      expect(fromCss, mode).toEqual(fromTsList);
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
