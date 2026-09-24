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

// The only columns any browsable surface is allowed to see. Spelled out as an
// explicit `select` rather than an `omit` so a column added later is excluded
// by default instead of leaking until someone remembers to blocklist it — and
// `key`, the ungated paid original (ugcportal-5d6), is the column that must
// never appear here.
const LISTING_SELECT = {
  id: true,
  kind: true,
  previewKey: true,
  originalName: true,
  createdAt: true,
} as const;

const LISTING_LIMIT = 100;

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
        return NextResponse.json(
          { error: "Could not process this image" },
          { status: 422 },
        );
      }
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
 *   2. the response exposes previewKey only — `key`, the paid original, is
 *      never selected, never mapped, never serialised.
 *
 * Scoped to the signed-in user's own media. Widening this to a public feed is
 * a deliberate decision for ugcportal-71y to make, not something to inherit by
 * accident. Turning previewKey into a fetchable URL (signed or public) belongs
 * with the delivery work, not here.
 */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.media.findMany({
    where: { userId, previewKey: { not: null } },
    select: LISTING_SELECT,
    orderBy: { createdAt: "desc" },
    take: LISTING_LIMIT,
  });

  // The where-clause already excludes them, but previewKey is still typed
  // `string | null`; narrowing here makes the emitted shape non-nullable and
  // means a future query change can't quietly start emitting preview-less rows.
  const items = rows.filter(
    (row): row is typeof row & { previewKey: string } => row.previewKey !== null,
  );

  return NextResponse.json({ items });
}
