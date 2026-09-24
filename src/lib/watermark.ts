import sharp from "sharp";

import type { ConcurrencyGate, ConcurrencyLimitReason } from "@/lib/concurrency-gate";
import {
  ConcurrencyLimitError,
  createConcurrencyGate,
} from "@/lib/concurrency-gate";
import type { CpuBudget, MemoryBudget } from "@/lib/container-limits";
import { detectCpuBudget, detectMemoryBudget } from "@/lib/container-limits";
import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/media";

// Longest-edge cap for a generated preview.
//
// A watermarked copy at the original's full resolution is nearly as valuable
// as the original itself, which would undermine the paid-original model
// (ugcportal-5d6) even with a mark on it. 1280px is large enough to look good
// in a gallery lightbox on a normal screen, and far below what a modern
// camera or phone produces (typically 3000-6000px), so the buyer is still
// paying for something the browser never handed out.
export const PREVIEW_MAX_DIMENSION = 1280;

// ...but a cap alone only bites on uploads bigger than the cap. An original
// at or below 1280px would otherwise come back as a preview at the original's
// exact resolution, and for that whole class of upload the argument above
// would simply not hold — the buyer would be paying for a mark removal, not
// for pixels. So the preview is additionally never more than this fraction of
// the original's longest edge, which makes "the preview is strictly smaller
// than the original" true for every upload rather than only for large ones.
export const PREVIEW_MAX_SCALE = 0.75;

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
// camera.
//
// What this bounds is exactly one decode: a single call cannot expand past
// ~50 MP instead of tens of GB. It says nothing on its own about how many
// such decodes run at once — that is the job of the concurrency gate below
// (ugcportal-e86), and the two only bound the process *together*: this
// constant fixes the worst case of one operation, and the gate fixes how
// many worst cases can overlap.
export const MAX_INPUT_PIXELS = 50_000_000;

// ---------------------------------------------------------------------------
// Concurrency gate (ugcportal-e86)
//
// Preview generation is the one thing this app does that allocates hundreds of
// megabytes *outside* the V8 heap: libvips buffers live in native memory, so
// --max-old-space-size does not see them, the GC does not bound them, and the
// only component that has an opinion about the total is the kernel's OOM
// killer. Bounding one decode (MAX_INPUT_PIXELS) therefore bounds nothing
// about the process; a burst of concurrent uploads multiplies it.
//
// Policy, stated rather than emergent — a bounded queue that degrades into
// load shedding:
//
//   * up to `limit` previews render at once;
//   * the next `queueLimit` callers wait for a slot;
//   * a caller that waits longer than `queueTimeoutMs`, or that arrives when
//     the queue is already full, is rejected with a WatermarkOverloadedError
//     carrying a retryAfterSeconds hint. It is never partially processed, and
//     no upload is ever stored without its preview.
//
// Why not pure shedding: uploads arrive in bursts by construction (a
// multi-file picker sends every file at once), and a limit small enough to
// protect a 1 GB container would fail most of a perfectly ordinary five-image
// selection while the server is nearly idle a second later. On the default 1
// GB reference configuration below, a five-image burst is fully absorbed
// (limit 3 + queue 12) and nothing sheds.
//
// Why not an unbounded queue: it converts a memory problem into a latency
// problem and holds HTTP connections open while it does so, which is how a
// saturated service stops responding to health checks and gets restarted —
// the outage it was supposed to prevent, with a different cause in the
// postmortem. Under *sustained* overload (arrival rate above service rate) a
// queue cannot help by definition; shedding is the only honest answer, and
// the cap plus the timeout are what force the degradation to happen at a
// predictable point instead of at whatever depth the heap dies.
//
// A queued upload is NOT free, and the queue is bounded in bytes because of
// it. The gate copies nothing — the body is already buffered by the HTTP
// layer before this module is reached — but waiting keeps that body alive
// alongside every other queued one, when they would otherwise have been
// freed one at a time. See QUEUED_UPLOAD_BYTES, and the budget allocation in
// resolveWatermarkConcurrencySettings.

/**
 * Native memory to reserve for everything that is not preview work: the Next
 * server, the V8 heap, Prisma/libsql, the S3 client's buffers.
 *
 * Deliberately does *not* include queued upload bodies. An earlier version of
 * this constant did, hand-waving them in as "plus a request body or two",
 * which was wrong in a way worth naming: queued bodies scale with the queue
 * depth, which scales with the limit, which is derived from this. Folding a
 * variable into a constant that sizes it is circular, and it under-counted by
 * however deep the queue happened to go. They are now priced separately as
 * {@link QUEUED_UPLOAD_BYTES} and allocated out of the budget explicitly.
 *
 * Still an estimate, and flagged as one: it has not been measured against the
 * production image, only reasoned from a Next standalone server's typical
 * resident set. If it is wrong the derived limit is wrong with it, which is
 * what WATERMARK_MAX_CONCURRENCY exists to correct without a deploy.
 */
export const PREVIEW_PROCESS_BASELINE_BYTES = 320 * 1024 * 1024;

/**
 * Peak additional resident memory one preview costs, worst case.
 *
 * Measured, not guessed — but measured on darwin/arm64 with the same sharp
 * 0.35.4 / libvips 8.18.6 this app depends on, not inside the alpine image,
 * so treat it as the right order of magnitude rather than an exact figure for
 * production. A 49 MP PNG (the worst case MAX_INPUT_PIXELS allows, and worse
 * than JPEG because libvips cannot shrink-on-load it) cost ~66 MB of peak RSS
 * per operation with one libvips thread and ~85 MB with sharp's default of
 * four; the same image as JPEG cost ~31-40 MB. 128 MB is ~1.5x the worst
 * observed figure, which is the headroom for the allocator behaving
 * differently under musl than under darwin's.
 */
export const PREVIEW_BYTES_PER_OPERATION = 128 * 1024 * 1024;

/**
 * Resident memory one *queued* upload holds alive while it waits.
 *
 * Twice the image upload cap, because src/app/api/media/route.ts materialises
 * the body twice before it ever reaches this module: `await
 * request.formData()` produces a File holding the bytes, and
 * `Buffer.from(await file.arrayBuffer())` copies them into a Buffer that
 * stays referenced for the whole handler. Both are alive for the entire wait.
 *
 * This is the correction to the original reasoning that "queueing costs no
 * extra memory because the body is already buffered". True as far as it goes
 * — the gate does not copy anything — but the conclusion drawn from it was
 * wrong: the cost of a queue is not the copy, it is keeping N bodies
 * *simultaneously* alive that would otherwise have been freed one at a time.
 * At a 20-deep queue that is 400 MB, which is not a rounding error against a
 * 1 GB container.
 */
export const QUEUED_UPLOAD_BYTES = 2 * MAX_IMAGE_UPLOAD_BYTES;

/**
 * Absolute ceiling on the derived limit, whatever any budget says.
 *
 * The effective ceiling is usually lower; see
 * {@link resolveConcurrencyCeiling}. This one only exists so a host with
 * enormous limits cannot derive something absurd.
 */
export const MAX_DERIVED_CONCURRENCY = 8;

/**
 * libuv's default worker-thread count, used when UV_THREADPOOL_SIZE is unset.
 *
 * Relevant because sharp's async work runs *on* that pool: each in-flight
 * preview occupies one libuv worker for its whole duration. It is the same
 * pool `dns.lookup` and async fs use, and every preview here is immediately
 * followed by an S3 PutObject that needs a DNS resolution.
 */
export const LIBUV_DEFAULT_THREADPOOL_SIZE = 4;

/** Queue depth per slot, i.e. worst-case wait of ~4 preview durations. */
export const DEFAULT_QUEUE_DEPTH_PER_SLOT = 4;

/**
 * How long a queued upload may wait. Well inside a typical 30-60s proxy or
 * browser upload timeout, so an overloaded server answers rather than having
 * the connection cut from the other end with nothing logged.
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 10_000;

/**
 * Cap on libvips threads per preview; see {@link resolveSharpThreads}.
 */
export const MAX_SHARP_THREADS_PER_OPERATION = 4;

/**
 * Smallest memory budget in which the gate can honour its own arithmetic:
 * the baseline plus one preview. Below this the limit is clamped up to 1 (a
 * gate that admits nothing is not an improvement on an OOM) and the
 * configuration is, by its own reckoning, over budget — which
 * {@link resolveWatermarkConcurrencySettings} reports via `fitsBudget` and
 * getGate() logs a warning about.
 */
export const MIN_VIABLE_BUDGET_BYTES =
  PREVIEW_PROCESS_BASELINE_BYTES + PREVIEW_BYTES_PER_OPERATION;

/**
 * Just the variables this module reads.
 *
 * Narrower than NodeJS.ProcessEnv on purpose: process.env is assignable to
 * it, but a test can pass a literal without having to fabricate NODE_ENV and
 * everything else the app's ProcessEnv declaration requires.
 */
export interface WatermarkConcurrencyEnv {
  readonly WATERMARK_MAX_CONCURRENCY?: string;
  readonly WATERMARK_QUEUE_LIMIT?: string;
  readonly WATERMARK_QUEUE_TIMEOUT_MS?: string;
  readonly WATERMARK_SHARP_THREADS?: string;
  readonly UV_THREADPOOL_SIZE?: string;
  // Present so process.env (which is an index-signature type) is assignable
  // without also making this a "weak type" TypeScript refuses to accept it
  // into. The named keys above are documentation, not a closed set.
  readonly [key: string]: string | undefined;
}

export interface WatermarkConcurrencySettings {
  limit: number;
  queueLimit: number;
  queueTimeoutMs: number;
  sharpThreads: number;
  /** Where the numbers above came from, for logging and for tests. */
  budgetBytes: number;
  budgetSource: MemoryBudget["source"];
  cpus: number;
  cpuSource: CpuBudget["source"];
  limitSource: "env" | "derived";
  /** Worst-case resident memory this configuration can reach. */
  projectedPeakBytes: number;
  /** False when `projectedPeakBytes` exceeds the budget; see MIN_VIABLE_BUDGET_BYTES. */
  fitsBudget: boolean;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * The most previews it makes sense to run at once, before memory is even
 * considered.
 *
 * Bounded by libuv's worker pool, not by CPU count, because that is the
 * resource an in-flight preview actually holds: sharp's async work runs on a
 * libuv worker for the duration of the operation. Going past the pool size
 * buys nothing — slots beyond it hold previews that are sitting in libuv's
 * own queue doing no work, which is a strictly worse way to queue than this
 * gate (no cap, no timeout, no visibility). It is also very likely the real
 * explanation for the 8-vs-4 timing measured during this work (376ms against
 * 226ms on a 10-core machine, which was originally read as CPU saturation;
 * with a 4-worker pool, 8 concurrent previews cannot have been running 8-wide
 * whatever the core count).
 *
 * One worker is left free on purpose. The pool is shared with `dns.lookup`
 * and async fs, and every preview here is immediately followed by an S3
 * PutObject that needs DNS — saturating the pool with previews would stall
 * the very uploads the previews belong to.
 *
 * Raising UV_THREADPOOL_SIZE raises this. That is the supported way to get a
 * limit above 3 out of a large container, and it is documented in
 * env.example; the alternative, setting it from inside the process, does not
 * work reliably because libuv reads it when the pool is first used, which has
 * long since happened by the time a request arrives.
 */
export function resolveConcurrencyCeiling(
  env: WatermarkConcurrencyEnv = process.env,
): number {
  const poolSize =
    positiveInt(env.UV_THREADPOOL_SIZE) ?? LIBUV_DEFAULT_THREADPOOL_SIZE;
  return Math.min(MAX_DERIVED_CONCURRENCY, Math.max(1, poolSize - 1));
}

/**
 * libvips threads to allow *per preview*.
 *
 * sharp's `concurrency` is not a cap on how many images are processed at
 * once — it is "the maximum number of threads libvips should use to process
 * *each image*" (sharp's own wording). So it multiplies with this gate rather
 * than substituting for it: N concurrent previews at the default thread count
 * is N thread pools, each with its own tile buffers. Measured on a 10-core
 * machine with four concurrent 49 MP PNG previews: 253 MB of peak RSS at one
 * thread per image, 337 MB at sharp's default of four, 417 MB at ten — a 65%
 * memory swing with *no* throughput difference at all (208ms in every case),
 * because at four concurrent images the machine is already busy.
 *
 * So the answer to "does it interact with the gate" is yes, and leaving it
 * alone would have quietly invalidated the memory arithmetic. Two reasons to
 * pin it rather than trust the default:
 *
 *  1. it is the difference between the memory budget meaning something and
 *     not, per the measurements above; and
 *  2. the default is the host's core count (on musl — sharp's
 *     one-thread-on-glibc-without-jemalloc exception does not apply to the
 *     alpine image), and glib reads that from the machine, not from the
 *     cgroup's CPU quota. A 2-vCPU container on a 64-core host would default
 *     to 64 threads per image.
 *
 * `cpus` must therefore be the *effective* CPU count from
 * detectCpuBudget() and not os.availableParallelism(), which has exactly the
 * blind spot in (2): a CFS bandwidth quota (`docker run --cpus=2`) does not
 * narrow the affinity mask, so availableParallelism() keeps reporting the
 * host's cores and this rule would hand out host-sized thread pools inside a
 * two-CPU container.
 *
 * The rule keeps *total* libvips threads at roughly one per effective CPU
 * instead of one per CPU per in-flight image. The cost is real but small and
 * only paid when the server is idle: a single lone 49 MP PNG preview took
 * ~169ms with one thread against ~158ms with four (3-run means), because the
 * PNG decode dominates and does not parallelise well.
 */
export function resolveSharpThreads(
  limit: number,
  cpus: number,
  override?: number,
): number {
  if (override !== undefined) return override;
  return Math.min(
    MAX_SHARP_THREADS_PER_OPERATION,
    Math.max(1, Math.floor(cpus / Math.max(1, limit))),
  );
}

/**
 * The gate's configuration, derived from the container's memory budget.
 *
 * "Derived from the budget, not guessed" is the whole point (and the bead's
 * explicit requirement): the number of previews that may overlap is whatever
 * fits in the memory the kernel will actually kill us for exceeding, after
 * reserving what the rest of the process needs. detectMemoryBudget() reads
 * that from the cgroup; if there is no cgroup limit it falls back to host RAM
 * and says so, and on a shared host that will over-provision — which is why
 * the Dockerfile documents running with an explicit `--memory`, why getGate()
 * logs a warning when it sees `source: "host"`, and why
 * WATERMARK_MAX_CONCURRENCY can override the result outright.
 *
 * The budget is spent in a fixed order, so the total is bounded by
 * construction rather than by hoping the parts add up:
 *
 *   1. the process baseline comes off the top;
 *   2. in-flight previews take what is left, capped by
 *      resolveConcurrencyCeiling();
 *   3. the queue gets whatever remains after that, in whole queued-upload
 *      bytes, capped at DEFAULT_QUEUE_DEPTH_PER_SLOT per slot so a large
 *      container does not buy a queue so deep that the wait is pointless.
 *
 * Step 3 is why the queue is bounded by *bytes* and not simply by 4x the
 * limit. A queued upload is not free — it holds ~20 MB of request body alive
 * (see QUEUED_UPLOAD_BYTES) — so a fixed multiple would let a 1 GB container
 * configure 5 in-flight previews and 20 queued bodies, i.e. ~640 MB of
 * preview work plus ~400 MB of queued bodies plus a 320 MB baseline, which
 * is 1.36 GB in a 1 GB box. The gate would then have been a mechanism for
 * causing the exact OOM it exists to prevent.
 *
 * Reference points, recomputed from the constants above rather than carried
 * over (default UV_THREADPOOL_SIZE, so the ceiling is 3). "Burst" is the
 * number of simultaneous uploads absorbed with nothing shed, i.e. limit plus
 * queue:
 *
 *   512 MB -> limit 1, queue 3   burst 4   (projected 508 MB)
 *   768 MB -> limit 3, queue 3   burst 6   (projected 764 MB)
 *     1 GB -> limit 3, queue 12  burst 15  (projected 944 MB)
 *     2 GB -> limit 3, queue 12  burst 15  (projected 944 MB; ceiling-bound,
 *             not memory-bound — raise UV_THREADPOOL_SIZE to use the rest)
 *
 * **768 MB is the practical floor, and 1 GB the recommended one.** At 512 MB
 * a burst of four is absorbed and the fifth sheds — one short of the
 * five-image multi-select used above to argue against pure shedding, and
 * today that shed is an unretryable 500 (see WatermarkOverloadedError and
 * ugcportal-u7g). That is not a tuning mistake to be papered over: 320 MB
 * baseline + 128 MB of preview + 5 x 20 MB of queued bodies is 548 MB, so a
 * 512 MB container genuinely cannot hold that burst. The choice is between
 * shedding it and being OOM-killed by it, and no arrangement of these
 * constants changes that. Give the container 1 GB, or accept that small
 * bursts shed.
 *
 * Below MIN_VIABLE_BUDGET_BYTES (448 MB) it gets worse: the limit is clamped
 * up to 1 and `fitsBudget` goes false, meaning the configuration is over
 * budget by its own reckoning and getGate() warns about it at startup.
 *
 * Every input is a parameter so this is testable without a container.
 */
export function resolveWatermarkConcurrencySettings(
  env: WatermarkConcurrencyEnv = process.env,
  budget: MemoryBudget = detectMemoryBudget(),
  cpu: CpuBudget = detectCpuBudget(),
): WatermarkConcurrencySettings {
  const override = positiveInt(env.WATERMARK_MAX_CONCURRENCY);
  const forPreviews = budget.bytes - PREVIEW_PROCESS_BASELINE_BYTES;
  const limit =
    override ??
    Math.min(
      resolveConcurrencyCeiling(env),
      Math.max(1, Math.floor(forPreviews / PREVIEW_BYTES_PER_OPERATION)),
    );

  const forQueue = forPreviews - limit * PREVIEW_BYTES_PER_OPERATION;
  const queueLimit =
    nonNegativeInt(env.WATERMARK_QUEUE_LIMIT) ??
    Math.min(
      limit * DEFAULT_QUEUE_DEPTH_PER_SLOT,
      Math.max(0, Math.floor(forQueue / QUEUED_UPLOAD_BYTES)),
    );

  const projectedPeakBytes =
    PREVIEW_PROCESS_BASELINE_BYTES +
    limit * PREVIEW_BYTES_PER_OPERATION +
    queueLimit * QUEUED_UPLOAD_BYTES;

  return {
    limit,
    queueLimit,
    queueTimeoutMs:
      positiveInt(env.WATERMARK_QUEUE_TIMEOUT_MS) ?? DEFAULT_QUEUE_TIMEOUT_MS,
    sharpThreads: resolveSharpThreads(
      limit,
      cpu.cpus,
      positiveInt(env.WATERMARK_SHARP_THREADS),
    ),
    budgetBytes: budget.bytes,
    budgetSource: budget.source,
    cpus: cpu.cpus,
    cpuSource: cpu.source,
    limitSource: override === undefined ? "derived" : "env",
    projectedPeakBytes,
    fitsBudget: projectedPeakBytes <= budget.bytes,
  };
}

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * One line at startup describing the configuration and, crucially, where it
 * came from.
 *
 * Without this the provenance tracked through
 * {@link WatermarkConcurrencySettings} is decoration: detectMemoryBudget()
 * goes to the trouble of reporting `source: "host"` precisely so a missing
 * container memory limit is noticeable, and the Dockerfile tells operators to
 * set one — but if nobody ever prints it, the only signal that the limit was
 * derived from a 256 GB shared host instead of a 1 GB container is the OOM
 * kill it was supposed to prevent.
 *
 * Exported so the message can be asserted on rather than eyeballed.
 */
export function describeWatermarkConcurrency(
  settings: WatermarkConcurrencySettings,
): string {
  return [
    `[watermark] preview concurrency limit=${settings.limit} (${settings.limitSource})`,
    `queue=${settings.queueLimit}`,
    `timeout=${settings.queueTimeoutMs}ms`,
    `libvipsThreadsPerPreview=${settings.sharpThreads}`,
    `memoryBudget=${mib(settings.budgetBytes)} (${settings.budgetSource})`,
    `cpuBudget=${settings.cpus} (${settings.cpuSource})`,
    `projectedPeak=${mib(settings.projectedPeakBytes)}`,
  ].join(" ");
}

function logConcurrencySettings(settings: WatermarkConcurrencySettings): void {
  const line = describeWatermarkConcurrency(settings);
  const warnings: string[] = [];

  if (settings.budgetSource === "host") {
    warnings.push(
      "no container memory limit found, so the limit was derived from total host RAM; run the container with an explicit memory limit (see the Dockerfile) or set WATERMARK_MAX_CONCURRENCY",
    );
  }
  if (!settings.fitsBudget) {
    warnings.push(
      `projected peak memory exceeds the budget by ${mib(settings.projectedPeakBytes - settings.budgetBytes)}; this container is below the ${mib(MIN_VIABLE_BUDGET_BYTES)} floor one preview needs`,
    );
  }

  if (warnings.length > 0) {
    console.warn(`${line} — ${warnings.join("; ")}`);
    return;
  }
  console.info(line);
}

let gate: ConcurrencyGate | undefined;
let gateSettings: WatermarkConcurrencySettings | undefined;

/**
 * Built on first use rather than at import time, so the configuration is read
 * after the runtime has finished populating process.env — and so importing
 * this module for `resolveWatermarkText` does not reconfigure libvips, or log
 * a startup line, as a side effect.
 */
function getGate(): ConcurrencyGate {
  if (gate) return gate;

  const settings = resolveWatermarkConcurrencySettings();
  // Process-global, and applied here because this is the only sharp user in
  // the app; if that changes, this becomes a shared setting and should move.
  sharp.concurrency(settings.sharpThreads);
  logConcurrencySettings(settings);
  gateSettings = settings;
  gate = createConcurrencyGate({
    name: "watermark preview generation",
    limit: settings.limit,
    queueLimit: settings.queueLimit,
    queueTimeoutMs: settings.queueTimeoutMs,
  });
  return gate;
}

/**
 * Live view of the gate, for tests and for anything that wants to log how
 * close the process is running to its bound.
 */
export function watermarkConcurrencyStats() {
  const stats = getGate().stats();
  return { ...stats, settings: gateSettings as WatermarkConcurrencySettings };
}

/**
 * Drops the memoised gate so the next call rebuilds it from the current
 * environment. Exists for tests; nothing in the app calls it, because
 * resizing a live pool would let in-flight work exceed either bound.
 */
export function resetWatermarkConcurrencyGate(): void {
  gate = undefined;
  gateSettings = undefined;
}

// Fallback when WATERMARK_TEXT is unset. Documented in env.example.
const DEFAULT_WATERMARK_TEXT = "ugcportal";

// Cap on the configured text so a silly-long value can't turn every preview
// into an unreadable smear (and can't blow up the generated SVG).
const MAX_WATERMARK_TEXT_LENGTH = 40;

// Named first so the font the Dockerfile installs is the one actually picked;
// the rest are there for local dev on macOS/Linux workstations.
const FONT_STACK = "DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif";

// Rough average advance width of a sans-serif glyph, in em. librsvg won't
// measure text for us, so tile geometry is estimated from the glyph count.
const GLYPH_ADVANCE_EM = 0.62;

// A single run of the watermark text may occupy at most this fraction of the
// preview's width. The tile is 1.8x a run, so 0.25 aims at a tile under half
// the frame — i.e. the pattern repeats horizontally rather than collapsing
// into one isolated run, which is the croppable single stamp the tiling
// exists to avoid.
//
// "Aims at", not "guarantees": MIN_FONT_SIZE below can override the
// shrink-to-fit on small frames, and then the tile grows past half the width
// again. Measured with the 40-character maximum text: a 1280x853 landscape
// preview lands at 0.42 of the width, a 853x1280 portrait one at 0.52, and a
// 640x480 at 0.70. What survives in every case is the thing that actually
// matters — the mark is rotated and repeats vertically too, so full-frame
// coverage stays around 13% spread evenly across all four quadrants. The
// horizontal repeat is what degrades on small frames, not the protection.
const MAX_TEXT_RUN_FRACTION = 0.25;

// Floor for the shrink-to-fit above, so a 40-character brand name on a small
// preview still produces something readable rather than a grey haze. This is
// a deliberate trade of horizontal repeats for legibility; see above for what
// it costs.
const MIN_FONT_SIZE = 10;

/**
 * Thrown when a preview cannot be produced from *this particular file* — an
 * undecodable/corrupt image, or one over the pixel limit. Callers must treat
 * it as fatal for the upload: see the failure policy in
 * src/app/api/media/route.ts. Never fall back to serving the original.
 */
export class WatermarkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WatermarkError";
  }
}

/**
 * Thrown when the *runtime* cannot draw text at all, i.e. no usable font is
 * installed. Deliberately not a {@link WatermarkError}: nothing is wrong with
 * the upload, the deployment is broken, and every image would come out with
 * an unreadable mark on it. Callers should let this surface as a 5xx rather
 * than blaming the file.
 */
export class WatermarkFontUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WatermarkFontUnavailableError";
  }
}

/**
 * Thrown when the *service* is too busy to start this preview (ugcportal-e86)
 * — the concurrency gate was full and either the queue was too, or the wait
 * ran past its timeout.
 *
 * Deliberately not a {@link WatermarkError}: nothing is wrong with the file,
 * and mapping it to a 4xx would blame the uploader for the server's capacity
 * and hide a saturation incident from alerting. It is the one error here that
 * is genuinely worth retrying, hence {@link retryAfterSeconds}.
 *
 * Caveat, stated plainly: src/app/api/media/route.ts currently rethrows
 * everything that is not a WatermarkError, so today this surfaces as a 500
 * with no Retry-After rather than the 503 it deserves. The honest mapping is
 * a few lines in that route, which is owned by another change in flight, so
 * it is tracked separately (ugcportal-u7g) — the shape of this error (a
 * distinct class carrying retryAfterSeconds) is what makes that a one-liner
 * when it lands. Blame-wise the current behaviour is already correct: a 5xx,
 * logged as "watermark service unavailable".
 */
export class WatermarkOverloadedError extends Error {
  readonly reason: ConcurrencyLimitReason;
  readonly retryAfterSeconds: number;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      reason: ConcurrencyLimitReason;
      retryAfterSeconds: number;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "WatermarkOverloadedError";
    this.reason = options.reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
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

/**
 * Drop every code point XML 1.0 forbids in character data.
 *
 * Entity-escaping alone is not enough: a control character such as a form
 * feed is not escapable, and librsvg rejects the whole document with
 * "PCDATA invalid Char value 12". Since the text comes from WATERMARK_TEXT,
 * that would turn one bad environment variable into a 422 on *every* image
 * upload. Iterating with for..of walks whole code points, so astral
 * characters (emoji) survive as pairs while lone surrogates — also illegal —
 * are dropped.
 */
function stripXmlIllegalChars(value: string): string {
  let out = "";
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    const legal =
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      cp >= 0x10000;
    if (legal) out += char;
  }
  return out;
}

/**
 * The watermark text, guaranteed safe to interpolate into the overlay SVG:
 * whitespace collapsed to single spaces (a multi-line mark makes no sense in
 * a tiled single-line <text>), XML-illegal code points removed, trimmed, and
 * length-capped. Falls back to the default if sanitising leaves nothing.
 */
export function resolveWatermarkText(override?: string): string {
  const raw = override ?? process.env.WATERMARK_TEXT ?? "";
  const cleaned = stripXmlIllegalChars(raw.replace(/\s+/g, " ")).trim();
  const text = cleaned.length > 0 ? cleaned : DEFAULT_WATERMARK_TEXT;
  // Truncate by code point, not by UTF-16 code unit. String.slice would cut an
  // astral character in half and leave a lone surrogate — the very thing
  // stripXmlIllegalChars just walked by code point to remove — which
  // Buffer.from then renders as a stray U+FFFD tiled across every preview.
  return [...text].slice(0, MAX_WATERMARK_TEXT_LENGTH).join("");
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
 * Each element is drawn as a white/black pair so it stays visible over both
 * light and dark photographs, at an opacity low enough to leave the image
 * readable.
 *
 * The tile also draws two rules, which need no font. libvips ships no font
 * files of its own — it renders text through whatever fontconfig finds on the
 * host — so a misconfigured runtime could otherwise produce a completely
 * unmarked "preview". {@link assertWatermarkFontAvailable} makes that case a
 * hard error rather than a silent one; the rules are the second line of
 * defence, and are positioned strictly inside the tile so the pattern repeat
 * cannot clip them away (drawing on the tile boundary loses half the stroke
 * and renders them all but invisible).
 *
 * Exported so tests can strip the glyphs and verify what a fontless runtime
 * would actually produce.
 */
export function buildWatermarkOverlaySvg(
  width: number,
  height: number,
  text: string,
): string {
  const safeText = escapeXml(text);
  const glyphs = Math.max(1, text.length);

  // Size to the frame first...
  const framedFontSize = Math.min(
    48,
    Math.max(14, Math.round(Math.min(width, height) * 0.045)),
  );
  // ...then shrink to fit the text, so tile width stays a function of the
  // frame rather than of how long someone's brand name is. Without this a
  // 40-character WATERMARK_TEXT (the cap env.example invites) produces a tile
  // wider than a 1280px preview and the repeat degenerates into a couple of
  // isolated runs.
  const fittedFontSize = Math.floor(
    (width * MAX_TEXT_RUN_FRACTION) / (glyphs * GLYPH_ADVANCE_EM),
  );
  const fontSize = Math.max(
    MIN_FONT_SIZE,
    Math.min(framedFontSize, fittedFontSize),
  );

  const estimatedTextWidth = glyphs * fontSize * GLYPH_ADVANCE_EM;
  const tileWidth = Math.round(estimatedTextWidth * 1.8);
  const tileHeight = Math.round(fontSize * 4);
  const textStrokeWidth = Math.max(1, fontSize / 24);
  const ruleWidth = Math.max(1, Math.round(fontSize / 16));

  // Quarter and three-quarter height: evenly spaced, and far enough from the
  // tile edges that the full stroke of both the white rule and its dark
  // companion survives the repeat.
  const rules = [Math.round(tileHeight / 4), Math.round((tileHeight * 3) / 4)]
    .flatMap((y) => [
      `<line x1="0" y1="${y}" x2="${tileWidth}" y2="${y}" stroke="white" stroke-opacity="0.22" stroke-width="${ruleWidth}" />`,
      `<line x1="0" y1="${y + ruleWidth}" x2="${tileWidth}" y2="${y + ruleWidth}" stroke="black" stroke-opacity="0.16" stroke-width="${ruleWidth}" />`,
    ])
    .join("\n      ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <pattern id="wm" width="${tileWidth}" height="${tileHeight}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      ${rules}
      <g font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="600" fill="white" fill-opacity="0.34" stroke="black" stroke-opacity="0.18" stroke-width="${textStrokeWidth}" paint-order="stroke">
        <text x="0" y="${fontSize}">${safeText}</text>
        <text x="${Math.round(tileWidth / 2)}" y="${Math.round(tileHeight / 2 + fontSize)}">${safeText}</text>
      </g>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#wm)" />
</svg>`;
}

/**
 * Two distinguishable outcomes, because they call for opposite operator
 * actions: "no glyphs came out" means install a font, while "the probe threw"
 * usually means something transient and has nothing to do with fonts.
 * Collapsing both into `false` is what makes an allocation failure advise a
 * font install — the operator then installs fonts, redeploys, and gets the
 * identical message.
 */
type FontProbeResult =
  | { available: true }
  | { available: false; rendered: boolean; cause?: unknown };

let fontProbe: Promise<FontProbeResult> | undefined;

async function probeFont(): Promise<FontProbeResult> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><text x="0" y="36" font-family="${FONT_STACK}" font-size="36" fill="white">Wg</text></svg>`;

  let data: Buffer;
  let channels: number;
  try {
    const probed = await sharp({
      create: {
        width: 96,
        height: 48,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: Buffer.from(svg) }])
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = probed.data;
    channels = probed.info.channels;
  } catch (cause) {
    return { available: false, rendered: false, cause };
  }

  // Any non-transparent pixel means glyphs were rasterised.
  for (let i = channels - 1; i < data.length; i += channels) {
    if (data[i] > 0) return { available: true };
  }
  return { available: false, rendered: true };
}

/**
 * Fail loudly if this runtime cannot rasterise text.
 *
 * Without this the fontless case is invisible: sharp reports success, the
 * overlay comes out with no words on it, and previews ship looking far less
 * protected than they should. A crashed upload is a much better outcome than
 * a quietly under-marked one, and it shows up in the logs of the environment
 * that actually has the problem — which a test on the CI host never can,
 * because CI is not the container image.
 *
 * Only *success* is memoised. Whether a font is installed can't change under
 * a running process, so caching a true result is free; caching a false one is
 * not, because the probe allocates and rasterises and can therefore fail for
 * reasons that have nothing to do with fonts. Memoising that would turn one
 * transient blip into every subsequent upload returning a 500, with a
 * thoroughly misleading "install a font package" in the log, until someone
 * restarts the process. Concurrent callers still share one in-flight probe.
 */
export async function assertWatermarkFontAvailable(): Promise<void> {
  const probe = (fontProbe ??= probeFont());

  let result: FontProbeResult;
  try {
    result = await probe;
  } catch (cause) {
    // probeFont() handles its own failures, so this is belt and braces; treat
    // it the same way rather than letting an unrelated error type escape.
    result = { available: false, rendered: false, cause };
  }

  if (result.available) return;

  // Drop the cached attempt so the next caller re-probes. Guarded in case
  // another caller already replaced it.
  if (fontProbe === probe) fontProbe = undefined;

  throw new WatermarkFontUnavailableError(
    result.rendered
      ? "No usable font found for watermark text: text rasterised to nothing. libvips ships no fonts; install a font package (e.g. fontconfig + font-dejavu) in the runtime image."
      : "Could not verify that a font is available: the probe itself failed, which is usually transient and unrelated to fonts. See the cause.",
    { cause: result.cause },
  );
}

/**
 * Pass 1: decode the upload, apply EXIF orientation, downscale.
 *
 * Split out so the WatermarkError wrapping covers exactly this step and no
 * more. This is the only stage whose input is the untrusted upload, so "the
 * file is bad" is the plausible explanation for a failure here and a 422 is
 * the honest answer.
 *
 * Caveat worth naming rather than papering over: it can still fail for
 * non-file reasons, most obviously an allocation failure. The concurrency
 * gate (ugcportal-e86) makes that far less likely by bounding how many
 * decodes overlap, but it cannot make it impossible — the per-operation
 * memory figure the gate sizes against is an estimate, not a guarantee.
 * Those are indistinguishable from a corrupt upload at this layer without
 * parsing libvips error strings, which is far too brittle to rely on. The
 * narrowing removes the systemic misattributions; it does not claim to remove
 * every one.
 */
async function decodeAndDownscale(input: Buffer, limitInputPixels: number) {
  try {
    // `animated` is left off, so an animated GIF/WebP collapses to its first
    // frame — a still preview is all the gallery shows today. Metadata (EXIF,
    // GPS, ...) is dropped because we never call withMetadata().
    const image = sharp(input, {
      limitInputPixels,
      // Reject genuinely broken files but tolerate the merely sloppy ones
      // (truncated trailing bytes, odd markers) that sharp's default
      // "warning" threshold would refuse — with a fail-closed upload policy,
      // being stricter than that rejects legitimate uploads.
      failOn: "error",
    });

    // Header parse only — this does not decode pixels, and the same instance
    // is reused for the real work below. The longest edge is what both bounds
    // are expressed against, and taking a max makes it invariant to whether
    // EXIF orientation will end up swapping the axes.
    const { width = 0, height = 0 } = await image.metadata();
    const longestEdge = Math.max(width, height);
    const target = Math.max(
      1,
      Math.min(
        PREVIEW_MAX_DIMENSION,
        Math.round(longestEdge * PREVIEW_MAX_SCALE),
      ),
    );

    return await image
      .rotate()
      .resize({
        width: target,
        height: target,
        fit: "inside",
        // Redundant now that `target` can never exceed the longest edge, but
        // kept so a future change to that arithmetic can't start upscaling.
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new WatermarkError("Failed to decode the uploaded image", {
      cause: error,
    });
  }
}

/**
 * Turn uploaded image bytes into a downscaled, watermarked preview.
 *
 * Images only. Video is deferred to ugcportal-pmb (watermarked poster frame),
 * so callers must not hand video bytes to this function.
 *
 * Throws rather than returning a partial result: there is deliberately no
 * "return the input unchanged" path, because that would put an unwatermarked
 * original into the slot the gallery reads from.
 *
 * The error type carries the blame, and callers depend on that distinction:
 * {@link WatermarkError} means the *file* could not be decoded (map it to a
 * 4xx), {@link WatermarkFontUnavailableError}, {@link WatermarkOverloadedError}
 * and any other error mean the *runtime* is at fault (map those to a 5xx, so
 * alerting sees them).
 *
 * Bounded, not unbounded: concurrent calls past the gate's limit queue, and
 * past the queue's cap or timeout they fail fast with
 * {@link WatermarkOverloadedError}. No call waits indefinitely.
 */
export async function generateWatermarkedPreview(
  input: Buffer,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  // Outside the try below on purpose: this is an environment fault, and must
  // not be laundered into a per-file WatermarkError.
  await assertWatermarkFontAvailable();

  const text = resolveWatermarkText(options.text);
  const limitInputPixels = options.limitInputPixels ?? MAX_INPUT_PIXELS;

  // Everything above this line is cheap (the font probe memoises after the
  // first call), so it stays outside the gate: a broken deployment should
  // fail immediately rather than queue behind previews that are also going to
  // fail. Everything below allocates native memory, so all of it is inside.
  try {
    return await getGate().run(() =>
      renderPreview(input, text, limitInputPixels),
    );
  } catch (error) {
    if (error instanceof ConcurrencyLimitError) {
      throw new WatermarkOverloadedError(
        "Too many previews are being generated right now",
        {
          cause: error,
          reason: error.reason,
          retryAfterSeconds: error.retryAfterSeconds,
        },
      );
    }
    throw error;
  }
}

/** The part of preview generation that actually costs memory. */
async function renderPreview(
  input: Buffer,
  text: string,
  limitInputPixels: number,
): Promise<PreviewResult> {
  // Only this step's failures become a WatermarkError; see its doc comment.
  const { data: pixels, info } = await decodeAndDownscale(
    input,
    limitInputPixels,
  );

  // Pass 2: composite the overlay, sized to the actual downscaled frame, then
  // encode. Going through raw pixels avoids a throwaway lossy re-encode
  // between the two passes.
  //
  // Deliberately not wrapped in a WatermarkError: this stage consumes raw
  // pixels we produced ourselves against an SVG we generated, so nothing here
  // can be blamed on the uploader. A libvips built without WebP save would
  // otherwise turn 100% of uploads into 422s and never register as a 5xx
  // anywhere in alerting.
  const data = await sharp(pixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  })
    .composite([
      {
        input: Buffer.from(
          buildWatermarkOverlaySvg(info.width, info.height, text),
        ),
      },
    ])
    .webp({ quality: PREVIEW_QUALITY })
    .toBuffer();

  return {
    data,
    contentType: PREVIEW_CONTENT_TYPE,
    width: info.width,
    height: info.height,
  };
}
