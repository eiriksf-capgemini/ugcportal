import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { parseColor, toHex } from "./color";
import {
  PAIRINGS,
  PHASE_2_MOVED_TOKENS,
  RING_ALPHA_MODIFIER,
  RING_OVERRIDE_SURFACES,
  SURFACES,
  THRESHOLDS,
  checkPhase2MigrationClaim,
  evaluatePairing,
  findColorScaleNameCollisions,
  parseTokenReference,
  type Pairing,
  type ScaleNameCollision,
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
 * Canonical identity for BACKGROUND coverage specifically (PR #115 round 1,
 * findings 1+2) - deliberately NOT `tokenAlphaKey`'s full `resolveToken`
 * walk, which follows every `var(...)` hop down to a final literal colour
 * value. That full walk is correct, deliberate, and tested for FOREGROUND
 * ("does not let a UI-boundary pairing cover a text usage of the same
 * literal and alpha" below): a verified contrast RATIO is a fact about the
 * rendered colour, so two differently-named references that happen to
 * resolve to the same value really do share the guarantee, and K2's own fix
 * exists to let a stronger reference's proof survive exactly that collision.
 *
 * It is not correct for BACKGROUND. "Some pairing recorded a foreground
 * against this literal" says nothing about a DIFFERENT foreground painted on
 * a DIFFERENT component that happens to share the literal by coincidence of
 * this theme's current values, not by being the same semantic concept -
 * confirmed for real, not hypothetically: `--sidebar-primary` and
 * `--color-fjord-400` currently resolve to the identical literal, so
 * `sidebar-primary-foreground-on-sidebar-primary` (`background:
 * ["--sidebar-primary"]`) used to "cover" every `bg-fjord-400` usage
 * (button.tsx's default-neutral fill, the upload queue's progress-bar fill -
 * one of the four PR #79 regressions this bead exists because of) even with
 * `surface-0-on-fjord-400` - the entry that actually measures what's
 * painted on top of that fill - deleted entirely. `contrast.test.ts`'s own
 * K3 block proves this both ways below.
 *
 * The fix is narrower than abandoning cross-reference sharing for
 * backgrounds generally: this app's `@theme inline` block aliases EVERY
 * semantic token as `--color-X: var(--X)`, with no exceptions (read in full
 * at review time) - a NAMING convention this file's scanners already depend
 * on (it is why a scanned utility's token is always reported as
 * `--color-<name>`). Unwrapping exactly that one hop - `--color-X` to `--X`,
 * only when the stylesheet actually declares that precise alias - keeps
 * `bg-primary` (`--color-primary`) matching a PAIRING written as `--primary`
 * (needed: `primary-label-on-primary` writes it that way), without
 * continuing on to whatever `--X` itself happens to equal. `--sidebar-primary`
 * has no `--color-sidebar-primary`-shaped counterpart pointing at it from a
 * usage's side (a scanned usage's property is always the `--color-<name>`
 * form, never a bare semantic name), and `--color-fjord-400` has no bare
 * `--fjord-400` alias to unwrap to (the fjord scale's OKLCH values live
 * directly under `--color-*`, never behind a semantic alias - confirmed:
 * `globals.css` declares no bare `--fjord-400`) - so neither collapses into
 * the other under this narrower rule, and the two stay distinct keys.
 *
 * ugcportal-uo15 note: `--color-petrol-100`/`-200`/`-500` are a DIFFERENT
 * case from `--color-fjord-400` here - those three now ARE exactly this
 * shape of alias (`--color-petrol-200: var(--petrol-200)`), so
 * `backgroundTokenIdentity` DOES unwrap them to their bare `--petrol-200`
 * form. That is correct, not a new instance of the bug this function fixes:
 * the bare and `--color-` forms are the SAME colour now (K1), so collapsing
 * them is exactly the "two spellings, one guarantee" behaviour K2's fix
 * (described above) protects for a real alias, not an accidental, value-only
 * coincidence the way `--sidebar-primary`/`--color-fjord-400` was.
 */
function backgroundTokenIdentity(
  property: string,
  mode: Map<string, Declaration>,
): string {
  const match = /^--color-([\w-]+)$/.exec(property);
  if (!match) return property;
  const bareName = `--${match[1]}`;
  return mode.get(property)?.value === `var(${bareName})` ? bareName : property;
}

/** `--ring/70` (or a bare `--ring`) to `<background identity>@<alpha percent>` - see `backgroundTokenIdentity`. Background coverage only; foreground keeps `tokenAlphaKey`. */
function backgroundCoverageKey(
  reference: string,
  mode: Map<string, Declaration>,
): string {
  const { property, alphaPercent } = parseTokenReference(reference);
  return `${backgroundTokenIdentity(property, mode)}@${alphaPercent}`;
}

/**
 * Which PAIRINGS ids provide background coverage for each key - a provenance
 * map, not just a boolean Set, so a passing coverage check can say WHICH
 * entry is doing the covering (PR #115 round 1 finding 2: "the gate must
 * report which entry covered a usage, so shadowing by an alias is visible").
 * Built as its own function, not inlined where `COVERAGE_BY_MODE` needs it,
 * so the K3 mutation tests below run this EXACT construction over a
 * (deliberately mutated) pairings list rather than a hand-duplicated copy
 * that could drift from it - round 1's finding 1 was precisely a K3 block
 * that had drifted into asserting against an empty Set instead of this.
 */
function buildMeasuredBackground(
  pairings: readonly Pairing[],
  mode: Map<string, Declaration>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const pairing of pairings) {
    for (const reference of pairing.background) {
      const key = backgroundCoverageKey(reference, mode);
      const ids = result.get(key) ?? new Set<string>();
      ids.add(pairing.id);
      result.set(key, ids);
    }
  }
  return result;
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
  { foregroundVerified: Map<string, number>; measuredBackground: Map<string, Set<string>> }
> = Object.fromEntries(
  THEME_MODES.map((mode) => {
    const modeTokens = tokensByMode[mode];
    return [
      mode,
      {
        foregroundVerified: buildForegroundVerifiedThreshold(PAIRINGS, modeTokens),
        measuredBackground: buildMeasuredBackground(PAIRINGS, modeTokens),
      },
    ];
  }),
) as Record<ThemeMode, { foregroundVerified: Map<string, number>; measuredBackground: Map<string, Set<string>> }>;

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

  it("never lets the SAME token be declared both a decorative foreground and a control-edge/focus-ring foreground in PAIRINGS", () => {
    // --color-line is exempt from 3:1 precisely because it is never the thing
    // that tells you a control is there. --input (the semantic token) and
    // --color-line-strong (its own direct remaining consumer, the upload
    // dropzone - these are two DIFFERENT literals as of ugcportal-6uc2 phase
    // 2, not aliases of each other the way they were before) both are, and
    // both are checked at 3:1 above (control-edge-* and line-strong-edge-on-*
    // respectively).
    //
    // Round-1 review of ugcportal-6uc2, CONFIRMED medium: this proves PAIRINGS
    // is internally consistent (no one token reference is declared decorative
    // by one entry and a control boundary by another) - it does NOT prove
    // that the real, shipped markup never renders a decorative-classified
    // token AS a control boundary. That second, stronger claim is what
    // "every real border-border usage is audited, decorative or covered"
    // below actually checks, against real usage sites rather than two lists
    // of names - see that test's own comment for the regression this gap
    // let through (sign-in-menu.tsx/mobile-nav-toggle.tsx's floating panels).
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
   * Round-1 review of ugcportal-6uc2, CONFIRMED medium. "never lets a
   * decorative token be the boundary of an interactive control" above only
   * ever compared two PAIRINGS-derived SETS OF TOKEN NAMES - which proves
   * the pairings list does not contradict itself, not that nothing in the
   * real, shipped markup renders `--border` (a decorative-only token: its
   * one PAIRINGS entry, divider-on-background, is explicitly justified as
   * "ornamental separation", never checked at 3:1) as if it identified an
   * interactive control. That is exactly the shape sign-in-menu.tsx and
   * mobile-nav-toggle.tsx shipped: a floating popover panel, bordered in
   * `border-border`, over the SAME `bg-background` fill as the page behind
   * it - the border was the only thing identifying the open panel's edge,
   * which is precisely what K3 means by "an interactive control's boundary".
   * Before this bead, `--border` was `--color-line` (11.62:1, plenty, by
   * accident); once it moved to the decorative `--paper-line` (1.40:1,
   * correct for an ornamental hairline), both panels silently dropped below
   * 3:1 with nothing in this file able to notice, because this file never
   * looked at a real `border-border` usage site at all.
   *
   * Round-2 review, CONFIRMED medium: round 1's own classification was ONE
   * blanket sentence covering four categories, not a per-site judgement -
   * exactly how a fifth site fitting none of the four (cookie-banner.tsx:
   * `fixed`, `z-40`, conditionally rendered, over `bg-background`, with
   * `border-t border-border` as its only edge - 1.3965:1 after this bead,
   * indistinguishable from the footer it overlays when open) stayed
   * invisible to a blanket claim that confidently said "none of which is a
   * floating/toggleable control" four lines above being wrong about one.
   * Fixed the same way as the first two (now `border-input`, see that
   * component's own comment) and removed from this list entirely, same as
   * they were.
   *
   * This file now states the classification as a RULE, checked per site
   * below rather than asserted once in prose: a usage needs `ui`-grade
   * coverage (a dedicated PAIRINGS entry, like control-edge-on-background)
   * exactly when it is (a) removed from normal document flow (`fixed` or
   * `absolute` positioning), (b) shown/hidden by a specific user action
   * rather than always present, and (c) painted on a fill identical to the
   * page behind it, such that the border is the only cue marking where the
   * panel starts. Every remaining entry below was checked against that
   * rule, not assumed decorative by category:
   *
   *   - admin/curation/page.tsx (10), admin/settings/instagram/page.tsx
   *     (2), admin/settings/rights/brands/page.tsx (3),
   *     admin/settings/rights/page.tsx (6), admin/settings/users/page.tsx
   *     (1): static, in-flow content - bg-muted/bg-destructive-surface
   *     callout panels, `divide-y` list containers, one thumbnail frame, one
   *     plain bordered `<div>` - none `fixed`/`absolute`, none toggled by a
   *     user action; the data they show or don't (a recorded decision, an
   *     empty list) is not the same thing as a popover opening and closing.
   *   - globals.css (1): `* { @apply border-border }`, the base-layer
   *     DEFAULT every element inherits before an actual border-width makes
   *     it visible anywhere - not a specific component's boundary at all.
   *   - legal-page.tsx (1): the draft-notice `<p role="status">`, shown or
   *     not based on a `draft` prop (page content, not a user toggle),
   *     static in the document flow, not floating over anything.
   *   - purchase-offer.tsx (1): a `bg-muted` `<aside>`, present or absent
   *     based on whether an offer exists (data, not a user toggle), static
   *     in flow - the same shape as the admin bg-muted panels above, not a
   *     floating overlay.
   *   - site-footer.tsx (2), site-header.tsx (1): permanent page chrome,
   *     always rendered, never toggled by a user action (criterion (b)
   *     alone excludes both, regardless of positioning).
   *
   * Checked for exhaustiveness, not merely asserted: grepped the whole
   * `src/` tree for every `shadow-md`/`shadow-lg`/`shadow-xl` usage (a
   * floating panel's own visual-separation cue, and one every genuine case
   * in this codebase happens to carry) - returns exactly the three sites
   * named above (two already fixed in round 1, the third in round 2). A
   * second grep, for `fixed`/`absolute` co-occurring with any `border`
   * utility, returns only cookie-banner - the two popovers are base-ui
   * `Popover.Popup` with no literal positioning class of their own, so
   * that grep cannot see them; it corroborates the one site it does
   * catch, not a second independent confirmation of all three.
   *
   * Same discipline as AUDITED_DECORATIVE_BACKGROUND_USAGES below: keyed by
   * `${file}:${utility}` -> occurrence COUNT, not just file presence, so a
   * SECOND, genuinely different `border-border` usage landing in an
   * already-audited file (a new floating panel added to
   * admin/curation/page.tsx, say) changes the count and fails loudly
   * instead of riding the existing entry silently.
   */
  const AUDITED_DECORATIVE_BORDER_USAGES: Readonly<Record<string, number>> = {
    "src/app/admin/curation/page.tsx:border-border": 10,
    "src/app/admin/settings/instagram/page.tsx:border-border": 2,
    "src/app/admin/settings/rights/brands/page.tsx:border-border": 3,
    "src/app/admin/settings/rights/page.tsx:border-border": 6,
    "src/app/admin/settings/users/page.tsx:border-border": 1,
    "src/app/globals.css:border-border": 1,
    "src/components/legal/legal-page.tsx:border-border": 1,
    "src/components/media/purchase-offer.tsx:border-border": 1,
    "src/components/site-footer.tsx:border-border": 2,
    "src/components/site-header.tsx:border-border": 1,
  };

  function borderBorderOccurrences(
    usages: readonly AlphaUtilityUsage[],
  ): Record<string, number> {
    const occurrences: Record<string, number> = {};
    for (const usage of usages) {
      if (usage.property !== "--color-border" || usage.utility !== "border-border") continue;
      const key = `${usage.file}:${usage.utility}`;
      occurrences[key] = (occurrences[key] ?? 0) + 1;
    }
    return occurrences;
  }

  it("every real border-border usage is audited, at exactly its audited count, and no new ones ride in unaudited", () => {
    expect(borderBorderOccurrences(usedBareUtilities)).toEqual(
      AUDITED_DECORATIVE_BORDER_USAGES,
    );
  });

  it("FIXTURE MUTATION: a second, genuinely new border-border usage in an already-audited file does not ride the existing entry", () => {
    // Reproduces the shape PR #115's own bg-petrol-200 mutation test proves
    // for AUDITED_DECORATIVE_BACKGROUND_USAGES, for this new audited list:
    // a real scan result with one MORE occurrence in an audited file must
    // stop matching the pinned count, rather than silently passing because
    // the file is already in the allowlist.
    const mutated: AlphaUtilityUsage[] = [
      ...usedBareUtilities,
      {
        file: "src/app/admin/curation/page.tsx",
        utility: "border-border",
        property: "--color-border",
        alphaPercent: 100,
        role: "foreground",
        prefix: "border",
      },
    ];
    expect(borderBorderOccurrences(mutated)).not.toEqual(AUDITED_DECORATIVE_BORDER_USAGES);
    expect(borderBorderOccurrences(mutated)["src/app/admin/curation/page.tsx:border-border"]).toBe(
      11,
    );
  });

  /**
   * ugcportal-5gca K2's "excluded with a derived reason" half, for a bare
   * background-role usage with no PAIRINGS entry - which is not automatically
   * an oversight the way an uncovered foreground is: a purely decorative
   * surface with nothing ever painted on top of it has no contrast ratio to
   * measure at all, and PAIRINGS has no entry shape for "nothing sits here"
   * (its decorative bucket is for a foreground WCAG 1.4.11 does not cover,
   * not for a background with no foreground).
   *
   * Keyed `${file}:${utility}` -> occurrence COUNT, not just a Set of keys
   * present (PR #115 round 1 finding 3): a Set membership check alone would
   * let a SECOND, genuinely non-decorative `bg-petrol-300` usage landing in
   * the same audited file ride this entry silently - reproduced: adding one
   * left every test here green with no PAIRINGS entry and no audit asked
   * for. `dual-meaning-usage.test.ts`'s own allowlist already pins `(file,
   * token, count)` for exactly this reason; this carries the same count
   * field forward rather than only claiming parity with it.
   *
   * EMPTY as of ugcportal-a3hj K2. The one entry this allowlist ever held —
   * hero.tsx's `HeroVisual` (ugcportal-qqnt.4 K1; `HeroDecoration`'s
   * replacement) rendering a neutral `aria-hidden`, childless `<div>`
   * fallback tile in `bg-petrol-200` for whichever slot(s) had no curated
   * preview — is gone along with that fallback tile itself: a3hj K2 removed
   * padding-with-placeholders entirely (fewer than three published pieces
   * now renders no collage at all, rather than a mix of real photographs and
   * this bare fill), so there is no longer any bare, decorative background
   * usage anywhere in the source tree for this list to name. Left as an
   * empty, still-exhaustiveness-checked allowlist (not deleted outright)
   * so a FUTURE bare decorative background usage is a deliberate, audited
   * addition here rather than something that starts passing silently the
   * moment this map is gone. `AUDITED_DECORATIVE_BORDER_USAGES` above still
   * demonstrates the identical "count, not just presence" mechanism against
   * real, non-empty entries unrelated to this change.
   */
  const AUDITED_DECORATIVE_BACKGROUND_USAGES: Readonly<Record<string, number>> = {};

  /**
   * Occurrence counts behind the allowlist above, computed once (a fact
   * about the source tree, not the theme mode) from the same `usedBareUtilities`
   * the real coverage check below iterates - not a second, independent scan
   * that could drift from what the gate actually sees.
   */
  const bareBackgroundOccurrences = new Map<string, number>();
  for (const usage of usedBareUtilities) {
    if (usage.role !== "background") continue;
    const key = `${usage.file}:${usage.utility}`;
    bareBackgroundOccurrences.set(key, (bareBackgroundOccurrences.get(key) ?? 0) + 1);
  }

  /**
   * True only for the EXACT audited (file, utility, count) - not merely a
   * (file, utility) pair the allowlist happens to mention. See the allowlist's
   * own doc comment (PR #115 round 1 finding 3) for the regression this
   * closes; the dedicated test below ("a second ... does not ride") proves
   * the count check actually bites, in isolation, without touching the real
   * hero.tsx.
   */
  function isAuditedDecorativeBackground(
    usage: Pick<AlphaUtilityUsage, "file" | "utility">,
    occurrences: ReadonlyMap<string, number>,
  ): boolean {
    const key = `${usage.file}:${usage.utility}`;
    const auditedCount = AUDITED_DECORATIVE_BACKGROUND_USAGES[key];
    return auditedCount !== undefined && occurrences.get(key) === auditedCount;
  }

  it("has exactly this audited decorative-background allowlist, at exactly its audited count, and no others", () => {
    // Pinned so a silent addition is a visible diff, the same reason
    // PAIRINGS' own decorative-id list is frozen above. EMPTY as of
    // ugcportal-a3hj K2 (see the allowlist's own comment) — a real bare
    // decorative-background usage would both add a key here AND show up in
    // `bareBackgroundOccurrences`, so the loop below still has a real,
    // non-vacuous (if currently empty) comparison to make.
    expect(Object.keys(AUDITED_DECORATIVE_BACKGROUND_USAGES).sort()).toEqual([]);
    for (const [key, count] of Object.entries(AUDITED_DECORATIVE_BACKGROUND_USAGES)) {
      expect(bareBackgroundOccurrences.get(key), `${key} occurrence count`).toBe(count);
    }
  });

  /**
   * ugcportal-a3hj K2 retired the one real case this test used to exercise
   * (two bare `bg-petrol-200` occurrences in hero.tsx, against a real
   * audited-count-of-1 entry for that exact file) along with the allowlist
   * entry itself, which is now empty (see its own comment). Reproduced here
   * instead against a SYNTHETIC, locally-scoped allowlist, built the same
   * shape the real one is (`${file}:${utility}` -> count), so the general
   * mechanism PR #115 round 1 finding 3 added — a count, not just a Set of
   * keys, so a SECOND occurrence in an already-audited file cannot ride the
   * existing entry — stays proven independently of whatever the real,
   * current allowlist happens to hold.
   */
  it("FIXTURE MUTATION: a second, non-decorative occurrence of an audited decorative background does not ride the existing entry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "axu-contrast-"));
    try {
      const file = path.join(root, "src", "components", "home", "hero.tsx");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `const a = "bg-petrol-200"; const b = "bg-petrol-200";`);
      const found = findBareColorUtilities(path.join(root, "src"));

      const occurrences = new Map<string, number>();
      for (const usage of found) {
        if (usage.role !== "background") continue;
        const key = `${usage.file}:${usage.utility}`;
        occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      }

      const petrol200 = found.find((usage) => usage.utility === "bg-petrol-200");
      expect(petrol200, "fixture ships bg-petrol-200").toBeDefined();
      const key = `${petrol200!.file}:${petrol200!.utility}`;
      expect(occurrences.get(key)).toBe(2);

      const syntheticAudited: Readonly<Record<string, number>> = { [key]: 1 };
      const auditedCount = syntheticAudited[key];
      const isAudited = auditedCount !== undefined && occurrences.get(key) === auditedCount;
      expect(isAudited, "two occurrences must not match the audited count of one").toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

        if (usage.role === "background") {
          if (isAuditedDecorativeBackground(usage, bareBackgroundOccurrences)) {
            continue;
          }
          const backgroundKey = `${backgroundTokenIdentity(usage.property, modeTokens)}@${usage.alphaPercent}`;
          const coveringEntries = measuredBackground.get(backgroundKey);
          expect(
            coveringEntries !== undefined && coveringEntries.size > 0,
            `[${mode}] ${usage.file} uses "${usage.utility}", but no pairing in PAIRINGS ` +
              `measures ${usage.property} at ${usage.alphaPercent}% alpha as a ` +
              `background. Add that pairing - a colour measured as a foreground ` +
              `does not cover it, because the two sit against different things - ` +
              `or, if nothing is ever painted on top of it, add it to ` +
              `AUDITED_DECORATIVE_BACKGROUND_USAGES with its occurrence count and why.`,
          ).toBe(true);
          continue;
        }

        const usageKey = `${resolveToken(usage.property, modeTokens)}@${usage.alphaPercent}`;

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
   * round 5 of PR #79 let through - bg-fjord-400 and text-petrol-900 shipped
   * on button.tsx's default-neutral and the upload dropzone's "Choose files"
   * label with no coverage check able to see either.
   *
   * PR #115 round 1, finding 1 (CONFIRMED medium): the first version of this
   * block asserted against an EMPTY Set and an empty PAIRINGS array for each
   * "without the entry" half - `new Set<string>().has(x)` and
   * `buildForegroundVerifiedThreshold([], ...).get(x) ?? -Infinity` can never
   * be anything but "uncovered", under any mutation, so none of the six
   * assertions could ever fail, and the block's own title ("...are
   * load-bearing") was not actually true of the real PAIRINGS. Every
   * sub-test below now runs the REAL PAIRINGS array minus exactly the one
   * entry its own name describes, through the same `buildMeasuredBackground`/
   * `buildForegroundVerifiedThreshold` the real gate above uses.
   *
   * Doing that honestly surfaced round 1 finding 2: `bg-fjord-400`'s
   * background coverage was NOT in fact load-bearing on this entry (at the
   * time still called `petrol-900-on-petrol-400`; ugcportal-ei5c later
   * renamed it to `surface-0-on-fjord-400`, same background reference)
   * before this PR's fix, because `--sidebar-primary` (aliased to
   * the identical `--color-fjord-400` literal) already supplied an
   * unrelated background entry of its own
   * (`sidebar-primary-foreground-on-sidebar-primary`) that `tokenAlphaKey`'s
   * full literal resolution could not tell apart from the real one. Fixed by
   * `backgroundTokenIdentity`/`backgroundCoverageKey`/`buildMeasuredBackground`
   * above - a narrower, one-hop `--color-X`/`--X` unwrap, not a
   * general abandonment of cross-reference sharing (see those functions' own
   * doc comments for why, and for why the general case is left alone).
   *
   * The two FOREGROUND sub-tests below (fjord-400 as a UI-boundary mark,
   * petrol-900 as the label on the fill) are NOT fixed the same way, and are
   * not claimed to be: `buildForegroundVerifiedThreshold`'s cross-reference
   * sharing is deliberate and tested (see "does not let a UI-boundary
   * pairing cover a text usage of the same literal and alpha" below) - a
   * verified RATIO is a fact about the rendered colour, so letting a
   * different reference's proof survive a collision is correct there, not a
   * bug to narrow. Both axes remain genuinely shadowed by an unrelated
   * reference today (`chart-3-on-surface-*` for fjord-400 as foreground;
   * `foreground-on-background`/`selection-text-on-selection` for petrol-900
   * as foreground), and the sub-tests assert that reality rather than a
   * false "reds".
   */
  describe("K3: the round-5 PAIRINGS entries, against the real, mutated PAIRINGS array", () => {
    const surfaceOnFjord400 = PAIRINGS.find((p) => p.id === "surface-0-on-fjord-400");
    const fjord400FillOnOldSurface = PAIRINGS.filter((p) =>
      p.id.startsWith("fjord-400-fill-on-old-surface-"),
    );

    it("both round-5 entries this bead's premise names are still in PAIRINGS to mutate", () => {
      expect(surfaceOnFjord400, "surface-0-on-fjord-400").toBeDefined();
      expect(fjord400FillOnOldSurface.length, "fjord-400-fill-on-old-surface-*").toBeGreaterThan(0);
    });

    /**
     * surface-0-on-fjord-400's OWN background reference (`--color-fjord-400`)
     * is what a real, shipped `bg-fjord-400` usage's coverage (this bare
     * scanner's "background role" check) actually depends on - NOT
     * fjord-400-fill-on-old-surface-*, which measures fjord-400 the other
     * way around (as a foreground UI-boundary mark against the surfaces
     * behind it - see the next test). This bare scanner classifies every
     * `bg-*` utility as background role unconditionally (isBackgroundRole),
     * so a real `bg-fjord-400` usage is never checked against
     * fjord-400-fill-on-old-surface-* at all.
     *
     * This is the one sub-test that now genuinely reds on its own mutation
     * (PR #115 round 1 findings 1+2, fixed together): with the real
     * `backgroundTokenIdentity` fix in place, deleting only
     * `surface-0-on-fjord-400` from the real PAIRINGS array removes
     * `bg-fjord-400`'s only covering entry - `sidebar-primary-foreground-
     * on-sidebar-primary` no longer substitutes for it.
     */
    it.each(THEME_MODES)(
      "surface-0-on-fjord-400 is bg-fjord-400's only covering entry, and deleting it reds the real gate (%s)",
      (mode) => {
        const modeTokens = tokensByMode[mode];
        const fjord400Fill = usedBareUtilities.find(
          (usage) => usage.property === "--color-fjord-400" && usage.role === "background",
        );
        expect(
          fjord400Fill,
          "bg-fjord-400 is still shipped as a background somewhere in src",
        ).toBeDefined();
        const backgroundKey = `${backgroundTokenIdentity(fjord400Fill!.property, modeTokens)}@${fjord400Fill!.alphaPercent}`;

        // With PAIRINGS intact: covered, and the gate can now say BY WHAT
        // (PR #115 round 1 finding 2's "report which entry covered a
        // usage") - exactly surface-0-on-fjord-400, not an alias.
        const coveredToday = buildMeasuredBackground(PAIRINGS, modeTokens).get(backgroundKey);
        expect(
          [...(coveredToday ?? [])],
          `[${mode}] covering entries for bg-fjord-400`,
        ).toEqual(["surface-0-on-fjord-400"]);

        // The real PAIRINGS array, minus exactly that one entry.
        const withoutEntry = buildMeasuredBackground(
          PAIRINGS.filter((pairing) => pairing.id !== "surface-0-on-fjord-400"),
          modeTokens,
        );
        expect(
          withoutEntry.get(backgroundKey)?.size ?? 0,
          `[${mode}] bg-fjord-400 must be uncovered once surface-0-on-fjord-400 is removed`,
        ).toBe(0);
      },
    );

    /**
     * fjord-400-fill-on-old-surface-*'s own half: fjord-400 as a FOREGROUND
     * UI-boundary mark (the button fill / progress-bar fill's own visibility)
     * against the old near-black surface scale as background. This bare
     * scanner's role convention never generates a usage on this axis for a
     * `bg-*` utility (see above), so a synthetic usage stands in for the real
     * shape (`AlphaUtilityUsage`'s own type, not a scanner result).
     *
     * Disclosed, not fixed (see this describe block's own header): deleting
     * fjord-400-fill-on-old-surface-* from the real PAIRINGS array leaves
     * this key at exactly ui's 3:1 regardless, because chart-3-on-surface-0/1
     * (`foreground: "--chart-3"`, and `--chart-3: var(--color-fjord-400)`
     * in globals.css) resolves to the identical literal and is itself
     * checked at `ui`. Narrowing `buildForegroundVerifiedThreshold`'s
     * cross-reference sharing to fix this would also narrow it for the
     * `--ring`/`--primary` case that sharing exists to protect - out of this
     * gate's scope, and asserted as what it is rather than claimed fixed.
     */
    it.each(THEME_MODES)(
      "fjord-400-fill-on-old-surface-* measures fjord-400 as a UI-boundary foreground, shadowed by chart-3-on-surface-* on this axis (%s)",
      (mode) => {
        const modeTokens = tokensByMode[mode];
        const syntheticFillUsage: AlphaUtilityUsage = {
          file: "synthetic - this bare scanner's bg=background-role convention never classifies a fill this way",
          utility: "bg-fjord-400",
          property: "--color-fjord-400",
          alphaPercent: 100,
          role: "foreground",
          prefix: "bg",
        };
        const usageKey = `${resolveToken(syntheticFillUsage.property, modeTokens)}@${syntheticFillUsage.alphaPercent}`;

        const withEntries = buildForegroundVerifiedThreshold(PAIRINGS, modeTokens);
        expect(withEntries.get(usageKey), `[${mode}] covered today`).toBe(THRESHOLDS.ui);

        const withoutEntries = buildForegroundVerifiedThreshold(
          PAIRINGS.filter((pairing) => !pairing.id.startsWith("fjord-400-fill-on-old-surface-")),
          modeTokens,
        );
        expect(
          withoutEntries.get(usageKey),
          `[${mode}] still reads as ui-verified via chart-3-on-surface-* - a known, disclosed shadow on this axis, not fixed by this PR`,
        ).toBe(THRESHOLDS.ui);
      },
    );

    /**
     * The remaining half of the original gap this describe block's header
     * names: text-petrol-900 as a foreground on the fill, at body's 4.5:1 -
     * NOW FIXED (ugcportal-z1nh). This used to be a synthetic usage, because
     * `--color-fjord-900` is declared outside `@theme`, so `text-petrol-900`
     * compiled to no Tailwind utility at all and findBareColorUtilities
     * correctly never reported it as a shipped usage (see that function's own
     * doc comment on why a non-compiling bare candidate is excluded, not
     * flagged) - Tailwind itself refused to generate the one thing a
     * synthetic usage had to stand in for.
     *
     * ugcportal-ei5c closed this gap for button.tsx's default-neutral
     * variant - its one real caller (the upload queue's "Sign in" link,
     * shown on a failed upload that needs re-authentication) renders
     * `text-surface-0`, a label `surface-0-on-fjord-400` above actually
     * measures - but left src/app/upload/upload-form.tsx's "Choose files"
     * label out of scope, still pasting `bg-fjord-400 text-petrol-900`
     * directly rather than going through the Button component. ugcportal-
     * z1nh fixed that label onto the identical `text-surface-0` token
     * (staying a hand-styled label rather than adopting buttonVariants
     * wholesale - see that file's own comment on why), so this is no longer
     * a synthetic stand-in: `text-surface-0` really is shipped there today,
     * and findBareColorUtilities' real, repo-wide scan picks it up like any
     * other usage.
     *
     * Two things this asserts, not one: that the real scan actually finds
     * this usage (a 0-results scan here would mean the fix regressed, or the
     * label's class string moved/changed shape, silently), and that it is
     * verified GENUINELY by surface-0-on-fjord-400 - not merely via some
     * unrelated reference that happens to resolve to the same literal, the
     * exact "only accidentally covered" shape this test used to document for
     * the pre-fix bug. Filtering PAIRINGS down to ONLY that one entry and
     * confirming it alone still reaches body's threshold is what tells the
     * two apart: an accidental shadow could not survive that filter, because
     * the unrelated reference supplying it would be gone.
     */
    it.each(THEME_MODES)(
      "text-surface-0 (upload-form.tsx's \"Choose files\" label, after ugcportal-z1nh) is a real, shipped usage, genuinely verified by surface-0-on-fjord-400, per mode (%s)",
      (mode) => {
        const modeTokens = tokensByMode[mode];
        const labelUsage = usedBareUtilities.find(
          (usage) =>
            usage.file.includes("upload-form.tsx") && usage.utility === "text-surface-0",
        );
        expect(
          labelUsage,
          "expected a real text-surface-0 usage from upload-form.tsx's \"Choose files\" label - " +
            "if this is undefined, either the fix regressed back to text-petrol-900/something else, " +
            "or the label's class string changed shape and this scan needs updating, not relaxing",
        ).toBeDefined();

        const usageKey = `${resolveToken(labelUsage!.property, modeTokens)}@${labelUsage!.alphaPercent}`;

        expect(
          buildForegroundVerifiedThreshold(PAIRINGS, modeTokens).get(usageKey),
          `[${mode}] real PAIRINGS`,
        ).toBe(THRESHOLDS.body);

        // Not an accidental shadow: surface-0-on-fjord-400 ALONE already
        // reaches body's threshold for this key, with every other PAIRINGS
        // entry removed.
        const onlyThisPairing = PAIRINGS.filter((p) => p.id === "surface-0-on-fjord-400");
        expect(onlyThisPairing.length, "surface-0-on-fjord-400 present").toBe(1);
        expect(
          buildForegroundVerifiedThreshold(onlyThisPairing, modeTokens).get(usageKey),
          `[${mode}] surface-0-on-fjord-400 alone - a weaker result here would mean this key only ` +
            "reads as covered via some OTHER, unrelated reference, the same accidental-shadow shape " +
            "this test used to document for the pre-fix bug",
        ).toBe(THRESHOLDS.body);
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
      // NOTE (ugcportal-uo15): this claim already looked stale before this
      // bead - --ring tracks --primary, which is var(--petrol-700) (hex) in
      // light mode, not --color-petrol-400/--color-fjord-400 - filed as
      // ugcportal-hiae rather than fixed here (scope freeze; this test
      // does not depend on the comment, only on the real resolveToken calls
      // below).
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
   * `bg-fjord-900` could ship a clipped colour with the suite green. Anything
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
 *
 * Updated again by ugcportal-uo15: that "old OKLCH scale" is the thing K1 of
 * this bead fixed from colliding with the hex one by NAME - every step
 * without a hex counterpart (300, 400, 600, 700, 800, 900, 950, deep) is
 * renamed `--color-fjord-*`, and every step WITH one (100, 200, 500) is now
 * a direct alias of the hex token (`--color-petrol-200: var(--petrol-200)`,
 * not an independent OKLCH literal) - so "ships the full scale" is now two
 * checks, one per surviving name, not one.
 */
describe("petrol is demoted, not removed", () => {
  it("still ships every surviving --color-petrol-* step (the ones a hex counterpart claimed)", () => {
    for (const step of [50, 100, 200, 500]) {
      expect(tokens.has(`--color-petrol-${step}`), `petrol-${step}`).toBe(true);
    }
  });

  it("still ships the full renamed --color-fjord-* scale (ugcportal-uo15)", () => {
    for (const step of [300, 400, 600, 700, 800, 900, 950, "deep"]) {
      expect(tokens.has(`--color-fjord-${step}`), `fjord-${step}`).toBe(true);
    }
  });

  it("no longer has a --color-petrol-* entry at the steps this bead renamed away", () => {
    for (const step of [300, 400, 600, 700, 800, 900, 950, "deep"]) {
      expect(tokens.has(`--color-petrol-${step}`), `petrol-${step} should not exist`).toBe(false);
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

  it("no longer paints overlays, the secondary button or the neutral hover fill", () => {
    // The demotion, stated as a check: the big areas are all neutral surface.
    // --background is deliberately NOT in this list any more (ugcportal-rw9j):
    // painting the page canvas with the petrol/paper palette is this bead's
    // entire point, not a regression of the demotion K4 originally checked.
    // --card and --muted are ALSO deliberately not in this list any more
    // (ugcportal-6uc2, phase 2): see "moves --card and --muted off the
    // near-black scale onto the paper one" below for their own check -
    // this test now documents exactly the SIX tokens phase 2 did not touch.
    for (const token of ["--popover", "--accent", "--secondary", "--sidebar"]) {
      expect(tokens.get(token)?.value, token).toMatch(
        /^var\(--color-(surface-\d+|scrim)\)$/,
      );
    }
  });

  it("moves --card and --muted off the near-black scale onto the paper one (ugcportal-6uc2, phase 2)", () => {
    expect(tokens.get("--card")?.value).toBe("var(--paper-card)");
    expect(tokens.get("--muted")?.value).toBe("var(--paper-card)");
    const darkTokens = tokensByMode.dark;
    expect(darkTokens.get("--card")?.value).toBe("var(--petrol-card)");
    expect(darkTokens.get("--muted")?.value).toBe("var(--petrol-card)");
  });

  /**
   * Round-2 review of ugcportal-6uc2, CONFIRMED low: --card/--muted got a
   * value-pin test the moment they moved (immediately above); --border/
   * --input, moved by the same bead, got none - an asymmetry with no
   * reason behind it other than the first test happening to get written
   * before this one did. --input is pinned to the SAME value in both
   * modes deliberately (see its own declaration's comment in globals.css
   * for why no dark override exists), unlike --border/--card/--muted,
   * which all flip.
   */
  it("moves --border and --input off the near-black scale onto the paper one (ugcportal-6uc2, phase 2)", () => {
    expect(tokens.get("--border")?.value).toBe("var(--paper-line)");
    expect(tokens.get("--input")?.value).toBe("var(--paper-line-strong)");
    const darkTokens = tokensByMode.dark;
    expect(darkTokens.get("--border")?.value).toBe("var(--petrol-line)");
    expect(darkTokens.get("--input")?.value).toBe("var(--paper-line-strong)");
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

  it("declares a dark-mode override for exactly the tokens phase 1 and phase 2 together touch", () => {
    // ugcportal-6uc2 (phase 2) adds --card, --muted and --border to this
    // set: both --card/--muted now carry a foreground that already flips in
    // dark mode (--card-foreground tracks --foreground; --muted-foreground
    // is re-declared two lines below), so each needs its own dark fill or
    // the pair goes light-on-light (see globals.css's own comment on this
    // block). --border is included too, for the decorative reason
    // docs/design/tokens.css gives it a distinct dark value at all - see
    // the same comment. --input is deliberately NOT here: it is the one
    // phase-2 token proven to need no dark-mode override at all (one
    // mode-invariant value already clears 3:1 in both modes - see its own
    // declaration's comment in globals.css).
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
        "--card",
        "--muted",
        "--border",
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
 * .bg-sidebar { --ring: var(--color-fjord-400); }` selector list, with
 * nothing tying the two together before this test - exactly the kind of
 * two-list drift this repo's own review history keeps finding (round 4's
 * MAJOR finding against the predecessor of this same override). Resolves
 * both independently: the CSS selector's classes through their real
 * semantic aliases (`.bg-sidebar` -> `--sidebar` -> `--color-surface-1`, etc
 * - round-2 review of ugcportal-6uc2, CONFIRMED: this used to say
 * `.bg-muted` -> `--muted` -> `--color-surface-1`, which stopped being true
 * in BOTH halves once phase 2 landed - `.bg-muted` is no longer in
 * globals.css's selector list at all, and `--muted` no longer resolves to
 * `--color-surface-1` either; `.bg-sidebar` is a selector this rule still
 * actually carries - the same mapping documented on RING_OVERRIDE_SURFACES's
 * own comment), and
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

/**
 * ugcportal-uo15 K1: "given the change, when the same step is read both
 * ways, both resolve to the same colour". Checks the ACTUAL Tailwind-
 * compiled `bg-petrol-200` utility (via `designSystem`, the same mechanism
 * button.test.ts and usage.ts use to confirm a candidate compiles at all), not
 * merely the two declarations' text - so a future change that keeps the two
 * `var()` chains textually distinct but makes them compile to the same
 * value by coincidence would still be caught as readable-both-ways by this
 * test, which is the actual guarantee K1 asks for, and a change that LOOKS
 * aliased in the declaration but gets re-written by some future Tailwind
 * compile step would be caught too.
 */
describe("K1 (ugcportal-uo15): bg-petrol-200 and var(--petrol-200) resolve to the same colour", () => {
  /** The `background-color`/`color` declaration a compiled utility carries, resolved to a final hex. */
  function compiledUtilityHex(
    utility: string,
    property: "background-color" | "color",
    mode: Map<string, Declaration> = tokens,
  ): string {
    const [css] = designSystem.candidatesToCss([utility]);
    if (css === null) {
      throw new Error(`"${utility}" does not compile to any Tailwind rule`);
    }
    let declaredValue: string | undefined;
    postcss.parse(css).walkDecls((decl) => {
      if (decl.prop === property) declaredValue = decl.value;
    });
    if (declaredValue === undefined) {
      throw new Error(`"${utility}" compiled, but produced no ${property} declaration: ${css}`);
    }
    const varMatch = /^var\(\s*(--[\w-]+)\s*\)$/.exec(declaredValue.trim());
    const resolved = varMatch ? resolveToken(varMatch[1], mode) : declaredValue.trim();
    return toHex(parseColor(resolved));
  }

  it("bg-petrol-200 (the @theme-compiled utility) equals var(--petrol-200) (the hex reference token)", () => {
    const utilityHex = compiledUtilityHex("bg-petrol-200", "background-color");
    const bareHex = toHex(parseColor(resolveToken("--petrol-200", tokens)));
    expect(utilityHex, "bg-petrol-200").toBe(bareHex);

    // The BEFORE state this bead fixes, quoted in the PR body: #bce7ec
    // (oklch(0.9 0.045 205), @theme's old independent literal) vs #9fc5c8
    // (docs/design/tokens.css's hex). Pinning both the equality above AND
    // the exact shared value below means a future edit that makes them
    // equal by both drifting to some THIRD colour still fails this test.
    expect(utilityHex, "the AFTER value - tokens.css's own hex").toBe("#9fc5c8");
  });

  it.each(["petrol-100", "petrol-500"] as const)(
    "bg-%s also resolves to the identical colour both ways (K1 is not step-200-only)",
    (step) => {
      const utilityHex = compiledUtilityHex(`bg-${step}`, "background-color");
      const bareHex = toHex(parseColor(resolveToken(`--${step}`, tokens)));
      expect(utilityHex, `bg-${step}`).toBe(bareHex);
    },
  );
});

/**
 * ugcportal-uo15 K3: "following should never happen - two live scales again
 * share a step name across `@theme` and `:root`, in either direction".
 *
 * `findColorScaleNameCollisions` (contrast.ts) is written against the
 * invariant, not against petrol by name, so this suite proves that two ways:
 * first that it actually CAN fail (the fixture-mutation check the bead's own
 * K3 and this repo's review standards ask for - re-add a colliding pair and
 * watch it fail, then remove it and watch it pass), then that the real,
 * shipped stylesheet has zero collisions, in both theme modes.
 */
describe("K3 (ugcportal-uo15): no two live colour scales share a step name across @theme and :root", () => {
  function fixtureTokens(declared: Record<string, string>): Map<string, Declaration> {
    const map = new Map<string, Declaration>();
    for (const [property, value] of Object.entries(declared)) {
      map.set(property, { property, value, selector: "(fixture)" });
    }
    return map;
  }

  it("FIXTURE MUTATION: fails when a --color-<name>-<step> and --<name>-<step> pair resolve to different colours", () => {
    // Exactly this bead's own before-state: @theme's independent OKLCH
    // literal and tokens.css's hex, both named "petrol-200".
    const colliding = fixtureTokens({
      "--color-petrol-200": "oklch(0.9 0.045 205)",
      "--petrol-200": "#9fc5c8",
    });
    const collisions = findColorScaleNameCollisions(colliding);
    expect(
      collisions,
      "the guard must catch this - if it does not, it cannot fail and is not a guard",
    ).toEqual([
      {
        colorProperty: "--color-petrol-200",
        bareProperty: "--petrol-200",
        colorHex: "#bce7ec",
        bareHex: "#9fc5c8",
      } satisfies ScaleNameCollision,
    ]);
  });

  it("FIXTURE MUTATION, reverted: once --color-petrol-200 aliases --petrol-200 directly, the same pair no longer collides", () => {
    // This bead's own after-state: a direct var() alias, not an independent
    // literal that happens to match today and could drift apart tomorrow.
    const fixed = fixtureTokens({
      "--petrol-200": "#9fc5c8",
      "--color-petrol-200": "var(--petrol-200)",
    });
    expect(findColorScaleNameCollisions(fixed)).toEqual([]);
  });

  it("does not flag a --color-<name>-<step> with no bare counterpart at all", () => {
    // --color-fjord-400 (this bead's renamed OKLCH ramp): nothing is
    // declared at bare --fjord-400, so there is only one value for this
    // name and nothing for it to disagree with.
    const noCounterpart = fixtureTokens({
      "--color-fjord-400": "oklch(0.72 0.085 205)",
    });
    expect(findColorScaleNameCollisions(noCounterpart)).toEqual([]);
  });

  it("does not flag a legitimate --color-X: var(--X) semantic alias sharing a step number (e.g. chart-1)", () => {
    // globals.css's real `@theme inline` shape (`--color-chart-1: var(--chart-1)`):
    // --chart-1 happens to end in a digit too, so SCALE_STEP_PROPERTY matches
    // it the same way it matches a real scale step - correctly, since a
    // genuine alias always resolves both sides to the identical colour.
    const aliasedChart = fixtureTokens({
      "--chart-1": "#9fc5c8",
      "--color-chart-1": "var(--chart-1)",
    });
    expect(findColorScaleNameCollisions(aliasedChart)).toEqual([]);
  });

  it.each(THEME_MODES)(
    "the real, shipped stylesheet has zero scale-name collisions (%s)",
    (mode) => {
      expect(findColorScaleNameCollisions(tokensByMode[mode])).toEqual([]);
    },
  );
});

/**
 * K4 (ugcportal-6uc2): "following should never happen - the phase-1 holding
 * comment in globals.css is deleted while any of --border, --input, --card
 * or --muted still reads from the near-black scale, leaving the file
 * claiming a migration it did not finish."
 *
 * Same shape as K3's own fixture-mutation suite just above: prove the real
 * file is clean today, then prove the guard function actually CAN fail by
 * feeding it a deliberately mutated (comment-stripped CSS text, near-black
 * token) pair, then prove reverting either half of that mutation clears it.
 */
/**
 * Round-1 review (PR #209), CONFIRMED medium: the ORIGINAL version of this
 * suite mutated only `--card`, reverted to `var(--color-surface-1)`. That
 * happens to be one of the two tokens `NEAR_BLACK_SCALE_REFERENCE`'s FIRST
 * version actually recognised (--card and --muted shared a pre-bead value,
 * `--color-surface-1`/`--color-scrim`); `--border` (pre-bead
 * `var(--color-line)`) and `--input` (pre-bead `var(--color-line-strong)`)
 * were never exercised at all, so the guard's blind spot for those two
 * survived the "mutate the fixture" discipline rather than being caught by
 * it. Every PRE_BEAD_VALUE below is this bead's own NOTES section, quoted
 * directly: "`--card` line 572 ... `var(--color-surface-1)`", "`--muted`
 * line 589 ... `var(--color-surface-1)`", "`--border` line 617
 * `var(--color-line)`", "`--input` line 618 `var(--color-line-strong)`".
 */
const PRE_BEAD_VALUES = {
  "--border": "var(--color-line)",
  "--input": "var(--color-line-strong)",
  "--card": "var(--color-surface-1)",
  "--muted": "var(--color-surface-1)",
} as const satisfies Record<(typeof PHASE_2_MOVED_TOKENS)[number], string>;

describe("K4 (ugcportal-6uc2): the phase-2 holding comment must not claim a finished migration", () => {
  it("names the same four tokens this bead's K1-K3 move", () => {
    expect([...PHASE_2_MOVED_TOKENS].sort()).toEqual(
      ["--border", "--card", "--input", "--muted"].sort(),
    );
  });

  it("PRE_BEAD_VALUES covers exactly PHASE_2_MOVED_TOKENS, no more and no fewer", () => {
    expect(Object.keys(PRE_BEAD_VALUES).sort()).toEqual(
      [...PHASE_2_MOVED_TOKENS].sort(),
    );
  });

  it("the real, shipped stylesheet: comment present, and none of the four still reads near-black", () => {
    const result = checkPhase2MigrationClaim(css, tokens);
    expect(result.commentPresent, "holding-comment marker").toBe(true);
    expect(result.stillNearBlack, "tokens still on the near-black scale").toEqual([]);
    expect(result.claimsUnfinishedMigrationAsDone).toBe(false);
  });

  it.each(PHASE_2_MOVED_TOKENS)(
    "FIXTURE MUTATION: comment deleted while %s is reverted to its own pre-bead value fails the guard",
    (token) => {
      const mutatedCss = css.replace(
        "Phase 2 (ugcportal-6uc2) is that approval acted on",
        "",
      );
      expect(
        mutatedCss.length,
        "the replace above must actually have removed something",
      ).toBeLessThan(css.length);

      const mutatedTokens = new Map(tokens);
      mutatedTokens.set(token, {
        property: token,
        value: PRE_BEAD_VALUES[token],
        selector: "(fixture)",
      });

      const result = checkPhase2MigrationClaim(mutatedCss, mutatedTokens);
      expect(result.commentPresent, "marker should be gone").toBe(false);
      expect(result.stillNearBlack, `mutated ${token} should be caught`).toEqual([token]);
      expect(
        result.claimsUnfinishedMigrationAsDone,
        `the guard must catch ${token} reverted to ${PRE_BEAD_VALUES[token]} - if it does not, it cannot fail and is not a guard`,
      ).toBe(true);
    },
  );

  it("FIXTURE MUTATION: comment deleted while a token is removed entirely (not merely reverted) also fails the guard", () => {
    // Round-1 review (PR #209), CONFIRMED medium: `tokens.get(token)?.value
    // ?? ""` let a DELETED token read as "not near-black" (the empty string
    // matches no pattern), escaping the guard the same way the
    // narrower-than-advertised regex did, just via a different gap. This
    // mutation removes --muted from the token map ENTIRELY rather than
    // reverting its value, which is the shape that specific fallback used
    // to miss.
    const mutatedCss = css.replace(
      "Phase 2 (ugcportal-6uc2) is that approval acted on",
      "",
    );
    const mutatedTokens = new Map(tokens);
    mutatedTokens.delete("--muted");

    const result = checkPhase2MigrationClaim(mutatedCss, mutatedTokens);
    expect(result.stillNearBlack, "a deleted token must be caught too").toEqual(["--muted"]);
    expect(result.claimsUnfinishedMigrationAsDone).toBe(true);
  });

  it.each(PHASE_2_MOVED_TOKENS)(
    "FIXTURE MUTATION, reverted (comment restored): %s at its pre-bead value no longer trips the guard once the comment is honest about it",
    (token) => {
      const mutatedTokens = new Map(tokens);
      mutatedTokens.set(token, {
        property: token,
        value: PRE_BEAD_VALUES[token],
        selector: "(fixture)",
      });
      // css (unmutated) still carries the comment here - this is deliberately
      // the PRE-phase-2 state (comment present, migration not yet done),
      // which K4 does not forbid: the comment is what makes that state
      // honest.
      const result = checkPhase2MigrationClaim(css, mutatedTokens);
      expect(result.commentPresent).toBe(true);
      expect(result.stillNearBlack).toEqual([token]);
      expect(result.claimsUnfinishedMigrationAsDone).toBe(false);
    },
  );

  it("FIXTURE MUTATION, reverted (migration finished): comment deleted but all four genuinely on the paper scale does not trip the guard either", () => {
    const mutatedCss = css.replace(
      "Phase 2 (ugcportal-6uc2) is that approval acted on",
      "",
    );
    // tokens (unmutated) already has all four correctly off the near-black
    // scale - this is the hypothetical FUTURE state where deleting the
    // comment would be honest, because the migration really is finished.
    const result = checkPhase2MigrationClaim(mutatedCss, tokens);
    expect(result.commentPresent).toBe(false);
    expect(result.stillNearBlack).toEqual([]);
    expect(result.claimsUnfinishedMigrationAsDone).toBe(false);
  });

  /**
   * Round-2 review, CONFIRMED low: with the round-1 `?? ""` fix in place, a
   * token present with a value this resolver does not RECOGNISE (neither
   * near-black-shaped nor an exact match for its own finished value) used
   * to silently read as "not near-black" - `stillNearBlack: []` - the same
   * result a genuinely finished migration produces. Each case below is one
   * of the shapes round-2 review specifically tried: a truly empty value,
   * nonsense text, a raw hex literal that bypasses the token system
   * entirely, near-black in substance but not in the exact shape this
   * resolver's pattern matches (trailing whitespace inside the value,
   * wrong case) - every one of them must now throw, loudly, rather than
   * silently joining either bucket.
   */
  it.each([
    ["an empty value", ""],
    ["nonsense text", "garbage"],
    ["a raw hex literal bypassing the token system", "#1a1d1d"],
    ["a near-black reference with trailing whitespace inside the value", "var(--color-surface-1) "],
    ["a near-black reference in the wrong case", "VAR(--COLOR-LINE)"],
  ])("FIXTURE MUTATION: --card with %s throws rather than silently passing", (_label, value) => {
    const mutatedTokens = new Map(tokens);
    mutatedTokens.set("--card", { property: "--card", value, selector: "(fixture)" });
    expect(() => checkPhase2MigrationClaim(css, mutatedTokens)).toThrow(
      /neither a recognised near-black-scale reference nor its expected finished value/,
    );
  });
});
