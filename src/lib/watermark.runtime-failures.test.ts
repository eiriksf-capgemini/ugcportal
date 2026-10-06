import { beforeEach, describe, expect, it, vi } from "vitest";

import sharp from "sharp";

/**
 * What the watermark service does when the *runtime* misbehaves, as opposed to
 * when the uploaded file is bad (that lives in watermark.test.ts).
 *
 * Separate file for two reasons: it mocks sharp, and the font probe memoises
 * in module scope — the main suite warms that cache on its first render, which
 * would make the retry behaviour here unreachable. vitest gives each test file
 * a fresh module registry.
 */

const sharpBehaviour = {
  /** Fail the next N sharp() calls, whatever they are. */
  failNextCalls: 0,
  /** Fail only calls that pass raw pixel input, which is uniquely pass 2. */
  failRawInput: false,
  /**
   * Make the font probe succeed but produce a fully transparent raster — what
   * a container with no fonts installed actually looks like, which is
   * otherwise impossible to reproduce on a host that has them.
   */
  blankProbe: false,
};

/** Minimal stand-in for the exact chain probeFont() uses. */
function blankProbePipeline() {
  const transparent = {
    data: Buffer.alloc(96 * 48 * 4),
    info: { width: 96, height: 48, channels: 4 },
  };
  return {
    composite: () => ({
      raw: () => ({ toBuffer: async () => transparent }),
    }),
  };
}

vi.mock("sharp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sharp")>();
  const real = actual.default as unknown as (...args: unknown[]) => unknown;

  const wrapped = (...args: unknown[]) => {
    const options = args[1] as Record<string, unknown> | undefined;
    const input = args[0] as Record<string, unknown> | undefined;
    const isProbe =
      options === undefined &&
      typeof input === "object" &&
      input !== null &&
      "create" in input;

    if (sharpBehaviour.blankProbe && isProbe) {
      return blankProbePipeline();
    }
    if (sharpBehaviour.failRawInput && options && "raw" in options) {
      // What a libvips built without WebP save, or an encoder fault, looks
      // like from here.
      throw new Error("vips: no suitable save operation");
    }
    if (sharpBehaviour.failNextCalls > 0) {
      sharpBehaviour.failNextCalls -= 1;
      // Stands in for anything that can make a rasterisation attempt fail
      // without the font situation having changed — an allocation blip, a
      // transient native error.
      throw new Error("transient native failure");
    }
    return real(...args);
  };
  Object.assign(wrapped, actual.default);

  return { ...actual, default: wrapped };
});

const {
  WatermarkError,
  WatermarkFontUnavailableError,
  assertWatermarkFontAvailable,
  generateWatermarkedPreview,
} = await import("@/lib/watermark");

async function buildSourcePng(): Promise<Buffer> {
  sharpBehaviour.failNextCalls = 0;
  sharpBehaviour.failRawInput = false;
  sharpBehaviour.blankProbe = false;
  return sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 120, g: 120, b: 120 },
    },
  })
    .png()
    .toBuffer();
}

beforeEach(() => {
  sharpBehaviour.failNextCalls = 0;
  sharpBehaviour.failRawInput = false;
  sharpBehaviour.blankProbe = false;
});

// Declaration order matters here: the probe memoises success, so the tests
// that need it to fail have to run before the ones that warm the cache. Both
// failing tests leave the cache cleared, which is itself the behaviour under
// test in the first one.
// ugcportal-9faa: assertWatermarkFontAvailable() runs a real libvips font
// probe (sharp), and the second test below calls it twice end to end —
// inherent image-processing cost (816ms unloaded), not redundant work.
// Explicit timeout, not a bigger global default.
describe("assertWatermarkFontAvailable", { timeout: 15_000 }, () => {
  it("says to install a font when text rasterises to nothing", async () => {
    // The fontless-container case: the probe runs fine and simply produces no
    // glyphs. Here the font advice is the correct advice, and there is no
    // underlying error to attach.
    sharpBehaviour.blankProbe = true;

    const error = await assertWatermarkFontAvailable().catch((e) => e);

    expect(error).toBeInstanceOf(WatermarkFontUnavailableError);
    expect((error as Error).message).toContain("install a font package");
    expect((error as Error).message).toContain("rasterised to nothing");
    expect((error as Error).cause).toBeUndefined();
  });

  it("reports a transient probe failure as such, with its cause, and retries", async () => {
    sharpBehaviour.failNextCalls = 1;

    const error = await assertWatermarkFontAvailable().catch((e) => e);

    expect(error).toBeInstanceOf(WatermarkFontUnavailableError);
    // Swallowing the rejection is how an allocation blip ends up advising a
    // font install: the operator installs fonts, redeploys, and gets the exact
    // same message back.
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("install a font package");
    expect((error as Error).message).toContain("probe itself failed");

    // The blip is over. Memoising the failure would make every subsequent
    // upload a 500 until the process restarted.
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();
  });

  it("memoises success, so a later blip can't retroactively break it", async () => {
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();

    // Whether a font is installed cannot change under a running process, so
    // the cached true result must be served without re-probing.
    sharpBehaviour.failNextCalls = 5;
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();
    expect(sharpBehaviour.failNextCalls).toBe(5);
  });
});

describe("generateWatermarkedPreview error taxonomy", () => {
  it("blames the file when decoding the upload fails", async () => {
    await expect(
      generateWatermarkedPreview(Buffer.from("definitely not an image")),
    ).rejects.toBeInstanceOf(WatermarkError);
  });

  it("does not blame the file when the overlay/encode stage fails", async () => {
    // WatermarkError is precisely what the route turns into a 422, so it has
    // to mean "this upload is bad" and nothing else. Pass 2 consumes raw
    // pixels we produced against an SVG we generated - nothing the uploader
    // controls. A libvips without WebP save would otherwise answer 100% of
    // uploads with 422 and never register as a 5xx anywhere in alerting.
    const source = await buildSourcePng();
    sharpBehaviour.failRawInput = true;

    const error = await generateWatermarkedPreview(source).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WatermarkError);
    expect((error as Error).message).toContain("no suitable save operation");
  });
});
