import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lives in its own file because the font probe's memoisation is module-level
 * state, and vitest gives each test file a fresh module registry. The main
 * watermark suite warms that cache on its first render, which would make the
 * behaviour under test here unreachable.
 */

const sharpFailures = { remaining: 0 };

vi.mock("sharp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sharp")>();
  const real = actual.default;
  const wrapped = (...args: unknown[]) => {
    if (sharpFailures.remaining > 0) {
      sharpFailures.remaining -= 1;
      // Stands in for anything that can make a rasterisation attempt fail
      // without the font situation having changed — an allocation blip, a
      // transient native error.
      throw new Error("transient native failure");
    }
    return (real as unknown as (...a: unknown[]) => unknown)(...args);
  };
  Object.assign(wrapped, real);
  return { ...actual, default: wrapped };
});

const { WatermarkFontUnavailableError, assertWatermarkFontAvailable } =
  await import("@/lib/watermark");

beforeEach(() => {
  sharpFailures.remaining = 0;
});

describe("assertWatermarkFontAvailable", () => {
  it("recovers after a transient probe failure instead of failing forever", async () => {
    sharpFailures.remaining = 1;

    await expect(assertWatermarkFontAvailable()).rejects.toBeInstanceOf(
      WatermarkFontUnavailableError,
    );

    // The blip is over. Memoising the failure would make every subsequent
    // upload a 500 — with a misleading "install a font package" in the log —
    // until the process restarted.
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();
  });

  it("memoises success, so a later blip can't retroactively break it", async () => {
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();

    // Whether a font is installed cannot change under a running process, so
    // the cached true result must be served without re-probing.
    sharpFailures.remaining = 5;
    await expect(assertWatermarkFontAvailable()).resolves.toBeUndefined();
    expect(sharpFailures.remaining).toBe(5);
  });
});
