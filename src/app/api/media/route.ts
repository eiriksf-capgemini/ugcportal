import { randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  MAX_UPLOAD_BYTES,
  sanitizeOriginalName,
  sniffKind,
  validateUpload,
} from "@/lib/media";
import { MEDIA_PUBLIC_SELECT } from "@/lib/media-access";
import { listMedia } from "@/lib/media-listing";
import { prisma } from "@/lib/prisma";
import { getBucketName, getS3Client } from "@/lib/s3";
import type { PreviewResult } from "@/lib/watermark";
import {
  PREVIEW_CONTENT_TYPE,
  PREVIEW_FILE_EXTENSION,
  WatermarkError,
  generateWatermarkedPreview,
} from "@/lib/watermark";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

/** Thrown from inside the body stream, so it surfaces out of formData(). */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Wraps a body stream so it errors the moment more than `limit` bytes have
 * gone through it, rather than letting the parser downstream buffer whatever
 * the client feels like sending.
 */
function cappedBody(
  source: ReadableStream<Uint8Array>,
  limit: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit) {
          controller.error(new BodyTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function isBodyTooLarge(error: unknown): boolean {
  // undici sometimes surfaces a stream error wrapped in its own TypeError,
  // so follow the cause chain rather than checking only the top.
  for (let cursor = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor instanceof BodyTooLargeError) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

type FormDataResult =
  | { ok: true; value: FormData }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads the multipart body, never letting more than `limit` bytes through.
 *
 * The Content-Length check is only a cheap early-out and deliberately not the
 * enforcement (ugcportal-i04): the header is absent on a chunked request —
 * `Number(null)` is 0 — and can be malformed, where `Number()` yields NaN and
 * `NaN > limit` is false. Either shape used to fall straight through to an
 * unbounded `request.formData()`, letting one authenticated caller make the
 * server buffer far more than the ~205 MB cap. The wrapped stream is what
 * actually holds the line; the header just saves the work when a client
 * declares an oversized upload honestly.
 *
 * The body is re-framed onto a new Request so the platform still does the
 * multipart parsing — this bounds what the parser is fed, it does not
 * reimplement it. Content-Length is dropped from the copied headers because
 * it describes the original framing, not this one.
 */
async function readCappedFormData(
  request: Request,
  limit: number,
): Promise<FormDataResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "Expected a multipart form body" };
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");

  const reframed = new Request(request.url, {
    method: request.method,
    headers,
    body: cappedBody(request.body, limit),
    // Required by the fetch spec for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  try {
    return { ok: true, value: await reframed.formData() };
  } catch (error) {
    if (isBodyTooLarge(error)) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
    return { ok: false, status: 400, error: "Malformed multipart form body" };
  }
}

// MEDIA_PUBLIC_SELECT moved to src/lib/media-access.ts when PATCH
// (ugcportal-bdh) became a third caller that has to honour it — the comment
// explaining what it guarantees lives with it there.

export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await readCappedFormData(request, MAX_UPLOAD_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const file = body.value.get("file");
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
      // Not a problem with this file — e.g. WatermarkFontUnavailableError,
      // meaning the runtime has no fonts and every preview would come out
      // under-marked. That is a 5xx, and must not be reported as a bad upload.
      console.error("[media] watermark service unavailable", error);
      throw error;
    }
  }

  // An independent UUID, deliberately not derived from `key`.
  //
  // Withholding the original's key from every response is worthless if the
  // key can simply be recomputed from what we do return. Sharing one id
  // between the two would mean previewKey + originalName + the (deterministic)
  // sanitizeFilename above is enough to reconstruct the original's full path —
  // so the moment ugcportal-71y makes previewKey fetchable against this
  // bucket, K2 is defeated by string concatenation. Uncorrelated ids make the
  // original's key unguessable from anything the listing exposes.
  const previewKey = preview
    ? `previews/${userId}/${randomUUID()}${PREVIEW_FILE_EXTENSION}`
    : null;

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
        previewKey,
        mimeType: file.type,
        sizeBytes: file.size,
        // Repaired, not rejected — see sanitizeOriginalName in
        // src/lib/media.ts for why the upload path is lenient where the
        // rename path refuses. `file.name` is fully client-controlled and
        // the GET listing echoes it back, so it cannot go in raw.
        originalName: sanitizeOriginalName(file.name),
      },
      select: MEDIA_PUBLIC_SELECT,
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
 *   1. only rows that have a previewKey are returned, so anything without a
 *      protected representation (today: every VIDEO) is invisible; and
 *   2. the response goes through MEDIA_PUBLIC_SELECT, which has no `key` in
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
export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await listMedia(request.url, {
    userId,
    previewKey: { not: null },
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.page);
}
