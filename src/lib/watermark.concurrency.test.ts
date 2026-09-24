import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryBudget } from "@/lib/memory-budget";
import {
  MAX_DERIVED_CONCURRENCY,
  MAX_SHARP_THREADS_PER_OPERATION,
  PREVIEW_CONTENT_TYPE,
  WatermarkOverloadedError,
  generateWatermarkedPreview,
  resetWatermarkConcurrencyGate,
  resolveSharpThreads,
  resolveWatermarkConcurrencySettings,
  watermarkConcurrencyStats,
} from "@/lib/watermark";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function budget(bytes: number): MemoryBudget {
  return { bytes, source: "cgroup-v2" };
}

describe("resolveWatermarkConcurrencySettings", () => {
  it("derives the limit from the memory budget, not from a guess", () => {
    // 320 MB reserved for the process, 128 MB per in-flight preview.
    expect(
      resolveWatermarkConcurrencySettings({}, budget(512 * MiB), 8).limit,
    ).toBe(1);
    expect(resolveWatermarkConcurrencySettings({}, budget(GiB), 8).limit).toBe(
      5,
    );
    expect(
      resolveWatermarkConcurrencySettings({}, budget(2 * GiB), 8).limit,
    ).toBe(MAX_DERIVED_CONCURRENCY);
  });

  it("never derives a limit below 1, however small the container", () => {
    // A container too small to fit even one preview is misconfigured, but
    // refusing every upload is a worse answer than trying and letting the
    // kernel decide.
    const settings = resolveWatermarkConcurrencySettings({}, budget(64 * MiB), 8);
    expect(settings.limit).toBe(1);
    expect(settings.limitSource).toBe("derived");
  });

  it("caps the derived limit however much memory there is", () => {
    expect(
      resolveWatermarkConcurrencySettings({}, budget(256 * GiB), 64).limit,
    ).toBe(MAX_DERIVED_CONCURRENCY);
  });

  it("lets WATERMARK_MAX_CONCURRENCY override the derivation", () => {
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "3" },
      budget(64 * GiB),
      8,
    );
    expect(settings.limit).toBe(3);
    expect(settings.limitSource).toBe("env");
    // The queue default tracks whatever limit won.
    expect(settings.queueLimit).toBe(12);
  });

  it("ignores junk env values rather than failing every upload", () => {
    for (const raw of ["", "  ", "0", "-2", "3.5", "lots"]) {
      const settings = resolveWatermarkConcurrencySettings(
        { WATERMARK_MAX_CONCURRENCY: raw },
        budget(GiB),
        8,
      );
      expect(settings.limit).toBe(5);
      expect(settings.limitSource).toBe("derived");
    }
  });

  it("allows an explicit queue depth of zero (pure load shedding)", () => {
    expect(
      resolveWatermarkConcurrencySettings(
        { WATERMARK_QUEUE_LIMIT: "0" },
        budget(GiB),
        8,
      ).queueLimit,
    ).toBe(0);
  });

  it("carries the budget's provenance through, so 'host' is visible", () => {
    const settings = resolveWatermarkConcurrencySettings(
      {},
      { bytes: GiB, source: "host" },
      8,
    );
    expect(settings.budgetSource).toBe("host");
    expect(settings.budgetBytes).toBe(GiB);
  });
});

describe("resolveSharpThreads", () => {
  it("divides the cores across the in-flight previews", () => {
    // The gate already provides image-level parallelism; per-image thread
    // pools on top of it multiply memory without adding throughput.
    expect(resolveSharpThreads(8, 8)).toBe(1);
    expect(resolveSharpThreads(4, 8)).toBe(2);
    expect(resolveSharpThreads(1, 2)).toBe(2);
  });

  it("caps per-image threads so a big host cannot inflate them", () => {
    // libvips reads the core count from the machine, not the cgroup's CPU
    // quota, so a small container on a 64-core host would otherwise default
    // to 64 threads per image.
    expect(resolveSharpThreads(1, 64)).toBe(MAX_SHARP_THREADS_PER_OPERATION);
  });

  it("never drops below one thread", () => {
    expect(resolveSharpThreads(8, 1)).toBe(1);
  });

  it("honours an explicit override", () => {
    expect(resolveSharpThreads(8, 8, 3)).toBe(3);
  });
});

/**
 * End-to-end: the settings and the standalone gate tests
 * (src/lib/concurrency-gate.test.ts) are worth nothing unless
 * generateWatermarkedPreview actually goes through the gate. These drive the
 * real function with real sharp.
 */
describe("generateWatermarkedPreview under concurrency", () => {
  const env = { ...process.env };

  beforeEach(() => {
    resetWatermarkConcurrencyGate();
  });

  afterEach(() => {
    process.env = { ...env };
    resetWatermarkConcurrencyGate();
    // Undo the process-global thread pinning these tests applied.
    sharp.concurrency(0);
  });

  async function source(): Promise<Buffer> {
    return sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: 90, g: 120, b: 150 },
      },
    })
      .png()
      .toBuffer();
  }

  it("holds in-flight previews at the configured limit (K1)", async () => {
    process.env.WATERMARK_MAX_CONCURRENCY = "2";
    process.env.WATERMARK_QUEUE_LIMIT = "20";
    process.env.WATERMARK_QUEUE_TIMEOUT_MS = "30000";
    resetWatermarkConcurrencyGate();

    const input = await source();

    // Sampled from outside the gate while eight previews race, so the peak
    // reported here is an observation rather than the gate's own opinion of
    // itself. The authoritative instrumented-worker assertion is the one in
    // concurrency-gate.test.ts; this exists to prove the wiring.
    let observedPeak = 0;
    const sampler = setInterval(() => {
      const { inFlight } = watermarkConcurrencyStats();
      if (inFlight > observedPeak) observedPeak = inFlight;
    }, 1);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => generateWatermarkedPreview(input)),
    );
    clearInterval(sampler);

    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.contentType).toBe(PREVIEW_CONTENT_TYPE);
      expect(result.data.byteLength).toBeGreaterThan(0);
    }

    const stats = watermarkConcurrencyStats();
    expect(stats.settings.limit).toBe(2);
    expect(stats.peakInFlight).toBe(2);
    expect(observedPeak).toBeGreaterThan(0);
    expect(observedPeak).toBeLessThanOrEqual(2);
    expect(stats.inFlight).toBe(0);
    expect(stats.shed).toBe(0);
    expect(stats.admitted).toBe(8);
  });

  it("sheds with a retryable error once the queue is full (K2)", async () => {
    // Limit 1, no queue at all: the second concurrent caller has nowhere to
    // wait and must fail fast rather than hang.
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "0";
    resetWatermarkConcurrencyGate();

    const input = await source();
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => generateWatermarkedPreview(input)),
    );

    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const result of rejected) {
      const error = result.reason as WatermarkOverloadedError;
      expect(error).toBeInstanceOf(WatermarkOverloadedError);
      expect(error.reason).toBe("queue-full");
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
    }
    // Not a WatermarkError: the file is fine, the server is busy. The upload
    // route keys on that distinction to decide 4xx vs 5xx.
    expect(rejected[0].reason).not.toHaveProperty("name", "WatermarkError");
    expect(settled.filter((r) => r.status === "fulfilled").length).toBe(
      settled.length - rejected.length,
    );
  });

  it("gives up on a queued caller at the timeout instead of hanging (K2)", async () => {
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "10";
    process.env.WATERMARK_QUEUE_TIMEOUT_MS = "1";
    resetWatermarkConcurrencyGate();

    const input = await source();
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => generateWatermarkedPreview(input)),
    );

    const timedOut = settled.filter(
      (r) =>
        r.status === "rejected" &&
        (r.reason as WatermarkOverloadedError).reason === "timeout",
    );
    expect(timedOut.length).toBeGreaterThan(0);
    expect(watermarkConcurrencyStats().inFlight).toBe(0);
  });

  it("queues rather than sheds when there is room to wait", async () => {
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "10";
    process.env.WATERMARK_QUEUE_TIMEOUT_MS = "30000";
    resetWatermarkConcurrencyGate();

    const input = await source();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => generateWatermarkedPreview(input)),
    );

    expect(results).toHaveLength(5);
    const stats = watermarkConcurrencyStats();
    expect(stats.shed).toBe(0);
    expect(stats.peakInFlight).toBe(1);
  });

  it("pins libvips threads when it builds the gate", () => {
    process.env.WATERMARK_SHARP_THREADS = "2";
    resetWatermarkConcurrencyGate();

    expect(watermarkConcurrencyStats().settings.sharpThreads).toBe(2);
    expect(sharp.concurrency()).toBe(2);
  });
});
