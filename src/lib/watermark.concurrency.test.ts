import sharp from "sharp";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CpuBudget, MemoryBudget } from "@/lib/container-limits";
import {
  IN_FLIGHT_BYTES_PER_UPLOAD,
  LIBUV_DEFAULT_THREADPOOL_SIZE,
  MAX_DERIVED_CONCURRENCY,
  MAX_QUEUE_TIMEOUT_MS,
  MAX_SHARP_THREADS_PER_OPERATION,
  MIN_VIABLE_BUDGET_BYTES,
  PREVIEW_BYTES_PER_OPERATION,
  PREVIEW_CONTENT_TYPE,
  PREVIEW_PROCESS_BASELINE_BYTES,
  UPLOAD_BODY_BYTES,
  WatermarkOverloadedError,
  describeWatermarkConcurrency,
  generateWatermarkedPreview,
  resetWatermarkConcurrencyGate,
  resolveConcurrencyCeiling,
  resolveSharpThreads,
  resolveWatermarkConcurrencySettings,
  watermarkConcurrencyStats,
} from "@/lib/watermark";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function budget(bytes: number): MemoryBudget {
  return { bytes, source: "cgroup-v2" };
}

function cpu(cpus: number): CpuBudget {
  return { cpus, source: "cgroup-v2" };
}

/**
 * The reference table, written out as literal expected values.
 *
 * Deliberately not computed from the module's own constants. The previous
 * version of the containment test rebuilt projectedPeakBytes with the same
 * expression the implementation uses, so when that expression was wrong —
 * it charged the request body to queued callers but not to running ones —
 * the test agreed with it and passed. A hand-written table cannot agree with
 * a formula it does not contain: if the derivation changes, these have to be
 * re-derived by hand and justified, which is the point.
 *
 * Worked by hand from: 320 MB baseline, 148 MB per in-flight upload (128 MB
 * decode + 20 MB body), 20 MB per queued body, ceiling 3.
 *   512 -> 192 spendable; 192/148 = 1 running (44 left -> 2 queued);
 *          320 + 148 + 40  = 508
 *   768 -> 448 spendable; 448/148 = 3 running (4 left  -> 0 queued);
 *          320 + 444 + 0   = 764
 *  1024 -> 704 spendable; capped at 3 running (260 left -> 13, capped 12);
 *          320 + 444 + 240 = 1004
 *  2048 -> ceiling-bound, identical to 1024
 */
const REFERENCE_TABLE = [
  { budgetMiB: 512, limit: 1, queueLimit: 2, projectedMiB: 508 },
  { budgetMiB: 768, limit: 3, queueLimit: 0, projectedMiB: 764 },
  { budgetMiB: 1024, limit: 3, queueLimit: 12, projectedMiB: 1004 },
  { budgetMiB: 2048, limit: 3, queueLimit: 12, projectedMiB: 1004 },
] as const;

describe("resolveWatermarkConcurrencySettings", () => {
  it("matches the documented reference table exactly", () => {
    // Literal expectations, hand-derived; see REFERENCE_TABLE. These are the
    // numbers the Dockerfile and env.example quote to operators, so drifting
    // from them silently is its own bug.
    for (const row of REFERENCE_TABLE) {
      const settings = resolveWatermarkConcurrencySettings(
        {},
        budget(row.budgetMiB * MiB),
        cpu(8),
      );
      expect({
        budgetMiB: row.budgetMiB,
        limit: settings.limit,
        queueLimit: settings.queueLimit,
        projectedMiB: settings.projectedPeakBytes / MiB,
      }).toEqual(row);
    }
  });

  it("charges the request body to running callers, not only queued ones", () => {
    // The round-3 finding. A running caller holds the same two copies of the
    // body a queued one does, and PREVIEW_BYTES_PER_OPERATION is a measured
    // delta taken with the source already resident, so it does not include
    // them. Charging queued callers only under-counted by limit x 20 MB —
    // enough for 768 MB to report 764 and fitsBudget true while really
    // committing ~824 MB.
    expect(UPLOAD_BODY_BYTES).toBe(20 * MiB);
    expect(IN_FLIGHT_BYTES_PER_UPLOAD).toBe(
      PREVIEW_BYTES_PER_OPERATION + UPLOAD_BODY_BYTES,
    );

    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "3", WATERMARK_QUEUE_LIMIT: "0" },
      budget(8 * GiB),
      cpu(8),
    );
    // 320 + 3 x 148, with no queue at all: every byte here is in-flight, so
    // an accounting that skipped running bodies would report 704 MB.
    expect(settings.projectedPeakBytes).toBe(764 * MiB);
    expect(settings.projectedPeakBytes).toBeGreaterThan(
      PREVIEW_PROCESS_BASELINE_BYTES + 3 * PREVIEW_BYTES_PER_OPERATION,
    );
  });

  it("keeps the whole configuration inside the memory budget", () => {
    // The property the reference table is a sample of: across the whole
    // plausible range, what the process commits to never exceeds what the
    // kernel will kill it for.
    for (const bytes of [512 * MiB, 640 * MiB, 768 * MiB, GiB, 2 * GiB, 8 * GiB]) {
      const settings = resolveWatermarkConcurrencySettings(
        {},
        budget(bytes),
        cpu(8),
      );
      expect(settings.projectedPeakBytes).toBeLessThanOrEqual(bytes);
      expect(settings.fitsBudget).toBe(true);
    }
  });

  it("shrinks the queue rather than the limit when memory is tight", () => {
    // 512 MB leaves 44 MB after one in-flight upload: two queued bodies, not
    // the four a fixed 4x multiple would have handed out.
    const settings = resolveWatermarkConcurrencySettings(
      {},
      budget(512 * MiB),
      cpu(8),
    );
    expect(settings.limit).toBe(1);
    expect(settings.queueLimit).toBe(2);
    expect(settings.projectedPeakBytes).toBeLessThanOrEqual(512 * MiB);
  });

  it("drops to pure shedding when nothing is left for a queue", () => {
    const settings = resolveWatermarkConcurrencySettings(
      {},
      budget(MIN_VIABLE_BUDGET_BYTES),
      cpu(8),
    );
    expect(settings.limit).toBe(1);
    expect(settings.queueLimit).toBe(0);
    expect(settings.fitsBudget).toBe(true);
  });

  it("flags a container below the one-preview floor instead of pretending", () => {
    // Clamping the limit up to 1 is the least-bad answer, but the resulting
    // configuration does not fit and the operator has to be told so.
    const settings = resolveWatermarkConcurrencySettings(
      {},
      budget(256 * MiB),
      cpu(8),
    );
    expect(settings.limit).toBe(1);
    expect(settings.queueLimit).toBe(0);
    expect(settings.fitsBudget).toBe(false);
    expect(settings.projectedPeakBytes).toBeGreaterThan(256 * MiB);
  });

  it("is bounded by the libuv worker pool, not by memory, on a big container", () => {
    // Above ~1 GB the binding constraint stops being memory: an in-flight
    // preview holds a libuv worker for its whole duration, and slots past the
    // pool size would just queue inside libuv where this gate cannot see
    // them, with one worker left free for dns.lookup and async fs.
    const big = resolveWatermarkConcurrencySettings({}, budget(8 * GiB), cpu(64));
    expect(big.limit).toBe(LIBUV_DEFAULT_THREADPOOL_SIZE - 1);

    const roomier = resolveWatermarkConcurrencySettings(
      { UV_THREADPOOL_SIZE: "16" },
      budget(8 * GiB),
      cpu(64),
    );
    expect(roomier.limit).toBe(MAX_DERIVED_CONCURRENCY);
  });

  it("never derives a limit below 1, however small the container", () => {
    // A container too small to fit even one preview is misconfigured, but
    // refusing every upload is a worse answer than trying and letting the
    // kernel decide.
    const settings = resolveWatermarkConcurrencySettings(
      {},
      budget(64 * MiB),
      cpu(8),
    );
    expect(settings.limit).toBe(1);
    expect(settings.limitSource).toBe("derived");
  });

  it("clamps WATERMARK_MAX_CONCURRENCY to the libuv pool and says so", () => {
    // Round-4 finding 1. Admitting 8 sharp operations onto a 4-worker pool
    // does not run 8 of them; it parks the surplus in libuv's own uncapped,
    // invisible queue and starves the dns.lookup for the S3 upload that
    // follows every preview — the failure the ceiling was added to prevent.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "8" },
      budget(8 * GiB),
      cpu(8),
    );
    expect(settings.limit).toBe(LIBUV_DEFAULT_THREADPOOL_SIZE - 1);
    expect(settings.limitSource).toBe("env");
    expect(settings.clamped).toHaveLength(1);
    expect(settings.clamped[0]).toContain("WATERMARK_MAX_CONCURRENCY=8");
    expect(settings.clamped[0]).toContain("UV_THREADPOOL_SIZE");
  });

  it("honours WATERMARK_MAX_CONCURRENCY when the pool can back it", () => {
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "6", UV_THREADPOOL_SIZE: "8" },
      budget(8 * GiB),
      cpu(8),
    );
    expect(settings.limit).toBe(6);
    expect(settings.clamped).toEqual([]);
  });

  it("clamps WATERMARK_SHARP_THREADS so the budget stays meaningful", () => {
    // Round-4 finding 3. 64 threads per preview invalidates the measured
    // per-operation figure the whole projection rests on.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_SHARP_THREADS: "64" },
      budget(GiB),
      cpu(8),
    );
    expect(settings.sharpThreads).toBe(MAX_SHARP_THREADS_PER_OPERATION);
    expect(settings.clamped[0]).toContain("WATERMARK_SHARP_THREADS=64");
  });

  it("clamps WATERMARK_QUEUE_TIMEOUT_MS so the wait stays bounded", () => {
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_QUEUE_TIMEOUT_MS: "3600000" },
      budget(GiB),
      cpu(8),
    );
    expect(settings.queueTimeoutMs).toBe(MAX_QUEUE_TIMEOUT_MS);
    expect(settings.clamped[0]).toContain("WATERMARK_QUEUE_TIMEOUT_MS=3600000");
  });

  it("does not clamp WATERMARK_QUEUE_LIMIT, but does count it", () => {
    // The other half of the rule: the queue's only cost is memory, and
    // fitsBudget is what memory claims are supposed to be checked against.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_QUEUE_LIMIT: "512" },
      budget(GiB),
      cpu(8),
    );
    expect(settings.queueLimit).toBe(512);
    expect(settings.clamped).toEqual([]);
    expect(settings.projectedPeakBytes).toBe(
      PREVIEW_PROCESS_BASELINE_BYTES +
        3 * IN_FLIGHT_BYTES_PER_UPLOAD +
        512 * UPLOAD_BODY_BYTES,
    );
    expect(settings.fitsBudget).toBe(false);
  });

  it("lets WATERMARK_MEMORY_BUDGET_MB escape an invisible cgroup limit", () => {
    // Round-4 finding 2. The documented escape hatch has to fix the *budget*,
    // not just the limit: a 512 MB container on a 64 GB host that overrode
    // only WATERMARK_MAX_CONCURRENCY still had its queue sized from 64 GB,
    // committed ~1004 MB, and reported fitsBudget true — the one scenario
    // the knob exists for was the one it did not cover.
    const hostRam = 64 * GiB;
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MEMORY_BUDGET_MB: "512" },
      { bytes: hostRam, source: "host" },
      cpu(8),
      hostRam,
    );
    expect(settings.budgetBytes).toBe(512 * MiB);
    expect(settings.budgetSource).toBe("env");
    expect(settings.limit).toBe(1);
    expect(settings.queueLimit).toBe(2);
    expect(settings.projectedPeakBytes).toBe(508 * MiB);
    expect(settings.fitsBudget).toBe(true);
  });

  it("reports over-budget rather than shrinking an explicit limit", () => {
    // The other side of "never clamped to the memory budget": an operator
    // who insists on 3 concurrent previews in a 512 MB container gets them,
    // gets no queue (there is nothing left to give it), and gets told the
    // configuration does not fit — rather than quietly getting 1.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "3" },
      budget(512 * MiB),
      cpu(8),
    );
    expect(settings.limit).toBe(3);
    expect(settings.queueLimit).toBe(0);
    expect(settings.clamped).toEqual([]);
    expect(settings.fitsBudget).toBe(false);
    expect(settings.projectedPeakBytes).toBe(764 * MiB);
  });

  it("will not accept a budget larger than the machine", () => {
    const hostRam = 8 * GiB;
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MEMORY_BUDGET_MB: "999999" },
      { bytes: hostRam, source: "host" },
      cpu(8),
      hostRam,
    );
    expect(settings.budgetBytes).toBe(hostRam);
    expect(settings.clamped[0]).toContain("more memory than the machine has");
  });

  it("lets WATERMARK_MAX_CONCURRENCY override the derivation", () => {
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "3" },
      budget(64 * GiB),
      cpu(8),
    );
    expect(settings.limit).toBe(3);
    expect(settings.limitSource).toBe("env");
    // The queue default still tracks whatever limit won, and is still capped
    // by what is left of the budget.
    expect(settings.queueLimit).toBe(12);
  });

  it("ignores junk env values rather than failing every upload", () => {
    for (const raw of ["", "  ", "0", "-2", "3.5", "lots"]) {
      const settings = resolveWatermarkConcurrencySettings(
        { WATERMARK_MAX_CONCURRENCY: raw },
        budget(GiB),
        cpu(8),
      );
      expect(settings.limit).toBe(3);
      expect(settings.limitSource).toBe("derived");
    }
  });

  it("allows an explicit queue depth of zero (pure load shedding)", () => {
    expect(
      resolveWatermarkConcurrencySettings(
        { WATERMARK_QUEUE_LIMIT: "0" },
        budget(GiB),
        cpu(8),
      ).queueLimit,
    ).toBe(0);
  });

  it("carries the budget's provenance through, so 'host' is visible", () => {
    const settings = resolveWatermarkConcurrencySettings(
      {},
      { bytes: GiB, source: "host" },
      { cpus: 4, source: "host" },
    );
    expect(settings.budgetSource).toBe("host");
    expect(settings.budgetBytes).toBe(GiB);
    expect(settings.cpuSource).toBe("host");
    expect(settings.cpus).toBe(4);
  });

  it("sizes libvips threads from the CPU quota, not the host's cores", () => {
    // The blind spot this closes: os.availableParallelism() would report 64
    // inside `docker run --cpus=2`, and the thread rule would hand out
    // host-sized pools to every in-flight preview.
    const quotaLimited = resolveWatermarkConcurrencySettings(
      {},
      budget(GiB),
      cpu(2),
    );
    expect(quotaLimited.limit).toBe(3);
    expect(quotaLimited.sharpThreads).toBe(1);

    const roomy = resolveWatermarkConcurrencySettings({}, budget(GiB), cpu(64));
    expect(roomy.sharpThreads).toBe(MAX_SHARP_THREADS_PER_OPERATION);
  });
});

describe("resolveConcurrencyCeiling", () => {
  it("leaves one libuv worker free for dns and fs", () => {
    expect(resolveConcurrencyCeiling({})).toBe(
      LIBUV_DEFAULT_THREADPOOL_SIZE - 1,
    );
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "8" })).toBe(7);
  });

  it("never goes below 1, even with a one-worker pool", () => {
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "1" })).toBe(1);
  });

  it("stays under the absolute ceiling however big the pool is", () => {
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "128" })).toBe(
      MAX_DERIVED_CONCURRENCY,
    );
  });

  it("ignores a junk UV_THREADPOOL_SIZE", () => {
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "nope" })).toBe(
      LIBUV_DEFAULT_THREADPOOL_SIZE - 1,
    );
  });
});

describe("describeWatermarkConcurrency", () => {
  it("names both provenances, so a missing container limit is visible", () => {
    const line = describeWatermarkConcurrency(
      resolveWatermarkConcurrencySettings(
        {},
        { bytes: GiB, source: "host" },
        { cpus: 8, source: "host" },
      ),
    );
    expect(line).toContain("limit=3 (derived)");
    expect(line).toContain("queue=12");
    expect(line).toContain("memoryBudget=1024 MB (host)");
    expect(line).toContain("cpuBudget=8 (host)");
    expect(line).toContain("projectedPeak=1004 MB");
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
    // Belt and braces on top of detectCpuBudget(): even when the effective
    // CPU count really is 64, one preview does not need a 64-thread pool,
    // and libvips' default would have given it one.
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
  // Every gate build logs a line. Captured rather than printed, both to keep
  // the suite's output readable and so the two logging tests below can assert
  // on it.
  let infoSpy: MockInstance;
  let warnSpy: MockInstance;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetWatermarkConcurrencyGate();
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
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

  it("logs the configuration and its provenance exactly once", () => {
    // Without this the provenance tracked through the settings is decoration:
    // detectMemoryBudget reports source "host" precisely so a missing
    // container memory limit is noticeable, and the Dockerfile tells
    // operators to set one — but nothing printed it.
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "1";
    resetWatermarkConcurrencyGate();
    infoSpy.mockClear();
    warnSpy.mockClear();

    // Twice: the gate is memoised, so the second call must not re-log.
    watermarkConcurrencyStats();
    watermarkConcurrencyStats();

    const lines = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map(
      ([line]) => line as string,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[watermark] preview concurrency limit=1 (env)");
    expect(lines[0]).toMatch(/memoryBudget=\d+ MB \((cgroup-v[12]|host)\)/);
    expect(lines[0]).toMatch(/cpuBudget=\d+ \((cgroup-v[12]|host)\)/);
  });

  it("blames the right thing when the configuration does not fit", () => {
    // fitsBudget goes false for two unrelated reasons, and naming the wrong
    // one sends the operator to a knob that cannot help during exactly the
    // incident this line exists for. A 1 GB container with an over-large
    // queue is not "below the 468 MB floor".
    //
    // The budget is pinned rather than read from the machine. An earlier
    // version of this test asserted fitsBudget === false against real host
    // RAM, which only held because the projection happened to exceed this
    // workstation's memory; on a larger machine the assertion inverted and
    // the next line threw on an empty warnSpy. A test whose outcome depends
    // on the developer's RAM is not testing the code.
    process.env.WATERMARK_MEMORY_BUDGET_MB = "1024";
    process.env.WATERMARK_QUEUE_LIMIT = "512";
    resetWatermarkConcurrencyGate();
    warnSpy.mockClear();

    const stats = watermarkConcurrencyStats();
    expect(stats.settings.budgetBytes).toBe(1024 * MiB);
    expect(stats.settings.fitsBudget).toBe(false);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain("WATERMARK_MAX_CONCURRENCY / WATERMARK_QUEUE_LIMIT");
    expect(line).not.toContain("floor");
  });

  it("names the floor, not the knobs, when the container is simply too small", () => {
    process.env.WATERMARK_MEMORY_BUDGET_MB = "256";
    resetWatermarkConcurrencyGate();
    warnSpy.mockClear();

    const stats = watermarkConcurrencyStats();
    expect(stats.settings.fitsBudget).toBe(false);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain("floor");
    expect(line).toContain("give it more memory");
  });

  it("warns when it has to clamp an override, rather than silently obeying", () => {
    // The round-4 class of bug: an override that quietly exceeds a bound the
    // budget arithmetic depends on makes fitsBudget a lie. Clamping without
    // saying so would only move the lie.
    process.env.WATERMARK_MEMORY_BUDGET_MB = "2048";
    process.env.WATERMARK_MAX_CONCURRENCY = "64";
    process.env.WATERMARK_SHARP_THREADS = "64";
    process.env.WATERMARK_QUEUE_TIMEOUT_MS = "600000";
    resetWatermarkConcurrencyGate();
    warnSpy.mockClear();

    const { settings } = watermarkConcurrencyStats();
    expect(settings.limit).toBe(LIBUV_DEFAULT_THREADPOOL_SIZE - 1);
    expect(settings.sharpThreads).toBe(MAX_SHARP_THREADS_PER_OPERATION);
    expect(settings.queueTimeoutMs).toBe(MAX_QUEUE_TIMEOUT_MS);
    expect(settings.clamped).toHaveLength(3);
    // And the projection describes what is in force, not what was asked for.
    expect(settings.fitsBudget).toBe(true);

    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain("WATERMARK_MAX_CONCURRENCY=64 clamped to 3");
    expect(line).toContain("WATERMARK_SHARP_THREADS=64 clamped to 4");
    expect(line).toContain("WATERMARK_QUEUE_TIMEOUT_MS=600000 clamped to");
  });

  it("warns, rather than logging quietly, when no container memory limit was found", () => {
    resetWatermarkConcurrencyGate();
    infoSpy.mockClear();
    warnSpy.mockClear();

    // On a workstation there is no cgroup, so the budget source is "host" and
    // the warning must fire. In a cgroup-limited CI container it would
    // legitimately be an info line instead, so accept either — but require
    // that the "host" case is the warning one.
    const source = watermarkConcurrencyStats().settings.budgetSource;
    if (source === "host") {
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(
        "no container memory limit found",
      );
    } else {
      expect(infoSpy).toHaveBeenCalledTimes(1);
    }
  });
});
