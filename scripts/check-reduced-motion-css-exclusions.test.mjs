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

import { findUngatedGroupHoverScaleRules } from "./check-reduced-motion-css-exclusions.mjs";

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
      .group-hover\\:translate-y-px:is(:where(.group):hover *) { translate: 0 -1px; }
      .motion-safe\\:scale-100 { scale: 1; }
    `;

    expect(findUngatedGroupHoverScaleRules(css)).toEqual([]);
  });
});
