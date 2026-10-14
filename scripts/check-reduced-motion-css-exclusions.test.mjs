/**
 * Tests for scripts/check-reduced-motion-css-exclusions.mjs (ugcportal-61pv
 * round 2).
 *
 * Drives `findUngatedGroupHoverScaleRules` directly against small, literal
 * CSS fragments shaped like real compiled Tailwind output - not against a
 * real `next build` (that stays a manual/CI-time run of the script itself,
 * per the review comment this script answers: "do not add a full build to
 * vitest").
 */
import { describe, expect, it } from "vitest";

import {
  UNGATED_MOTION_ALLOWLIST,
  allowlistDrift,
  findUngatedGroupHoverScaleRules,
  findUngatedMotionRules,
  utilityOfSelector,
} from "./check-reduced-motion-css-exclusions.mjs";

describe("findUngatedGroupHoverScaleRules", () => {
  it("reports nothing for a rule correctly gated by motion-safe: and @media (prefers-reduced-motion: no-preference)", () => {
    const css = `
      @media (prefers-reduced-motion: no-preference) {
        @media (hover: hover) {
          .motion-safe\\:group-hover\\:scale-\\[1\\.04\\]:is(:where(.group):hover *) {
            scale: 1.04;
          }
        }
      }
    `;

    expect(findUngatedGroupHoverScaleRules(css)).toEqual([]);
  });

  it("flags a bare group-hover+scale rule with no motion-safe: prefix and no media gate at all", () => {
    const css = `
      .group-hover\\:scale-\\[1\\.17\\]:is(:where(.group):hover *) {
        scale: 1.17;
      }
    `;

    const offenders = findUngatedGroupHoverScaleRules(css);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("no motion-safe: prefix");
    expect(offenders[0]).toContain("not nested inside @media (prefers-reduced-motion: ...)");
  });

  it("flags a motion-safe:-prefixed rule that is NOT nested inside a prefers-reduced-motion media query", () => {
    const css = `
      @media (hover: hover) {
        .motion-safe\\:group-hover\\:scale-\\[1\\.04\\]:is(:where(.group):hover *) {
          scale: 1.04;
        }
      }
    `;

    const offenders = findUngatedGroupHoverScaleRules(css);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("not nested inside @media (prefers-reduced-motion: ...)");
    expect(offenders[0]).not.toContain("no motion-safe: prefix");
  });

  it("flags a rule nested inside prefers-reduced-motion but with no motion-safe: prefix (the not-motion-safe: inverse-variant shape)", () => {
    const css = `
      @media not (prefers-reduced-motion: no-preference) {
        @media (hover: hover) {
          .not-motion-safe\\:group-hover\\:scale-\\[1\\.04\\]:is(:where(.group):hover *) {
            scale: 1.04;
          }
        }
      }
    `;

    const offenders = findUngatedGroupHoverScaleRules(css);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("no motion-safe: prefix");
  });

  it("ignores a rule that mentions only one of group-hover/scale", () => {
    const css = `
      .group-hover\\:translate-y-${"px"}:is(:where(.group):hover *) { translate: 0 -1px; }
      .motion-safe\\:scale-${"100"} { scale: 1; }
    `;

    expect(findUngatedGroupHoverScaleRules(css)).toEqual([]);
  });
});

describe("findUngatedMotionRules (ugcportal-rj7y K2)", () => {
  it("flags a bare animation utility from any file's text, with no group-hover or scale in it", () => {
    const css = `
      @layer utilities {
        .animate-${"spin"} { animation: var(--animate-spin); }
      }
    `;

    const offenders = findUngatedMotionRules(css);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toBe(
      `.animate-${"spin"} { animation } (not nested inside @media (prefers-reduced-motion: no-preference))`,
    );
  });

  it("flags bare scale, translate and rotate rules", () => {
    const css = `
      .scale-${"110"} { scale: 1.1; }
      .translate-y-${"px"} { translate: 0 1px; }
      .rotate-${"6"} { rotate: 6deg; }
    `;

    expect(findUngatedMotionRules(css)).toHaveLength(3);
  });

  it("flags the not-motion-safe: inverse, which sits in a prefers-reduced-motion media query but fires under reduce", () => {
    const css = `
      @media not (prefers-reduced-motion: no-preference) {
        .not-motion-safe\\:animate-${"spin"} { animation: spin 1s linear infinite; }
      }
    `;

    expect(findUngatedMotionRules(css)).toHaveLength(1);
  });

  it("flags a bare skew or 3D rotate, which Tailwind compiles to transform (round-1 F1)", () => {
    const css = `
      .skew-x-${"3"} { --tw-skew-x: skewX(3deg); transform: var(--tw-rotate-x,) var(--tw-skew-x,); }
      .rotate-y-${"12"} { --tw-rotate-y: rotateY(12deg); transform: var(--tw-rotate-x,) var(--tw-rotate-y,); }
      .transform-none { transform: none; }
    `;

    expect(findUngatedMotionRules(css)).toEqual([
      `.skew-x-${"3"} { transform } (not nested inside @media (prefers-reduced-motion: no-preference))`,
      `.rotate-y-${"12"} { transform } (not nested inside @media (prefers-reduced-motion: no-preference))`,
    ]);
  });

  it("accepts any motion rule inside the motion-safe: media query", () => {
    const css = `
      @media (prefers-reduced-motion: no-preference) {
        .motion-safe\\:animate-${"spin"} { animation: spin 1s linear infinite; }
        .motion-safe\\:skew-x-${"3"} { transform: var(--tw-skew-x,); }
      }
    `;

    expect(findUngatedMotionRules(css)).toEqual([]);
  });

  // Orchestrator decision on round-1 F6.
  it("flags a motion-reduce: rule that ADDS motion: it animates only for users who asked for none", () => {
    const css = `
      @media (prefers-reduced-motion: reduce) {
        .motion-reduce\\:animate-${"spin"} { animation: spin 1s linear infinite; }
        .motion-reduce\\:rotate-${"6"} { rotate: 6deg; }
      }
    `;

    const offenders = findUngatedMotionRules(css);
    expect(offenders).toHaveLength(2);
    for (const offender of offenders) expect(offender).toContain("under @media (prefers-reduced-motion: reduce) but adds motion");
  });

  it("accepts a motion-reduce: rule whose utility removes or neutralises motion, even with a non-none value", () => {
    const css = `
      @media (prefers-reduced-motion: reduce) {
        .motion-reduce\\:scale-${"100"} { --tw-scale-x: 100%; scale: var(--tw-scale-x) var(--tw-scale-y); }
        .motion-reduce\\:hover\\:translate-x-${"0"}:hover { translate: var(--tw-translate-x) var(--tw-translate-y); }
        .motion-reduce\\:rotate-${"0"} { rotate: 0deg; }
        .motion-reduce\\:skew-${"0"} { transform: var(--tw-skew-x,); }
        .motion-reduce\\:animate-none { animation: none; }
      }
    `;

    expect(findUngatedMotionRules(css)).toEqual([]);
    // The same neutral rules outside the media query are not gated.
    expect(findUngatedMotionRules(`.motion-reduce\\:rotate-${"0"} { rotate: 0deg; }`)).toHaveLength(1);
  });

  it("accepts a none value and does not read keyframe steps as rules", () => {
    const css = `
      .animate-none { animation: none; }
      .translate-none { translate: none; }
      @keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }
    `;

    expect(findUngatedMotionRules(css)).toEqual([]);
  });

  it("reads the utility off a compiled selector", () => {
    expect(utilityOfSelector(`.motion-reduce\\:hover\\:scale-${"100"}:hover`)).toBe(`scale-${"100"}`);
    expect(utilityOfSelector(`.translate-x-${"0"}\\.5`)).toBe(`translate-x-${"0"}.5`);
    expect(utilityOfSelector(`.md\\:motion-reduce\\:\\[rotate\\:0deg\\]`)).toBe("[rotate" + ":0deg]");
    expect(utilityOfSelector(".pswp__icn")).toBe("pswp__icn");
    expect(utilityOfSelector("0%")).toBe("");
  });

  it("accepts only the allowlisted selectors, by exact selector", () => {
    const [selector] = [...UNGATED_MOTION_ALLOWLIST.keys()];
    expect(findUngatedMotionRules(`${selector} { translate: 0.125rem; }`)).toEqual([]);
    expect(findUngatedMotionRules(`${selector}-x { translate: 0.125rem; }`)).toHaveLength(1);
  });

  describe("allowlistDrift (round-1 F5)", () => {
    const fixture = (selectors) => selectors.map((selector) => `${selector} { transform: scaleX(-1); }`).join("\n");
    const drift = (css) => {
      const hits = new Map();
      const offenders = findUngatedMotionRules(css, hits);
      return { offenders, drift: allowlistDrift(hits) };
    };
    const selectors = [...UNGATED_MOTION_ALLOWLIST.keys()];

    it("reports nothing when every entry matches exactly its stated count", () => {
      for (const { count } of UNGATED_MOTION_ALLOWLIST.values()) expect(count).toBe(1);
      expect(drift(fixture(selectors))).toEqual({ offenders: [], drift: [] });
    });

    it("names an entry that matched no rule (stale)", () => {
      const [removed, ...rest] = selectors;
      expect(drift(fixture(rest)).drift).toEqual([
        `UNGATED_MOTION_ALLOWLIST ${removed}: expected 1 matching rule(s), found 0`,
      ]);
    });

    it("names an entry that matched more rules than stated (widened)", () => {
      const last = selectors[selectors.length - 1];
      expect(drift(fixture([...selectors, last])).drift).toEqual([
        `UNGATED_MOTION_ALLOWLIST ${last}: expected 1 matching rule(s), found 2`,
      ]);
    });

    it("does not count an allowlisted rule that carries no motion declaration", () => {
      const [first, ...rest] = selectors;
      const css = `${fixture(rest)}\n${first} { color: red; }`;
      expect(drift(css).drift).toEqual([`UNGATED_MOTION_ALLOWLIST ${first}: expected 1 matching rule(s), found 0`]);
    });
  });
});
