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
  findUngatedGroupHoverScaleRules,
  findUngatedMotionRules,
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
      `.animate-${"spin"} { animation } (not nested inside @media (prefers-reduced-motion: ...))`,
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

  it("accepts a rule inside motion-safe: or motion-reduce: media queries", () => {
    const css = `
      @media (prefers-reduced-motion: no-preference) {
        .motion-safe\\:animate-${"spin"} { animation: spin 1s linear infinite; }
      }
      @media (prefers-reduced-motion: reduce) {
        .motion-reduce\\:rotate-${"6"} { rotate: 6deg; }
      }
    `;

    expect(findUngatedMotionRules(css)).toEqual([]);
  });

  it("accepts a none value and does not read keyframe steps as rules", () => {
    const css = `
      .animate-none { animation: none; }
      .translate-none { translate: none; }
      @keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }
    `;

    expect(findUngatedMotionRules(css)).toEqual([]);
  });

  it("accepts only the allowlisted selectors, by exact selector", () => {
    const [selector] = [...UNGATED_MOTION_ALLOWLIST.keys()];
    expect(findUngatedMotionRules(`${selector} { translate: 0.125rem; }`)).toEqual([]);
    expect(findUngatedMotionRules(`${selector}-x { translate: 0.125rem; }`)).toHaveLength(1);
  });
});
