/**
 * Colour maths for the design-system contrast gate (ugcportal-axu).
 *
 * Deliberately strict: parseColor, relativeLuminance, compositeOver and
 * contrastRatio throw on input they cannot fully evaluate rather than
 * returning a number. A contrast helper that quietly passes a pair it could
 * not parse is worse than no helper at all, because the build stays green
 * while the guarantee is gone.
 *
 * Two exceptions, both reporting-only: `toHex` clamps rather than throwing,
 * and `oklchToSrgb` does not range-check its arguments (parseColor does that
 * before calling it) but does report out-of-gamut results instead of hiding
 * the clip.
 */

/** A colour resolved to non-linear sRGB channels in 0..1 plus alpha in 0..1. */
export type Srgb = {
  r: number;
  g: number;
  b: number;
  alpha: number;
  /**
   * True when the source colour fell outside the sRGB gamut and had to be
   * clipped per channel. Contrast for such a colour is only as meaningful as
   * the clip, so callers are expected to reject it rather than trust it.
   */
  outOfGamut: boolean;
};

function fail(message: string): never {
  throw new Error(`[design/color] ${message}`);
}

/**
 * Parses one CSS number that may be written as a percentage.
 *
 * `percentBasis` is what 100% means for this component (1 for lightness,
 * 0.4 for OKLCH chroma, per the CSS Color 4 definition).
 */
function parseNumeric(
  raw: string,
  percentBasis: number,
  what: string,
  source: string,
): number {
  const text = raw.trim();
  if (text === "") fail(`empty ${what} in "${source}"`);
  if (text === "none") {
    // CSS Color 4 "none" carries missing-component semantics that only matter
    // for interpolation. Treating it as 0 here would be a guess.
    fail(`"none" is not supported for ${what} in "${source}"`);
  }
  const isPercent = text.endsWith("%");
  const numberText = isPercent ? text.slice(0, -1) : text;
  // Number() would accept "", " ", "0x10" and "Infinity"; this does not.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(numberText)) {
    fail(`could not parse ${what} "${text}" in "${source}"`);
  }
  const value = Number(numberText);
  if (!Number.isFinite(value)) {
    fail(`non-finite ${what} "${text}" in "${source}"`);
  }
  return isPercent ? (value / 100) * percentBasis : value;
}

function parseAngle(raw: string, source: string): number {
  const text = raw.trim().toLowerCase();
  const withUnit =
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(deg|grad|rad|turn)?$/.exec(
      text,
    );
  if (!withUnit) fail(`could not parse hue "${raw}" in "${source}"`);
  const value = Number(withUnit[1]);
  if (!Number.isFinite(value)) fail(`non-finite hue "${raw}" in "${source}"`);
  switch (withUnit[2]) {
    case undefined:
    case "deg":
      return value;
    case "grad":
      return value * 0.9;
    case "rad":
      return (value * 180) / Math.PI;
    case "turn":
      return value * 360;
    default:
      return fail(`unsupported hue unit in "${raw}"`);
  }
}

function encodeGamma(channel: number): number {
  return channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function decodeGamma(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** OKLCH -> non-linear sRGB (Ottosson's OKLab matrices). */
export function oklchToSrgb(
  lightness: number,
  chroma: number,
  hueDeg: number,
  alpha: number,
): Srgb {
  const hueRad = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hueRad);
  const bComponent = chroma * Math.sin(hueRad);

  const lp = lightness + 0.3963377774 * a + 0.2158037573 * bComponent;
  const mp = lightness - 0.1055613458 * a - 0.0638541728 * bComponent;
  const sp = lightness - 0.0894841775 * a - 1.291485548 * bComponent;

  const l = lp * lp * lp;
  const m = mp * mp * mp;
  const s = sp * sp * sp;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  // A display cannot show out-of-gamut values; it clips. Record that it
  // happened so callers can refuse the colour instead of trusting a ratio
  // derived from a clip.
  const epsilon = 1e-6;
  let outOfGamut = false;
  const encoded = linear.map((channel) => {
    if (channel < -epsilon || channel > 1 + epsilon) outOfGamut = true;
    return encodeGamma(Math.min(1, Math.max(0, channel)));
  });

  return {
    r: encoded[0],
    g: encoded[1],
    b: encoded[2],
    alpha,
    outOfGamut,
  };
}

/**
 * Parses the CSS colour syntaxes this design system actually uses:
 * `oklch(L C H)`, `oklch(L C H / A)` and `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`.
 *
 * Anything else throws. Adding a syntax here is a deliberate act; silently
 * accepting one is how a pair stops being checked.
 */
export function parseColor(value: string): Srgb {
  const source = value.trim();
  if (source === "") fail("empty colour value");

  if (source.startsWith("#")) {
    const hex = source.slice(1);
    if (
      !/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(
        hex,
      )
    ) {
      fail(`could not parse hex colour "${source}"`);
    }
    const pairs =
      hex.length <= 4
        ? hex.split("").map((char) => char + char)
        : (hex.match(/.{2}/g) as string[]);
    const [r, g, b, a] = pairs.map((pair) => parseInt(pair, 16) / 255);
    return { r, g, b, alpha: a === undefined ? 1 : a, outOfGamut: false };
  }

  const oklch = /^oklch\(([^)]*)\)$/i.exec(source);
  if (!oklch) {
    fail(
      `unsupported colour syntax "${source}" - this gate understands oklch() and hex only, ` +
        `so an unrecognised value is an error rather than a skipped pair`,
    );
  }

  const [componentText, alphaText, ...extra] = oklch[1].split("/");
  if (extra.length > 0) fail(`malformed oklch alpha in "${source}"`);
  const components = componentText.trim().split(/\s+/).filter(Boolean);
  if (components.length !== 3) {
    fail(
      `expected 3 components in "${source}", got ${components.length} - ` +
        `relative colour syntax (from ...) is not supported`,
    );
  }

  const lightness = parseNumeric(components[0], 1, "lightness", source);
  const chroma = parseNumeric(components[1], 0.4, "chroma", source);
  const hue = parseAngle(components[2], source);
  const alpha =
    alphaText === undefined ? 1 : parseNumeric(alphaText, 1, "alpha", source);
  if (alpha < 0 || alpha > 1) fail(`alpha out of range in "${source}"`);
  if (chroma < 0) fail(`negative chroma in "${source}"`);
  if (lightness < 0 || lightness > 1) {
    fail(`lightness out of range in "${source}"`);
  }

  return oklchToSrgb(lightness, chroma, hue, alpha);
}

/** WCAG 2.x relative luminance of an opaque sRGB colour. */
export function relativeLuminance(color: Srgb): number {
  if (color.alpha !== 1) {
    fail(
      "relativeLuminance() needs an opaque colour; composite over a backdrop first",
    );
  }
  const r = decodeGamma(color.r);
  const g = decodeGamma(color.g);
  const b = decodeGamma(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Source-over composite of `top` onto an opaque `backdrop`. */
export function compositeOver(top: Srgb, backdrop: Srgb): Srgb {
  if (backdrop.alpha !== 1) {
    fail(
      "a backdrop must be opaque; a translucent background has no single defined contrast",
    );
  }
  if (top.alpha === 1) return top;
  const mix = (a: number, b: number) =>
    encodeGamma(decodeGamma(a) * top.alpha + decodeGamma(b) * (1 - top.alpha));
  return {
    r: mix(top.r, backdrop.r),
    g: mix(top.g, backdrop.g),
    b: mix(top.b, backdrop.b),
    alpha: 1,
    outOfGamut: top.outOfGamut || backdrop.outOfGamut,
  };
}

/**
 * WCAG 2.x contrast ratio between a (possibly translucent) foreground and an
 * opaque background. Returns a number in 1..21.
 */
export function contrastRatio(foreground: Srgb, background: Srgb): number {
  const flattened = compositeOver(foreground, background);
  const a = relativeLuminance(flattened);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  if (!Number.isFinite(ratio)) {
    fail("contrast ratio computed as non-finite");
  }
  return ratio;
}

/** Convenience for reporting: `#rrggbb` (alpha dropped, so composite first). */
export function toHex(color: Srgb): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}
