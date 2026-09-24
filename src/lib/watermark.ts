import sharp from "sharp";

// Longest-edge cap for a generated preview.
//
// A watermarked copy at the original's full resolution is nearly as valuable
// as the original itself, which would undermine the paid-original model
// (ugcportal-5d6) even with a mark on it. 1280px is large enough to look good
// in a gallery lightbox on a normal screen, and far below what a modern
// camera or phone produces (typically 3000-6000px), so the buyer is still
// paying for something the browser never handed out.
export const PREVIEW_MAX_DIMENSION = 1280;

// One normalised output format for every preview, whatever the source was
// (JPEG/PNG/WebP/GIF). The gallery then never has to branch on format, and a
// preview's content type is a constant. WebP at q78 is a good size/quality
// trade-off and is supported by every browser we target.
export const PREVIEW_QUALITY = 78;
export const PREVIEW_CONTENT_TYPE = "image/webp";
export const PREVIEW_FILE_EXTENSION = ".webp";

// Decompression-bomb guard. A 10 MB PNG (our image upload cap, see
// src/lib/media.ts) can legitimately be a few megapixels, but can also be
// crafted to decode to billions of them. sharp's own default is ~268 MP,
// far more than any real upload needs; 50 MP still covers every consumer
// camera while capping worst-case decode memory at a few hundred MB rather
// than tens of GB.
export const MAX_INPUT_PIXELS = 50_000_000;

// Fallback when WATERMARK_TEXT is unset. Documented in env.example.
const DEFAULT_WATERMARK_TEXT = "ugcportal";

// Cap on the configured text so a silly-long value can't turn every preview
// into an unreadable smear (and can't blow up the generated SVG).
const MAX_WATERMARK_TEXT_LENGTH = 40;

/**
 * Thrown when a preview cannot be produced — an undecodable/corrupt file, an
 * input over the pixel limit, or any other sharp failure. Callers must treat
 * this as fatal for the upload: see the failure policy in
 * src/app/api/media/route.ts. Never fall back to serving the original.
 */
export class WatermarkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WatermarkError";
  }
}

export interface PreviewResult {
  data: Buffer;
  contentType: string;
  width: number;
  height: number;
}

export interface PreviewOptions {
  /** Overrides WATERMARK_TEXT / the built-in default. */
  text?: string;
  /** Overrides MAX_INPUT_PIXELS. Exposed mainly so tests can drive the guard. */
  limitInputPixels?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function resolveWatermarkText(override?: string): string {
  const raw = (override ?? process.env.WATERMARK_TEXT ?? "").trim();
  const text = raw.length > 0 ? raw : DEFAULT_WATERMARK_TEXT;
  return text.slice(0, MAX_WATERMARK_TEXT_LENGTH);
}

/**
 * An SVG the exact size of the preview, filled edge to edge with a rotated,
 * tiled, semi-transparent repeat of the watermark text.
 *
 * Tiled and rotated on purpose: a single small corner mark is not protection,
 * because one crop removes it and leaves a clean image. Covering the whole
 * frame diagonally means any crop large enough to be worth stealing still
 * carries the mark.
 *
 * White text with a thin dark outline so it stays visible over both light and
 * dark photographs, at an opacity low enough to leave the image readable.
 *
 * The tile also draws a hairline rule. libvips ships no font files of its own
 * — it renders text through whatever fontconfig finds on the host — so on a
 * bare container image the text could silently render as nothing. The hairline
 * needs no font, so in that (misconfigured) case the overlay degrades to a
 * visible diagonal grid instead of to an unmarked image. The Dockerfile
 * installs a font so this stays a backstop, not the main event.
 */
function buildWatermarkSvg(width: number, height: number, text: string): string {
  const safeText = escapeXml(text);
  const fontSize = Math.min(
    48,
    Math.max(14, Math.round(Math.min(width, height) * 0.045)),
  );
  // librsvg can't be asked to measure text for us, so estimate the advance
  // width from the glyph count; 0.62em per character is a fair average for a
  // sans-serif face and only affects tile spacing.
  const estimatedTextWidth = Math.max(1, text.length) * fontSize * 0.62;
  const tileWidth = Math.round(estimatedTextWidth * 1.8);
  const tileHeight = Math.round(fontSize * 4);
  const strokeWidth = Math.max(1, fontSize / 24);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <pattern id="wm" width="${tileWidth}" height="${tileHeight}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <line x1="0" y1="${tileHeight}" x2="${tileWidth}" y2="${tileHeight}" stroke="white" stroke-opacity="0.10" stroke-width="1" />
      <g font-family="DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" fill="white" fill-opacity="0.34" stroke="black" stroke-opacity="0.18" stroke-width="${strokeWidth}" paint-order="stroke">
        <text x="0" y="${fontSize}">${safeText}</text>
        <text x="${Math.round(tileWidth / 2)}" y="${Math.round(tileHeight / 2 + fontSize)}">${safeText}</text>
      </g>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#wm)" />
</svg>`;
}

/**
 * Turn uploaded image bytes into a downscaled, watermarked preview.
 *
 * Images only. Video is deferred to ugcportal-pmb (watermarked poster frame),
 * so callers must not hand video bytes to this function.
 *
 * Throws {@link WatermarkError} rather than returning a partial result: there
 * is deliberately no "return the input unchanged" path, because that would put
 * an unwatermarked original into the slot the gallery reads from.
 */
export async function generateWatermarkedPreview(
  input: Buffer,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  const text = resolveWatermarkText(options.text);
  const limitInputPixels = options.limitInputPixels ?? MAX_INPUT_PIXELS;

  try {
    // Pass 1: normalise orientation and downscale. `animated` is left off, so
    // an animated GIF/WebP collapses to its first frame — a still preview is
    // all the gallery shows today. Metadata (EXIF, GPS, ...) is dropped
    // because we never call withMetadata().
    const { data: pixels, info } = await sharp(input, {
      limitInputPixels,
      // Reject genuinely broken files but tolerate the merely sloppy ones
      // (truncated trailing bytes, odd markers) that sharp's default
      // "warning" threshold would refuse — with a fail-closed upload policy,
      // being stricter than that rejects legitimate uploads.
      failOn: "error",
    })
      .rotate()
      .resize({
        width: PREVIEW_MAX_DIMENSION,
        height: PREVIEW_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Pass 2: composite the overlay, sized to the actual downscaled frame,
    // then encode. Going through raw pixels avoids a throwaway lossy re-encode
    // between the two passes.
    const data = await sharp(pixels, {
      raw: {
        width: info.width,
        height: info.height,
        channels: info.channels,
      },
    })
      .composite([
        { input: Buffer.from(buildWatermarkSvg(info.width, info.height, text)) },
      ])
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer();

    return {
      data,
      contentType: PREVIEW_CONTENT_TYPE,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    throw new WatermarkError("Failed to generate a watermarked preview", {
      cause: error,
    });
  }
}
