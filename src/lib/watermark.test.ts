import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_INPUT_PIXELS,
  PREVIEW_CONTENT_TYPE,
  PREVIEW_MAX_DIMENSION,
  PREVIEW_QUALITY,
  WatermarkError,
  generateWatermarkedPreview,
  resolveWatermarkText,
} from "@/lib/watermark";

const SOURCE_WIDTH = 2400;
const SOURCE_HEIGHT = 1600;
// A flat mid-grey source: every pixel of the *unwatermarked* downscale is the
// same colour, so anything that differs in the watermarked version is overlay
// and nothing else.
const SOURCE_COLOR = { r: 120, g: 120, b: 120 };

async function buildSourcePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      channels: 3,
      background: SOURCE_COLOR,
    },
  })
    .png()
    .toBuffer();
}

/**
 * The exact same resize/encode the service performs, minus the composite.
 * Comparing against this isolates the watermark: "the bytes changed" on its
 * own would also be true of a plain resize, which protects nothing.
 */
async function buildUnwatermarkedBaseline(source: Buffer) {
  return sharp(source)
    .rotate()
    .resize({
      width: PREVIEW_MAX_DIMENSION,
      height: PREVIEW_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: PREVIEW_QUALITY })
    .toBuffer();
}

/** Per-pixel comparison of two same-sized images, decoded back to RGB. */
async function diffPixels(a: Buffer, b: Buffer) {
  const [left, right] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  expect(left.info.width).toBe(right.info.width);
  expect(left.info.height).toBe(right.info.height);

  const { width, height, channels } = left.info;
  // WebP is lossy, so identical inputs still differ by a point or two. Only
  // count a pixel as marked once it moves well past that noise floor.
  const NOISE_TOLERANCE = 12;
  const quadrants = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
  let changed = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      let delta = 0;
      for (let c = 0; c < channels; c += 1) {
        delta = Math.max(
          delta,
          Math.abs(left.data[offset + c] - right.data[offset + c]),
        );
      }
      if (delta <= NOISE_TOLERANCE) continue;
      changed += 1;
      const top = y < height / 2;
      const leftHalf = x < width / 2;
      if (top && leftHalf) quadrants.topLeft += 1;
      else if (top) quadrants.topRight += 1;
      else if (leftHalf) quadrants.bottomLeft += 1;
      else quadrants.bottomRight += 1;
    }
  }

  return { changed, total: width * height, quadrants };
}

afterEach(() => {
  delete process.env.WATERMARK_TEXT;
});

describe("generateWatermarkedPreview", () => {
  it("produces a downscaled WebP that differs from the original bytes", async () => {
    const source = await buildSourcePng();

    const preview = await generateWatermarkedPreview(source);
    const metadata = await sharp(preview.data).metadata();

    expect(preview.contentType).toBe(PREVIEW_CONTENT_TYPE);
    expect(preview.data.equals(source)).toBe(false);
    expect(metadata.format).toBe("webp");
    // "inside" fit on a 3:2 source capped at the longest edge.
    expect(metadata.width).toBe(PREVIEW_MAX_DIMENSION);
    expect(metadata.height).toBe(
      Math.round((SOURCE_HEIGHT / SOURCE_WIDTH) * PREVIEW_MAX_DIMENSION),
    );
    expect(preview.width).toBe(metadata.width);
    expect(preview.height).toBe(metadata.height);
    expect(metadata.width).toBeLessThan(SOURCE_WIDTH);
    expect(metadata.height).toBeLessThan(SOURCE_HEIGHT);
  });

  it("burns a watermark into the pixels, spread across the whole frame (K1)", async () => {
    const source = await buildSourcePng();

    const preview = await generateWatermarkedPreview(source);
    const baseline = await buildUnwatermarkedBaseline(source);

    const { changed, total, quadrants } = await diffPixels(
      preview.data,
      baseline,
    );

    // The overlay has to actually mark the image, not merely re-encode it.
    expect(changed / total).toBeGreaterThan(0.02);
    // ...and it has to be everywhere, so no single crop removes it. A corner
    // stamp would light up one quadrant and leave the other three untouched.
    const perQuadrantFloor = (total / 4) * 0.01;
    expect(quadrants.topLeft).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.topRight).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.bottomLeft).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.bottomRight).toBeGreaterThan(perQuadrantFloor);
  });

  it("leaves the image recognisable rather than obliterating it", async () => {
    const source = await buildSourcePng();

    const preview = await generateWatermarkedPreview(source);
    const baseline = await buildUnwatermarkedBaseline(source);
    const { changed, total } = await diffPixels(preview.data, baseline);

    expect(changed / total).toBeLessThan(0.6);
  });

  it("renders the configured watermark text, not just the fallback hairlines", async () => {
    // Canary for font availability: libvips ships no fonts, so on a host
    // without any installed, the text silently disappears and only the
    // hairline grid survives. Two different texts must produce two different
    // images — if they don't, no text is being drawn at all.
    const source = await buildSourcePng();

    const [shortText, longText] = await Promise.all([
      generateWatermarkedPreview(source, { text: "aa" }),
      generateWatermarkedPreview(source, { text: "WATERMARKED SAMPLE" }),
    ]);

    const { changed } = await diffPixels(shortText.data, longText.data);
    expect(changed).toBeGreaterThan(0);
  });

  it("reads the watermark text from WATERMARK_TEXT at call time", async () => {
    const source = await buildSourcePng();

    const withDefault = await generateWatermarkedPreview(source);
    process.env.WATERMARK_TEXT = "another studio name";
    const withEnv = await generateWatermarkedPreview(source);

    expect(withDefault.data.equals(withEnv.data)).toBe(false);
  });

  it("escapes XML metacharacters in the configured text", async () => {
    const source = await buildSourcePng();

    // An unescaped '<' or '&' would make the overlay SVG unparseable and blow
    // up the composite, i.e. turn configuration into an upload outage.
    const preview = await generateWatermarkedPreview(source, {
      text: `<g/>&"'`,
    });

    await expect(sharp(preview.data).metadata()).resolves.toMatchObject({
      format: "webp",
    });
  });

  it("rejects a file that isn't decodable as an image", async () => {
    // A valid PNG signature with no actual PNG behind it.
    const corrupt = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await expect(generateWatermarkedPreview(corrupt)).rejects.toBeInstanceOf(
      WatermarkError,
    );
  });

  it("rejects an input above the pixel limit (decompression-bomb guard)", async () => {
    const source = await buildSourcePng();

    // Driving the guard with a tiny limit rather than building an actual
    // multi-gigapixel bomb: what's under test is that limitInputPixels is
    // wired through, not the specific value of MAX_INPUT_PIXELS.
    await expect(
      generateWatermarkedPreview(source, { limitInputPixels: 1_000 }),
    ).rejects.toBeInstanceOf(WatermarkError);

    expect(MAX_INPUT_PIXELS).toBeLessThan(268_402_689); // sharp's own default
  });

  it("keeps the underlying sharp failure as the error cause", async () => {
    const corrupt = Buffer.from("definitely not an image");

    const error = await generateWatermarkedPreview(corrupt).catch((e) => e);

    expect(error).toBeInstanceOf(WatermarkError);
    expect((error as WatermarkError).cause).toBeInstanceOf(Error);
  });
});

describe("resolveWatermarkText", () => {
  it("falls back to the built-in default when unset or blank", () => {
    expect(resolveWatermarkText()).toBe("ugcportal");
    process.env.WATERMARK_TEXT = "   ";
    expect(resolveWatermarkText()).toBe("ugcportal");
  });

  it("prefers an explicit override over the environment", () => {
    process.env.WATERMARK_TEXT = "from env";
    expect(resolveWatermarkText("override")).toBe("override");
  });

  it("truncates an absurdly long value", () => {
    process.env.WATERMARK_TEXT = "x".repeat(500);
    expect(resolveWatermarkText().length).toBe(40);
  });
});
