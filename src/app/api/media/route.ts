import { randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  FALLBACK_ORIGINAL_NAME,
  MAX_UPLOAD_BYTES,
  PREVIEW_KEY_PREFIX,
  mediaPreviewColumns,
  sanitizeOriginalName,
  sniffKind,
  altTextEqualsFilename,
  validateAltText,
  validateCaption,
  validateUpload,
} from "@/lib/media";
import { MEDIA_OWNER_SELECT } from "@/lib/media-access";
import { listMedia } from "@/lib/media-listing";
import { prisma } from "@/lib/prisma";
import {
  multipartBoundary,
  peekDeclaredPartType,
  readCappedFormDataFrom,
} from "@/lib/request-body";
import {
  MEDIA_ALT_TEXT_FIELD,
  MEDIA_CAPTION_FIELD,
  MEDIA_TAGS_FIELD,
} from "@/lib/routes";
import {
  ObjectStorageUnreachableError,
  getBucketName,
  getS3Client,
  sendWithTransportClassification,
} from "@/lib/s3";
import { parseTagNames, resolveTagRows } from "@/lib/tags";
import { createThrottledLog } from "@/lib/throttled-log";
import type { UploadReservation } from "@/lib/upload-memory";
import {
  UploadMemoryExhaustedError,
  UploadTooLargeForBudgetError,
  reserveUploadMemory,
  uploadReadLimitBytes,
  uploadReservationBytes,
} from "@/lib/upload-memory";
import type { PreviewResult } from "@/lib/watermark";
import {
  PREVIEW_CONTENT_TYPE,
  PREVIEW_FILE_EXTENSION,
  WatermarkError,
  WatermarkOverloadedError,
  generateWatermarkedPreview,
} from "@/lib/watermark";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

/**
 * Shortest interval between "object storage unreachable" log lines — a
 * storage outage during a burst of uploads would otherwise produce one line
 * PER REQUEST (round-3 review finding 5, the same volume problem
 * `watermark.ts`'s `SHED_LOG_INTERVAL_MS` exists to solve for the busy-503
 * path, ugcportal-e86 — this is the storage-unreachable 503's sibling case).
 *
 * `flush: true`: an outage is exactly the kind of capacity/service signal
 * `createThrottledLog`'s doc comment says that option is for — losing the
 * tail of an outage burst (how many uploads actually failed, not just that
 * one did) is a real cost here, the same way it would be for a shed. The
 * flush itself only ever reports a COUNT (`onFlush` below), never any
 * per-request detail — see `createThrottledLog`'s own doc comment for why
 * that is load-bearing, not a simplification: round-4 review found that an
 * earlier version let the flush report whichever request's closure happened
 * to schedule it, silently dropping every other suppressed request's detail.
 *
 * NOT applied to the per-key "failed to clean up orphaned object" line in
 * `cleanupStoredKeys` below (round-4 finding, option (a) of the two offered):
 * orphaned keys are distinct and rare — nowhere near the volume a per-upload
 * busy-503 or a storage-unreachable classification can produce — and each
 * one is itself the only record of which object needs manual cleanup, so
 * throttling it trades a log-volume problem this line does not have for a
 * real chance of losing the one piece of information that line exists to
 * preserve.
 */
const OBJECT_STORAGE_UNREACHABLE_LOG_INTERVAL_MS = 10_000;

const objectStorageUnreachableLog = createThrottledLog({
  intervalMs: OBJECT_STORAGE_UNREACHABLE_LOG_INTERVAL_MS,
  flush: true,
  onFlush: (suppressed) => {
    console.error("[media] object storage unreachable (additional occurrences suppressed)", {
      suppressed,
    });
  },
});

/**
 * Test-only: the throttle above is module-level state, so a test file that
 * triggers the storage-unreachable log line more than once (likely, across
 * many `it` blocks in the same process) needs to reset it between tests —
 * otherwise every assertion past the first would be looking for a line the
 * throttle correctly, and silently, swallowed. Mirrors the same reset-export
 * pattern `resetWatermarkConcurrencyGate`/`resetUploadMemoryBudget` already
 * use in this codebase.
 */
export function resetObjectStorageUnreachableLogThrottles(): void {
  objectStorageUnreachableLog.reset();
}

/**
 * Best-effort compensation so a failed preview upload, a DB hiccup, or a
 * storage outage doesn't leave untracked objects sitting in the bucket
 * forever. Failures here are swallowed — the caller's own error (or 503) is
 * the one worth propagating — but they are logged, not discarded: a
 * compensation that is quietly failing every time leaks storage indefinitely
 * with nothing to notice it by. Expected to fail on every key in the
 * storage-unreachable path: if PutObject could not reach the bucket, this
 * DeleteObject cannot either, and that failure is itself worth the same log
 * line rather than a silently swallowed promise.
 *
 * Wrapped through `sendWithTransportClassification` (operation `"cleanup"`)
 * like the two PutObjects below, so a transport failure here is also a typed
 * `ObjectStorageUnreachableError` rather than a bare SDK error — not because
 * this function branches on it (it still logs and swallows either way), but
 * so the shape is consistent for whatever a caller's log line inspects.
 *
 * NOT throttled, deliberately (round-4 review finding) — see the doc comment
 * on `OBJECT_STORAGE_UNREACHABLE_LOG_INTERVAL_MS` above. Every key that
 * failed to clean up is logged, every time: there are at most two per
 * request (the original and the preview), and each one names an object nothing
 * else will ever point back to.
 */
async function cleanupStoredKeys(storedKeys: readonly string[]): Promise<void> {
  await Promise.all(
    storedKeys.map((storedKey) =>
      sendWithTransportClassification("cleanup", () =>
        getS3Client().send(
          new DeleteObjectCommand({
            Bucket: getBucketName(),
            Key: storedKey,
          }),
        ),
      ).catch((cleanupError) => {
        console.error("[media] failed to clean up orphaned object", {
          key: storedKey,
          cause: cleanupError,
        });
      }),
    ),
  );
}

// The response projections moved to src/lib/media-access.ts when PATCH
// (ugcportal-bdh) became a third caller that has to honour them — the comment
// explaining what they guarantee, and why there are two, lives with them there.

/**
 * The multipart field the upload arrives in.
 *
 * One constant because two things now depend on it naming the same part: the
 * pre-read peek that decides this request's cap, and the `get()` below that
 * actually takes the file out. A peek that inspected a different part than
 * the handler reads would size the cap from one file and buffer another.
 */
const UPLOAD_FIELD_NAME = "file";

/**
 * Admission, then the upload.
 *
 * The order is the point of ugcportal-05b. Everything down to
 * `reserveUploadMemory` is O(1) in the size of the body — a session lookup, a
 * header, and PART_HEADER_PEEK_BYTES or so of the stream — so an upload that
 * will not fit is answered before the process has committed to holding it.
 * Before this, the body was read to MAX_UPLOAD_BYTES (~205 MB) and *then*
 * checked against its kind's cap, and the only bound on how many requests did
 * that at once was how many a client cared to open.
 *
 * Four bounds now apply, and each is narrower than the last:
 *
 *  1. Content-Length against MAX_UPLOAD_BYTES — free, and the only one that
 *     can act on a request whose body has not been touched at all;
 *  2. the per-kind cap, from what the file part *declares* it is, applied to
 *     the request stream (see uploadReadLimitBytes for why a lying
 *     declaration cannot widen it);
 *  3. the process-wide byte budget, which is what turns "each request is
 *     bounded" into "all of them together are bounded" — the dimension
 *     ugcportal-i04's per-request cap deliberately did not cover. It is taken
 *     in two parts: a fixed grant of one image's worth before the read, which
 *     is what lets a burst be refused at the door, and then growth in step
 *     with the bytes actually delivered. Nothing past the grant is committed
 *     on a client's say-so, which is the difference between a bound and a
 *     number an attacker chooses (round-2 finding 1); and
 *  4. BODY_STALL_TIMEOUT_MS, which bounds how *long* a reservation can be
 *     held by a client that has stopped sending. Without it the first three
 *     are bounds on bytes with no bound on time, and one stalled connection
 *     holds its whole reservation until Node's 300-second requestTimeout —
 *     enough, on a 1 GB container, for a handful of them to 503 every other
 *     upload for five minutes (round-1 finding 2).
 *
 * On either refusal the remaining body is left unread rather than cancelled.
 * Cancelling a request body by hand has a known failure mode with
 * FormData-backed bodies (see the note on multipartRequest in route.test.ts),
 * and the runtime tears the stream down with the response anyway. The unread
 * bytes cost nothing on this heap.
 */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Unchanged from ugcportal-i04, and still only an early-out rather than the
  // enforcement: absent the header `Number(null)` is 0, malformed it is NaN,
  // and `NaN > limit` is false. The stream caps below are what hold the line.
  const contentLengthHeader = request.headers.get("content-length");
  const declaredLength = Number(contentLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 },
    );
  }

  if (!request.body) {
    return NextResponse.json(
      { error: "Expected a multipart form body" },
      { status: 400 },
    );
  }

  // The boundary comes from this request's own Content-Type, so the peek can
  // split on framing rather than guess at it — which is what lets it find the
  // file part wherever the form put it, instead of only when it happens to be
  // first (round-1 finding 1: a caption field rendered before the file input
  // is an ordinary form, and used to cost a ~430 MB reservation).
  const peeked = await peekDeclaredPartType(request.body, {
    fieldName: UPLOAD_FIELD_NAME,
    boundary: multipartBoundary(request.headers.get("content-type")),
  });
  const readLimit = uploadReadLimitBytes({
    declaredContentType: peeked.declaredContentType,
    contentLengthHeader,
  });
  const readLimitBytes = readLimit.bytes;

  let reservation;
  try {
    reservation = reserveUploadMemory(uploadReservationBytes(readLimitBytes), {
      // Only a limit the client itself stated may be refused before the body
      // is read. A limit derived from the declared *kind* says nothing about
      // this request's size, and refusing on it turned a 2 MB chunked video
      // into a non-retryable 413 (round-4 finding 2).
      certain: readLimit.fromContentLength,
    });
  } catch (error) {
    if (error instanceof UploadTooLargeForBudgetError) {
      // Not a load condition: this upload would not fit even on an idle
      // process, so a retry cannot help and must not be suggested.
      return NextResponse.json(
        {
          error: "Upload is larger than this server can buffer",
          maxBytes: error.limitBytes,
        },
        { status: 413 },
      );
    }
    if (error instanceof UploadMemoryExhaustedError) {
      // The same answer the watermark gate's shed path gives (ugcportal-u7g),
      // for the same reason: a busy-but-healthy server, not a bad upload.
      // Deliberately not error-logged — a burst is exactly when this fires,
      // and a line per rejection would turn a load problem into a log storm.
      return NextResponse.json(
        {
          error: "Too many uploads are being processed right now",
          retryAfterSeconds: error.retryAfterSeconds,
        },
        {
          status: 503,
          headers: { "Retry-After": String(error.retryAfterSeconds) },
        },
      );
    }
    throw error;
  }

  try {
    return await handleUpload(request, peeked.body, userId, {
      readLimitBytes,
      reservation,
      // Null means the peek could not find the file part, so `readLimitBytes`
      // is the undeclared floor rather than this upload's own kind's cap. The
      // 413 has to say so — see below.
      declarationRead: peeked.declaredContentType !== null,
    });
  } finally {
    // Held for the whole handler, not just the read: the File's backing store
    // and the Buffer over its arrayBuffer copy both stay reachable until this
    // returns, including across the S3 puts. Releasing at the end of the read
    // would free the accounting while the memory was still held, which is the
    // under-counting mistake ugcportal-e86 made twice.
    reservation.release();
  }
}

async function handleUpload(
  request: Request,
  requestBody: ReadableStream<Uint8Array>,
  userId: string,
  admission: {
    readLimitBytes: number;
    reservation: UploadReservation;
    declarationRead: boolean;
  },
) {
  const { readLimitBytes, reservation } = admission;
  const body = await readCappedFormDataFrom(request, requestBody, readLimitBytes, {
    // Commit memory in step with what has actually arrived. The grant taken
    // before the read is one image's worth; everything past that is backed by
    // bytes the client really sent, rather than by the size it claimed it was
    // going to send (round-2 finding 1). A refusal here stops the stream, so
    // the bytes are never forwarded to the parser.
    admitBytes: (received) =>
      reservation.growTo(uploadReservationBytes(received)),
    // (growTo's outcomes are the ones readCappedFormDataFrom expects.)
  });
  if (!body.ok) {
    if (body.status === 503) {
      // Same answer, and the same shape, as a refused admission: a
      // busy-but-healthy server. The budget already logged it, throttled.
      return NextResponse.json(
        {
          error: body.error,
          retryAfterSeconds: reservation.retryAfterSeconds,
        },
        {
          status: 503,
          headers: {
            "Retry-After": String(reservation.retryAfterSeconds),
          },
        },
      );
    }
    if (body.status === 413 && !admission.declarationRead) {
      // The cap that cut this body off was not this upload's own kind's cap:
      // the file part was not found within PART_HEADER_PEEK_BYTES, so it was
      // held to the limit for an upload of unknown kind. A bare "Request body
      // too large" is indistinguishable from being over a per-kind cap, so
      // say which limit applied and what would change it.
      //
      // Deliberately does *not* suggest sending Content-Length (round-4
      // finding 3): that header cannot widen this limit — uploadReadLimitBytes
      // only ever lets it narrow — so advising it would be unactionable, and
      // the client that hits this most often, a browser form with a large
      // field before the file input, has already sent one.
      return NextResponse.json(
        {
          error:
            `Could not find the '${UPLOAD_FIELD_NAME}' field near the start ` +
            `of the request, so this upload was limited to ${readLimitBytes} ` +
            "bytes. Put that field earlier in the form.",
          maxBytes: readLimitBytes,
        },
        { status: 413 },
      );
    }
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const file = body.value.get(UPLOAD_FIELD_NAME);
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'file' field" },
      { status: 400 },
    );
  }

  const validation = validateUpload(file);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.message },
      { status: validation.status },
    );
  }

  /*
   * Subject tags (ugcportal-jsc), read from repeated `tags` parts.
   *
   * REFUSED HERE, BEFORE ANY WORK. `getAll` returns [] for a form with no
   * tags at all, which parseTagNames accepts as "no tags" — so an untagged
   * upload is unaffected. A tag that is too long, or carries a bidi override,
   * fails the whole upload rather than being dropped, and that is the
   * opposite of what `sanitizeOriginalName` does one field over. The
   * asymmetry is deliberate: a filename is incidental metadata the user often
   * did not choose (a phone's picker wrote it), while a tag is a label they
   * typed on purpose, so silently storing a different one is worse than
   * saying no. The position matters too — this runs before the watermark and
   * before either PutObject, so a refusal leaves nothing in the bucket to
   * compensate for.
   *
   * `String(...)` is not used: a `tags` part sent as a file arrives as a File
   * and would stringify to "[object File]", which is a perfectly valid tag
   * name. parseTagNames refuses a non-string outright.
   */
  const tags = parseTagNames(body.value.getAll(MEDIA_TAGS_FIELD));
  if (!tags.ok) {
    return NextResponse.json({ error: tags.message }, { status: 400 });
  }

  /*
   * Alt text and caption (ugcportal-gwr). NOT required here — see
   * MAX_ALT_TEXT_LENGTH's docstring and the publish route, which is the one
   * place `altText` is actually enforced. What IS refused here is a value
   * that is present and malformed: too long, or carrying a bidi override —
   * the same "fails the whole upload rather than being silently dropped"
   * treatment `tags` gets above, and for the same reason: both are strings a
   * person typed on purpose, immediately before submitting this request, so
   * silently storing something other than what they typed is worse than
   * saying no.
   *
   * `get()`, not `getAll()`: unlike tags these are sent at most once per
   * upload (MEDIA_ALT_TEXT_FIELD's docstring in src/lib/routes.ts). A part
   * sent as a file would arrive as a File rather than a string; `validateAltText`
   * and `validateCaption` already refuse a non-string outright, so that
   * shape is rejected rather than coerced into "[object File]".
   */
  const altText = validateAltText(body.value.get(MEDIA_ALT_TEXT_FIELD));
  if (!altText.ok) {
    return NextResponse.json({ error: altText.message }, { status: 400 });
  }
  /*
   * Computed once and reused below at the actual write (review round 3
   * finding 9) — `file.name` does not change between the two reads, so a
   * second call here would be doing the same work twice for no reason, and
   * is exactly the kind of duplicate-call shape that drifts if either site
   * is edited independently later without the other.
   */
  const sanitizedFileName = sanitizeOriginalName(file.name);

  /*
   * Alt text equal to the filename is one of K2's own "never happen" cases
   * (ugcportal-gwr's Norwegian description: "alt-tekst lik filnavnet"), and
   * review round 2 found that nothing stopped an uploader from simply
   * TYPING the filename into the field themselves — `validateAltText` only
   * checks length and character class, not content. `altTextEqualsFilename`
   * (src/lib/media-rules.ts) is the SAME function the upload form's client-
   * side precheck calls (review round 3 finding 4) for the raw name; this
   * route additionally checks the sanitized form that actually becomes
   * `originalName` (sanitizeOriginalName can repair a name that started out
   * different but would collapse to the same string), which the client
   * cannot do without pulling in a node-only module — see that function's
   * own docstring for why.
   *
   * `sanitizedFileName` is EXCLUDED from this check when it equals
   * `FALLBACK_ORIGINAL_NAME` ("untitled") (review round 4, finding 1): that
   * value means `sanitizeOriginalName` could not read a real name at all —
   * the file arrived with an empty name, or one made only of
   * stripped/invisible characters — so it is not actually the filename the
   * uploader saw, it is this codebase's placeholder for "no filename was
   * readable". An uploader who honestly types "untitled" as alt text for
   * an abstract photo is not repeating anything, and refusing them for it
   * would be a false positive K2 was never aimed at. The RAW `file.name`
   * is still always checked: a file whose real name happens to be
   * literally "untitled" (no extension) remains caught by that half of
   * the comparison.
   */
  const filenamesToCheck = [file.name];
  if (sanitizedFileName !== FALLBACK_ORIGINAL_NAME) {
    filenamesToCheck.push(sanitizedFileName);
  }
  if (altTextEqualsFilename(altText.value, filenamesToCheck)) {
    return NextResponse.json(
      {
        error:
          "Alt text must describe the photo, not repeat its filename.",
        field: "altText",
      },
      { status: 400 },
    );
  }
  const caption = validateCaption(body.value.get(MEDIA_CAPTION_FIELD));
  if (!caption.ok) {
    return NextResponse.json({ error: caption.message }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (sniffKind(buffer) !== validation.kind) {
    return NextResponse.json(
      { error: "File content does not match its declared type" },
      { status: 415 },
    );
  }

  const key = `media/${userId}/${randomUUID()}-${sanitizeFilename(file.name)}`;

  // Watermark first, store second.
  //
  // Failure policy (ugcportal-44q K2): a failed watermark fails the whole
  // upload. There is no path where the original lands in the bucket with a
  // null previewKey for an image — that row would be an unprotected original
  // sitting in the same table the gallery reads from, one careless query away
  // from being served. Doing this before any PutObject means a rejected
  // upload also leaves nothing behind to compensate for.
  //
  // VIDEO gets no preview yet (ugcportal-pmb owns the watermarked poster
  // frame). Those rows keep previewKey null and are excluded from the listing
  // below, so they are never browsable in the meantime.
  let preview: PreviewResult | null = null;
  if (validation.kind === "IMAGE") {
    try {
      preview = await generateWatermarkedPreview(buffer);
    } catch (error) {
      if (error instanceof WatermarkError) {
        // Log the underlying sharp failure. A 422 on its own is
        // indistinguishable from "user uploaded junk"; if watermarking starts
        // failing systemically the cause is the only thing that says so.
        console.error("[media] watermark generation failed", {
          userId,
          mimeType: file.type,
          sizeBytes: file.size,
          cause: error.cause,
        });
        return NextResponse.json(
          { error: "Could not process this image" },
          { status: 422 },
        );
      }
      if (error instanceof WatermarkOverloadedError) {
        // Not a fault, and not this route's fault to report as one. The gate
        // (ugcportal-e86) is working as designed, and watermark.ts already
        // emits a throttled console.warn per shed (logShedUpload) — at most
        // one line per SHED_LOG_INTERVAL_MS *in total*, off a single global
        // timestamp rather than one throttle per reason. The line that fires
        // does carry that shed's own reason/limit/queue/shedTotal, but a shed
        // suppressed by the throttle is only ever counted in the next line's
        // "+N more" tally (or the flush line, which reports a count with no
        // reason at all) — so e.g. a `timeout` shed a few seconds after a
        // `queue-full` shed can be folded into a count without its reason
        // ever appearing in the logs. Logging again here, even at a lower
        // level, would reintroduce exactly the volume problem this bead
        // exists to remove: a 52-upload shed burst would go from "52 error
        // lines" to "52 lines of some other level," not to a handful. The
        // operator-facing signal already exists and is already throttled;
        // all this branch owes the caller is a response that says try again.
        return NextResponse.json(
          {
            error: "Too many uploads are being processed right now",
            retryAfterSeconds: error.retryAfterSeconds,
          },
          {
            status: 503,
            headers: { "Retry-After": String(error.retryAfterSeconds) },
          },
        );
      }
      // Not a problem with this file, and not routine shedding either — e.g.
      // WatermarkFontUnavailableError, meaning the runtime has no fonts and
      // every preview would come out under-marked. That is a genuine 5xx
      // fault distinct from both of the above and must not be reported as a
      // bad upload or as a busy-but-healthy gate.
      console.error("[media] watermark service unavailable", error);
      throw error;
    }
  }

  // Both preview columns at once, via the one helper that can produce them.
  //
  // The preview's own UUID is independent of the original's, deliberately.
  // Withholding the original's key from every response is worthless if the key
  // can simply be recomputed from what we do return: sharing one id between the
  // two would mean previewKey + originalName + the (deterministic)
  // sanitizeFilename above is enough to reconstruct the original's full path,
  // so the moment previewKey became fetchable against this bucket, K2 would
  // fall to string concatenation. Uncorrelated ids make the original's key
  // unguessable from anything any listing exposes.
  //
  // `previewKey` is the storage path and embeds `userId`, so it is owner-only;
  // `previewId` is the opaque handle the anonymous feed exposes instead
  // (ugcportal-r1d). They are inseparable — a row with one and not the other
  // is filtered out of every listing — so they are never written as two
  // independent expressions. See mediaPreviewColumns in src/lib/media.ts.
  const previewColumns = mediaPreviewColumns(
    preview
      ? `${PREVIEW_KEY_PREFIX}${userId}/${randomUUID()}${PREVIEW_FILE_EXTENSION}`
      : null,
  );
  const { previewKey } = previewColumns;

  // Track what actually made it into the bucket so the compensating delete
  // below covers both objects, not just the original.
  const storedKeys: string[] = [];

  try {
    await sendWithTransportClassification("original", () =>
      getS3Client().send(
        new PutObjectCommand({
          Bucket: getBucketName(),
          Key: key,
          Body: buffer,
          ContentType: file.type,
        }),
      ),
    );
    storedKeys.push(key);

    if (preview && previewKey) {
      await sendWithTransportClassification("preview", () =>
        getS3Client().send(
          new PutObjectCommand({
            Bucket: getBucketName(),
            Key: previewKey,
            Body: preview.data,
            ContentType: PREVIEW_CONTENT_TYPE,
          }),
        ),
      );
      storedKeys.push(previewKey);
    }

    /*
     * ONE TRANSACTION FOR THE TAG ROWS AND THE MEDIA ROW.
     *
     * The tag rows have to exist before `connect` can name them, so they are
     * written first — and an earlier version left it at that, inside the
     * `try` on the theory that the compensating cleanup below would cover
     * them. It does not: that cleanup deletes the OBJECTS in `storedKeys`,
     * which is a different kind of debris. A `media.create` that threw on
     * the next line (a unique violation on `previewId`, a dropped libSQL
     * connection, a full disk) left the bucket tidy and the Tag rows behind
     * forever, vocabulary minted by an upload that never existed — and
     * nothing in this product deletes a tag.
     *
     * A transaction rather than tracking created-versus-found slugs and
     * deleting them on the compensating path, which was the other way to do
     * it. Deleting a Tag is not a safe compensation: `_MediaToTag` cascades,
     * so a concurrent upload that attached the same new subject in between
     * would silently lose it. Rolling back never touches a row somebody else
     * committed.
     */
    const media = await prisma.$transaction(async (tx) => {
      const tagRefs = await resolveTagRows(tags.value, tx);

      return tx.media.create({
        data: {
          userId,
          kind: validation.kind,
          key,
          // Spread as a pair, never as two fields, so the columns cannot
          // drift apart at this call site either.
          ...previewColumns,
          mimeType: file.type,
          sizeBytes: file.size,
          // Repaired, not rejected — see sanitizeOriginalName in
          // src/lib/media.ts for why the upload path is lenient where the
          // rename path refuses. `file.name` is fully client-controlled and
          // the GET listing echoes it back, so it cannot go in raw.
          originalName: sanitizedFileName,
          // Null, not "", when nothing was supplied — the same "absent means
          // not yet decided" encoding as the triage booleans on
          // MediaListing, and what lets the publish gate (ugcportal-gwr K1)
          // use a plain null/blank check rather than two.
          altText: altText.value === "" ? null : altText.value,
          caption: caption.value === "" ? null : caption.value,
          // `connect`, not `connectOrCreate`: resolveTagRows already made
          // sure every row exists, so one place decides how a Tag comes into
          // existence and both writers (here and PUT .../tags) go through it.
          tags: { connect: tagRefs },
        },
        select: MEDIA_OWNER_SELECT,
      });
    });

    return NextResponse.json(media, { status: 201 });
  } catch (error) {
    if (error instanceof ObjectStorageUnreachableError) {
      // A storage outage (ugcportal-1b2c) — MinIO/S3 unreachable, not
      // anything about this upload — so it is answered deliberately rather
      // than as the bare, stack-trace-bearing 500 an unhandled SDK rejection
      // produced before this. `error` can only ever be this type because
      // `sendWithTransportClassification` (src/lib/s3.ts) classifies at the
      // source, around the S3 send itself — a DB/libSQL error from the
      // `prisma.$transaction` call a few lines up can never land here no
      // matter what `code` it happens to carry (round-1 finding 1).
      //
      // The client gets a stable, machine-readable `reason` plus a message
      // that names neither the endpoint nor the bucket; the operator gets
      // which operation failed, the transport code, the SDK's own retry
      // count, the underlying message, and — via `cause` — the stack
      // (round-2 finding 2: the fields above are the quick-scan summary, but
      // without the error object itself, console.error has nothing to print
      // a stack trace from, and "object storage unreachable" with no stack
      // is a harder outage to debug than it needs to be).
      //
      // Throttled (round-3 finding 5): an outage can affect every upload in
      // flight, and without this a request-per-second burst would log a
      // line per request for the one thing already true of all of them. See
      // src/lib/throttled-log.ts.
      const unreachableError = error;
      objectStorageUnreachableLog.log((suppressed) => {
        console.error("[media] object storage unreachable", {
          operation: unreachableError.operation,
          code: unreachableError.code,
          attempts: unreachableError.attempts,
          message: unreachableError.message,
          cause: unreachableError,
          ...(suppressed > 0 ? { suppressed } : {}),
        });
      });
      // Whatever already landed in the bucket (the original, and/or the
      // preview) before the failing call must not be left orphaned. If
      // storage is genuinely unreachable this DeleteObject will fail too —
      // cleanupStoredKeys logs that rather than masking it or throwing.
      await cleanupStoredKeys(storedKeys);
      return NextResponse.json(
        {
          error:
            "Object storage is temporarily unavailable. Please try again shortly.",
          // Machine-readable, and stable: src/app/upload/outcomes.ts reads
          // this to tell this 503 apart from the "too many uploads" shed
          // 503 (ugcportal-u7g/e86), which carries no such field. Both
          // reach the client as the same HTTP status, but they mean
          // different things and must not collapse into the same sentence
          // (round-1 finding 2).
          reason: "object_storage_unavailable",
        },
        { status: 503 },
      );
    }

    // Best-effort compensation so a failed preview upload or DB hiccup doesn't
    // leave untracked objects sitting in the bucket forever. Failures here are
    // swallowed because the original error is the one worth propagating — but
    // they are logged, not discarded: a compensation that is quietly failing
    // every time leaks storage indefinitely with nothing to notice it by.
    await cleanupStoredKeys(storedKeys);
    throw error;
  }
}

/**
 * Listing feed for the signed-in user's own media.
 *
 * This is deliberately the minimum needed to make ugcportal-44q's K2
 * checkable — "the original file URL is never reachable from the gallery" is
 * only a real guarantee once something actually lists media. The gallery UI
 * itself (lightbox, layout, public portfolio page) is ugcportal-71y's job and
 * is not built here; that bead should consume this endpoint's projection
 * rather than querying Media directly.
 *
 * Two rules hold the guarantee up, and both live in listMedia():
 *   1. only rows that have a preview are returned, so anything without a
 *      protected representation (today: every VIDEO) is invisible; and
 *   2. the response goes through MEDIA_OWNER_SELECT, which has no `key` in
 *      it — the paid original is never selected, mapped, or serialised.
 *
 * Scoped to the signed-in user's own media, and deliberately NOT filtered by
 * publishedAt: this is the owner's view of their own library, where seeing
 * their unpublished uploads is the entire point (ugcportal-r1d). The public
 * feed is a separate endpoint, GET /api/public/media, precisely so that one
 * handler never has to decide which audience it is answering — that
 * role-dependent branch is the shape that leaks.
 *
 * Turning previewKey into a fetchable URL (signed or public) belongs with the
 * delivery work, not here.
 */
/**
 * Private to one account, and said so explicitly.
 *
 * Deliberately NOT the same header as GET /api/public/media, because the two
 * endpoints are uncacheable for different reasons and the header should carry
 * the reason. The public feed is `no-store` because its content changes when
 * an owner unpublishes and a cache must not outlive that. This one is
 * `private` because the response belongs to exactly one account: the body is
 * that user's library, drafts included.
 *
 * `private` is the load-bearing word. This route authenticates with a session
 * *cookie*, and a shared cache does not treat a cookie-bearing response as
 * unshareable the way RFC 9111 makes it treat an `Authorization`-bearing one.
 * Absent this header, a misconfigured intermediary keying on the URL alone
 * could store one user's response and serve it to the next caller — one
 * person's private uploads handed to a stranger. The preconditions are narrow;
 * the outcome is not.
 *
 * `no-store` alongside it because there is nothing worth keeping even in the
 * end user's own browser: a list of someone's unpublished work should not
 * survive on a shared machine after they sign out.
 */
const PRIVATE_NO_STORE = { "cache-control": "private, no-store" } as const;

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE },
    );
  }

  const result = await listMedia(
    request.url,
    // `previewKey` only, deliberately. The anonymous feed additionally filters
    // on `previewId` because that is the handle it hands out; here it would
    // buy nothing — this projection returns `previewKey` and the owner can
    // resolve their own — while hiding a row with a real preview object but no
    // public handle from the person who uploaded it. Fail-closed is right for
    // the public feed, where being wrong means a leak. On someone's own
    // library it means their work disappearing. See MediaOwnerScope.
    { userId, previewKey: { not: null } },
    // The owner's own filenames. The anonymous feed uses the narrower
    // MEDIA_ANONYMOUS_SELECT — see src/lib/media-access.ts.
    MEDIA_OWNER_SELECT,
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: PRIVATE_NO_STORE },
    );
  }

  return NextResponse.json(result.page, { headers: PRIVATE_NO_STORE });
}
