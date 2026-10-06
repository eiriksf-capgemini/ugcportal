import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  declaredUploadCapBytes,
} from "@/lib/media";
import {
  DEFAULT_THROTTLE_INTERVAL_MS,
  createThrottledLog,
} from "@/lib/throttled-log";
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
 * because the body stream is capped at the same number the reservation may
 * grow to (see {@link uploadReadLimitBytes}).
 *
 * The reservation is taken in two parts, and the split is the difference
 * between a bound and a number the client picks:
 *
 *  - {@link INITIAL_GRANT_BYTES} on arrival, before a byte of body is read.
 *    One image's worth, fixed, the same for every request whatever it claims
 *    to be. This is what lets a burst be refused at the door rather than
 *    after every body is resident.
 *  - everything above that only as bytes are actually delivered, via
 *    {@link UploadReservation.growTo}. A declared `video/mp4`, or a 205 MB
 *    Content-Length, buys a larger *ceiling* — a threshold for refusing the
 *    request outright — but commits nothing until the bytes turn up.
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
 *    {@link resolveUploadMemorySettings} states exactly how the two compose,
 *    as two separate claims — a proved one against the gate's own pricing of
 *    a body, and a measured one against what the route actually reserves,
 *    which is one queue slot weaker at some container sizes. Read that note
 *    rather than assuming the stronger of the two; conflating them is the
 *    mistake the first version of this module shipped.
 *
 * ## What it does NOT cover
 *
 * Stated here rather than discovered later, because an accounting comment
 * that claims more than it delivers is the failure this whole bead is about:
 *
 *  - **Other routes.** This budget is POST /api/media's. The admin evidence
 *    upload (POST /api/admin/rights/decision) buffers its own body
 *    the same way and is outside it (ugcportal-wa4).
 *  - **The peek itself.** Reading the part header happens before anything is
 *    reserved, so that much *is* still unbounded by request count. It is a
 *    small multiple of PART_HEADER_PEEK_BYTES per concurrent request — the
 *    chunks held, which can overshoot the threshold by one chunk since a
 *    chunk cannot be half-read, plus a decoded copy of them for the header
 *    search. Tens of kilobytes against the 205 MB it replaces.
 *  - **The parser's working memory.** The reservation prices the two copies
 *    the handler holds (see UPLOAD_BODY_COPIES), which is the same model
 *    ugcportal-e86 used; whatever undici allocates transiently while parsing
 *    is left to BUDGET_HEADROOM_FRACTION, as before.
 *  - **How long one caller may occupy a share of it.** The bytes are bounded;
 *    the time is only partly. BODY_STALL_TIMEOUT_MS (src/lib/request-body.ts)
 *    cuts off a body that goes silent, but it is an idle timeout and not a
 *    deadline — deliberately, so a slow connection is not mistaken for a
 *    hostile one — so a client that drips a byte inside every window keeps
 *    its reservation for the whole request lifetime (ugcportal-9qk).
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
 * Everything in the request that is not the file, allowed on top of the
 * file's own cap.
 *
 * The cap applies to the request *stream*, and the stream carries the boundary
 * lines, the part headers **and every other form field** — while the per-kind
 * cap it is built from describes the file alone. So anything else the form
 * submits is charged against the file's allowance, and with a 64 KiB
 * allowance (the first version of this constant) a 10 MB image accompanied by
 * a 100 KB caption field would have been refused with a 413 for being too
 * large, which is not what the operator configured and not what the uploader
 * did.
 *
 * 256 KiB is therefore sized for *a whole form*, not for framing: it is three
 * orders of magnitude above a browser's part framing and leaves room for the
 * caption/tags/description fields the upload UI (ugcportal-n3c) will submit
 * alongside the file. It is also deliberately below the point where it starts
 * to matter to the budget — see the note on resolveUploadMemorySettings about
 * the one-slot shortfall this allowance causes, which stays at one slot at
 * this size and becomes two at 1 MiB.
 *
 * A request whose non-file content exceeds this is refused with 413 rather
 * than accepted. That is deliberate and fail-closed: the alternative is a cap
 * a client can inflate at will by padding fields, which is not a cap.
 */
export const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 256 * 1024;

/**
 * Cap for an upload whose declared type could not be read at all.
 *
 * Reached only when the file part's headers were not within
 * PART_HEADER_PEEK_BYTES of the start of the body *and* the request sent no
 * usable Content-Length — i.e. a chunked request with more than 8 KiB of
 * other fields ahead of the file. No ordinary client produces that shape:
 * a browser buffers a FormData body and sends Content-Length, and a form puts
 * its file input within a few hundred bytes of the start.
 *
 * Held to the smallest supported size rather than to MAX_UPLOAD_BYTES, which
 * is what it used to be, because that fallback was wildly disproportionate:
 * a 100 KB photo reserved ~430 MB, which on a 768 MB container is more than
 * the whole spendable budget (so the upload was refused outright with a 413
 * about server capacity) and on 1 GB monopolised the budget and 503'd
 * everything else for the duration. Capping small instead means such a client
 * uploads images normally, and a larger one is refused rather than served
 * from a disproportionate commitment.
 *
 * Being refused has to be *diagnosable*, which is a separate obligation and
 * is met in POST /api/media rather than here: a 413 reached through this
 * constant carries a message naming the limit that applied and the one thing
 * that would change it — moving the file field nearer the front of the form.
 * Not Content-Length: that header can only ever narrow this limit, so
 * advising it would be unactionable, and an earlier version of this comment
 * both promised a message that did not exist and then described one giving
 * advice that could not work.
 */
export const UNDECLARED_UPLOAD_LIMIT_BYTES =
  MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;

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
  UPLOAD_BODY_COPIES * (MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES);

/**
 * Average rate an upload must sustain to keep holding more than the whole
 * shared budget.
 *
 * Only ever applies to a reservation that is *excluding other people* — one
 * whose pledge exceeds {@link UploadMemorySettings.budgetBytes}. An upload
 * that fits inside the budget alongside others is policed by nothing here,
 * however slowly it trickles, because it is costing nobody anything.
 *
 * 512 KiB/s is deliberately generous (a 4 Mbit/s uplink), because it is not
 * the load-bearing part of the defence — see the note on
 * {@link createUploadMemoryBudget} about revocation being driven by the
 * arrival of the requests being blocked. A legitimate large upload on a slow
 * link should not be killed for being slow; a connection holding the route
 * shut while sending nothing should be.
 *
 * Measured as a cumulative average from the moment exclusivity was taken, not
 * instantaneously, so a momentary stall on a real connection is absorbed.
 */
export const EXCLUSIVE_MIN_THROUGHPUT_BYTES_PER_SEC = 512 * 1024;

/**
 * How long a newly exclusive upload is left alone before its rate is judged.
 *
 * Without a grace window the very first check — taken microseconds after the
 * pledge, with no elapsed time to have delivered anything in — would be
 * arithmetic noise.
 */
export const EXCLUSIVE_GRACE_MS = 5_000;

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
 *  - what the file part declares itself to be, which gives the cap
 *    `validateUpload` will apply to it anyway
 *    ({@link declaredUploadCapBytes}); and
 *  - Content-Length, when it is present and sane, which can only make the
 *    answer *smaller*.
 *
 * Both are client-controlled, and that is fine, because neither can widen the
 * answer beyond what the route already allowed everybody:
 *
 *  - declaring `image/png` and sending 200 MB gets the 10 MB cap and a 413 at
 *    ~10 MB, which is the point;
 *  - declaring `video/mp4` and sending an image gets the 200 MB cap, exactly
 *    as before — and then a 415 from sniffKind, which reads the actual bytes;
 *  - declaring something no kind accepts gets the smallest cap there is,
 *    because such an upload is refused at any size, so the only question is
 *    how much of it to read first.
 *
 * `declaredContentType` is three-valued, and the three cases are priced
 * differently because they mean different things:
 *
 *  - a media type — the part said what it is;
 *  - `""` — the part was *found* and declared no Content-Type. RFC 7578 makes
 *    that `text/plain`, which no kind accepts, so this is a certain 415 and
 *    gets the smallest cap;
 *  - `null` — the part was not found within the peek budget, so nothing is
 *    known, and the answer is {@link UNDECLARED_UPLOAD_LIMIT_BYTES}.
 *
 * Content-Length **narrows and never widens**, and that asymmetry is the
 * whole safety argument. An earlier version let a large Content-Length lift
 * the undeclared case back up to MAX_UPLOAD_BYTES, on the reasoning that an
 * honest header is information — but the header is an assertion the client
 * has not delivered on, and sizing anything from it meant two connections
 * asserting 205 MB could commit ~430 MB apiece for a few hundred bytes of
 * actual traffic. Every input here can now only make the answer smaller than
 * the type-derived cap, so no client statement can enlarge what this process
 * commits to.
 *
 * The cost is one shape: a chunked request with more than 8 KiB of fields
 * ahead of the file *and* a file above the image cap is refused. No ordinary
 * client produces it — browsers send Content-Length for a FormData body, and
 * forms put the file input near the front.
 *
 * Content-Length is handled the way ugcportal-i04 established for the same
 * header: as an optimisation, never as the enforcement. Absent, it is
 * `Number(null)` === 0; malformed, it is NaN and every comparison against NaN
 * is false. Both fall through to the type-derived cap rather than to a cap of
 * zero or to an unbounded read, which is why the guard tests `> 0` explicitly
 * instead of relying on a comparison that happens to be false for both.
 */
export interface UploadReadLimit {
  /** Bytes of request stream this upload may deliver. */
  bytes: number;
  /**
   * True when Content-Length fixed the answer, so it describes *this request*
   * rather than the largest thing its declared kind is allowed to be.
   *
   * The distinction is what separates a refusal that is certainly right from
   * one that is a guess. A client that says "I am sending 200 MB" can be told
   * immediately that this container cannot buffer that. A client that merely
   * says "this is a video" has said nothing about its size, and refusing it
   * up front — which this route used to do — turns a 2 MB chunked upload into
   * a non-retryable 413 quoting a limit two orders of magnitude above it.
   */
  fromContentLength: boolean;
}

export function uploadReadLimitBytes(options: {
  declaredContentType: string | null;
  contentLengthHeader?: string | null;
}): UploadReadLimit {
  const { declaredContentType } = options;
  const declaredLength = Number(options.contentLengthHeader);
  const hasLength = Number.isFinite(declaredLength) && declaredLength > 0;

  const byType =
    declaredContentType === null
      ? UNDECLARED_UPLOAD_LIMIT_BYTES
      : (declaredUploadCapBytes(declaredContentType) ?? MAX_IMAGE_UPLOAD_BYTES) +
        MULTIPART_OVERHEAD_ALLOWANCE_BYTES;

  const capped = Math.min(byType, MAX_UPLOAD_BYTES);
  if (!hasLength) return { bytes: capped, fromContentLength: false };

  // The allowance is added because Content-Length frames the whole request
  // while a client that got it slightly wrong should still upload; it can
  // only narrow, never widen, because of the Math.min.
  const withLength = declaredLength + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;
  return {
    bytes: Math.min(capped, withLength),
    fromContentLength: withLength <= capped,
  };
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
 * ## How this composes with the gate, stated exactly
 *
 * There are two claims here and they are not the same claim. Conflating them
 * is what the first version of this comment did, which is the defect family
 * this whole bead is about, so both are spelled out.
 *
 * **1. Provable, and exact.** Against the gate's *own* pricing of a body —
 * `UPLOAD_BODY_BYTES`, which is `UPLOAD_BODY_COPIES x MAX_IMAGE_UPLOAD_BYTES`
 * and prices the file alone:
 *
 *     budgetBytes  =  spendable - limit x DECODE
 *     forQueue     =  spendable - limit x (DECODE + BODY)
 *     queueLimit  <=  floor(forQueue / BODY)          (by its derivation)
 *  => queueLimit x BODY  <=  forQueue
 *  => (limit + queueLimit) x BODY  <=  spendable - limit x DECODE
 *                                   =  budgetBytes
 *
 * The floored case needs its own line, since the proof assumes `budgetBytes`
 * is the derived value: the floor only bites when
 * `spendable - limit x DECODE < MIN`, which for a derived limit means limit
 * is 1 and `spendable < DECODE + MIN`; then
 * `forQueue = spendable - (DECODE + BODY) < MIN - BODY`, under one body, so
 * `queueLimit` is 0 and the requirement is `MIN >= 1 x BODY` — true by MIN's
 * own definition.
 *
 * **2. Measured, and one slot weaker.** What the route actually reserves is
 * not `BODY`. It is `UPLOAD_BODY_COPIES x (MAX_IMAGE_UPLOAD_BYTES +
 * MULTIPART_OVERHEAD_ALLOWANCE_BYTES)`, because at reservation time the file's
 * real size is not yet known and the allowance for the rest of the form has
 * to be inside the number. That is 512 KiB more per upload than the gate
 * prices, so at some container sizes the budget affords **one fewer**
 * maximum-size image than `limit + queueLimit`, and the gate's last queue slot
 * goes unused. Swept exhaustively at every whole MB from 512 to 4096: the
 * shortfall is never more than one slot, and the sizes where it happens are a
 * small minority. The earlier version of this comment asserted claim 1 and
 * described claim 2, which was simply false at those sizes.
 *
 * That shortfall is the safe direction — the tighter bound wins and the cost
 * is one upload of burst capacity, not a memory overshoot — and it is the
 * reason {@link MULTIPART_OVERHEAD_ALLOWANCE_BYTES} is 256 KiB rather than
 * 1 MiB, at which the shortfall reaches two slots. It is not closed by
 * reserving less, because reserving less than the stream can deliver would
 * make the reservation a guess rather than a bound, which is the thing this
 * module exists not to be.
 *
 * Neither claim says the gate stops shedding. On a large container the budget
 * affords many more bodies than the gate's ceiling-bound `limit + queueLimit`,
 * so a big burst is still buffered and shed there. What changed is that the
 * memory held while that happens is now inside a bound, which is the whole of
 * what this bead asked for. The converse case — an explicit
 * WATERMARK_QUEUE_LIMIT bigger than memory affords, which the gate honours and
 * only reports on — makes this bound the tighter of the two, so the surplus
 * queue never fills. Also the safe direction, also left alone.
 */
export function resolveUploadMemorySettings(
  watermark: WatermarkConcurrencySettings = resolveWatermarkConcurrencySettings(),
): UploadMemorySettings {
  const spendable =
    watermark.usableBudgetBytes - PREVIEW_PROCESS_BASELINE_BYTES;
  const decodeReserveBytes = watermark.limit * PREVIEW_BYTES_PER_OPERATION;

  const derivedBudget = spendable - decodeReserveBytes;
  const budgetBytes = Math.max(MIN_UPLOAD_BUDGET_BYTES, derivedBudget);
  // One decode short of everything, not everything. A solo caller is alone in
  // the *budget*, which is not the same as being alone in the process: if it
  // is an image it goes on to run a preview, and that decode lands on top of
  // the body it is still holding. Handing it the whole spendable region made
  // the real peak `spendable + DECODE`, which at 768 MB was 818,728,140 bytes
  // inside an 805,306,368-byte container — an OOM reachable with one upload.
  const soloReservationCeilingBytes = Math.max(
    budgetBytes,
    spendable - PREVIEW_BYTES_PER_OPERATION,
  );

  const projectedUploadPathPeakBytes =
    PREVIEW_PROCESS_BASELINE_BYTES +
    Math.max(
      // Many callers: bodies up to the budget, and up to `limit` previews.
      decodeReserveBytes + budgetBytes,
      // One caller: its body, and the one preview it can be running.
      soloReservationCeilingBytes + PREVIEW_BYTES_PER_OPERATION,
    );

  return {
    budgetBytes,
    soloReservationCeilingBytes,
    maxSingleUploadBytes: Math.max(
      0,
      Math.floor(soloReservationCeilingBytes / UPLOAD_BODY_COPIES) -
        MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
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

/**
 * What a request may commit to before it has delivered anything.
 *
 * One maximum-size image — the same figure as
 * {@link MIN_UPLOAD_BUDGET_BYTES}, deliberately, since that is the floor the
 * budget is guaranteed to have, so a single upload is always admissible on an
 * idle process.
 *
 * This is the whole unbacked commitment, and keeping it small is the point.
 * A reservation used to be taken in full from the cap the request *declared*
 * it was entitled to, which meant a client that asserted `video/mp4`, or a
 * 205 MB Content-Length, committed ~430 MB having sent nothing but part
 * headers. On a 1 GiB container that fits only under the solo rule, so it
 * 503'd every other upload — and since the stall timeout is an idle timer,
 * one byte every 29 seconds held it for Node's full `requestTimeout`. Two
 * alternating connections could close the upload route for a few hundred
 * bytes of traffic: cheaper to trigger than the problem this module exists to
 * fix, and an availability regression against having no bound at all.
 *
 * So: grant this much on arrival, and grow the reservation only as bytes are
 * actually delivered ({@link UploadReservation.growTo}). Everything past the
 * first 10 MB is backed by bytes the client has really sent.
 *
 * It cannot be much smaller. The reason a reservation is taken before the
 * read at all is so that a burst is refused *at the door* rather than after
 * every body is resident, and the granularity at which that decision is worth
 * making is one upload's worth. A one-chunk grant would admit all 60 of a
 * 60-request burst and only then start refusing them, which is the behaviour
 * this bead removed.
 */
export const INITIAL_GRANT_BYTES = MIN_UPLOAD_BUDGET_BYTES;

/** @see UploadReservation.growTo */
export type GrowOutcome = "ok" | "over-budget" | "too-large";

export interface UploadReservation {
  /** Bytes held right now: the initial grant, plus whatever has been grown. */
  readonly bytes: number;
  /** The most this reservation may ever grow to. */
  readonly ceilingBytes: number;
  /** Suggested backoff if a later {@link growTo} is refused. */
  readonly retryAfterSeconds: number;
  /**
   * Raises the reservation to `toBytes`, or says why it cannot be raised.
   *
   * `"ok"` when the reservation now covers `toBytes` — including when it
   * already did, so a caller charging cumulative progress can call this on
   * every chunk without tracking what it last asked for.
   *
   * `"over-budget"` when the process cannot spare the increase now; the
   * caller should stop reading and answer 503. `"too-large"` when no state of
   * the process could ever hold it, which is a 413 — and it is reported
   * *here*, from bytes that have arrived, rather than guessed at admission
   * from a declared kind's cap. Either way the bytes have not been committed,
   * so reading them anyway would put the process over the bound.
   *
   * Never shrinks. A reservation only releases when the handler returns,
   * because what it is pricing — the parsed File and the Buffer over its
   * arrayBuffer copy — stays reachable until then.
   */
  growTo(toBytes: number): GrowOutcome;
  /** Idempotent: a double release cannot hand the budget back twice. */
  release(): void;
}

export interface UploadMemoryStats {
  budgetBytes: number;
  /** Bytes reserved right now. May exceed the budget under the solo rule. */
  heldBytes: number;
  /**
   * What live reservations hold against *new* ones being admitted: the bytes
   * they have committed, plus, for any that have grown past the initial
   * grant, the rest of the ceiling they were promised. Always at least
   * {@link heldBytes}; the gap is the room reserved for uploads that are
   * still arriving.
   */
  pledgedBytes: number;
  /** Highest `heldBytes` ever observed. The number this budget exists to bound. */
  peakHeldBytes: number;
  /** Reservations granted, cumulative. */
  admitted: number;
  /** Uploads refused with {@link UploadMemoryExhaustedError}, cumulative. */
  shed: number;
  /** Reservations refused an increase mid-read, cumulative. */
  outgrown: number;
  /**
   * Exclusive reservations taken back for not sustaining
   * {@link EXCLUSIVE_MIN_THROUGHPUT_BYTES_PER_SEC}, cumulative.
   */
  revoked: number;
  /** Uploads refused with {@link UploadTooLargeForBudgetError}, cumulative. */
  refusedTooLarge: number;
}

export interface UploadMemoryBudget {
  /**
   * Admits a request that may eventually hold up to `ceilingBytes`, granting
   * it {@link INITIAL_GRANT_BYTES} (or the ceiling, if smaller) to start.
   * Never waits — see the note at the top of this file on why the outer of
   * two bounds in series does not queue.
   *
   * `certain` says whether `ceilingBytes` describes *this request* — it came
   * from a Content-Length — or merely the largest thing its declared kind may
   * be. Only a certain ceiling may be refused up front, because only then is
   * the refusal about a size the client itself has stated. An uncertain one
   * is admitted and judged by what arrives; see {@link UploadReadLimit}.
   *
   * @throws {UploadTooLargeForBudgetError} when a *certain* `ceilingBytes`
   *   could not be held even on an idle process (413; retrying will not
   *   help).
   * @throws {UploadMemoryExhaustedError} when the process is currently
   *   holding too much to grant even the initial share (503; retrying will).
   */
  reserve(ceilingBytes: number, options?: { certain?: boolean }): UploadReservation;
  stats(): UploadMemoryStats;
}

/**
 * A reservation as the budget sees it: what it is really holding, and what it
 * has been promised it may still take.
 */
interface LiveReservation {
  /** Memory actually committed. Backed by bytes the client has delivered. */
  bytes: number;
  /** The most it may ever grow to. */
  ceiling: number;
  /**
   * True once this request has delivered more than its initial grant, at
   * which point its whole ceiling is held against newcomers — see the note on
   * {@link createUploadMemoryBudget} about why the right to finish is earned
   * rather than claimed.
   */
  pledged: boolean;
  /**
   * When this reservation's pledge first exceeded the whole shared budget,
   * i.e. when it started excluding everybody, and what it held at that
   * moment. Undefined while it is only taking a share.
   */
  exclusiveSince?: number;
  exclusiveFrom?: number;
  /**
   * True once exclusivity has been taken away for not being earned. The
   * reservation keeps the memory it has (that cannot be handed back until
   * the handler returns) but stops holding anything against newcomers, and
   * its next growth fails, which ends the request.
   */
  revoked: boolean;
}

/**
 * The budget, and the policy for who gets refused when it runs out.
 *
 * ## The one rule, arrived at the hard way
 *
 * Three consecutive reviews each found a denial-of-service path here, each
 * through a different door, and all three were the same mistake:
 *
 *  - a reservation sized from a declared `Content-Length` (round 2);
 *  - a reservation sized from a declared media type (round 2, same fix);
 *  - exclusivity granted once at the crossing and then held for as long as
 *    the connection stayed open (round 4).
 *
 * The rule those converge on, and the one to test any future change here
 * against:
 *
 *   **A declaration may only ever narrow what this process will read.
 *   Nothing else is decided from one — not memory, not admission, not
 *   exclusivity, not rejection. Those are decided by bytes that have
 *   actually arrived, and any privilege granted on that basis has to keep
 *   being earned for as long as it is held.**
 *
 * The last clause is the round-4 addition and is the one that is easy to
 * forget: "earned once" is not the same as "earned", and a privilege that
 * excludes other people is exactly the kind that has to be re-checked. About
 * 10 MB of traffic used to buy five minutes of the whole upload route.
 *
 * ## The policy, chosen rather than fallen into
 *
 * Two things are scarce, and they are not the same thing: *memory*, which is
 * only ever committed as bytes actually arrive, and the *right to finish*,
 * which a long upload needs and a short one does not. Round 2 established the
 * first half — nothing is committed from what a client claims it will send.
 * Round 3 pointed out that the first half alone produces a bad second half:
 * with admission checking only the fixed grant, a 200 MB video streaming past
 * ~87 MB on a 1 GB container was killed the instant any small upload was
 * admitted behind it. That policy always sacrifices the long-running request
 * for the cheap latecomer, so retries do not converge: the busier the server,
 * the more certain the video is to die at the same point, having uploaded
 * tens of megabytes each time.
 *
 * The policy now is: **a request earns the right to finish by delivering
 * bytes.**
 *
 *  - While a request has delivered no more than {@link INITIAL_GRANT_BYTES},
 *    it holds only the grant and *pledges* only the grant. A client that
 *    merely claims a large upload — a declared `video/mp4`, a large
 *    Content-Length — therefore commits no memory beyond the grant and
 *    excludes nobody. That is what stops the exclusivity from becoming a
 *    denial-of-service lever, which is the trap that reserving at admission
 *    would have walked straight back into.
 *  - The moment it delivers more than the grant, its whole ceiling is pledged
 *    — atomically with that growth, so it either gets the room to finish or
 *    is refused right there. From then on newcomers are admitted against
 *    what is left, and the upload cannot be killed by one.
 *  - A pledge that exceeds the whole shared budget is *exclusive* — it shuts
 *    everybody else out — and is therefore conditional on continuing to earn
 *    it: {@link EXCLUSIVE_MIN_THROUGHPUT_BYTES_PER_SEC} sustained on average
 *    since it was taken, after {@link EXCLUSIVE_GRACE_MS}. Falling behind
 *    loses the pledge, and losing the pledge ends the request at its next
 *    chunk. A pledge that fits *inside* the budget is not policed at all,
 *    because it is costing nobody anything.
 *
 * Revocation is checked before every admission and every growth, but never
 * against the reservation doing the asking — a reservation calling in is
 * reporting progress, and the bytes it has just delivered are not counted yet.
 * So it is driven by the requests being excluded rather than by a timer, which
 * also means a squatter alone on an idle server is left alone: it is harming
 * nobody, and the idle timeout still has it. That
 * matters for how quickly the route recovers: a squatter has by definition
 * delivered almost nothing, so it is holding almost no *memory* — the pledge
 * was the whole of the harm — and taking the pledge back lets the blocked
 * traffic straight through, without waiting for the squatter to notice it is
 * dead.
 *
 * So a large upload is refused at exactly one point: ~10 MB in, where
 * refusing is cheap and a retry costs the client almost nothing. It is never
 * refused at 87 MB, and never because somebody arrived later.
 *
 * What this does **not** promise, stated because the previous version of this
 * comment promised something adjacent and untrue: an upload between the grant
 * and the budget (roughly 10-87 MB on 1 GB) shares the budget rather than
 * taking the process, so its pledge can fail at the transition if the budget
 * is busy. It fails early and cheaply, and it is not exclusive on purpose —
 * taking a whole container for a 20 MB upload would be the worse trade. An
 * upload at or below the grant — every image, and any video under ~10 MB —
 * never grows at all, so it can never be refused mid-read.
 *
 * A client that delivers the grant and then drips still holds *its own* grant
 * until the idle timeout or the end of the request — that is ugcportal-9qk,
 * and it is bounded by the grant, which is one image's worth. What it can no
 * longer do is hold everybody else's share with it.
 */
export function createUploadMemoryBudget(
  settings: UploadMemorySettings,
): UploadMemoryBudget {
  let peakHeldBytes = 0;
  let admitted = 0;
  let shed = 0;
  let outgrown = 0;
  let refusedTooLarge = 0;
  let revoked = 0;
  const live = new Set<LiveReservation>();

  /** Memory actually committed, across every live reservation. */
  function heldBytes(): number {
    let total = 0;
    for (const r of live) total += r.bytes;
    return total;
  }

  /** What a reservation holds against *other* requests being admitted. */
  function pledgeOf(r: LiveReservation): number {
    return r.pledged && !r.revoked ? r.ceiling : r.bytes;
  }

  /**
   * Has an exclusive holder stopped earning it?
   *
   * Measured as a cumulative average from the moment exclusivity was taken,
   * in reservation bytes (so {@link UPLOAD_BODY_COPIES} times the wire rate),
   * after a grace window. Only ever asked of a reservation that is actually
   * excluding other people.
   */
  function overdue(r: LiveReservation, now: number): boolean {
    if (r.exclusiveSince === undefined || r.revoked) return false;
    const elapsedMs = now - r.exclusiveSince;
    if (elapsedMs <= EXCLUSIVE_GRACE_MS) return false;
    const delivered = r.bytes - (r.exclusiveFrom ?? 0);
    const required =
      (elapsedMs / 1000) *
      EXCLUSIVE_MIN_THROUGHPUT_BYTES_PER_SEC *
      UPLOAD_BODY_COPIES;
    return delivered < required;
  }

  /**
   * Take exclusivity back from anyone who has stopped earning it.
   *
   * Run before every admission and every growth, which means it is run *by
   * the requests being excluded*. That is the load-bearing part: a connection
   * squatting on exclusivity is evicted by the arrival of the very traffic it
   * is blocking, rather than having to wait to be noticed. Revoking the
   * pledge alone unblocks them immediately, because a squatter has by
   * definition delivered almost nothing and so is holding almost no memory —
   * the pledge was the whole of the harm.
   */
  function reapExclusive(except: LiveReservation | null): void {
    const now = Date.now();
    for (const r of live) {
      // Never judge the reservation that is asking, because it is asking in
      // order to report progress: the bytes it has just delivered are not in
      // `r.bytes` yet, so judging it here would convict it of the silence it
      // is in the middle of ending. It is other people's arrival that
      // evicts a squatter, which is also the only moment the squatting is
      // doing any harm.
      if (r === except) continue;
      if (!overdue(r, now)) continue;
      r.revoked = true;
      r.pledged = false;
      r.exclusiveSince = undefined;
      revoked += 1;
      console.warn(
        `[media] revoked an exclusive upload reservation: ${mib(
          r.bytes - (r.exclusiveFrom ?? 0),
        )} delivered since it took the budget, below the ${mib(
          EXCLUSIVE_MIN_THROUGHPUT_BYTES_PER_SEC,
        )}/s it has to sustain to keep excluding other uploads`,
      );
    }
  }

  function otherPledges(self: LiveReservation | null): number {
    let total = 0;
    for (const r of live) if (r !== self) total += pledgeOf(r);
    return total;
  }

  /**
   * Can `self` (or a newcomer, when null) hold `want` bytes?
   *
   * Two ways, and the second is what makes a 200 MB video possible at all:
   * fit alongside what everyone else is holding or promised, or take more
   * than the budget when nobody else holds anything. "Nobody else" is the
   * entire precondition for the solo path — it is what guarantees at most one
   * preview can be running, because the route holds its reservation across
   * the watermark gate, which is why `soloReservationCeilingBytes` is a
   * decode short of the spendable region rather than all of it.
   */
  function admissible(self: LiveReservation | null, want: number): boolean {
    reapExclusive(self);
    const others = otherPledges(self);
    if (others + want <= settings.budgetBytes) return true;
    return others === 0 && want <= settings.soloReservationCeilingBytes;
  }

  function recordPeak(): void {
    const held = heldBytes();
    if (held > peakHeldBytes) peakHeldBytes = held;
  }

  return {
    reserve(
      ceilingBytes: number,
      options: { certain?: boolean } = {},
    ): UploadReservation {
      if (
        options.certain &&
        ceilingBytes > settings.soloReservationCeilingBytes
      ) {
        refusedTooLarge += 1;
        throw new UploadTooLargeForBudgetError(
          `Upload of up to ${ceilingBytes} bytes exceeds what this container can buffer (${settings.soloReservationCeilingBytes} bytes)`,
          { limitBytes: settings.maxSingleUploadBytes },
        );
      }

      const grant = Math.min(ceilingBytes, INITIAL_GRANT_BYTES);
      if (!admissible(null, grant)) {
        shed += 1;
        logShedUpload({
          wanted: grant,
          heldBytes: heldBytes(),
          budgetBytes: settings.budgetBytes,
          shed: shed + outgrown,
        });
        throw new UploadMemoryExhaustedError(
          `Upload buffers are at capacity (${heldBytes()} of ${settings.budgetBytes} bytes held); try again shortly`,
          { retryAfterSeconds: settings.retryAfterSeconds },
        );
      }

      const entry: LiveReservation = {
        bytes: grant,
        ceiling: ceilingBytes,
        pledged: false,
        revoked: false,
      };
      live.add(entry);
      admitted += 1;
      recordPeak();

      let released = false;
      return {
        get bytes() {
          return entry.bytes;
        },
        ceilingBytes,
        retryAfterSeconds: settings.retryAfterSeconds,
        growTo(toBytes: number): GrowOutcome {
          if (released || entry.revoked) return "over-budget";
          if (toBytes <= entry.bytes) return "ok";
          // Nothing this process could ever hold, whatever else is going on.
          // Reported from delivered bytes rather than guessed from the
          // declaration at admission (round-4 finding 2), which is what used
          // to refuse a 2 MB chunked video for being "larger than this server
          // can buffer".
          if (toBytes > settings.soloReservationCeilingBytes) {
            refusedTooLarge += 1;
            return "too-large";
          }
          // The ceiling is enforced by the caller's stream cap too, but a
          // reservation that could exceed it would make that cap and this
          // budget disagree about the same request.
          if (toBytes > ceilingBytes) return "over-budget";

          // Crossing the grant is where the right to finish is bought, and it
          // is bought for the *whole* ceiling at once. Checking only `toBytes`
          // here would let the upload inch past the grant into a budget that
          // could never have held the rest of it, which is the shape that
          // gets killed at 87 MB instead of refused at 10.
          const crossing = !entry.pledged && toBytes > INITIAL_GRANT_BYTES;
          // Pledging the whole ceiling is what buys the right to finish, but
          // an uncertain ceiling can be far beyond anything this container
          // could hold, and pledging *that* would be pledging a claim rather
          // than a need. Capped at what one caller may ever hold.
          const needed = crossing
            ? Math.min(ceilingBytes, settings.soloReservationCeilingBytes)
            : toBytes;

          if (!admissible(entry, needed)) {
            outgrown += 1;
            logShedUpload({
              wanted: needed,
              heldBytes: heldBytes(),
              budgetBytes: settings.budgetBytes,
              shed: shed + outgrown,
            });
            return "over-budget";
          }

          if (crossing) {
            entry.pledged = true;
            // Only a pledge that exceeds the whole shared budget excludes
            // anyone, and only that kind has to keep being earned.
            if (needed > settings.budgetBytes) {
              entry.exclusiveSince = Date.now();
              entry.exclusiveFrom = toBytes;
            }
          }
          entry.bytes = toBytes;
          recordPeak();
          // A reservation that has just been revoked by its own admissibility
          // check must not then act on the grant it was refused.
          if (entry.revoked) return "over-budget";
          return "ok";
        },
        release() {
          if (released) return;
          released = true;
          live.delete(entry);
          entry.bytes = 0;
        },
      };
    },
    stats: () => ({
      budgetBytes: settings.budgetBytes,
      heldBytes: heldBytes(),
      pledgedBytes: otherPledges(null),
      peakHeldBytes,
      admitted,
      shed,
      outgrown,
      revoked,
      refusedTooLarge,
    }),
  };
}

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Shortest interval between shed log lines; the rest are counted and reported
 * on the next one.
 *
 * Same reasoning as logShedUpload in src/lib/watermark.ts: shedding fires
 * precisely when the service is busiest, so a line per rejection would add a
 * log storm to a load problem. The first shed after a quiet period is always
 * logged, so the transition *into* shedding — the part worth alerting on — is
 * never delayed.
 *
 * This route's 503 is deliberately not logged by the route handler, which is
 * the convention ugcportal-u7g established for the gate's 503. But the gate
 * already had its own throttled line and this budget had none, so a saturated
 * upload path was invisible: one stalled client holding the budget produced
 * nothing but 503s with no record of why.
 */
export const SHED_LOG_INTERVAL_MS = DEFAULT_THROTTLE_INTERVAL_MS;

/**
 * Built on `createThrottledLog` (ugcportal-z3lo). This module's own
 * pre-migration copy said it plainly: "the first version of this logger
 * copied watermark.ts's *shape* and not its fix" — a third hand-rolled
 * instance of the exact same throttle, found while migrating the two this
 * bead already knew about. `flush: true` for the same reason
 * `watermark.ts`'s shed log needs it: env.example keys a saturation alert
 * on this line, so losing the tail of an isolated burst to a throttle with
 * no flush would under-report by exactly the amount this fix exists to
 * stop losing.
 */
const shedLog = createThrottledLog({
  intervalMs: SHED_LOG_INTERVAL_MS,
  flush: true,
  onFlush: (suppressed) => {
    console.warn(
      `[media] upload shed ${suppressed} more since the last line. Throttled ` +
        `to at most one flush per ${SHED_LOG_INTERVAL_MS}ms (this summary line ` +
        `plus the detailed line); see ugcportal-05b.`,
    );
  },
});

/**
 * Emit the tail of a burst: the sheds that were counted but never printed.
 *
 * Called from a timer (so it happens without anyone asking) and from
 * {@link uploadMemoryStats} (so it is observable synchronously, and so a
 * process shutting down before the timer fires still gets a chance).
 */
function flushShedLog(): void {
  shedLog.flushNow();
}

function logShedUpload(detail: {
  wanted: number;
  heldBytes: number;
  budgetBytes: number;
  shed: number;
}): void {
  shedLog.log((suppressed) => {
    console.warn(
      `[media] upload shed: wanted ${mib(detail.wanted)}, holding ${mib(
        detail.heldBytes,
      )} of ${mib(detail.budgetBytes)}; ${detail.shed} shed since start` +
        (suppressed > 0 ? ` (+${suppressed} more since the last line)` : ""),
    );
  });
}

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
export function reserveUploadMemory(
  ceilingBytes: number,
  options: { certain?: boolean } = {},
): UploadReservation {
  return getBudget().reserve(ceilingBytes, options);
}

/** Live view of the budget, for tests and for anything that wants to log it. */
export function uploadMemoryStats() {
  // Anyone asking how the budget is doing should not be told a shed count
  // that is still sitting unprinted in the throttle; see flushShedLog.
  flushShedLog();
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
  shedLog.reset();
}
