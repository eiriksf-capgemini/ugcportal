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
  SHED_LOG_INTERVAL_MS,
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
 * version of the containment test rebuilt projectedGatedPeakBytes with the same
 * expression the implementation uses, so when that expression was wrong —
 * it charged the request body to queued callers but not to running ones —
 * the test agreed with it and passed. A hand-written table cannot agree with
 * a formula it does not contain: if the derivation changes, these have to be
 * re-derived by hand and justified, which is the point.
 *
 * Worked by hand from: 15% headroom off the budget first, then 320 MB
 * baseline, then 148 MB per in-flight upload (128 MB decode + 20 MB body),
 * then 20 MB per queued body, ceiling 3, queue capped at 4 per slot.
 *
 *   512 -> usable 435.2; spendable 115.2; 115.2/148 = 0 -> clamped to 1
 *          running, nothing left to queue; 320 + 148       =  468, and
 *          468 > 435.2, so this container does NOT fit
 *   768 -> usable 652.8; spendable 332.8; 332.8/148 = 2 running
 *          (36.8 left -> 1 queued);       320 + 296 + 20    =  636
 *  1024 -> usable 870.4; spendable 550.4; 550.4/148 = 3, at the ceiling
 *          (106.4 left -> 5 queued);      320 + 444 + 100   =  864
 *  2048 -> usable 1740.8; ceiling-bound at 3 running, queue capped at 12;
 *                                         320 + 444 + 240   = 1004
 */
const REFERENCE_TABLE = [
  { budgetMiB: 512, limit: 1, queueLimit: 0, projectedMiB: 468, fits: false },
  { budgetMiB: 768, limit: 2, queueLimit: 1, projectedMiB: 636, fits: true },
  { budgetMiB: 1024, limit: 3, queueLimit: 5, projectedMiB: 864, fits: true },
  { budgetMiB: 2048, limit: 3, queueLimit: 12, projectedMiB: 1004, fits: true },
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
        projectedMiB: settings.projectedGatedPeakBytes / MiB,
        fits: settings.fitsBudget,
      }).toEqual(row);
    }
  });

  it("leaves headroom rather than spending the budget to the last byte", () => {
    // Round-5 finding 4. Before this, step 3 gave every remaining byte to
    // queue depth and the recommended 1 GB configuration landed at
    // 1004/1024 MB — 98% of the number the kernel kills on, defended by a
    // per-operation figure that has never run on the alpine image.
    for (const row of REFERENCE_TABLE) {
      const settings = resolveWatermarkConcurrencySettings(
        {},
        budget(row.budgetMiB * MiB),
        cpu(8),
      );
      expect(settings.usableBudgetBytes).toBeLessThan(settings.budgetBytes);
      if (settings.fitsBudget) {
        // The headroom is real: what is committed stays clear of the cliff.
        const utilisation =
          settings.projectedGatedPeakBytes / settings.budgetBytes;
        expect(utilisation).toBeLessThan(0.9);
      }
    }

    // And the headroom at the recommended size covers at least one whole
    // unaccounted upload, which is the unit the under-estimates come in.
    const recommended = resolveWatermarkConcurrencySettings(
      {},
      budget(1024 * MiB),
      cpu(8),
    );
    expect(
      recommended.budgetBytes - recommended.usableBudgetBytes,
    ).toBeGreaterThan(IN_FLIGHT_BYTES_PER_UPLOAD);
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
    expect(settings.projectedGatedPeakBytes).toBe(764 * MiB);
    expect(settings.projectedGatedPeakBytes).toBeGreaterThan(
      PREVIEW_PROCESS_BASELINE_BYTES + 3 * PREVIEW_BYTES_PER_OPERATION,
    );
  });

  it("keeps the whole configuration inside the memory budget", () => {
    // The property the reference table is a sample of: across the whole
    // plausible range, what the process commits to never exceeds what the
    // kernel will kill it for.
    // Every size at or above the viable floor; below it no configuration
    // fits and that is reported rather than hidden (see the floor test).
    for (const bytes of [576 * MiB, 640 * MiB, 768 * MiB, GiB, 2 * GiB, 8 * GiB]) {
      const settings = resolveWatermarkConcurrencySettings(
        {},
        budget(bytes),
        cpu(8),
      );
      expect(settings.projectedGatedPeakBytes).toBeLessThanOrEqual(
        settings.usableBudgetBytes,
      );
      expect(settings.fitsBudget).toBe(true);
    }
  });

  it("shrinks the queue rather than the limit when memory is tight", () => {
    // 640 MB affords one in-flight upload and 76 MB after it: three queued
    // bodies, not the four a fixed 4x multiple would have handed out.
    const settings = resolveWatermarkConcurrencySettings(
      {},
      budget(640 * MiB),
      cpu(8),
    );
    expect(settings.limit).toBe(1);
    expect(settings.queueLimit).toBe(3);
    expect(settings.projectedGatedPeakBytes).toBe(528 * MiB);
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
    expect(settings.projectedGatedPeakBytes).toBeGreaterThan(256 * MiB);
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

  it("does not tell the operator to raise a pool that is not what bound them", () => {
    // Round-5 finding 1. With a 32-worker pool the ceiling is the module's
    // own cap of 8, and "raise UV_THREADPOOL_SIZE" would send them round a
    // loop that can never change the answer.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MAX_CONCURRENCY: "16", UV_THREADPOOL_SIZE: "32" },
      budget(64 * GiB),
      cpu(32),
    );
    expect(settings.limit).toBe(MAX_DERIVED_CONCURRENCY);
    expect(settings.clamped[0]).toContain("MAX_DERIVED_CONCURRENCY");
    expect(settings.clamped[0]).toContain("will not lift it");
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
    expect(settings.projectedGatedPeakBytes).toBe(
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
    expect(settings.queueLimit).toBe(0);
    expect(settings.projectedGatedPeakBytes).toBe(468 * MiB);
    // And the answer it now escapes *to* is "this container is too small",
    // which is the useful one. Sized from the 64 GB host it would have
    // derived 3 previews and a 12-deep queue and called that a fit.
    expect(settings.fitsBudget).toBe(false);
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
    expect(settings.projectedGatedPeakBytes).toBe(764 * MiB);
  });

  it("will not let the override exceed a cgroup limit the kernel enforces", () => {
    // Round-8 finding 1, and the sharpest edge in this whole change: the
    // knob added to make the budget *honest* was itself a route to the OOM
    // the gate exists to prevent. A 1 GB container on a 64 GB host asking
    // for 8 GB used to be accepted with no clamp at all — limit 3, queue 12,
    // ~1004 MB committed, fitsBudget true, logged at info level, killed.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MEMORY_BUDGET_MB: "8192" },
      { bytes: GiB, source: "cgroup-v2" },
      cpu(8),
      64 * GiB,
    );
    expect(settings.budgetBytes).toBe(GiB);
    expect(settings.clamped).toHaveLength(1);
    expect(settings.clamped[0]).toContain("cgroup-v2 memory limit");
    expect(settings.clamped[0]).toContain("OOM-killed");
  });

  it("still lets the override lower a budget below the detected one", () => {
    // The direction the knob exists for is untouched: downwards it is the
    // operator telling us something the kernel did not.
    const settings = resolveWatermarkConcurrencySettings(
      { WATERMARK_MEMORY_BUDGET_MB: "768" },
      { bytes: 2 * GiB, source: "cgroup-v2" },
      cpu(8),
      64 * GiB,
    );
    expect(settings.budgetBytes).toBe(768 * MiB);
    expect(settings.clamped).toEqual([]);
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
    expect(resolveConcurrencyCeiling({})).toEqual({
      value: LIBUV_DEFAULT_THREADPOOL_SIZE - 1,
      boundBy: "libuv-pool",
    });
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "8" })).toEqual({
      value: 7,
      boundBy: "libuv-pool",
    });
  });

  it("never goes below 1, even with a one-worker pool", () => {
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "1" }).value).toBe(1);
  });

  it("reports the absolute cap as the binding term when it is", () => {
    // Round-5 finding 1: which term bound decides what advice the operator
    // gets, and "raise UV_THREADPOOL_SIZE" is advice that cannot work here.
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "128" })).toEqual({
      value: MAX_DERIVED_CONCURRENCY,
      boundBy: "absolute-cap",
    });
    // Exactly at the boundary the cap is what binds, since raising the pool
    // further changes nothing.
    expect(
      resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "9" }).boundBy,
    ).toBe("absolute-cap");
    expect(
      resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "8" }).boundBy,
    ).toBe("libuv-pool");
  });

  it("ignores a junk UV_THREADPOOL_SIZE", () => {
    expect(resolveConcurrencyCeiling({ UV_THREADPOOL_SIZE: "nope" }).value).toBe(
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
    expect(line).toContain("queue=5");
    expect(line).toContain("memoryBudget=1024 MB (host)");
    expect(line).toContain("cpuBudget=8 (host)");
    expect(line).toContain("usableBudget=870 MB");
    expect(line).toContain("projectedGatedPeak=864 MB");
  });

  it("says 'gated' so the figure is not read as a whole-process bound", () => {
    // The label carries the caveat, because the log line is where an
    // operator meets this number. What it excludes — shed uploads, video,
    // oversized-then-rejected bodies — is ugcportal-05b.
    const line = describeWatermarkConcurrency(
      resolveWatermarkConcurrencySettings({}, budget(GiB), cpu(8)),
    );
    expect(line).toContain("projectedGatedPeak=");
    expect(line).not.toMatch(/projectedPeak=/);
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
    // Undo the process-global thread pinning these tests applied — but to 1,
    // not to 0. sharp.concurrency(0) means "one thread per core", the
    // heaviest possible setting, and it would be inherited by whatever test
    // file shares this process next; vitest runs them in parallel.
    sharp.concurrency(1);
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

  it("logs shedding distinguishably from a broken runtime (K2)", async () => {
    // Round-5 finding 2, resolved by ugcportal-u7g: the route used to rethrow
    // WatermarkOverloadedError into
    // console.error("[media] watermark service unavailable") — the message
    // written for the fontless-runtime case, where every upload is broken
    // and someone should be paged. Shedding is routine on a small container,
    // so without a line of its own the two would have been byte-identical in
    // the logs, and alerting could not have told normal operation from an
    // outage. The route now maps a shed upload to a 503 with Retry-After and
    // logs nothing further for it, so this throttled warn is the only
    // per-shed log line there is.
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "0";
    resetWatermarkConcurrencyGate();
    warnSpy.mockClear();

    const input = await source();
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => generateWatermarkedPreview(input)),
    );
    expect(settled.some((r) => r.status === "rejected")).toBe(true);

    const shedLines = warnSpy.mock.calls
      .map(([line]) => line as string)
      .filter((line) => line.includes("shed an upload"));
    expect(shedLines).toHaveLength(1);
    expect(shedLines[0]).toContain("queue-full");
    expect(shedLines[0]).toContain("not a broken runtime");
    // Names the bead that maps this to a 503 + Retry-After, so the response
    // a caller actually sees is traceable from the log rather than mysterious.
    expect(shedLines[0]).toContain("ugcportal-u7g");
  });

  it("throttles the shed log instead of adding a log storm to a load problem", async () => {
    // Fake timers for the WHOLE test (ugcportal-qz1u item 1), installed
    // before anything sheds: `vi.useFakeTimers()` resets `performance.now()`
    // to `0` the moment it installs, discarding whatever real elapsed time
    // came before it. If installed only around the later window-advance
    // below, the throttle's `lastAt` (seeded from the REAL clock by the
    // first shed, above) would be compared against a `now` that had
    // silently restarted from `0`, undercounting the elapsed window by
    // however much real time had already passed. Real sharp preview
    // generation and `Promise.allSettled` below are unaffected: fake timers
    // replace `setTimeout`/`setInterval`/`Date`/`performance.now()`, not how
    // native-code promises (sharp's own worker-thread results) resolve, and
    // this test's fixture (`WATERMARK_QUEUE_LIMIT=0`) sheds immediately
    // rather than queuing, so no timeout-driven `setTimeout` is in play
    // either.
    vi.useFakeTimers();
    try {
      process.env.WATERMARK_MAX_CONCURRENCY = "1";
      process.env.WATERMARK_QUEUE_LIMIT = "0";
      resetWatermarkConcurrencyGate();
      warnSpy.mockClear();

      const input = await source();
      // Two separate bursts, well inside the throttle interval.
      await Promise.allSettled(
        Array.from({ length: 6 }, () => generateWatermarkedPreview(input)),
      );
      await Promise.allSettled(
        Array.from({ length: 6 }, () => generateWatermarkedPreview(input)),
      );

      const shedLines = warnSpy.mock.calls
        .map(([line]) => line as string)
        .filter((line) => line.includes("shed an upload"));
      expect(shedLines).toHaveLength(1);

      const tailLines = () =>
        warnSpy.mock.calls
          .map(([line]) => line as string)
          .filter((line) => line.includes("more upload(s) since the last line"));

      // Reading the stats inside the window must NOT emit. That was round-8
      // finding 2: the flush reset the interval, so a health check polling
      // every second during sustained shedding produced a line per second
      // while the line itself claimed one per 10000ms. Callers may ask; they
      // do not get to restart the clock.
      const duringWindow = watermarkConcurrencyStats();
      expect(duringWindow.shed).toBeGreaterThan(1);
      expect(tailLines()).toHaveLength(0);

      // ...but the swallowed ones are not lost either. This is the half the
      // throttle originally dropped: the suppressed count was only ever
      // flushed by the *next logged* shed, so a burst that sheds and then goes
      // quiet reported one upload out of ten. Once the window has genuinely
      // elapsed the tail is reported — by a timer in production, and here by
      // advancing the fake-timer clock (which `performance.now()` moves with
      // — ugcportal-qz1u item 1) rather than waiting ten real seconds.
      vi.advanceTimersByTime(SHED_LOG_INTERVAL_MS + 1);
      const stats = watermarkConcurrencyStats();
      const tail = tailLines();
      expect(tail).toHaveLength(1);
      // The two lines must account for every shed upload between them: one
      // named by the first line, the rest by the tail.
      const reported = Number(/shed (\d+) more/.exec(tail[0])?.[1]);
      expect(reported).toBe(stats.shed - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit a tail line when nothing was suppressed", async () => {
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "0";
    resetWatermarkConcurrencyGate();
    warnSpy.mockClear();

    const input = await source();
    // Exactly two callers: one runs, one sheds and is logged immediately.
    await Promise.allSettled([
      generateWatermarkedPreview(input),
      generateWatermarkedPreview(input),
    ]);
    watermarkConcurrencyStats();

    const lines = warnSpy.mock.calls.map(([line]) => line as string);
    expect(lines.filter((l) => l.includes("shed an upload"))).toHaveLength(1);
    expect(
      lines.filter((l) => l.includes("more upload(s) since the last line")),
    ).toHaveLength(0);
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
