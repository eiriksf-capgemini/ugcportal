import { randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, sniffKind, validateUpload } from "@/lib/media";
import { prisma } from "@/lib/prisma";
import { getBucketName, getS3Client } from "@/lib/s3";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

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

  const key = `media/${userId}/${randomUUID()}-${sanitizeFilename(file.name)}`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: buffer,
      ContentType: file.type,
    }),
  );

  try {
    const media = await prisma.media.create({
      data: {
        userId,
        kind: validation.kind,
        key,
        mimeType: file.type,
        sizeBytes: file.size,
        originalName: file.name,
      },
    });

    return NextResponse.json(media, { status: 201 });
  } catch (error) {
    // Best-effort compensation so a DB hiccup doesn't leave an untracked
    // object sitting in the bucket forever.
    await getS3Client()
      .send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }))
      .catch(() => {});
    throw error;
  }
}
