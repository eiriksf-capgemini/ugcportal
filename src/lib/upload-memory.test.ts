import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  declaredUploadCapBytes,
  validateUpload,
} from "@/lib/media";
import {
  INITIAL_GRANT_BYTES,
  MIN_UPLOAD_BUDGET_BYTES,
  MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
  UNDECLARED_UPLOAD_LIMIT_BYTES,
  UPLOAD_BODY_COPIES,
  UploadMemoryExhaustedError,
  UploadTooLargeForBudgetError,
  createUploadMemoryBudget,
  describeUploadMemory,
  SHED_LOG_INTERVAL_MS,
  resetUploadMemoryBudget,
  resolveUploadMemorySettings,
  uploadMemoryStats,
  uploadReadLimitBytes,
  uploadReservationBytes,
} from "@/lib/upload-memory";
import type {
  UploadMemorySettings,
  UploadReservation,
} from "@/lib/upload-memory";
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

  // Round-2 finding 3. The first version normalised the media type by
  // splitting off Content-Type parameters; validateUpload does not, and
  // `File.type` really does carry them on this runtime. So
  // `video/mp4; codecs="avc1.42E01E"` was given a 200 MB stream cap and then
  // refused with a 415 — read-to-the-maximum-then-reject, for the cost of
  // appending a parameter — while the doc claimed the two were provably
  // identical. They are now the same code path, so this is a property rather
  // than a list of cases.
  it.each([
    "image/png",
    "video/mp4",
    "application/pdf",
    'video/mp4; codecs="avc1.42E01E"',
    "image/png; charset=binary",
    "IMAGE/PNG",
    "  video/mp4  ",
    "",
    "constructor",
    "__proto__",
  ])("answers exactly as validateUpload does for %j", (type) => {
    const accepted = validateUpload({ type, size: 1 }).ok;

    expect(declaredUploadCapBytes(type) !== null).toBe(accepted);
  });

  it("gives a parameterised type the smallest cap, not its kind's", () => {
    // The concrete consequence of the property above, spelled out because it
    // is the attack it closes: a parameterised video type now reads ~10 MB
    // before its 415 instead of ~200 MB.
    expect(declaredUploadCapBytes('video/mp4; codecs="avc1.42E01E"')).toBeNull();
    expect(
      uploadReadLimitBytes({
        declaredContentType: 'video/mp4; codecs="avc1.42E01E"',
      }),
    ).toBe(MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES);
  });

  it("returns null rather than a number for a type no kind accepts", () => {
    expect(declaredUploadCapBytes("application/pdf")).toBeNull();
    expect(declaredUploadCapBytes("")).toBeNull();
    expect(declaredUploadCapBytes(null)).toBeNull();
    expect(declaredUploadCapBytes(undefined)).toBeNull();
  });

  // The declared type is a client-controlled string used as an object key, so
  // the inherited names are part of its input domain. A plain
  // `MIME_TO_KIND[type]` answers "constructor" with the Object constructor,
  // which is neither undefined nor a MediaKind — see kindForDeclaredType.
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "does not answer %s off Object.prototype",
    (mimeType) => {
      expect(declaredUploadCapBytes(mimeType)).toBeNull();
      // Specifically null and not undefined: the return type says `number |
      // null`, and a caller writing `cap === null` would not catch undefined.
      expect(declaredUploadCapBytes(mimeType)).not.toBeUndefined();
    },
  );
});

describe("uploadReadLimitBytes", () => {
  it("caps a declared image at the image cap, not at the route's fallback", () => {
    expect(uploadReadLimitBytes({ declaredContentType: "image/png" })).toBe(
      10 * MiB + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
    );
  });

  it("caps a declared video at the video cap", () => {
    expect(uploadReadLimitBytes({ declaredContentType: "video/mp4" })).toBe(
      200 * MiB + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
    );
  });

  it("reads as little as possible of a type that will be refused anyway", () => {
    // An unsupported type is a 415 at any size, so the only question is how
    // much of it to buffer first: the smallest cap the route has.
    expect(uploadReadLimitBytes({ declaredContentType: "application/pdf" })).toBe(
      MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
    );
  });

  it("holds an upload it could not read a declaration for to the smallest cap", () => {
    // Round-1 finding 1: this used to be MAX_UPLOAD_BYTES, so a 100 KB photo
    // behind a caption field on a chunked request reserved ~430 MB — more
    // than a 768 MB container's whole spendable budget.
    expect(uploadReadLimitBytes({ declaredContentType: null })).toBe(
      UNDECLARED_UPLOAD_LIMIT_BYTES,
    );
    expect(UNDECLARED_UPLOAD_LIMIT_BYTES).toBeLessThan(MAX_UPLOAD_BYTES / 10);
  });

  it("prices a found-but-untyped part as the certain 415 it is", () => {
    // "" means the part was located and declared no Content-Type. RFC 7578
    // makes that text/plain, which no kind accepts, so there is no size at
    // which it succeeds — read as little of it as possible.
    expect(uploadReadLimitBytes({ declaredContentType: "" })).toBe(
      MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
    );
  });

  // Round-2 finding 1. An earlier version let a large Content-Length lift the
  // undeclared case back to MAX_UPLOAD_BYTES on the reasoning that an honest
  // header is information — but it is an assertion the client has not
  // delivered on, and it was enough to make two connections commit ~430 MB
  // apiece for a few hundred bytes of traffic.
  it.each([
    ["an unreadable declaration", null],
    ["a declared image", "image/png"],
    ["a declared video", "video/mp4"],
  ])("never lets Content-Length widen the cap, with %s", (_label, declared) => {
    const withoutHeader = uploadReadLimitBytes({
      declaredContentType: declared,
    });
    const withHugeHeader = uploadReadLimitBytes({
      declaredContentType: declared,
      contentLengthHeader: String(4 * 1024 * MiB),
    });

    expect(withHugeHeader).toBe(withoutHeader);
  });

  it("keeps an undeclared upload at the smallest cap however big it claims to be", () => {
    expect(
      uploadReadLimitBytes({
        declaredContentType: null,
        contentLengthHeader: String(150 * MiB),
      }),
    ).toBe(UNDECLARED_UPLOAD_LIMIT_BYTES);
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
      "",
      null,
    ]) {
      expect(
        uploadReadLimitBytes({ declaredContentType }),
      ).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    }
  });

  it("leaves room for the rest of the form, not just the framing", () => {
    // Round-1 finding 4: the cap applies to the whole request stream, so
    // every other field is charged against the file's per-kind cap. At the
    // original 64 KiB a 10 MB image plus a 100 KB caption was a 413.
    const formOverhead = 100 * 1024;
    const wireBytes = MAX_IMAGE_UPLOAD_BYTES + formOverhead;

    expect(
      uploadReadLimitBytes({ declaredContentType: "image/png" }),
    ).toBeGreaterThanOrEqual(wireBytes);
    expect(MULTIPART_OVERHEAD_ALLOWANCE_BYTES).toBe(256 * 1024);
  });

  it("narrows to an honestly declared Content-Length", () => {
    expect(
      uploadReadLimitBytes({
        declaredContentType: "image/png",
        contentLengthHeader: String(2 * MiB),
      }),
    ).toBe(2 * MiB + MULTIPART_OVERHEAD_ALLOWANCE_BYTES);
  });

  it("lets Content-Length narrow but never widen", () => {
    expect(
      uploadReadLimitBytes({
        declaredContentType: "image/png",
        contentLengthHeader: String(500 * MiB),
      }),
    ).toBe(10 * MiB + MULTIPART_OVERHEAD_ALLOWANCE_BYTES);
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
    ).toBe(10 * MiB + MULTIPART_OVERHEAD_ALLOWANCE_BYTES);
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
        MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
      ),
    ).toBe(UPLOAD_BODY_BYTES + UPLOAD_BODY_COPIES * MULTIPART_OVERHEAD_ALLOWANCE_BYTES);
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
  //   solo      = spendable - 128 MiB               = 442_918_502  (422.4 MiB)
  //   maxSingle = floor(solo / 2) - 256 KiB         = 221_197_107  (211.0 MiB)
  //   projected = 320 MiB + max(decode + budget, solo + decode) = usable
  it("derives the recommended 1 GB configuration", () => {
    const settings = uploadFor(1024);

    expect(settings.watermark.usableBudgetBytes).toBe(912_680_550);
    expect(settings.watermark.limit).toBe(3);
    expect(settings.budgetBytes).toBe(174_483_046);
    expect(settings.soloReservationCeilingBytes).toBe(442_918_502);
    expect(settings.maxSingleUploadBytes).toBe(221_197_107);
    expect(settings.projectedUploadPathPeakBytes).toBe(912_680_550);
    expect(settings.fitsBudget).toBe(true);
  });

  it("accepts every upload the app allows at 1 GB, and not at 768 MB", () => {
    // The operator-facing consequence, and the reason maxSingleUploadBytes is
    // a field rather than an internal: a 200 MB video costs two copies plus
    // the form allowance, which 1 GB affords and 768 MB does not.
    expect(uploadFor(1024).maxSingleUploadBytes).toBeGreaterThan(200 * MiB);
    expect(uploadFor(768).maxSingleUploadBytes).toBeLessThan(200 * MiB);
    // Images fit everywhere, including the smallest container that runs.
    expect(uploadFor(512).maxSingleUploadBytes).toBeGreaterThanOrEqual(
      MAX_IMAGE_UPLOAD_BYTES,
    );
  });

  // Round-2 finding 2. A solo caller is alone in the *budget*, not in the
  // process: an image goes on to run a preview, and that decode lands on top
  // of the body it is still holding. Handing solo the whole spendable region
  // made the true peak `usable + DECODE` — 818,728,140 bytes inside a
  // 805,306,368-byte container at 768 MB, an OOM from a single upload.
  it.each([512, 640, 768, 1024, 1536, 2048, 4096])(
    "leaves room for the preview a solo upload then runs, at %i MB",
    (mb) => {
      const settings = uploadFor(mb);
      const soloPeak =
        PREVIEW_PROCESS_BASELINE_BYTES +
        settings.soloReservationCeilingBytes +
        PREVIEW_BYTES_PER_OPERATION;

      expect(settings.projectedUploadPathPeakBytes).toBeGreaterThanOrEqual(
        soloPeak,
      );
      if (settings.fitsBudget) {
        expect(soloPeak).toBeLessThanOrEqual(
          settings.watermark.usableBudgetBytes,
        );
      }
      // The container itself, not just the derated budget — the number the
      // kernel actually kills on.
      expect(soloPeak).toBeLessThanOrEqual(mb * MiB);
    },
  );

  it("admits exactly the burst the gate can hold at 1 GB", () => {
    const settings = uploadFor(1024);

    // The initial grant is what a burst is refused against, and it is one
    // maximum-size image's worth — so the arithmetic is the same whether the
    // burst is of images or of anything else claiming to be larger.
    expect(INITIAL_GRANT_BYTES).toBe(
      uploadReservationBytes(
        MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
      ),
    );
    expect(Math.floor(settings.budgetBytes / INITIAL_GRANT_BYTES)).toBe(
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

  // The two claims from resolveUploadMemorySettings, swept exhaustively at
  // every whole MB rather than at a handful of sampled sizes. Round-1
  // finding 3: the sampled sweep asserted the stronger claim and all eight
  // of its samples happened to miss the 26 sizes in 512-2048 MB where the
  // stronger claim is false. Sampling is how a claim like that survives.
  const EVERY_MB: number[] = [];
  for (let mb = 512; mb <= 4096; mb += 1) EVERY_MB.push(mb);

  it("never starves the gate's queue, priced as the gate prices it", () => {
    // Claim 1, the provable one: budgetBytes >= (limit + queueLimit) x
    // UPLOAD_BODY_BYTES, where UPLOAD_BODY_BYTES prices the file alone.
    const failures = EVERY_MB.filter((mb) => {
      const settings = uploadFor(mb);
      const gateHolds =
        settings.watermark.limit + settings.watermark.queueLimit;
      return settings.budgetBytes < gateHolds * UPLOAD_BODY_BYTES;
    });

    expect(failures).toEqual([]);
  });

  it("is at most one queue slot short of the gate, priced as the route reserves", () => {
    // Claim 2, the measured one. What the route actually reserves carries
    // MULTIPART_OVERHEAD_ALLOWANCE_BYTES that the gate's figure does not, so
    // at some sizes the budget affords one fewer maximum-size image than the
    // gate could hold. That is the safe direction; what must not happen is
    // it being worse than one, or the claim saying otherwise.
    const perMaxImage = uploadReservationBytes(
      MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
    );
    let worstShortfall = 0;
    let sizesShort = 0;

    for (const mb of EVERY_MB) {
      const settings = uploadFor(mb);
      const gateHolds =
        settings.watermark.limit + settings.watermark.queueLimit;
      const affords = Math.floor(settings.budgetBytes / perMaxImage);
      const shortfall = gateHolds - affords;
      if (shortfall > 0) {
        sizesShort += 1;
        worstShortfall = Math.max(worstShortfall, shortfall);
      }
    }

    expect(worstShortfall).toBeLessThanOrEqual(1);
    // Pinned so that raising the allowance — which would push this to two
    // slots at 1 MiB — cannot happen silently.
    expect(sizesShort).toBeLessThan(EVERY_MB.length / 10);
  });

  it("keeps the projected peak exactly at the usable budget wherever it fits", () => {
    const failures = EVERY_MB.filter((mb) => {
      const settings = uploadFor(mb);
      const expected =
        PREVIEW_PROCESS_BASELINE_BYTES +
        Math.max(
          settings.watermark.limit * PREVIEW_BYTES_PER_OPERATION +
            settings.budgetBytes,
          settings.soloReservationCeilingBytes + PREVIEW_BYTES_PER_OPERATION,
        );
      if (settings.projectedUploadPathPeakBytes !== expected) return true;
      // The Dockerfile says "the container limit less the 15% headroom, by
      // construction". This is the construction, asserted as an equality
      // rather than as "under it somewhere".
      return (
        settings.fitsBudget &&
        settings.projectedUploadPathPeakBytes !==
          settings.watermark.usableBudgetBytes
      );
    });

    expect(failures).toEqual([]);
  });

  it("keeps every reserving branch inside the container, not just inside the budget", () => {
    // Round-2 asked for the peak to be re-derived per branch and checked
    // against the container size rather than against the budget, because the
    // gap between the two is exactly where finding 2 lived: the solo ceiling
    // fitted the budget and the decode that followed it did not fit the
    // container.
    //
    // There are two shapes the process can be in, and the admission rule
    // admits nothing outside them:
    //   many holders — bodies bounded by budgetBytes, up to `limit` previews;
    //   one holder    — its body bounded by soloReservationCeilingBytes, and
    //                   the single preview it can be running.
    // Which branch produced the reservation (declared type, undeclared with
    // or without Content-Length) changes only the *ceiling*, never what the
    // rule will let be held, so it cannot move either peak.
    const failures: string[] = [];

    for (const mb of EVERY_MB) {
      const settings = uploadFor(mb);
      const manyPeak =
        PREVIEW_PROCESS_BASELINE_BYTES +
        settings.budgetBytes +
        settings.watermark.limit * PREVIEW_BYTES_PER_OPERATION;
      const soloPeak =
        PREVIEW_PROCESS_BASELINE_BYTES +
        settings.soloReservationCeilingBytes +
        PREVIEW_BYTES_PER_OPERATION;
      const peak = Math.max(manyPeak, soloPeak);

      if (peak > mb * MiB) failures.push(`${mb} MB: ${peak} over the container`);
      if (peak !== settings.projectedUploadPathPeakBytes) {
        failures.push(`${mb} MB: projection does not report the real peak`);
      }
      if (settings.fitsBudget && peak !== settings.watermark.usableBudgetBytes) {
        failures.push(`${mb} MB: peak is not the usable budget exactly`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("never lets any branch's ceiling exceed what one caller may hold", () => {
    // The ceiling is a rejection threshold, not a commitment — but it must
    // still be something the process could honour, or a request would be
    // admitted and then cut off part-way for no reason it could have known.
    const branches = (mb: number) => ({
      declaredImage: uploadReservationBytes(
        uploadReadLimitBytes({ declaredContentType: "image/png" }),
      ),
      declaredVideo: uploadReservationBytes(
        uploadReadLimitBytes({ declaredContentType: "video/mp4" }),
      ),
      undeclared: uploadReservationBytes(
        uploadReadLimitBytes({ declaredContentType: null }),
      ),
      undeclaredWithLength: uploadReservationBytes(
        uploadReadLimitBytes({
          declaredContentType: null,
          contentLengthHeader: String(4 * 1024 * MiB),
        }),
      ),
      _mb: mb,
    });

    for (const mb of [512, 640, 768, 1024, 2048, 4096]) {
      const settings = uploadFor(mb);
      const ceilings = branches(mb);

      // The image and undeclared branches must be admissible everywhere, or
      // the route would refuse ordinary uploads on a supported container.
      expect(ceilings.declaredImage).toBeLessThanOrEqual(
        settings.soloReservationCeilingBytes,
      );
      expect(ceilings.undeclared).toBeLessThanOrEqual(
        settings.soloReservationCeilingBytes,
      );
      // Content-Length cannot enlarge the undeclared branch, whatever it says.
      expect(ceilings.undeclaredWithLength).toBe(ceilings.undeclared);
      // Video is the branch that legitimately does not fit small containers,
      // and gets a 413 saying so rather than being admitted and then cut off.
      expect(ceilings.declaredVideo <= settings.soloReservationCeilingBytes).toBe(
        mb >= 1024,
      );
    }
  });

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
    expect(line).toContain("maxSingleUpload=211 MB");
    expect(line).toContain("projectedUploadPathPeak=870 MB");
  });
});

describe("createUploadMemoryBudget", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Shedding logs, throttled (round-1 finding 2). Reset so each test sees
    // its own throttle window, and captured so the block's output is the
    // assertions rather than the log lines.
    resetUploadMemoryBudget();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("logs a shed, so a saturated upload path is diagnosable at all", () => {
    // Round-1 finding 2. The route deliberately does not log its own 503 —
    // that is the convention ugcportal-u7g set for the gate's — but the gate
    // has its own throttled line and this budget had none, so one client
    // holding the budget produced five minutes of unexplained 503s.
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
    );
    budget.reserve(100);

    expect(() => budget.reserve(50)).toThrow(UploadMemoryExhaustedError);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[media] upload shed"),
    );
  });

  it("throttles the shed log instead of adding a log storm to a load problem", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
    );
    budget.reserve(100);

    for (let i = 0; i < 50; i += 1) {
      expect(() => budget.reserve(50)).toThrow(UploadMemoryExhaustedError);
    }

    // The transition into shedding is never delayed; the other 49 are counted
    // and reported on the next line rather than each getting one.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(budget.stats().shed).toBe(50);
  });

  // Round-3 finding 2. The first version of this logger copied the shape of
  // watermark.ts's and not its fix: with nothing to flush the tail, a burst
  // printed one line saying "1 shed since start" and lost the other 49 until
  // the next shed — possibly hours later, which then attributed them to that
  // moment. env.example tells operators to alert on exactly this line.
  it("reports the tail of a burst rather than losing it until the next shed", async () => {
    vi.useFakeTimers();
    try {
      const budget = createUploadMemoryBudget(
        budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
      );
      budget.reserve(100);
      for (let i = 0; i < 50; i += 1) {
        expect(() => budget.reserve(50)).toThrow(UploadMemoryExhaustedError);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Nothing else happens — no further shed to piggyback on. The timer is
      // what has to print the rest.
      await vi.advanceTimersByTimeAsync(SHED_LOG_INTERVAL_MS + 100);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenLastCalledWith(
        expect.stringContaining("upload shed 49 more since the last line"),
      );

      // And the tail is reported once, not on every tick after it.
      await vi.advanceTimersByTimeAsync(5 * SHED_LOG_INTERVAL_MS);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stats read reset the throttle clock", () => {
    // Callers get to ask; they do not get to turn the read into the throttle.
    // A health check polling during sustained shedding would otherwise emit a
    // line per poll while the line claimed one per interval.
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
    );
    budget.reserve(100);
    for (let i = 0; i < 10; i += 1) {
      expect(() => budget.reserve(50)).toThrow(UploadMemoryExhaustedError);
    }

    for (let i = 0; i < 10; i += 1) uploadMemoryStats();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("commits only the initial grant before a byte has been delivered", () => {
    // Round-2 finding 1, in one assertion: what a request claims it will send
    // buys a ceiling, not a commitment.
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 10_000_000,
        soloReservationCeilingBytes: 10_000_000,
      }),
    );

    const huge = budget.reserve(9_000_000);

    expect(huge.ceilingBytes).toBe(9_000_000);
    expect(huge.bytes).toBe(Math.min(9_000_000, INITIAL_GRANT_BYTES));
    expect(budget.stats().heldBytes).toBe(huge.bytes);
  });

  it("grows only as far as delivered bytes justify, and no further than the ceiling", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 600, soloReservationCeilingBytes: 600 }),
    );
    const reservation = budget.reserve(500);

    // Ceiling below the grant, so the grant is the ceiling.
    expect(reservation.bytes).toBe(500);
    // Already covered; a caller charging cumulative progress can call this
    // on every chunk without tracking what it last asked for.
    expect(reservation.growTo(100)).toBe(true);
    expect(budget.stats().heldBytes).toBe(500);
    // Past the ceiling is refused even with the budget wide open, so the
    // stream cap and this budget cannot disagree about the same request.
    expect(reservation.growTo(501)).toBe(false);
    expect(budget.stats().heldBytes).toBe(500);
  });

  it("grows past the budget only while nobody else holds anything", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 100, soloReservationCeilingBytes: 400 }),
    );
    const solo = budget.reserve(400);

    expect(solo.bytes).toBe(100 > INITIAL_GRANT_BYTES ? INITIAL_GRANT_BYTES : 400);
    expect(solo.growTo(400)).toBe(true);
    expect(budget.stats().heldBytes).toBe(400);
    // Over-committed now, so nothing else joins it.
    expect(() => budget.reserve(1)).toThrow(UploadMemoryExhaustedError);
  });

  it("refuses to grow when someone else is holding the budget", () => {
    // Scaled in grants, because growth past the grant is the path under test
    // and any ceiling below INITIAL_GRANT_BYTES is handed over in full.
    const grant = INITIAL_GRANT_BYTES;
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 3 * grant,
        soloReservationCeilingBytes: 10 * grant,
      }),
    );
    const a = budget.reserve(5 * grant);
    const b = budget.reserve(5 * grant);

    expect(a.bytes).toBe(grant);
    expect(b.bytes).toBe(grant);

    // a holds one grant, so b growing to three would put the pair at four
    // against a budget of three. Refused rather than the process going over.
    expect(b.growTo(3 * grant)).toBe(false);
    expect(budget.stats().heldBytes).toBe(2 * grant);
    expect(budget.stats().outgrown).toBe(1);
    // Counted separately from a refused admission: one is a request that
    // never started, the other is one cut off part-way.
    expect(budget.stats().shed).toBe(0);

    a.release();
    expect(b.growTo(3 * grant)).toBe(true);
    expect(budget.stats().heldBytes).toBe(3 * grant);
  });

  // Round-3 finding 1. Admission used to check only the fixed grant, so a
  // large upload streaming past the budget was killed the instant any small
  // upload was admitted behind it — the policy always sacrificed the
  // long-running request for the cheap latecomer, and retries never
  // converged. The right to finish is now earned by delivering bytes.
  it("keeps a latecomer out once an upload has earned the room to finish", () => {
    const grant = INITIAL_GRANT_BYTES;
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 4 * grant,
        soloReservationCeilingBytes: 10 * grant,
      }),
    );

    const big = budget.reserve(3 * grant);
    expect(big.bytes).toBe(grant);
    // Nothing is held against newcomers yet beyond what it actually has.
    expect(budget.stats().pledgedBytes).toBe(grant);

    // Delivering past the grant buys the whole ceiling, atomically.
    expect(big.growTo(grant + 1)).toBe(true);
    expect(budget.stats().pledgedBytes).toBe(3 * grant);
    expect(budget.stats().heldBytes).toBe(grant + 1);

    // A latecomer now fits in what is left, and no further.
    const small = budget.reserve(grant);
    expect(budget.stats().pledgedBytes).toBe(4 * grant);
    expect(() => budget.reserve(grant)).toThrow(UploadMemoryExhaustedError);

    // And the incumbent still finishes — which is the whole point. Before
    // this it was the incumbent that died here, at whatever point it had
    // reached, however many megabytes in.
    expect(big.growTo(3 * grant)).toBe(true);
    expect(budget.stats().heldBytes).toBe(3 * grant + grant);

    small.release();
    big.release();
    expect(budget.stats().heldBytes).toBe(0);
    expect(budget.stats().pledgedBytes).toBe(0);
  });

  it("refuses a large upload at the crossing, not part-way up the ceiling", () => {
    // The pledge is for the whole ceiling at once. Checking only the bytes in
    // hand would let the upload inch past the grant into a budget that could
    // never have held the rest of it — which is the shape that gets killed
    // at 87 MB instead of refused at 10.
    const grant = INITIAL_GRANT_BYTES;
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 3 * grant,
        soloReservationCeilingBytes: 10 * grant,
      }),
    );
    const blocker = budget.reserve(grant);
    const big = budget.reserve(5 * grant);

    // 1 grant blocked + 5 pledged is over a 3-grant budget, and `blocker`
    // means the solo path is closed, so the crossing is refused...
    expect(big.growTo(grant + 1)).toBe(false);
    expect(budget.stats().outgrown).toBe(1);
    // ...at the crossing, with the reservation still where it was, rather
    // than several grants further along.
    expect(big.bytes).toBe(grant);
    expect(budget.stats().heldBytes).toBe(2 * grant);

    // Once the budget frees up, the same upload can buy the room.
    blocker.release();
    expect(big.growTo(grant + 1)).toBe(true);
    expect(budget.stats().pledgedBytes).toBe(5 * grant);
  });

  it("lets a claimed-large upload that never delivers exclude nobody", () => {
    // The round-2 property, which the round-3 fix must not undo: pledging at
    // admission would have made "declare a 200 MB video and stall" a way to
    // shut the route down. The entry price is real bytes.
    const grant = INITIAL_GRANT_BYTES;
    const budget = createUploadMemoryBudget(
      budgetOf({
        budgetBytes: 4 * grant,
        soloReservationCeilingBytes: 10 * grant,
      }),
    );

    const claimant = budget.reserve(9 * grant);
    // Delivered nothing past the grant, so it holds nothing past the grant.
    expect(budget.stats().pledgedBytes).toBe(grant);

    // Three more ordinary uploads still get in.
    const others = [0, 1, 2].map(() => budget.reserve(grant));
    expect(budget.stats().admitted).toBe(4);
    expect(budget.stats().shed).toBe(0);

    for (const r of others) r.release();
    claimant.release();
  });

  it("releases whatever it had grown to, not what it started at", () => {
    const budget = createUploadMemoryBudget(
      budgetOf({ budgetBytes: 1000, soloReservationCeilingBytes: 1000 }),
    );
    const reservation = budget.reserve(900);
    reservation.growTo(900);
    expect(budget.stats().heldBytes).toBe(900);

    reservation.release();

    // A reservation that released its grant instead of its grown size would
    // leak the difference on every large upload, shrinking the budget until
    // the route refused everything.
    expect(budget.stats().heldBytes).toBe(0);
    expect(reservation.growTo(900)).toBe(false);
  });

  it("never holds more than the solo ceiling, under arbitrary interleaving, with growth", () => {
    // The bound itself with the metered path exercised: reserve, grow and
    // release in a long randomised sequence, checked after every operation.
    const grant = INITIAL_GRANT_BYTES;
    const settings = budgetOf({
      budgetBytes: 3 * grant,
      soloReservationCeilingBytes: 7 * grant,
    });
    const budget = createUploadMemoryBudget(settings);
    const held: UploadReservation[] = [];
    let seed = 776_211;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    // Ceilings spanning the grant, so both the "granted in full" and the
    // "has to grow" shapes occur.
    const size = () => 1 + (next() % (4 * grant));

    for (let step = 0; step < 5000; step += 1) {
      const roll = next() % 3;
      if (held.length > 0 && roll === 0) {
        held.splice(next() % held.length, 1)[0].release();
      } else if (held.length > 0 && roll === 1) {
        held[next() % held.length].growTo(size());
      } else {
        try {
          held.push(budget.reserve(size()));
        } catch {
          // Shed or refused; both are correct answers here.
        }
      }
      expect(budget.stats().heldBytes).toBeLessThanOrEqual(
        settings.soloReservationCeilingBytes,
      );
      expect(budget.stats().heldBytes).toBeGreaterThanOrEqual(0);
      // The sum of what the holders think they have must equal what the
      // budget thinks it has handed out, or a release will corrupt the count.
      expect(held.reduce((total, r) => total + r.bytes, 0)).toBe(
        budget.stats().heldBytes,
      );
    }

    expect(budget.stats().outgrown).toBeGreaterThan(0);
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
