import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  declaredUploadCapBytes,
} from "@/lib/media";
import {
  PREVIEW_BYTES_PER_OPERATION,
  PREVIEW_PROCESS_BASELINE_BYTES,
  resolveWatermarkConcurrencySettings,
} from "@/lib/watermark";
import type { WatermarkConcurrencySettings } from "@/lib/watermark";

/**
 * A single-process bound on how many bytes of upload body POST /api/media may
 * hold at once (ugcportal-05b).
 *
 * ## What it is for
 *
 * ugcportal-e86 gave preview generation a concurrency gate and sized the
 * container from it. That arithmetic is correct and is not touched here, but
 * it prices exactly one thing: the uploads the gate is *holding*. Its own
 * field name says so — `projectedGatedPeakBytes`. The route buffers each
 * request body before it ever calls in, so three classes of upload cost
 * memory the gate cannot see:
 *
 *  1. bodies read to MAX_UPLOAD_BYTES (~205 MB) and *then* rejected by
 *     validateUpload for exceeding their kind's cap;
 *  2. video, which passes validateUpload at up to 200 MB and is excluded from
 *     preview generation entirely, so it never reaches the gate at all; and
 *  3. image uploads the gate *sheds* — the case the gate itself creates,
 *     because every shed caller had already buffered its body twice by the
 *     time the shed decision was taken.
 *
 * This module bounds all three by moving the decision in front of the read:
 * nothing is buffered until the bytes it will occupy have been reserved out
 * of a fixed budget, and the reservation is *enforced* rather than trusted,
 * because the number reserved is the same number the body stream is capped
 * at (see {@link uploadReadLimitBytes}).
 *
 * ## Why it is a byte budget and not a second gate
 *
 * Two admission bounds in series is the hazard worth naming: if both can
 * make a caller wait, they can deadlock or starve each other, and if both
 * charge for the same bytes the arithmetic double-counts. Both are avoided
 * by construction rather than by care:
 *
 *  - **No waiting here.** This bound only ever admits or refuses, never
 *    queues. A caller that cannot reserve is answered 503 immediately,
 *    without its body being read. With no wait there is no lock ordering, no
 *    deadlock, and no starvation to reason about. Waiting still happens, in
 *    the watermark gate's queue, on the far side of this bound — which is
 *    where it belongs, because that is the resource with a service time.
 *  - **No double count.** The budget is what is left of the container after
 *    the process baseline and the gate's *decode* allocation
 *    (`limit x PREVIEW_BYTES_PER_OPERATION`). The gate's own per-caller body
 *    charge is not added on top: those bodies are the same bodies this
 *    budget is holding, so they are counted once, here.
 *    {@link resolveUploadMemorySettings} proves the two fit together —
 *    `budgetBytes` is always at least `(limit + queueLimit) x
 *    UPLOAD_BODY_BYTES`, so this bound never starves the gate's queue of
 *    maximum-size images.
 *
 * ## What it does NOT cover
 *
 * Stated here rather than discovered later, because an accounting comment
 * that claims more than it delivers is the failure this whole bead is about:
 *
 *  - **Other routes.** This budget is POST /api/media's. The admin evidence
 *    upload (POST /api/admin/instagram/rights-decision) buffers its own body
 *    the same way and is outside it (ugcportal-wa4).
 *  - **The peek itself.** {@link PART_HEADER_PEEK_BYTES} per concurrent
 *    request is read before anything is reserved, so that much *is*
 *    unbounded by request count. It is 8 KiB against the 205 MB it replaces.
 *  - **The parser's working memory.** The reservation prices the two copies
 *    the handler holds (see UPLOAD_BODY_COPIES), which is the same model
 *    ugcportal-e86 used; whatever undici allocates transiently while parsing
 *    is left to BUDGET_HEADROOM_FRACTION, as before.
 *  - **Bytes still resident after release.** A reservation is released when
 *    the handler returns; the memory comes back when V8 and the allocator
 *    get round to it. Also headroom's job.
 *  - **Other replicas.** One process, like the gate. N replicas are N times
 *    this, which is correct — each has its own container.
 *  - **The per-operation constant underneath all of it.**
 *    PREVIEW_BYTES_PER_OPERATION is a darwin measurement that has never run
 *    on the alpine image (ugcportal-68r), so every figure derived here
 *    inherits that. The numbers are arithmetic on an estimate, not a
 *    measurement of this container.
 */

/**
 * Copies of an upload body the route holds at its peak.
 *
 * The same figure UPLOAD_BODY_BYTES in src/lib/watermark.ts is built from,
 * and for the same reason: `formData()` produces a File that keeps the bytes
 * in its own backing store, and `file.arrayBuffer()` allocates a second copy
 * that `Buffer.from` then views rather than copies again. Both stay reachable
 * until the handler returns.
 *
 * If a change ever adds a third live copy, this goes to 3 — and so does
 * UPLOAD_BODY_BYTES, which is the number the gate's side of the arithmetic
 * uses. They are deliberately two constants with one meaning rather than one
 * import, because the gate prices only maximum-size images while this prices
 * whatever the request declared; keeping them textually adjacent in review is
 * the mechanism, and the invariant test in upload-memory.test.ts is the
 * backstop.
 */
export const UPLOAD_BODY_COPIES = 2;

/**
 * Multipart framing allowed on top of the file itself.
 *
 * The cap applies to the request *stream*, which carries the boundary lines
 * and part headers as well as the file, so a request whose file is exactly at
 * its kind's cap is a little over it on the wire. 64 KiB is far more than a
 * browser's framing (a few hundred bytes) and leaves room for a long
 * filename.
 *
 * A request whose framing exceeds this is refused with 413 rather than
 * accepted. That is deliberate and fail-closed: the alternative is a cap that
 * a client can inflate at will by padding its own headers, which is not a cap.
 */
export const MULTIPART_ENVELOPE_SLACK_BYTES = 64 * 1024;

/**
 * Floor on {@link UploadMemorySettings.budgetBytes}: one maximum-size image.
 *
 * Applied only when the derivation comes out smaller, i.e. on a container too
 * small for the configuration the gate chose. A budget of zero would refuse
 * every upload, which is not an improvement on an OOM; the honest answer is
 * to keep the route working for one upload at a time and report
 * `fitsBudget: false`, exactly as the gate does below MIN_VIABLE_BUDGET_BYTES.
 */
export const MIN_UPLOAD_BUDGET_BYTES =
  UPLOAD_BODY_COPIES * (MAX_IMAGE_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES);

/** The upload was refused because the process is already holding its budget. */
export class UploadMemoryExhaustedError extends Error {
  /** Suggested backoff, suitable for a Retry-After header. */
  readonly retryAfterSeconds: number;

  constructor(message: string, options: { retryAfterSeconds: number }) {
    super(message);
    this.name = "UploadMemoryExhaustedError";
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * The upload could not be accepted at *any* level of load: even with the
 * process otherwise idle, buffering it would exceed the budget.
 *
 * Distinct from {@link UploadMemoryExhaustedError} because the answers differ:
 * this one is a 413 and retrying will not help, that one is a 503 and
 * retrying will. Mixing them would tell a caller with a too-big file to try
 * again forever, or tell a caller who hit a busy server that their file was
 * the problem.
 */
export class UploadTooLargeForBudgetError extends Error {
  readonly limitBytes: number;

  constructor(message: string, options: { limitBytes: number }) {
    super(message);
    this.name = "UploadTooLargeForBudgetError";
    this.limitBytes = options.limitBytes;
  }
}

export interface UploadMemorySettings {
  /**
   * Upload-body bytes the route may hold across all concurrent requests.
   *
   * What is left of the container after the process baseline and the
   * watermark gate's decode allocation, floored at
   * {@link MIN_UPLOAD_BUDGET_BYTES}.
   */
  budgetBytes: number;
  /**
   * Largest single reservation admissible when nothing else is being
   * uploaded, which is more than {@link budgetBytes}.
   *
   * Without this a 200 MB video could never be accepted on the recommended
   * container, since one costs more than the whole steady-state budget. It is
   * sound only because of a property of the *route*: every caller that
   * reaches the watermark gate holds a reservation for the whole handler, so
   * "no reservations held" means "no previews running" and the decode
   * allocation is free for this one upload to use. A second caller cannot
   * join it — the budget is already over-committed, so everything else is
   * shed until it finishes.
   */
  soloReservationCeilingBytes: number;
  /**
   * Largest file this container can accept, whatever the per-kind caps say.
   *
   * The operator-facing form of {@link soloReservationCeilingBytes}: divided
   * by the copies the handler holds, less the framing allowance. On the
   * recommended 1 GB this is above the 200 MB video cap, so every upload the
   * app allows fits; on 768 MB it is not, and a maximum-size video is
   * refused with a 413.
   */
  maxSingleUploadBytes: number;
  /** Retry-After for a shed upload, matched to the gate's queue timeout. */
  retryAfterSeconds: number;
  /**
   * Worst-case resident memory of **POST /api/media**: the process baseline,
   * the gate's in-flight decodes, and every upload body the route is holding
   * — buffered, queued for a preview, being previewed, or on its way to S3.
   *
   * Named for the route rather than for the process, on the precedent of
   * `projectedGatedPeakBytes` (ugcportal-e86 renamed it from
   * `projectedPeakBytes` precisely so it stopped implying coverage it never
   * had). The list under "What it does NOT cover" at the top of this file is
   * what the name is excluding, and the one worth repeating is that this is
   * arithmetic over a darwin-measured per-operation constant, not a measured
   * figure for the alpine image.
   *
   * **Not additive with `projectedGatedPeakBytes`.** That figure charges for
   * the bodies of the callers the gate holds; those bodies are inside this
   * budget. Adding the two would count them twice. This is the larger and
   * more complete of the two.
   */
  projectedUploadPathPeakBytes: number;
  /**
   * False when {@link projectedUploadPathPeakBytes} exceeds the gate's
   * `usableBudgetBytes` — i.e. when the floor above had to be applied because
   * the container is too small for the configuration in force.
   */
  fitsBudget: boolean;
  /** The gate settings this was derived from, for logging and for tests. */
  watermark: WatermarkConcurrencySettings;
}

/**
 * How many bytes of request stream this upload may be allowed to deliver.
 *
 * Two inputs, and neither is trusted:
 *
 *  - the media type the first multipart part declares, which gives the cap
 *    `validateUpload` will apply to it anyway
 *    ({@link declaredUploadCapBytes}); and
 *  - Content-Length, when it is present and sane, which can only make the
 *    answer *smaller*.
 *
 * Both are client-controlled, and that is fine, because neither can widen the
 * cap beyond the route's existing fallback:
 *
 *  - declaring `image/png` and sending 200 MB gets the 10 MB cap and a 413 at
 *    ~10 MB, which is the point;
 *  - declaring `video/mp4` and sending an image gets the 200 MB cap, exactly
 *    as today — and then a 415 from sniffKind, which reads the actual bytes;
 *  - declaring something unsupported gets the smallest cap there is, because
 *    such an upload is refused at any size, so the only question is how much
 *    of it to read first;
 *  - declaring nothing readable gets `fallbackBytes` (MAX_UPLOAD_BYTES), the
 *    cap that applied to everything before this existed.
 *
 * Content-Length is handled the way ugcportal-i04 established for the same
 * header: as an optimisation, never as the enforcement. Absent, it is
 * `Number(null)` === 0; malformed, it is NaN and `NaN < x` is false. Both
 * fall through to the declared-type cap rather than to a cap of zero or to
 * an unbounded read, which is why the guard tests `> 0` explicitly instead of
 * relying on a comparison that happens to be false for both.
 */
export function uploadReadLimitBytes(options: {
  declaredContentType: string | null;
  contentLengthHeader?: string | null;
  fallbackBytes?: number;
}): number {
  const fallbackBytes = options.fallbackBytes ?? MAX_UPLOAD_BYTES;

  const declaredCap = declaredUploadCapBytes(options.declaredContentType);
  const byType =
    options.declaredContentType === null
      ? fallbackBytes
      : // A type no kind accepts is a 415 at any size, so read as little of it
        // as possible: the smallest cap the route has.
        (declaredCap ?? MAX_IMAGE_UPLOAD_BYTES) +
        MULTIPART_ENVELOPE_SLACK_BYTES;

  const capByType = Math.min(byType, fallbackBytes);

  const declaredLength = Number(options.contentLengthHeader);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return capByType;
  }
  // The slack is added because Content-Length frames the whole request while
  // a client that got it slightly wrong should still upload; it can only
  // narrow, never widen, because of the Math.min.
  return Math.min(
    capByType,
    declaredLength + MULTIPART_ENVELOPE_SLACK_BYTES,
  );
}

/** Bytes to reserve for a request whose stream is capped at `readLimitBytes`. */
export function uploadReservationBytes(readLimitBytes: number): number {
  return UPLOAD_BODY_COPIES * readLimitBytes;
}

/**
 * The budget, derived from the watermark gate's own view of the container.
 *
 * Deliberately downstream of {@link resolveWatermarkConcurrencySettings}
 * rather than a parallel reading of the cgroup: the two must agree about the
 * container's size and about what the gate is going to spend, and the only
 * way to guarantee that is to compute one from the other. It reads three
 * things from it — `usableBudgetBytes` (the container less
 * BUDGET_HEADROOM_FRACTION), `limit`, and `queueTimeoutMs` — and changes
 * none of them.
 *
 * The invariant that makes the two bounds compose, proved rather than
 * asserted (and pinned by a test):
 *
 *     budgetBytes  =  spendable - limit x DECODE
 *     forQueue     =  spendable - limit x (DECODE + BODY)
 *     queueLimit  <=  floor(forQueue / BODY)          (by its derivation)
 *  => queueLimit x BODY  <=  forQueue
 *  => (limit + queueLimit) x BODY  <=  spendable - limit x DECODE
 *                                   =  budgetBytes
 *
 * i.e. this bound always admits at least as many maximum-size images as the
 * gate can hold, so it never renders the gate's queue unreachable. It does
 * *not* follow that the gate stops shedding: on a large container the budget
 * affords many more bodies than the gate's ceiling-bound limit+queue, so a
 * big burst is still shed there. What changed is that the memory held while
 * that happens is now inside a bound, which is the whole of what this bead
 * asked for. The converse case — an explicit WATERMARK_QUEUE_LIMIT bigger
 * than memory affords, which the gate honours and only reports on — makes
 * this bound the tighter of the two, so the surplus queue simply never fills.
 * That is the safe direction and is left alone.
 *
 * The proof above assumes `budgetBytes` is the derived value rather than the
 * {@link MIN_UPLOAD_BUDGET_BYTES} floor, so the floored case needs its own
 * line: the floor only bites when `spendable - limit x DECODE < MIN`, which
 * for a derived limit means limit is 1 and `spendable < DECODE + MIN`; then
 * `forQueue = spendable - (DECODE + BODY) < MIN - BODY`, which is under one
 * body, so `queueLimit` is 0 and the requirement is `MIN >= 1 x BODY` — true
 * by MIN's own definition (one maximum-size image *plus* its framing). Both
 * cases are swept in upload-memory.test.ts rather than left at "should hold".
 */
export function resolveUploadMemorySettings(
  watermark: WatermarkConcurrencySettings = resolveWatermarkConcurrencySettings(),
): UploadMemorySettings {
  const spendable =
    watermark.usableBudgetBytes - PREVIEW_PROCESS_BASELINE_BYTES;
  const decodeReserveBytes = watermark.limit * PREVIEW_BYTES_PER_OPERATION;

  const derivedBudget = spendable - decodeReserveBytes;
  const budgetBytes = Math.max(MIN_UPLOAD_BUDGET_BYTES, derivedBudget);
  const soloReservationCeilingBytes = Math.max(budgetBytes, spendable);

  const projectedUploadPathPeakBytes =
    PREVIEW_PROCESS_BASELINE_BYTES +
    Math.max(decodeReserveBytes + budgetBytes, soloReservationCeilingBytes);

  return {
    budgetBytes,
    soloReservationCeilingBytes,
    maxSingleUploadBytes: Math.max(
      0,
      Math.floor(soloReservationCeilingBytes / UPLOAD_BODY_COPIES) -
        MULTIPART_ENVELOPE_SLACK_BYTES,
    ),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(watermark.queueTimeoutMs / 1000),
    ),
    projectedUploadPathPeakBytes,
    fitsBudget:
      projectedUploadPathPeakBytes <= watermark.usableBudgetBytes,
    watermark,
  };
}

export interface UploadReservation {
  readonly bytes: number;
  /** Idempotent: a double release cannot hand the budget back twice. */
  release(): void;
}

export interface UploadMemoryStats {
  budgetBytes: number;
  /** Bytes reserved right now. May exceed the budget under the solo rule. */
  heldBytes: number;
  /** Highest `heldBytes` ever observed. The number this budget exists to bound. */
  peakHeldBytes: number;
  /** Reservations granted, cumulative. */
  admitted: number;
  /** Uploads refused with {@link UploadMemoryExhaustedError}, cumulative. */
  shed: number;
  /** Uploads refused with {@link UploadTooLargeForBudgetError}, cumulative. */
  refusedTooLarge: number;
}

export interface UploadMemoryBudget {
  /**
   * Reserves `bytes` or refuses. Never waits — see the note at the top of
   * this file on why the outer bound of two bounds in series does not queue.
   *
   * @throws {UploadTooLargeForBudgetError} when `bytes` could not be admitted
   *   even on an idle process (413; retrying will not help).
   * @throws {UploadMemoryExhaustedError} when the process is currently
   *   holding too much (503; retrying will).
   */
  reserve(bytes: number): UploadReservation;
  stats(): UploadMemoryStats;
}

export function createUploadMemoryBudget(
  settings: UploadMemorySettings,
): UploadMemoryBudget {
  let heldBytes = 0;
  let peakHeldBytes = 0;
  let admitted = 0;
  let shed = 0;
  let refusedTooLarge = 0;

  return {
    reserve(bytes: number): UploadReservation {
      if (bytes > settings.soloReservationCeilingBytes) {
        refusedTooLarge += 1;
        throw new UploadTooLargeForBudgetError(
          `Upload of ${bytes} bytes exceeds what this container can buffer (${settings.soloReservationCeilingBytes} bytes)`,
          { limitBytes: settings.maxSingleUploadBytes },
        );
      }

      // Two ways in, and the second is the one that makes a 200 MB video
      // possible at all: take a share of the budget, or take the whole thing
      // when nobody else holds any. `heldBytes === 0` is the entire
      // precondition — it is what guarantees no preview is running, because
      // the route holds its reservation across the gate.
      const fits = heldBytes + bytes <= settings.budgetBytes;
      if (!fits && heldBytes !== 0) {
        shed += 1;
        throw new UploadMemoryExhaustedError(
          `Upload buffers are at capacity (${heldBytes} of ${settings.budgetBytes} bytes held); try again shortly`,
          { retryAfterSeconds: settings.retryAfterSeconds },
        );
      }

      heldBytes += bytes;
      admitted += 1;
      if (heldBytes > peakHeldBytes) peakHeldBytes = heldBytes;

      let released = false;
      return {
        bytes,
        release() {
          if (released) return;
          released = true;
          heldBytes -= bytes;
        },
      };
    },
    stats: () => ({
      budgetBytes: settings.budgetBytes,
      heldBytes,
      peakHeldBytes,
      admitted,
      shed,
      refusedTooLarge,
    }),
  };
}

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** One line describing the budget, and where each number came from. */
export function describeUploadMemory(settings: UploadMemorySettings): string {
  return [
    `[media] upload body budget=${mib(settings.budgetBytes)}`,
    `maxSingleUpload=${mib(settings.maxSingleUploadBytes)}`,
    `previewDecodeReserve=${mib(
      settings.watermark.limit * PREVIEW_BYTES_PER_OPERATION,
    )}`,
    `processBaseline=${mib(PREVIEW_PROCESS_BASELINE_BYTES)}`,
    `usableBudget=${mib(settings.watermark.usableBudgetBytes)}`,
    `projectedUploadPathPeak=${mib(settings.projectedUploadPathPeakBytes)}`,
  ].join(" ");
}

let budget: UploadMemoryBudget | undefined;
let budgetSettings: UploadMemorySettings | undefined;

/**
 * Built on first upload, for the same reason the watermark gate is
 * (src/lib/watermark.ts getGate): the configuration has to be read after the
 * runtime has finished populating process.env, and this module must not
 * reconfigure anything as an import side effect.
 */
function getBudget(): UploadMemoryBudget {
  if (budget) return budget;
  const settings = resolveUploadMemorySettings();
  const line = describeUploadMemory(settings);
  if (settings.fitsBudget) {
    console.info(line);
  } else {
    console.warn(
      `${line} — this container is too small for the preview configuration in force: the upload budget was floored at ${mib(
        MIN_UPLOAD_BUDGET_BYTES,
      )} and the projected peak is ${mib(
        settings.projectedUploadPathPeakBytes - settings.watermark.usableBudgetBytes,
      )} over the usable budget. Give it more memory, or lower WATERMARK_MAX_CONCURRENCY.`,
    );
  }
  budgetSettings = settings;
  budget = createUploadMemoryBudget(settings);
  return budget;
}

/** @see UploadMemoryBudget.reserve */
export function reserveUploadMemory(bytes: number): UploadReservation {
  return getBudget().reserve(bytes);
}

/** Live view of the budget, for tests and for anything that wants to log it. */
export function uploadMemoryStats() {
  return {
    ...getBudget().stats(),
    settings: budgetSettings as UploadMemorySettings,
  };
}

/**
 * Drops the memoised budget so the next reservation rebuilds it from the
 * current environment. Exists for tests; nothing in the app calls it, because
 * resizing a live budget would let held reservations exceed the new bound.
 */
export function resetUploadMemoryBudget(): void {
  budget = undefined;
  budgetSettings = undefined;
}
