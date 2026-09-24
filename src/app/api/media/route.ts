import { randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, sniffKind, validateUpload } from "@/lib/media";
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

// The only Media columns any HTTP response may carry, shared by POST and GET
// so the two can't drift apart.
//
// Spelled out as an explicit `select` rather than an `omit` so a column added
// later is excluded by default instead of leaking until someone remembers to
// blocklist it — and `key`, the ungated paid original (ugcportal-5d6), is the
// column that must never appear here, in either direction. Returning the
// freshly created row from POST is just as much an exposure as listing it.
const MEDIA_PUBLIC_SELECT = {
  id: true,
  kind: true,
  previewKey: true,
  mimeType: true,
  sizeBytes: true,
  originalName: true,
  createdAt: true,
} as const;

const DEFAULT_LISTING_LIMIT = 50;
const MAX_LISTING_LIMIT = 100;

export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
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

  const uploadId = randomUUID();
  const key = `media/${userId}/${uploadId}-${sanitizeFilename(file.name)}`;

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

  const previewKey = preview
    ? `previews/${userId}/${uploadId}${PREVIEW_FILE_EXTENSION}`
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
        originalName: file.name,
      },
      select: MEDIA_PUBLIC_SELECT,
    });

    return NextResponse.json(media, { status: 201 });
  } catch (error) {
    // Best-effort compensation so a failed preview upload or DB hiccup doesn't
    // leave untracked objects sitting in the bucket forever.
    await Promise.all(
      storedKeys.map((storedKey) =>
        getS3Client()
          .send(
            new DeleteObjectCommand({
              Bucket: getBucketName(),
              Key: storedKey,
            }),
          )
          .catch(() => {}),
      ),
    );
    throw error;
  }
}

function parseLimit(raw: string | null): number {
  // Number(null) and Number("") are both 0, which would silently clamp an
  // absent ?limit down to a single row instead of using the default.
  if (raw === null || raw.trim() === "") return DEFAULT_LISTING_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LISTING_LIMIT;
  return Math.min(MAX_LISTING_LIMIT, Math.max(1, Math.floor(parsed)));
}

/**
 * Listing feed for browsable media.
 *
 * This is deliberately the minimum needed to make ugcportal-44q's K2
 * checkable — "the original file URL is never reachable from the gallery" is
 * only a real guarantee once something actually lists media. The gallery UI
 * itself (lightbox, layout, public portfolio page) is ugcportal-71y's job and
 * is not built here; that bead should consume this endpoint's projection
 * rather than querying Media directly.
 *
 * Two rules hold the guarantee up:
 *   1. only rows that have a previewKey are returned, so anything without a
 *      protected representation (today: every VIDEO) is invisible; and
 *   2. the response goes through MEDIA_PUBLIC_SELECT, which has no `key` in
 *      it — the paid original is never selected, mapped, or serialised.
 *
 * Paginated with an opaque cursor (the last item's id) rather than a bare cap,
 * so nothing becomes permanently unreachable once a user passes the page size,
 * and `hasMore` tells the caller when the list was truncated. Ordering is
 * (createdAt desc, id desc) because cursor pagination needs a unique tiebreak
 * to be stable across rows sharing a timestamp.
 *
 * Scoped to the signed-in user's own media. Widening this to a public feed is
 * a deliberate decision for ugcportal-71y to make, not something to inherit by
 * accident. Turning previewKey into a fetchable URL (signed or public) belongs
 * with the delivery work, not here.
 */
export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const limit = parseLimit(params.get("limit"));
  const cursor = params.get("cursor");

  const rows = await prisma.media.findMany({
    where: { userId, previewKey: { not: null } },
    select: MEDIA_PUBLIC_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row is a cheap way to know whether another page exists
    // without a second count query.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // The where-clause already excludes them, but previewKey is still typed
  // `string | null`; narrowing here makes the emitted shape non-nullable and
  // means a future query change can't quietly start emitting preview-less rows.
  const items = page.filter(
    (row): row is typeof row & { previewKey: string } => row.previewKey !== null,
  );

  return NextResponse.json({
    items,
    hasMore,
    // Taken from the unfiltered page, so the defensive filter above can never
    // strand the caller on a cursor that skips rows.
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  });
}
