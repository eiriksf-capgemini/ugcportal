import { describe, expect, it } from "vitest";

import {
  compositeOver,
  contrastRatio,
  oklchToSrgb,
  parseColor,
  relativeLuminance,
  toHex,
} from "./color";

describe("parseColor", () => {
  it("round-trips the sRGB anchors", () => {
    expect(toHex(parseColor("oklch(1 0 0)"))).toBe("#ffffff");
    expect(toHex(parseColor("oklch(0 0 0)"))).toBe("#000000");
  });

  it("matches the known OKLCH lightness of Tailwind's neutral ramp", () => {
    // These are the values shadcn/Tailwind ship, so they are an independent
    // check that the OKLab matrices and the gamma transfer are right.
    expect(toHex(parseColor("oklch(0.145 0 0)"))).toBe("#0a0a0a");
    expect(toHex(parseColor("oklch(0.205 0 0)"))).toBe("#171717");
    expect(toHex(parseColor("oklch(0.269 0 0)"))).toBe("#262626");
    expect(toHex(parseColor("oklch(0.985 0 0)"))).toBe("#fafafa");
  });

  it("gives an achromatic colour a relative luminance of L cubed", () => {
    // For a grey, OKLab's L is the cube root of the linear luminance, so this
    // is an exact identity rather than an approximation.
    for (const lightness of [0.185, 0.345, 0.5, 0.775, 0.945]) {
      expect(
        relativeLuminance(parseColor(`oklch(${lightness} 0 0)`)),
      ).toBeCloseTo(lightness ** 3, 10);
    }
  });

  it("accepts percentages and hue units", () => {
    const plain = parseColor("oklch(0.5 0.1 180)");
    expect(toHex(parseColor("oklch(50% 25% 180deg)"))).toBe(toHex(plain));
    expect(toHex(parseColor("oklch(0.5 0.1 0.5turn)"))).toBe(toHex(plain));
    expect(toHex(parseColor("oklch(0.5 0.1 200grad)"))).toBe(toHex(plain));
  });

  it("parses hex in every length", () => {
    expect(toHex(parseColor("#fff"))).toBe("#ffffff");
    expect(toHex(parseColor("#1a2b3c"))).toBe("#1a2b3c");
    expect(parseColor("#00000080").alpha).toBeCloseTo(128 / 255, 6);
  });

  it("flags an out-of-gamut colour instead of silently clipping it", () => {
    // shadcn's stock dark destructive. The browser shows a clipped colour, so
    // the only honest answer is "this value is not what you think it is".
    expect(parseColor("oklch(0.704 0.191 22.216)").outOfGamut).toBe(true);
    expect(parseColor("oklch(0.75 0.15 25)").outOfGamut).toBe(false);
  });

  // The failure family this gate exists to prevent: a helper that accepts
  // something it cannot evaluate and returns a passing-looking number.
  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["rebeccapurple", "named colour"],
    ["rgb(0 0 0)", "rgb()"],
    ["color-mix(in oklch, var(--a), var(--b) 5%)", "color-mix()"],
    ["oklch(from var(--x) l c h)", "relative colour syntax"],
    ["oklch(0.5 0.1)", "too few components"],
    ["oklch(0.5 0.1 180 200)", "too many components"],
    ["oklch(none 0.1 180)", "none component"],
    ["oklch(NaN 0.1 180)", "NaN lightness"],
    ["oklch(Infinity 0.1 180)", "infinite lightness"],
    ["oklch(0.5 -0.1 180)", "negative chroma"],
    ["oklch(1.5 0.1 180)", "lightness above 1"],
    ["oklch(0.5 0.1 180 / 1.5)", "alpha above 1"],
    ["oklch(0.5 0.1 180 / abc)", "unparseable alpha"],
    ["#12345", "malformed hex"],
    ["#gggggg", "non-hex digits"],
    ["var(--something)", "unresolved var()"],
  ])("throws on %s (%s)", (value) => {
    expect(() => parseColor(value)).toThrow();
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white and 1:1 for a colour on itself", () => {
    expect(contrastRatio(parseColor("#000"), parseColor("#fff"))).toBeCloseTo(
      21,
      6,
    );
    expect(
      contrastRatio(parseColor("#767676"), parseColor("#767676")),
    ).toBeCloseTo(1, 10);
  });

  it("puts the AA boundary greys exactly where WCAG does", () => {
    // #767676 on white is the canonical "lightest grey that still passes AA
    // body text" value; one step lighter fails. If the transfer function or
    // the luminance coefficients were wrong, this boundary would move.
    const onWhite = (hex: string) =>
      contrastRatio(parseColor(hex), parseColor("#ffffff"));
    expect(onWhite("#767676")).toBeGreaterThanOrEqual(4.5);
    expect(onWhite("#777777")).toBeLessThan(4.5);

    // The matching boundary at the dark end, which is where this palette lives.
    const onBlack = (hex: string) =>
      contrastRatio(parseColor(hex), parseColor("#000000"));
    expect(onBlack("#757575")).toBeGreaterThanOrEqual(4.5);
    expect(onBlack("#747474")).toBeLessThan(4.5);
  });

  it("is symmetric", () => {
    const a = parseColor("oklch(0.185 0.008 205)");
    const b = parseColor("oklch(0.945 0.004 205)");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("composites a translucent foreground before measuring", () => {
    const backdrop = parseColor("#000000");
    const half = parseColor("#ffffff80");
    const opaque = parseColor("#ffffff");
    expect(contrastRatio(half, backdrop)).toBeLessThan(
      contrastRatio(opaque, backdrop),
    );
    // A fully transparent foreground is indistinguishable from its backdrop.
    expect(contrastRatio(parseColor("#ffffff00"), backdrop)).toBeCloseTo(1, 10);
  });

  it("refuses a translucent background rather than guessing a backdrop", () => {
    expect(() =>
      contrastRatio(parseColor("#ffffff"), parseColor("#00000080")),
    ).toThrow(/opaque/);
  });

  it("refuses to take the luminance of a translucent colour", () => {
    expect(() => relativeLuminance(parseColor("#ffffff80"))).toThrow(
      /composite/,
    );
  });
});

describe("compositeOver", () => {
  it("returns the foreground unchanged when it is opaque", () => {
    const top = parseColor("#123456");
    expect(compositeOver(top, parseColor("#ffffff"))).toEqual(top);
  });

  it("composites the way a browser does, not the way light does", () => {
    // CSS simple alpha compositing runs on the non-linear device values, so
    // 50% white over black paints #808080. The physically correct answer is
    // linear 0.5, which encodes to #bcbcbc — that is what this asserted before
    // review, and it made every alpha pairing in the gate read 0.5 to 2.2
    // ratio points higher than the browser actually paints.
    // Asserted on the channel rather than the hex: `oklch(1 0 0)` lands a
    // half-ULP below 1, so white-over-black rounds to #7f7f7f while
    // black-over-white rounds to #808080. That is 8-bit quantisation, not the
    // model, and pinning the hex would make this test about floating point.
    // The two models are not close enough for that to matter: gamma-space
    // gives channel 0.5, linear light gives 0.7354.
    const whiteOverBlack = compositeOver(
      parseColor("oklch(1 0 0 / 0.5)"),
      parseColor("#000000"),
    );
    expect(whiteOverBlack.r).toBeCloseTo(0.5, 10);
    expect(
      toHex(compositeOver(parseColor("oklch(0 0 0 / 0.5)"), parseColor("#ffffff"))),
    ).toBe("#808080");
  });

  it("is linear in alpha, per channel", () => {
    // The property that makes the above true in general rather than at one
    // convenient midpoint. Under the old linear-light blend, alpha 0.25 gave
    // an encoded channel of 0.537, not 0.25.
    for (const alpha of [0, 0.25, 0.6, 0.9, 1]) {
      const composited = compositeOver(
        parseColor(`oklch(1 0 0 / ${alpha})`),
        parseColor("#000000"),
      );
      expect(composited.r).toBeCloseTo(alpha, 10);
    }
  });
});

describe("oklchToSrgb", () => {
  it("treats hue as irrelevant when chroma is zero", () => {
    for (const hue of [0, 90, 205, 359]) {
      expect(toHex(oklchToSrgb(0.5, 0, hue, 1))).toBe(toHex(oklchToSrgb(0.5, 0, 0, 1)));
    }
  });
});
