import os from "node:os";

import sharp from "sharp";

import type { ConcurrencyGate, ConcurrencyLimitReason } from "@/lib/concurrency-gate";
import {
  ConcurrencyLimitError,
  createConcurrencyGate,
} from "@/lib/concurrency-gate";
import type { CpuBudget, MemoryBudget } from "@/lib/container-limits";
import { detectCpuBudget, detectMemoryBudget } from "@/lib/container-limits";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  PREVIEW_CONTENT_TYPE,
  PREVIEW_FILE_EXTENSION,
} from "@/lib/media";
import {
  DEFAULT_THROTTLE_INTERVAL_MS,
  createThrottledLog,
} from "@/lib/throttled-log";

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

// Re-exported, not defined here. Both now live in src/lib/media.ts because
// consumers that only need to NAME or LABEL a preview object must not be made
// to import this module — it pulls sharp, libvips and a native binary, which
// is a steep price for a string and an invisible one at the import site. See
// the note beside them there. Re-exported so this module still answers
// "everything about previews" and no existing importer had to change.
export { PREVIEW_CONTENT_TYPE, PREVIEW_FILE_EXTENSION };

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
// The timeout bounds *waiting*, not running: once a preview starts it has no
// deadline, because the libvips call cannot be cancelled and freeing the slot
// without freeing the memory would defeat the bound. See ConcurrencyGate.run.
//
// Why not pure shedding: uploads arrive in bursts by construction (a
// multi-file picker sends every file at once), and a limit small enough to
// protect a 1 GB container would fail most of a perfectly ordinary five-image
// selection while the server is nearly idle a second later. On the default 1
// GB reference configuration below, a five-image burst is fully absorbed
// (limit 3 + queue 5) and nothing sheds.
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
// Every upload the gate is holding — running or queued — costs its request
// body, and the budget accounts for all of them. The gate copies nothing (the
// body is already buffered by the HTTP layer before this module is reached),
// but holding N of them alive at once is a real commitment where freeing them
// one at a time would not have been. See UPLOAD_BODY_BYTES,
// IN_FLIGHT_BYTES_PER_UPLOAD, and the budget allocation in
// resolveWatermarkConcurrencySettings.

/**
 * Native memory to reserve for everything that is not preview work: the Next
 * server, the V8 heap, Prisma/libsql, the S3 client's buffers.
 *
 * Deliberately does *not* include upload bodies, queued or in flight. An
 * earlier version of this constant did, hand-waving them in as "plus a
 * request body or two", which was wrong in a way worth naming: the number of
 * live bodies scales with the limit and the queue, both of which are derived
 * from this. Folding a variable into the constant that sizes it is circular,
 * and it under-counted by however many bodies were actually live. They are
 * priced separately as {@link UPLOAD_BODY_BYTES} and allocated out of the
 * budget explicitly.
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
 *
 * Read it as "the cost of decoding a body", not "the cost of an upload": it
 * is a *delta*, measured with the source buffer already resident, so it does
 * not include the body itself. {@link IN_FLIGHT_BYTES_PER_UPLOAD} is the
 * figure to size anything against.
 */
export const PREVIEW_BYTES_PER_OPERATION = 128 * 1024 * 1024;

/**
 * Resident memory one upload's request body holds, from the moment the route
 * has read it until the handler returns.
 *
 * Twice the image upload cap, because src/app/api/media/route.ts holds the
 * body in two separate allocations before it ever reaches this module, and
 * holds both for the whole handler:
 *
 *  1. `await request.formData()` produces a File, which keeps the bytes in
 *     its own backing store; `body.value` and `file` both stay in scope.
 *  2. `await file.arrayBuffer()` allocates a *second* copy of them.
 *
 * `Buffer.from(arrayBuffer)` is then a **view** over (2), not a third
 * allocation — but that also means it keeps (2) alive for as long as the
 * handler holds the Buffer, which is until it returns.
 *
 * Getting that mechanism right matters more than the number, which an
 * earlier version of this comment got to by accident: it claimed the
 * ArrayBuffer was a transient third copy that was garbage immediately. It is
 * neither transient nor third. Believing otherwise would license adding a
 * real copy — `Buffer.from(buffer)`, a `Buffer.concat`, a re-encode into a
 * new buffer — while assuming the budget still held. It would not: on the
 * recommended 1 GB configuration the gate holds up to eight uploads (limit 3
 * + queue 5), so a third live copy is 80 MB unaccounted for. If a change
 * ever adds one, this constant goes to 3x and the reference table is
 * re-derived.
 *
 * Charged to *every* caller the gate is holding, queued or running, and that
 * is the correction to two successive mistakes rather than one:
 *
 *  - first, that queueing was free because the body was already buffered.
 *    True that the gate copies nothing; false that it costs nothing, because
 *    a queue keeps N bodies simultaneously alive that would otherwise have
 *    been freed one at a time.
 *  - then, that only *queued* callers held a body. A running caller holds
 *    exactly the same two copies, and PREVIEW_BYTES_PER_OPERATION does not
 *    cover them: it is a measured delta taken with the source buffer already
 *    resident, so it is the cost of decoding a body, on top of the body.
 *
 * Both errors ran the same way — under-counting what the process is actually
 * committed to — which is the direction that ends in an OOM rather than in
 * an unnecessarily small limit.
 */
export const UPLOAD_BODY_BYTES = 2 * MAX_IMAGE_UPLOAD_BYTES;

/**
 * Total resident memory one in-flight preview commits the process to: the
 * decode/encode work plus the request body that is being decoded.
 */
export const IN_FLIGHT_BYTES_PER_UPLOAD =
  PREVIEW_BYTES_PER_OPERATION + UPLOAD_BODY_BYTES;

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
 * Fraction of the memory budget left unspent.
 *
 * The budget arithmetic is only as good as PREVIEW_BYTES_PER_OPERATION, and
 * that figure is a darwin measurement that has never run on the alpine image
 * this ships in. Spending the budget to the last byte turns any under-
 * estimate straight into the OOM kill this whole change exists to replace
 * with shedding — and the derivation *would* spend it all, because step 3
 * gives every remaining byte to queue depth. Before this, the recommended
 * 1 GB configuration sat at 1004/1024 MB: 98% of the number the kernel kills
 * on, defended by an estimate.
 *
 * 15% is chosen so the headroom at the recommended container size (~154 MB of
 * 1 GB) is larger than one whole in-flight upload (148 MB). That is the unit
 * the under-estimates come in: musl's allocator fragmenting more than
 * darwin's, RSS not being returned promptly between operations, or one upload
 * the gate is not accounting for (see the note on projectedGatedPeakBytes).
 * It absorbs at least one of those rather than being a round number.
 */
export const BUDGET_HEADROOM_FRACTION = 0.15;

/** Which term bound {@link resolveConcurrencyCeiling}'s answer. */
export interface ConcurrencyCeiling {
  value: number;
  boundBy: "libuv-pool" | "absolute-cap";
}

/**
 * Longest wait an operator may configure for a queued upload.
 *
 * The queue's memory cost is bounded by its depth, not by how long anyone
 * waits, so an enormous timeout does not break the budget — it breaks the
 * other promise this module makes, that a caller gets a bounded wait and a
 * documented answer rather than a held-open connection. Two minutes is
 * already past any sensible proxy timeout; beyond it the caller is gone and
 * the slot is being held for nobody.
 */
export const MAX_QUEUE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// How overrides are treated
//
// One rule, applied to every variable below, because the alternative — each
// knob deciding for itself — is how three of them ended up able to silently
// invalidate the arithmetic that `fitsBudget` reports on:
//
//   An override is clamped exactly where exceeding it would break something
//   this module promises, and clamping is always reported (settings.clamped,
//   logged as a warning). It is never clamped to the memory budget, because
//   that is the one input an operator may legitimately know better than we
//   do — so the budget itself is overridable instead, and the projection is
//   always recomputed from the settings that actually took effect.
//
// Concretely: WATERMARK_MAX_CONCURRENCY is clamped to the libuv worker pool
// (past it, previews queue invisibly inside libuv and starve the DNS lookup
// of the S3 upload that follows each one); WATERMARK_SHARP_THREADS to
// MAX_SHARP_THREADS_PER_OPERATION (past it, PREVIEW_BYTES_PER_OPERATION stops
// describing reality); WATERMARK_QUEUE_TIMEOUT_MS to MAX_QUEUE_TIMEOUT_MS
// (past it, "bounded wait" stops being true). WATERMARK_QUEUE_LIMIT is *not*
// clamped: its only cost is memory, and memory is exactly what
// projectedGatedPeakBytes/fitsBudget already tell the truth about.
//
// The consequence to keep in mind: `fitsBudget` is an honest statement about
// the configuration that is actually in force, including overrides, and never
// about the one that was asked for.
//
// Every variable this module reads, and what a hostile or merely wrong value
// does (audited rather than assumed, because the first three rounds of this
// change all shipped an override that could quietly invalidate the budget):
//
//   WATERMARK_MEMORY_BUDGET_MB  tiny -> limit 1, no queue, fitsBudget false
//                               and a warning; huge -> clamped to host RAM.
//   WATERMARK_MAX_CONCURRENCY   above the pool -> clamped, warned; above what
//                               memory affords -> honoured, queue drops to 0,
//                               fitsBudget false.
//   WATERMARK_QUEUE_LIMIT       any size -> honoured and counted; fitsBudget
//                               goes false when it does not fit.
//   WATERMARK_QUEUE_TIMEOUT_MS  huge -> clamped to MAX_QUEUE_TIMEOUT_MS; tiny
//                               -> effectively pure shedding, which is safe.
//   WATERMARK_SHARP_THREADS     above the measured cap -> clamped, warned.
//   UV_THREADPOOL_SIZE          raises the ceiling up to MAX_DERIVED_
//                               CONCURRENCY. The one unfixable case: set in a
//                               .env file it does not reach libuv but is
//                               still read here, so the ceiling rises while
//                               the real pool does not. No API exposes the
//                               real pool size; env.example says not to set
//                               it there. fitsBudget stays honest either way,
//                               since the harm is libuv queueing, not memory.
//   WATERMARK_TEXT              sanitised by resolveWatermarkText (ugcportal-
//                               44q); no effect on any of this.
//
// Anything non-integer, zero or negative falls back to the derived value
// rather than throwing: a typo in one variable must not turn every upload
// into a 500.

/**
 * Smallest memory budget in which the gate can honour its own arithmetic:
 * the baseline plus one upload being processed (its body and its decode),
 * grossed up by {@link BUDGET_HEADROOM_FRACTION} so it is a floor on the
 * budget rather than on the spend. Currently ~551 MB.
 *
 * Below this the limit is clamped up to 1 — a gate that admits nothing is
 * not an improvement on an OOM — and the configuration is, by its own
 * reckoning, over budget, which {@link resolveWatermarkConcurrencySettings}
 * reports via `fitsBudget` and getGate() warns about. Note that this moved
 * up when the headroom was introduced: a 512 MB container used to be
 * reported as fitting, at 91% utilisation defended by an unvalidated
 * estimate. It now reports that it does not fit, which is the more useful
 * answer even though it is the less flattering one.
 *
 * Note this is a floor on the *arithmetic*, not a recommendation. See the
 * reference table on resolveWatermarkConcurrencySettings for the practical
 * one, which is a good deal higher.
 */
export const MIN_VIABLE_BUDGET_BYTES = Math.ceil(
  (PREVIEW_PROCESS_BASELINE_BYTES + IN_FLIGHT_BYTES_PER_UPLOAD) /
    (1 - BUDGET_HEADROOM_FRACTION),
);

/**
 * Just the variables this module reads.
 *
 * Narrower than NodeJS.ProcessEnv on purpose: process.env is assignable to
 * it, but a test can pass a literal without having to fabricate NODE_ENV and
 * everything else the app's ProcessEnv declaration requires.
 */
export interface WatermarkConcurrencyEnv {
  readonly WATERMARK_MEMORY_BUDGET_MB?: string;
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
  budgetSource: MemoryBudget["source"] | "env";
  cpus: number;
  cpuSource: CpuBudget["source"];
  limitSource: "env" | "derived";
  /**
   * The part of the budget the derivation is allowed to spend:
   * `budgetBytes` less {@link BUDGET_HEADROOM_FRACTION}.
   */
  usableBudgetBytes: number;
  /**
   * Worst-case resident memory of the uploads **this gate is holding** —
   * every running and queued caller's body, every running caller's decode,
   * plus the process baseline.
   *
   * Named "gated" because that is the whole of what it bounds, and the
   * unqualified version of this claim was wrong. The route buffers each
   * request body *before* calling in, so uploads the gate has not admitted
   * are not counted here and never were: 60 concurrent 10 MB POSTs on the
   * recommended 1 GB configuration are 8 admitted or queued (limit 3 +
   * queue 5) and 52 shed, and every one of those 52 bodies used to be
   * resident at the moment its shed decision was taken. Video uploads and
   * oversized-then-rejected bodies were outside it too.
   *
   * Those three are now bounded — one step earlier, by the byte budget in
   * src/lib/upload-memory.ts (ugcportal-05b), which refuses an upload before
   * its body is read. This field is unchanged and still means exactly what
   * it says; what changed is that it is no longer the *outermost* number.
   * `projectedUploadPathPeakBytes` over there is, and the two are **not
   * additive**: the per-caller body charge below is for bodies that budget
   * is already holding, so summing them double-counts. Size a container from
   * that figure, not from this one.
   */
  projectedGatedPeakBytes: number;
  /**
   * False when `projectedGatedPeakBytes` exceeds `usableBudgetBytes`. Read
   * it as "the gated part fits, with headroom", not "the process fits" —
   * for the process, see `fitsBudget` on UploadMemorySettings.
   */
  fitsBudget: boolean;
  /**
   * One entry per environment override that was reduced, explaining which and
   * why. Empty when every override was honoured as given.
   */
  clamped: string[];
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
 * Raising UV_THREADPOOL_SIZE raises this, and is the supported way to get a
 * limit above 3 out of a large container — but it has to be set in the real
 * process environment, and there is a trap worth stating because this
 * function cannot detect it. libuv reads UV_THREADPOOL_SIZE when the pool is
 * first used, which is early in process start. Setting it from inside the
 * process is therefore too late, and so is putting it in a `.env` file: Next
 * loads those into process.env after libuv has already sized its pool. In
 * both cases this function would read the raised value and lift the ceiling
 * while the actual pool stayed at 4, pushing the surplus into libuv's
 * invisible, uncapped queue — the precise failure this ceiling exists to
 * avoid. There is no public API for the real pool size, so the variable is
 * trusted; env.example says not to set it there.
 */
export function resolveConcurrencyCeiling(
  env: WatermarkConcurrencyEnv = process.env,
): ConcurrencyCeiling {
  const poolSize =
    positiveInt(env.UV_THREADPOOL_SIZE) ?? LIBUV_DEFAULT_THREADPOOL_SIZE;
  const fromPool = Math.max(1, poolSize - 1);
  // Which term won matters to the operator, not just to us: told "raise
  // UV_THREADPOOL_SIZE" when the absolute cap is what bound them, they would
  // raise it, redeploy, and get the same number back.
  return fromPool >= MAX_DERIVED_CONCURRENCY
    ? { value: MAX_DERIVED_CONCURRENCY, boundBy: "absolute-cap" }
    : { value: fromPool, boundBy: "libuv-pool" };
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
 * The rule keeps *total* libvips threads at one per effective CPU instead of
 * one per CPU per in-flight image — with one exception, since the floor of a
 * thread per preview wins when the limit exceeds the CPU count (limit 3 on
 * 2 CPUs gives 3 threads, not 2). The cost is real but small and
 * only paid when the server is idle: a single lone 49 MP PNG preview took
 * ~169ms with one thread against ~158ms with four (3-run means), because the
 * PNG decode dominates and does not parallelise well.
 */
export function resolveSharpThreads(
  limit: number,
  cpus: number,
  override?: number,
): number {
  // The override is clamped like everything else (see "How overrides are
  // treated" above): 64 threads per preview would multiply the per-operation
  // memory this module's whole budget is built on, and it is measured only
  // up to four.
  if (override !== undefined) {
    return Math.min(MAX_SHARP_THREADS_PER_OPERATION, Math.max(1, override));
  }
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
 * The budget is spent in a fixed order, and every caller the gate can be
 * holding is charged for, so the projected total is a statement about the
 * whole configuration rather than about a convenient part of it:
 *
 *   0. BUDGET_HEADROOM_FRACTION comes off the budget first, so none of the
 *      steps below can spend it;
 *   1. the process baseline comes off the top of what is left;
 *   2. in-flight uploads take what remains, at
 *      IN_FLIGHT_BYTES_PER_UPLOAD each (a preview's decode *plus* the body
 *      being decoded), capped by resolveConcurrencyCeiling();
 *   3. the queue gets whatever is still spare, at UPLOAD_BODY_BYTES each,
 *      capped at DEFAULT_QUEUE_DEPTH_PER_SLOT per slot so a large container
 *      does not buy a queue so deep that the wait is pointless.
 *
 * Both of those per-caller figures were arrived at by getting them wrong
 * first, and in the same direction each time — under-counting, which is the
 * direction that ends in an OOM:
 *
 *  - a flat "queue = 4x the limit" ignored queued bodies entirely, letting a
 *    1 GB container commit to ~1.36 GB;
 *  - then charging UPLOAD_BODY_BYTES only to *queued* callers ignored the
 *    body every running caller is holding too, under-counting by
 *    limit x 20 MB — enough to make a 768 MB container report 764 MB and
 *    `fitsBudget: true` while actually committing ~824 MB.
 *
 * Reference points, computed from the constants above (not measured; the
 * per-operation figure they build on is the darwin measurement documented on
 * PREVIEW_BYTES_PER_OPERATION). Default UV_THREADPOOL_SIZE, so the ceiling
 * is 3. "Burst" is how many simultaneous uploads are absorbed with nothing
 * shed, i.e. limit + queue:
 *
 *   512 MB -> limit 1, queue 0   burst 1   (projected 468 MB — DOES NOT FIT)
 *   768 MB -> limit 2, queue 1   burst 3   (projected 636 MB, 83% used)
 *     1 GB -> limit 3, queue 5   burst 8   (projected 864 MB, 84% used)
 *     2 GB -> limit 3, queue 12  burst 15  (projected 1004 MB, 49% used;
 *             ceiling-bound, not memory-bound — raise UV_THREADPOOL_SIZE in
 *             the container environment to use the rest)
 *
 * **1 GB is the recommended floor.** It absorbs an ordinary multi-image
 * selection with room over; 768 MB absorbs three and sheds the fourth. Below
 * that, 512 MB no longer fits at all — it used to be reported as fitting, at
 * 91% utilisation, which is what the headroom is for. Below 1 GB the honest
 * summary is that bursts shed — a retryable 503 with Retry-After since
 * ugcportal-u7g, not the unretryable 500 it used to be, but still a shed
 * upload the caller has to redo (see WatermarkOverloadedError).
 *
 * Note 2 GB is now meaningfully better than 1 GB rather than identical: with
 * the budget derated, the queue at 1 GB is what the remaining memory affords
 * rather than the 4-per-slot cap.
 *
 * Below MIN_VIABLE_BUDGET_BYTES (~551 MB) the limit is clamped up to 1 and
 * `fitsBudget` goes false, meaning the configuration is over budget by its
 * own reckoning. getGate() warns about that the first time a preview is
 * generated.
 *
 * Every input is a parameter so this is testable without a container.
 */
export function resolveWatermarkConcurrencySettings(
  env: WatermarkConcurrencyEnv = process.env,
  detected: MemoryBudget = detectMemoryBudget(),
  cpu: CpuBudget = detectCpuBudget(),
  hostMemoryBytes: number = os.totalmem(),
): WatermarkConcurrencySettings {
  const clamped: string[] = [];

  // 1. The budget. Overridable outright, because "the cgroup is invisible so
  //    the detected number is wrong" is the whole reason an escape hatch
  //    exists, and overriding only the *limit* does not escape anything —
  //    the queue would still be sized from a budget everyone agrees is
  //    fiction.
  //
  //    Overridable *downwards* only. The variable exists for the case where
  //    the detected budget is too big — no visible cgroup, so it fell back
  //    to host RAM — and in that direction it is the operator telling us
  //    something the kernel did not. Upwards it is the operator contradicting
  //    something the kernel *did* say, and the kernel wins: a cgroup limit is
  //    enforced whatever this variable claims. Left unclamped, this knob is a
  //    direct route to the failure the whole gate exists to prevent —
  //    WATERMARK_MEMORY_BUDGET_MB=8192 inside a 1 GB container would derive
  //    limit 3 + queue 12, report fitsBudget: true at info level, and get
  //    OOM-killed.
  //
  //    So the ceiling is the detected budget, whatever its provenance: the
  //    cgroup limit when there is one, host RAM when there is not (which is
  //    what detectMemoryBudget already returns in that case).
  const budgetOverrideMb = positiveInt(env.WATERMARK_MEMORY_BUDGET_MB);
  let budgetBytes = detected.bytes;
  let budgetSource: WatermarkConcurrencySettings["budgetSource"] =
    detected.source;
  if (budgetOverrideMb !== undefined) {
    const requested = budgetOverrideMb * 1024 * 1024;
    const ceiling = Math.min(detected.bytes, hostMemoryBytes);
    budgetBytes = Math.min(requested, ceiling);
    budgetSource = "env";
    if (budgetBytes !== requested) {
      clamped.push(
        detected.source === "host"
          ? `WATERMARK_MEMORY_BUDGET_MB=${budgetOverrideMb} is more memory than the machine has; clamped to ${mib(budgetBytes)}`
          : `WATERMARK_MEMORY_BUDGET_MB=${budgetOverrideMb} exceeds this container's own ${detected.source} memory limit of ${mib(detected.bytes)}; clamped to it. The kernel enforces that limit whatever this variable says, so honouring the larger number would only mean being OOM-killed while reporting a fit.`,
      );
    }
  }

  // Headroom comes off before anything is allocated, so the derivation
  // cannot spend it: see BUDGET_HEADROOM_FRACTION for why an estimate-backed
  // budget must not be spent to the last byte.
  const usableBudgetBytes = Math.floor(
    budgetBytes * (1 - BUDGET_HEADROOM_FRACTION),
  );
  const spendable = usableBudgetBytes - PREVIEW_PROCESS_BASELINE_BYTES;

  // 2. The limit. An explicit value wins over the memory derivation but not
  //    over the libuv pool, which is a property of the runtime rather than
  //    an estimate: admitting more previews than there are workers does not
  //    run them, it queues them somewhere this gate cannot see or cap.
  const ceiling = resolveConcurrencyCeiling(env);
  const limitOverride = positiveInt(env.WATERMARK_MAX_CONCURRENCY);
  let limit: number;
  if (limitOverride === undefined) {
    limit = Math.min(
      ceiling.value,
      Math.max(1, Math.floor(spendable / IN_FLIGHT_BYTES_PER_UPLOAD)),
    );
  } else {
    limit = Math.min(limitOverride, ceiling.value);
    if (limit !== limitOverride) {
      clamped.push(
        ceiling.boundBy === "libuv-pool"
          ? `WATERMARK_MAX_CONCURRENCY=${limitOverride} clamped to ${limit}: one fewer than the libuv worker pool, which is all that can actually run at once (raise UV_THREADPOOL_SIZE in the container environment — not in .env — to lift it)`
          : `WATERMARK_MAX_CONCURRENCY=${limitOverride} clamped to ${limit}: MAX_DERIVED_CONCURRENCY, this module's absolute ceiling — raising UV_THREADPOOL_SIZE will not lift it`,
      );
    }
  }

  // 3. The queue. Not clamped, only counted: its cost is memory, and memory
  //    is what fitsBudget is for.
  const forQueue = spendable - limit * IN_FLIGHT_BYTES_PER_UPLOAD;
  const queueLimit =
    nonNegativeInt(env.WATERMARK_QUEUE_LIMIT) ??
    Math.min(
      limit * DEFAULT_QUEUE_DEPTH_PER_SLOT,
      Math.max(0, Math.floor(forQueue / UPLOAD_BODY_BYTES)),
    );

  // 4. The wait. Clamped because past this point "bounded wait" stops being
  //    a true description of the policy, not because of memory.
  const timeoutOverride = positiveInt(env.WATERMARK_QUEUE_TIMEOUT_MS);
  let queueTimeoutMs = timeoutOverride ?? DEFAULT_QUEUE_TIMEOUT_MS;
  if (queueTimeoutMs > MAX_QUEUE_TIMEOUT_MS) {
    clamped.push(
      `WATERMARK_QUEUE_TIMEOUT_MS=${queueTimeoutMs} clamped to ${MAX_QUEUE_TIMEOUT_MS}: a longer wait holds a connection open past any useful deadline`,
    );
    queueTimeoutMs = MAX_QUEUE_TIMEOUT_MS;
  }

  // 5. Threads. Clamped by resolveSharpThreads; reported here.
  const threadOverride = positiveInt(env.WATERMARK_SHARP_THREADS);
  const sharpThreads = resolveSharpThreads(limit, cpu.cpus, threadOverride);
  if (threadOverride !== undefined && sharpThreads !== threadOverride) {
    clamped.push(
      `WATERMARK_SHARP_THREADS=${threadOverride} clamped to ${sharpThreads}: more libvips threads per preview than the per-operation memory figure was measured at, which would make the budget meaningless`,
    );
  }

  const projectedGatedPeakBytes =
    PREVIEW_PROCESS_BASELINE_BYTES +
    limit * IN_FLIGHT_BYTES_PER_UPLOAD +
    queueLimit * UPLOAD_BODY_BYTES;

  return {
    limit,
    queueLimit,
    queueTimeoutMs,
    sharpThreads,
    budgetBytes,
    budgetSource,
    cpus: cpu.cpus,
    cpuSource: cpu.source,
    limitSource: limitOverride === undefined ? "derived" : "env",
    usableBudgetBytes,
    projectedGatedPeakBytes,
    fitsBudget: projectedGatedPeakBytes <= usableBudgetBytes,
    clamped,
  };
}

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * One line describing the configuration and, crucially, where it came from.
 * Emitted when the gate is first built — the first image upload, not
 * process start; see getGate().
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
    `usableBudget=${mib(settings.usableBudgetBytes)}`,
    `projectedGatedPeak=${mib(settings.projectedGatedPeakBytes)}`,
  ].join(" ");
}

function logConcurrencySettings(settings: WatermarkConcurrencySettings): void {
  const line = describeWatermarkConcurrency(settings);
  // Clamped overrides first: an operator who set something and did not get
  // it should find that out before anything else in the line.
  const warnings: string[] = [...settings.clamped];

  if (settings.budgetSource === "host") {
    warnings.push(
      "no container memory limit found, so the limit was derived from total host RAM; run the container with an explicit memory limit (see the Dockerfile) or set WATERMARK_MAX_CONCURRENCY",
    );
  }
  if (!settings.fitsBudget) {
    const overBy = mib(
      settings.projectedGatedPeakBytes - settings.usableBudgetBytes,
    );
    // Two quite different causes, and naming the wrong one sends the
    // operator to the wrong knob during exactly the incident this line
    // exists for. The budget being too small for a single upload is not
    // fixable by configuration; an over-large explicit limit or queue is
    // fixable by nothing else.
    warnings.push(
      settings.budgetBytes < MIN_VIABLE_BUDGET_BYTES
        ? `projected peak memory exceeds the budget by ${overBy}; this container is below the ${mib(MIN_VIABLE_BUDGET_BYTES)} floor a single upload needs, so no configuration fits — give it more memory`
        : `projected peak memory exceeds the budget by ${overBy}; the budget would fit a smaller configuration, so check the explicitly set WATERMARK_MAX_CONCURRENCY / WATERMARK_QUEUE_LIMIT (unset them to derive both from the budget)`,
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
 * after the runtime has finished populating process.env, and so importing
 * this module for `resolveWatermarkText` does not reconfigure libvips as a
 * side effect.
 *
 * The cost of that is timing, and it is worth being exact about rather than
 * calling it a startup log: {@link logConcurrencySettings} runs here, so it
 * fires on the first image upload, not at boot. A deployment missing its
 * `--memory` flag therefore looks clean until someone uploads something.
 * Moving the call to module scope would not actually fix that — the only
 * non-test importer of this module is the upload route, which Next does not
 * load until it is first served — so the documentation says "first upload"
 * instead of overstating it. A health check that calls
 * {@link watermarkConcurrencyStats} would surface it at boot properly; there
 * is no health endpoint to hang that on yet.
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
  // Anyone asking how the gate is doing should not be told a shed count that
  // is still sitting unprinted in the throttle; see flushShedLog.
  flushShedLog();
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
  shedLog.reset();
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
 * src/app/api/media/route.ts (ugcportal-u7g) catches this ahead of its
 * generic rethrow and maps it to a 503 with a `Retry-After` header set from
 * {@link retryAfterSeconds} — the shape of this error (a distinct class
 * carrying that field) is what makes that mapping a few lines rather than a
 * rewrite. The route does not additionally error-log the rejection: this
 * module's own {@link logShedUpload} already reports it, throttled, which is
 * the one line to key alerting on for this event.
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
 * {@link WatermarkOverloadedError}. No call waits indefinitely *for a slot*
 * — which is not the same as no call taking forever. Once admitted there is
 * no deadline, because the underlying libvips work cannot be cancelled and
 * abandoning the promise would free the slot without freeing the memory; see
 * ConcurrencyGate.run. A wedged operation holds its slot until the process
 * restarts, and shows up as a large
 * {@link watermarkConcurrencyStats}().longestRunningMs.
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
      logShedUpload(error);
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

/**
 * Shortest interval between shed log lines; the rest are counted and
 * reported on the next one.
 *
 * Shedding fires precisely when the service is busiest, so a line per
 * rejection would add a log storm to a load problem. The first shed after a
 * quiet period is always logged, so the transition into shedding — the part
 * worth alerting on — is never delayed.
 */
export const SHED_LOG_INTERVAL_MS = DEFAULT_THROTTLE_INTERVAL_MS;

/**
 * Built on `createThrottledLog` (ugcportal-z3lo), which is also what
 * {@link flushShedLog} and {@link logShedUpload} below now delegate to —
 * this module no longer hand-rolls the throttle itself. `flush: true`
 * because a shed is a capacity signal worth paging on: losing the tail of
 * an isolated burst to a throttle that only flushes on the next event is a
 * real cost (see `onFlush` below), unlike `public-media.ts`'s throttle,
 * which deliberately has no flush timer for a lower-stakes signal.
 */
const shedLog = createThrottledLog({
  intervalMs: SHED_LOG_INTERVAL_MS,
  flush: true,
  onFlush: (suppressed) => {
    const stats = gate?.stats();
    console.warn(
      `[watermark] shed ${suppressed} more upload(s) since the last line ` +
        `(shedTotal=${stats?.shed ?? "?"}). Throttled to at most one flush ` +
        `per ${SHED_LOG_INTERVAL_MS}ms (this summary line plus the detailed ` +
        `line); see ugcportal-e86.`,
    );
  },
});

/**
 * Emit the tail of a burst: the sheds that were counted but never printed.
 *
 * Without this the throttle silently eats them. A burst sheds, the first one
 * logs, the rest increment a counter — and if nothing sheds again, that
 * counter is never printed, because the only thing that flushed it was the
 * *next* logged shed. On the recommended 1 GB configuration a 60-upload
 * burst sheds 52, and the single line an operator got claimed one. A
 * throttle that loses the tail of every isolated incident is worse than no
 * throttle, because it reports a number that looks precise and is wrong by
 * a factor of 50.
 *
 * Called from a timer (so it happens without anyone asking) and from
 * {@link watermarkConcurrencyStats} (so it is observable synchronously, and
 * so a process shutting down before the timer fires still gets a chance).
 * Respects the interval even when asked directly — `shedLog.flushNow()`'s
 * own guard, so a health check polling faster than `SHED_LOG_INTERVAL_MS`
 * cannot become the clock the throttle resets on.
 */
function flushShedLog(): void {
  shedLog.flushNow();
}

/**
 * Say, in this module, that an upload was shed.
 *
 * This exists because of where the error goes next. Before ugcportal-u7g,
 * src/app/api/media/route.ts rethrew every WatermarkOverloadedError into
 * console.error("[media] watermark service unavailable") — a message written
 * for the fontless-runtime case, where every upload is broken and someone
 * should be woken up. Shedding is not that: it is this gate working as
 * designed, and on a small container it is routine (the 768 MB reference
 * configuration absorbs three concurrent uploads, so the fourth sheds).
 * Without a line of its own, normal operation and a broken deployment would
 * have produced byte-identical logs, and alerting could not have told them
 * apart.
 *
 * ugcportal-u7g fixed both halves of that on the route's side: it maps
 * WatermarkOverloadedError to a 503 with Retry-After instead of a bare 500,
 * and it stopped error-logging the rejection there at all — logging it again
 * on top of this line would have just moved the unthrottled-volume problem
 * from "many error lines" to "many lines of some other level." So this
 * throttled console.warn is now the *only* per-request log line for a shed
 * upload, and the one to key alerting on: a 52-upload burst produces one line
 * here (plus a flushed tail count), not 52 anywhere.
 */
function logShedUpload(error: ConcurrencyLimitError): void {
  shedLog.log((suppressed) => {
    const stats = gate?.stats();
    console.warn(
      `[watermark] shed an upload (${error.reason}): the preview gate is at capacity, ` +
        `limit=${stats?.limit ?? "?"} queue=${stats?.queueLimit ?? "?"} ` +
        `shedTotal=${stats?.shed ?? "?"}` +
        (suppressed > 0 ? ` (+${suppressed} more since the last line)` : "") +
        ". This is the gate working, not a broken runtime — see ugcportal-e86. " +
        "The route maps this to a 503 with Retry-After and logs nothing " +
        "further for it (ugcportal-u7g) — this is the only *place* a shed is " +
        "logged, throttled to at most one flush per " +
        `${SHED_LOG_INTERVAL_MS}ms (a summary line plus this detailed line), not one line per shed.`,
    );
  });
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
