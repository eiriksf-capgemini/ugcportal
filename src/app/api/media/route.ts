import { randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  MAX_UPLOAD_BYTES,
  PREVIEW_KEY_PREFIX,
  mediaPreviewColumns,
  sanitizeOriginalName,
  sniffKind,
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
import { getBucketName, getS3Client } from "@/lib/s3";
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
      // the file part was not found in the first PART_HEADER_PEEK_BYTES and
      // no usable Content-Length was sent, so it was held to the smallest
      // supported size. A bare "Request body too large" is indistinguishable
      // from being over a per-kind cap, and a chunked client sending a 50 MB
      // video would be cut at ~10 MB with no idea why — the exact trap
      // UNDECLARED_UPLOAD_LIMIT_BYTES's own comment claims to have removed.
      // So say which limit applied, and both ways out of it.
      return NextResponse.json(
        {
          error:
            "Could not read the upload's declared type, so it was limited to " +
            `${readLimitBytes} bytes. Send a Content-Length header, or put ` +
            `the '${UPLOAD_FIELD_NAME}' field earlier in the form.`,
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
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getBucketName(),
        Key: key,
        Body: buffer,
        ContentType: file.type,
      }),
    );
    storedKeys.push(key);

    if (preview && previewKey) {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: getBucketName(),
          Key: previewKey,
          Body: preview.data,
          ContentType: PREVIEW_CONTENT_TYPE,
        }),
      );
      storedKeys.push(previewKey);
    }

    const media = await prisma.media.create({
      data: {
        userId,
        kind: validation.kind,
        key,
        // Spread as a pair, never as two fields, so the columns cannot drift
        // apart at this call site either.
        ...previewColumns,
        mimeType: file.type,
        sizeBytes: file.size,
        // Repaired, not rejected — see sanitizeOriginalName in
        // src/lib/media.ts for why the upload path is lenient where the
        // rename path refuses. `file.name` is fully client-controlled and
        // the GET listing echoes it back, so it cannot go in raw.
        originalName: sanitizeOriginalName(file.name),
      },
      select: MEDIA_OWNER_SELECT,
    });

    return NextResponse.json(media, { status: 201 });
  } catch (error) {
    // Best-effort compensation so a failed preview upload or DB hiccup doesn't
    // leave untracked objects sitting in the bucket forever. Failures here are
    // swallowed because the original error is the one worth propagating — but
    // they are logged, not discarded: a compensation that is quietly failing
    // every time leaks storage indefinitely with nothing to notice it by.
    await Promise.all(
      storedKeys.map((storedKey) =>
        getS3Client()
          .send(
            new DeleteObjectCommand({
              Bucket: getBucketName(),
              Key: storedKey,
            }),
          )
          .catch((cleanupError) => {
            console.error("[media] failed to clean up orphaned object", {
              key: storedKey,
              cause: cleanupError,
            });
          }),
      ),
    );
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
