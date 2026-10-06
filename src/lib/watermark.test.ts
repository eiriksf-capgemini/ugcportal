import sharp from "sharp";
import type { MockInstance } from "vitest";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MAX_INPUT_PIXELS,
  PREVIEW_CONTENT_TYPE,
  PREVIEW_MAX_DIMENSION,
  PREVIEW_MAX_SCALE,
  PREVIEW_QUALITY,
  WatermarkError,
  assertWatermarkFontAvailable,
  buildWatermarkOverlaySvg,
  generateWatermarkedPreview,
  resetWatermarkConcurrencyGate,
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
  const { width = 0, height = 0 } = await sharp(source).metadata();
  const target = Math.max(
    1,
    Math.min(
      PREVIEW_MAX_DIMENSION,
      Math.round(Math.max(width, height) * PREVIEW_MAX_SCALE),
    ),
  );
  return sharp(source)
    .rotate()
    .resize({
      width: target,
      height: target,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: PREVIEW_QUALITY })
    .toBuffer();
}

// WebP is lossy, so identical inputs still differ by a point or two. Only
// count a pixel as marked once it moves well past that noise floor. Every
// claim in this file about "the watermark is visible" is made at this
// threshold, including the fontless-backstop check.
const NOISE_TOLERANCE = 12;

/** Per-pixel comparison of two same-sized images, decoded back to RGB. */
async function diffPixels(a: Buffer, b: Buffer) {
  const [left, right] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  expect(left.info.width).toBe(right.info.width);
  expect(left.info.height).toBe(right.info.height);

  const { width, height, channels } = left.info;
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

let infoSpy: MockInstance;
let warnSpy: MockInstance;

/**
 * Pin the concurrency gate, so these tests are about watermarking.
 *
 * generateWatermarkedPreview goes through the gate (ugcportal-e86), and the
 * gate sizes itself from the container's memory budget. Without this, tests
 * here that run two previews at once would pass or fail depending on how
 * much memory the machine has: on a small container the derivation lands on
 * limit 1 with a queue of 0, and a second concurrent call is shed with "Too
 * many previews are being generated right now" — a failure with nothing to
 * do with what any of these tests are checking. Reproduced with
 * `WATERMARK_MEMORY_BUDGET_MB=512`.
 *
 * Limit 1 rather than something larger, deliberately: it is the only value
 * that can never be clamped (so no warning is logged) whatever the host's
 * libuv pool size is. The generous queue is what makes concurrency here a
 * latency detail rather than a pass/fail condition — nothing is ever shed.
 *
 * Set per test rather than once: vitest.setup.ts scrubs these before every
 * test precisely so no file inherits them from the host, and its hook runs
 * before this one. Re-pinning here is what makes this file's intent win over
 * that scrub without weakening it for everyone else.
 */
beforeEach(() => {
  // Rebuilding the gate per test means it logs its configuration per test,
  // and on a workstation with no cgroup the budget comes from host RAM, so
  // it takes the warn branch: one "no container memory limit found" line per
  // test, in a file with nothing to say about container sizing. Captured
  // rather than printed — watermark.concurrency.test.ts, which does assert
  // on that line, spies the same way.
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.WATERMARK_MAX_CONCURRENCY = "1";
  process.env.WATERMARK_QUEUE_LIMIT = "64";
  // One libvips thread per preview, for the same reason: vitest runs test
  // files in parallel, and the default (cores / limit, so 4 here) would have
  // this file ask for more threads than the configuration it replaced. A
  // test suite wants its resource use predictable, not maximal.
  process.env.WATERMARK_SHARP_THREADS = "1";
  resetWatermarkConcurrencyGate();
});

afterAll(() => {
  resetWatermarkConcurrencyGate();
  // Deliberately not sharp.concurrency(0): 0 means "one thread per core",
  // which is the heaviest possible setting and would be inherited by
  // whatever test file shares this process next. Leave it low.
  sharp.concurrency(1);
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  delete process.env.WATERMARK_TEXT;
});

// ugcportal-9faa: real libvips image processing (sharp) throughout —
// several cases build and compare multiple full-size source/preview images
// (burning in a watermark, comparing pixels, re-encoding). Measured
// unloaded, the slowest individual cases here already ran up to ~2.1s;
// under machine load, sharp directly competes with everything else for the
// same CPU threads, so this is inherent cost (the "image processing"
// category that bead names), not redundant work there is anything to
// cache. Explicit timeout, not a bigger global default.
describe("generateWatermarkedPreview", { timeout: 15_000 }, () => {
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

  /**
   * The overlay has to actually mark the image (not merely re-encode it) and
   * it has to be everywhere, so that no single crop removes it — a corner
   * stamp would light up one quadrant and leave the other three untouched.
   */
  function expectFullFrameCoverage(diff: Awaited<ReturnType<typeof diffPixels>>) {
    const { changed, total, quadrants } = diff;
    expect(changed / total).toBeGreaterThan(0.02);
    const perQuadrantFloor = (total / 4) * 0.01;
    expect(quadrants.topLeft).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.topRight).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.bottomLeft).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.bottomRight).toBeGreaterThan(perQuadrantFloor);
  }

  it.each([
    ["well above the cap", 2400, 1600],
    // The case the cap alone misses: at or below PREVIEW_MAX_DIMENSION,
    // `withoutEnlargement` means no downscale happens at all, so a preview
    // would come back at the original's exact resolution and the only thing
    // the buyer would be paying to remove is the mark.
    ["just below the cap", 1200, 800],
    ["far below the cap", 200, 150],
  ])(
    "always returns a preview strictly smaller than the original (%s)",
    async (_label, width, height) => {
      const source = await sharp({
        create: { width, height, channels: 3, background: SOURCE_COLOR },
      })
        .png()
        .toBuffer();

      const preview = await generateWatermarkedPreview(source);

      expect(preview.width).toBeLessThan(width);
      expect(preview.height).toBeLessThan(height);
      expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(
        PREVIEW_MAX_DIMENSION,
      );
      expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(
        Math.round(Math.max(width, height) * PREVIEW_MAX_SCALE),
      );
    },
  );

  it("still produces a valid preview for a 1x1 original", async () => {
    // Degenerate end of the scale floor: 1 * 0.75 rounds to 1, and the clamp
    // must keep it at 1 rather than 0.
    const source = await sharp({
      create: { width: 1, height: 1, channels: 3, background: SOURCE_COLOR },
    })
      .png()
      .toBuffer();

    const preview = await generateWatermarkedPreview(source);

    expect(preview.width).toBe(1);
    expect(preview.height).toBe(1);
    await expect(sharp(preview.data).metadata()).resolves.toMatchObject({
      format: "webp",
    });
  });

  it("burns a watermark into the pixels, spread across the whole frame (K1)", async () => {
    const source = await buildSourcePng();

    const preview = await generateWatermarkedPreview(source);
    const baseline = await buildUnwatermarkedBaseline(source);

    expectFullFrameCoverage(await diffPixels(preview.data, baseline));
  });

  it.each([
    ["the default", undefined],
    ["a long brand name", "Some Rather Long Studio Name"],
    // The cap resolveWatermarkText enforces, i.e. the worst case a deployment
    // can actually configure. Tile width scales with glyph count, so without
    // shrink-to-fit this length makes the tile wider than the frame and the
    // diagonal repeat collapses to one or two isolated runs.
    ["the maximum-length text", "W".repeat(40)],
  ])("keeps full-frame coverage with %s", async (_label, text) => {
    const source = await buildSourcePng();

    const preview = await generateWatermarkedPreview(source, { text });
    const baseline = await buildUnwatermarkedBaseline(source);

    expectFullFrameCoverage(await diffPixels(preview.data, baseline));
  });

  it("repeats the mark horizontally at full preview width, even at max text length", async () => {
    // Coverage alone can be satisfied by a couple of enormous runs; this
    // checks the tile actually repeats at the configured cap.
    const svg = buildWatermarkOverlaySvg(
      PREVIEW_MAX_DIMENSION,
      853,
      "W".repeat(40),
    );
    const tileWidth = Number(/<pattern[^>]*\swidth="(\d+)"/.exec(svg)?.[1]);

    expect(tileWidth).toBeLessThan(PREVIEW_MAX_DIMENSION / 2);
  });

  it("still covers a portrait frame at max text length, where MIN_FONT_SIZE binds", async () => {
    // On a narrow frame the shrink-to-fit hits MIN_FONT_SIZE and the tile ends
    // up wider than half the width (~0.52 here), so the horizontal repeat
    // degrades. Pinned as a test because the protection must not: rotation and
    // the vertical repeat have to carry full-frame coverage regardless.
    const portrait = await sharp({
      create: {
        width: 1600,
        height: 2400,
        channels: 3,
        background: SOURCE_COLOR,
      },
    })
      .png()
      .toBuffer();
    const text = "W".repeat(40);

    const preview = await generateWatermarkedPreview(portrait, { text });
    const baseline = await buildUnwatermarkedBaseline(portrait);

    expect(preview.height).toBe(PREVIEW_MAX_DIMENSION);
    expect(preview.width).toBeLessThan(PREVIEW_MAX_DIMENSION);
    expectFullFrameCoverage(await diffPixels(preview.data, baseline));
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

  it("still marks the image when no font is available to draw the glyphs", async () => {
    // Simulates a runtime where fontconfig finds nothing: the overlay is
    // composited with every <text> element removed, leaving only the
    // font-independent rules. assertWatermarkFontAvailable should make this
    // case impossible in production, but if the overlay's own backstop is
    // worthless then a single missed check ships unprotected previews — and
    // no test running on the CI host would ever notice, because CI is not
    // the container image.
    const source = await buildSourcePng();
    const baseline = await buildUnwatermarkedBaseline(source);
    const { width, height } = await sharp(baseline).metadata();

    const glyphlessSvg = buildWatermarkOverlaySvg(
      width as number,
      height as number,
      "ugcportal",
    ).replace(/<text[\s\S]*?<\/text>/g, "");
    expect(glyphlessSvg).not.toContain("<text");

    const glyphless = await sharp(baseline)
      .composite([{ input: Buffer.from(glyphlessSvg) }])
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer();
    // Compare against the same image put through the same extra encode pass,
    // so only the overlay is being measured.
    const reencodedBaseline = await sharp(baseline)
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer();

    const { changed, total, quadrants } = await diffPixels(
      glyphless,
      reencodedBaseline,
    );

    // Must be clearly distinguishable from an unwatermarked resize at the
    // very threshold K1 uses — not merely "not byte-identical".
    expect(changed / total).toBeGreaterThan(0.02);
    const perQuadrantFloor = (total / 4) * 0.01;
    expect(quadrants.topLeft).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.topRight).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.bottomLeft).toBeGreaterThan(perQuadrantFloor);
    expect(quadrants.bottomRight).toBeGreaterThan(perQuadrantFloor);
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

  it("survives XML-illegal control characters in the configured text", async () => {
    const source = await buildSourcePng();

    // A form feed cannot be entity-escaped; interpolated raw it makes librsvg
    // reject the document ("PCDATA invalid Char value 12"), which would turn
    // one bad env var into a 422 on every single image upload.
    process.env.WATERMARK_TEXT = "studio\fname\u0000\u0008";

    const preview = await generateWatermarkedPreview(source);

    await expect(sharp(preview.data).metadata()).resolves.toMatchObject({
      format: "webp",
    });
  });

  it("requires a usable font to be installed", async () => {
    // Positive direction only — the negative case is an environment fault
    // that can't be induced here. Its value is that it runs at all: if the
    // probe itself is broken, every upload would start failing loudly rather
    // than shipping under-marked previews.
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();
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

  it("truncates by code point, never splitting an astral character", () => {
    // 39 plain characters then an emoji: a UTF-16 slice at 40 would cut the
    // surrogate pair in half and leave a lone high surrogate, which renders as
    // a stray U+FFFD tiled across every preview.
    const text = `${"x".repeat(39)}\u{1F4F7}z`;

    const resolved = resolveWatermarkText(text);

    expect([...resolved]).toHaveLength(40);
    expect(resolved.endsWith("\u{1F4F7}")).toBe(true);
    expect(resolved).not.toContain("�");
    // No unpaired surrogate survived the cut.
    expect(/[\uD800-\uDFFF]/.test(resolved.replace(/\u{1F4F7}/gu, ""))).toBe(
      false,
    );
  });

  it("removes XML-illegal control characters and collapses whitespace", () => {
    expect(resolveWatermarkText("a\fb\u0000c")).toBe("a bc");
    expect(resolveWatermarkText("two\n\tlines")).toBe("two lines");
    // Astral characters are legal XML and must survive intact.
    expect(resolveWatermarkText("studio \u{1F4F7}")).toBe("studio \u{1F4F7}");
  });

  it("falls back to the default when sanitising leaves nothing", () => {
    expect(resolveWatermarkText("\u0000\u0001\u0002")).toBe("ugcportal");
  });
});
