import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  declaredUploadCapBytes,
} from "@/lib/media";
import {
  MIN_UPLOAD_BUDGET_BYTES,
  MULTIPART_ENVELOPE_SLACK_BYTES,
  UPLOAD_BODY_COPIES,
  UploadMemoryExhaustedError,
  UploadTooLargeForBudgetError,
  createUploadMemoryBudget,
  describeUploadMemory,
  resolveUploadMemorySettings,
  uploadReadLimitBytes,
  uploadReservationBytes,
} from "@/lib/upload-memory";
import type { UploadMemorySettings } from "@/lib/upload-memory";
import {
  PREVIEW_BYTES_PER_OPERATION,
  PREVIEW_PROCESS_BASELINE_BYTES,
  UPLOAD_BODY_BYTES,
  resolveWatermarkConcurrencySettings,
} from "@/lib/watermark";
import type { WatermarkConcurrencyEnv } from "@/lib/watermark";

const MiB = 1024 * 1024;

/**
 * Real gate settings for a container of `mb`, with every input injected so
 * nothing here reads the host.
 *
 * Deliberately the real resolver rather than a hand-built settings object:
 * the whole claim of this module is that its budget composes with the gate's
 * derivation, and a fabricated `WatermarkConcurrencySettings` would let the
 * two drift apart without a test noticing. 64 GB of host RAM so the budget
 * override path is never clamped; 2 CPUs so sharpThreads is deterministic.
 */
function watermarkFor(mb: number, env: WatermarkConcurrencyEnv = {}) {
  return resolveWatermarkConcurrencySettings(
    env,
    { bytes: mb * MiB, source: "cgroup-v2" },
    { cpus: 2, source: "cgroup-v2" },
    64 * 1024 * MiB,
  );
}

function uploadFor(mb: number, env: WatermarkConcurrencyEnv = {}) {
  return resolveUploadMemorySettings(watermarkFor(mb, env));
}

describe("declaredUploadCapBytes", () => {
  it("returns the same cap validateUpload will apply", () => {
    expect(declaredUploadCapBytes("image/png")).toBe(10 * MiB);
    expect(declaredUploadCapBytes("video/mp4")).toBe(200 * MiB);
  });

  it("normalises case and strips Content-Type parameters", () => {
    // `File.type` is lower-cased by the platform before validateUpload ever
    // sees it, so a cap keyed on the raw header has to do the same or it
    // reads as "unknown" and caps loosely while validateUpload accepts.
    expect(declaredUploadCapBytes("IMAGE/PNG")).toBe(10 * MiB);
    expect(declaredUploadCapBytes("image/png; charset=binary")).toBe(10 * MiB);
    expect(declaredUploadCapBytes("  video/mp4  ")).toBe(200 * MiB);
  });

  it("returns null rather than a number for a type no kind accepts", () => {
    expect(declaredUploadCapBytes("application/pdf")).toBeNull();
    expect(declaredUploadCapBytes("")).toBeNull();
    expect(declaredUploadCapBytes(null)).toBeNull();
    expect(declaredUploadCapBytes(undefined)).toBeNull();
  });
});

describe("uploadReadLimitBytes", () => {
  it("caps a declared image at the image cap, not at the route's fallback", () => {
    expect(uploadReadLimitBytes({ declaredContentType: "image/png" })).toBe(
      10 * MiB + MULTIPART_ENVELOPE_SLACK_BYTES,
    );
  });

  it("caps a declared video at the video cap", () => {
    expect(uploadReadLimitBytes({ declaredContentType: "video/mp4" })).toBe(
      200 * MiB + MULTIPART_ENVELOPE_SLACK_BYTES,
    );
  });

  it("reads as little as possible of a type that will be refused anyway", () => {
    // An unsupported type is a 415 at any size, so the only question is how
    // much of it to buffer first: the smallest cap the route has.
    expect(uploadReadLimitBytes({ declaredContentType: "application/pdf" })).toBe(
      MAX_IMAGE_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES,
    );
  });

  it("falls back to the whole-request cap when nothing was declared", () => {
    expect(uploadReadLimitBytes({ declaredContentType: null })).toBe(
      MAX_UPLOAD_BYTES,
    );
  });

  it("never exceeds the fallback, whatever is declared", () => {
    // The guarantee that makes a client-controlled declaration safe: it can
    // only ever narrow. There is no declaration that buys a bigger read than
    // the route already allowed everyone.
    for (const declaredContentType of [
      "image/png",
      "video/mp4",
      "application/pdf",
      "video/quicktime",
      null,
    ]) {
      expect(
        uploadReadLimitBytes({ declaredContentType }),
      ).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    }
  });

  it("narrows to an honestly declared Content-Length", () => {
    expect(
      uploadReadLimitBytes({
        declaredContentType: "image/png",
        contentLengthHeader: String(2 * MiB),
      }),
    ).toBe(2 * MiB + MULTIPART_ENVELOPE_SLACK_BYTES);
  });

  it("lets Content-Length narrow but never widen", () => {
    expect(
      uploadReadLimitBytes({
        declaredContentType: "image/png",
        contentLengthHeader: String(500 * MiB),
      }),
    ).toBe(10 * MiB + MULTIPART_ENVELOPE_SLACK_BYTES);
  });

  // The header shapes ugcportal-i04 was shipped getting wrong. `Number(null)`
  // is 0 and `Number("4096abc")` is NaN, and every comparison against NaN is
  // false — so a guard written as `declared < cap` would silently accept
  // *both* as "small", and one written as `declared > 0 ? declared : 0` would
  // cap the read at zero bytes and break every chunked upload. Each of these
  // must land on the declared-type cap instead.
  it.each([
    ["absent", null],
    ["empty", ""],
    ["malformed", "4096abc"],
    ["not a number at all", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
  ])("ignores a %s Content-Length", (_label, contentLengthHeader) => {
    expect(
      uploadReadLimitBytes({
        declaredContentType: "image/png",
        contentLengthHeader,
      }),
    ).toBe(10 * MiB + MULTIPART_ENVELOPE_SLACK_BYTES);
  });
});

describe("uploadReservationBytes", () => {
  it("prices every copy the handler holds", () => {
    expect(uploadReservationBytes(1000)).toBe(UPLOAD_BODY_COPIES * 1000);
  });

  it("agrees with the gate's own per-body figure for a maximum-size image", () => {
    // UPLOAD_BODY_BYTES (src/lib/watermark.ts) and this reservation are two
    // constants expressing one fact: how much memory one image upload holds.
    // The gate's figure is the file alone; this one adds the multipart
    // framing the stream also carries, so it is larger by exactly that.
    expect(uploadReservationBytes(MAX_IMAGE_UPLOAD_BYTES)).toBe(
      UPLOAD_BODY_BYTES,
    );
    expect(
      uploadReservationBytes(
        MAX_IMAGE_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES,
      ),
    ).toBe(UPLOAD_BODY_BYTES + UPLOAD_BODY_COPIES * MULTIPART_ENVELOPE_SLACK_BYTES);
  });
});

describe("resolveUploadMemorySettings", () => {
  // Hand-derivable from the constants, so a reviewer can check the arithmetic
  // without running anything:
  //
  //   usable    = floor(1024 MiB x 0.85)            = 912_680_550
  //   spendable = usable - 320 MiB baseline         = 577_136_230
  //   limit     = 3 (libuv-bound), decode 3 x 128 MiB = 402_653_184
  //   budget    = spendable - decode                = 174_483_046  (166.4 MiB)
  //   solo      = spendable                         = 577_136_230  (550.4 MiB)
  //   maxSingle = floor(solo / 2) - 64 KiB          = 288_502_579  (275.1 MiB)
  //   projected = 320 MiB + max(decode + budget, solo) = usable exactly
  it("derives the recommended 1 GB configuration", () => {
    const settings = uploadFor(1024);

    expect(settings.watermark.usableBudgetBytes).toBe(912_680_550);
    expect(settings.watermark.limit).toBe(3);
    expect(settings.budgetBytes).toBe(174_483_046);
    expect(settings.soloReservationCeilingBytes).toBe(577_136_230);
    expect(settings.maxSingleUploadBytes).toBe(288_502_579);
    expect(settings.projectedUploadPathPeakBytes).toBe(912_680_550);
    expect(settings.fitsBudget).toBe(true);
  });

  it("accepts every upload the app allows at 1 GB, and not at 768 MB", () => {
    // The operator-facing consequence, and the reason maxSingleUploadBytes is
    // a field rather than an internal: a 200 MB video costs two copies plus
    // framing, which 1 GB affords and 768 MB does not.
    expect(uploadFor(1024).maxSingleUploadBytes).toBeGreaterThan(200 * MiB);
    expect(uploadFor(768).maxSingleUploadBytes).toBeLessThan(200 * MiB);
    // Images fit everywhere, including the smallest container that runs.
    expect(uploadFor(512).maxSingleUploadBytes).toBeGreaterThan(
      MAX_IMAGE_UPLOAD_BYTES,
    );
  });

  it("admits exactly the burst the gate can hold at 1 GB", () => {
    const settings = uploadFor(1024);
    const perMaxImage = uploadReservationBytes(
      MAX_IMAGE_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES,
    );

    expect(Math.floor(settings.budgetBytes / perMaxImage)).toBe(
      settings.watermark.limit + settings.watermark.queueLimit,
    );
  });

  it("reports a container too small for the configuration in force", () => {
    const settings = uploadFor(512);

    // 512 MB does not fit one in-flight preview once headroom is taken off,
    // which the gate already says. The budget is floored so the route still
    // works for one upload at a time rather than refusing everything, and
    // fitsBudget says the arithmetic does not close.
    expect(settings.watermark.fitsBudget).toBe(false);
    expect(settings.budgetBytes).toBe(MIN_UPLOAD_BUDGET_BYTES);
    expect(settings.fitsBudget).toBe(false);
    expect(settings.projectedUploadPathPeakBytes).toBeGreaterThan(
      settings.watermark.usableBudgetBytes,
    );
  });

  // The invariant the two bounds compose on. Stated on
  // resolveUploadMemorySettings and proved there for the derived case; this
  // is the executable half, swept across every container size that matters.
  //
  // Without it the outer bound could be tighter than the gate's queue, making
  // part of the gate's configuration permanently unreachable — the gate would
  // report a queue depth it could never fill.
  it.each([512, 640, 768, 1024, 1536, 2048, 4096, 8192])(
    "never starves the gate's queue at %i MB",
    (mb) => {
      const settings = uploadFor(mb);
      const gateHolds =
        settings.watermark.limit + settings.watermark.queueLimit;

      expect(settings.budgetBytes).toBeGreaterThanOrEqual(
        gateHolds * UPLOAD_BODY_BYTES,
      );
    },
  );

  it.each([512, 640, 768, 1024, 1536, 2048, 4096, 8192])(
    "keeps the projected peak inside the usable budget whenever it fits, at %i MB",
    (mb) => {
      const settings = uploadFor(mb);
      const expected =
        PREVIEW_PROCESS_BASELINE_BYTES +
        Math.max(
          settings.watermark.limit * PREVIEW_BYTES_PER_OPERATION +
            settings.budgetBytes,
          settings.soloReservationCeilingBytes,
        );

      expect(settings.projectedUploadPathPeakBytes).toBe(expected);
      if (settings.fitsBudget) {
        expect(settings.projectedUploadPathPeakBytes).toBeLessThanOrEqual(
          settings.watermark.usableBudgetBytes,
        );
      }
    },
  );

  it("is at least as large a claim as the gate's own projection", () => {
    // projectedGatedPeakBytes and projectedUploadPathPeakBytes are not
    // additive — the gate's per-caller body charge is for bodies this budget
    // is already holding. This pins the direction of the relationship, which
    // is what stops anyone summing them.
    for (const mb of [768, 1024, 2048, 4096]) {
      const settings = uploadFor(mb);
      expect(settings.projectedUploadPathPeakBytes).toBeGreaterThanOrEqual(
        settings.watermark.projectedGatedPeakBytes,
      );
    }
  });

  it("tracks an explicit WATERMARK_MAX_CONCURRENCY rather than ignoring it", () => {
    // The gate lets an operator set a limit memory does not afford, and only
    // reports on it. The budget must be computed from the limit that actually
    // took effect, not from the one the derivation would have chosen.
    const settings = uploadFor(1024, { WATERMARK_MAX_CONCURRENCY: "1" });

    expect(settings.watermark.limit).toBe(1);
    expect(settings.budgetBytes).toBe(
      settings.watermark.usableBudgetBytes -
        PREVIEW_PROCESS_BASELINE_BYTES -
        PREVIEW_BYTES_PER_OPERATION,
    );
  });

  it("matches the gate's queue timeout when suggesting a retry", () => {
    expect(uploadFor(1024).retryAfterSeconds).toBe(10);
    expect(
      uploadFor(1024, { WATERMARK_QUEUE_TIMEOUT_MS: "3500" }).retryAfterSeconds,
    ).toBe(4);
    // Never zero: a Retry-After of 0 invites an immediate retry into the same
    // saturated process.
    expect(
      uploadFor(1024, { WATERMARK_QUEUE_TIMEOUT_MS: "1" }).retryAfterSeconds,
    ).toBe(1);
  });
});

describe("describeUploadMemory", () => {
  it("names the budget, the largest acceptable upload and the projection", () => {
    const line = describeUploadMemory(uploadFor(1024));

    expect(line).toContain("budget=166 MB");
    expect(line).toContain("maxSingleUpload=275 MB");
    expect(line).toContain("projectedUploadPathPeak=870 MB");
  });
});

describe("createUploadMemoryBudget", () => {
  function budgetOf(
    overrides: Partial<UploadMemorySettings> = {},
  ): UploadMemorySettings {
    return { ...uploadFor(1024), ...overrides };
  }

  it("admits reservations up to the budget and sheds the next one", () => {
    const settings = budgetOf({
      budgetBytes: 100,
      soloReservationCeilingBytes: 400,
    });
    const budget = createUploadMemoryBudget(settings);

    const a = budget.reserve(60);
    const b = budget.reserve(40);
    expect(budget.stats().heldBytes).toBe(100);

    expect(() => budget.reserve(1)).toThrow(UploadMemoryExhaustedError);
    expect(budget.stats().shed).toBe(1);

    a.release();
    expect(budget.stats().heldBytes).toBe(40);
    const c = budget.reserve(60);
    expect(budget.stats().heldBytes).toBe(100);

    b.release();
    c.release();
    expect(budget.stats().heldBytes).toBe(0);
    expect(budget.stats().peakHeldBytes).toBe(100);
    expect(budget.stats().admitted).toBe(3);
  });

  it("carries a retry hint on a shed, and nothing else does", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 10,
        soloReservationCeilingBytes: 400,
        retryAfterSeconds: 7,
      }),
    );
    budget.reserve(10);

    try {
      budget.reserve(10);
      expect.unreachable("expected the second reservation to be shed");
    } catch (error) {
      expect(error).toBeInstanceOf(UploadMemoryExhaustedError);
      expect((error as UploadMemoryExhaustedError).retryAfterSeconds).toBe(7);
    }
  });

  it("lets one oversized upload through on an idle process, and only one", () => {
    // The rule that makes a 200 MB video possible at all: alone, it may use
    // the decode allocation too, because nothing can be decoding while the
    // budget is idle — every caller at the watermark gate holds a reservation.
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
    );

    const solo = budget.reserve(400);
    expect(budget.stats().heldBytes).toBe(400);

    // Over-committed, so everything else — even a tiny upload — waits its turn
    // as a 503 rather than joining it.
    expect(() => budget.reserve(1)).toThrow(UploadMemoryExhaustedError);
    expect(() => budget.reserve(400)).toThrow(UploadMemoryExhaustedError);

    solo.release();
    expect(budget.stats().heldBytes).toBe(0);
    expect(() => budget.reserve(400)).not.toThrow();
  });

  it("refuses an upload no amount of idleness would fit, as a distinct error", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 100,
        soloReservationCeilingBytes: 400,
        maxSingleUploadBytes: 150,
      }),
    );

    try {
      budget.reserve(401);
      expect.unreachable("expected the reservation to be refused outright");
    } catch (error) {
      // Not UploadMemoryExhaustedError: retrying this will never work, and
      // answering 503 + Retry-After would tell the caller otherwise.
      expect(error).toBeInstanceOf(UploadTooLargeForBudgetError);
      expect(error).not.toBeInstanceOf(UploadMemoryExhaustedError);
      expect((error as UploadTooLargeForBudgetError).limitBytes).toBe(150);
    }
    expect(budget.stats().refusedTooLarge).toBe(1);
    expect(budget.stats().shed).toBe(0);
    expect(budget.stats().heldBytes).toBe(0);
  });

  it("does not hand the budget back twice for one reservation", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
    );

    const a = budget.reserve(60);
    budget.reserve(40);
    a.release();
    a.release();
    a.release();

    expect(budget.stats().heldBytes).toBe(40);
    expect(() => budget.reserve(61)).toThrow(UploadMemoryExhaustedError);
  });

  it("never holds more than the solo ceiling, under arbitrary interleaving", () => {
    // The bound itself, exercised rather than reasoned about: a long random
    // sequence of reservations and releases, checked after every operation.
    const settings = budgetOf({
      budgetBytes: 1000,
      soloReservationCeilingBytes: 2500,
    });
    const budget = createUploadMemoryBudget(settings);
    const held: Array<{ release(): void }> = [];
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 20260925;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);

    for (let step = 0; step < 5000; step += 1) {
      if (held.length > 0 && next() % 3 === 0) {
        held.splice(next() % held.length, 1)[0].release();
      } else {
        const bytes = 1 + (next() % 2600);
        try {
          held.push(budget.reserve(bytes));
        } catch {
          // Shed or refused; both are correct answers here.
        }
      }
      expect(budget.stats().heldBytes).toBeLessThanOrEqual(
        settings.soloReservationCeilingBytes,
      );
      expect(budget.stats().heldBytes).toBeGreaterThanOrEqual(0);
    }

    expect(budget.stats().peakHeldBytes).toBeGreaterThan(
      settings.budgetBytes / 2,
    );
  });
});
