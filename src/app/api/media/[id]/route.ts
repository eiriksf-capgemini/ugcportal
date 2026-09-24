import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { requireOwnedMedia } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { getBucketName, getS3Client } from "@/lib/s3";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

// Display-only label, so the bound is about keeping the field printable and
// the row small rather than about any filesystem limit — the object's real
// storage key is derived at upload time and is never editable.
const MAX_ORIGINAL_NAME_LENGTH = 255;

// Control characters (and DEL) would survive into every UI that renders the
// name; there is no legitimate filename that needs them.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

type NameResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * Pulls the one editable field off the request body. `originalName` is the
 * only user-meaningful mutable column on Media — everything else is either
 * identity (`id`, `userId`), storage bookkeeping (`key`, `mimeType`,
 * `sizeBytes`, `kind`) or set by the DB (`createdAt`), and letting a client
 * rewrite any of those would either break the row's link to its object or
 * hand the row to someone else. Unknown fields are ignored rather than
 * rejected, and nothing from the body is ever spread into Prisma.
 */
function parseOriginalName(body: unknown): NameResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Expected a JSON object body" };
  }

  const { originalName } = body as { originalName?: unknown };
  if (typeof originalName !== "string") {
    return { ok: false, message: "Field 'originalName' must be a string" };
  }

  const trimmed = originalName.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Field 'originalName' must not be empty" };
  }
  if (trimmed.length > MAX_ORIGINAL_NAME_LENGTH) {
    return {
      ok: false,
      message: `Field 'originalName' must be at most ${MAX_ORIGINAL_NAME_LENGTH} characters`,
    };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return {
      ok: false,
      message: "Field 'originalName' must not contain control characters",
    };
  }

  return { ok: true, value: trimmed };
}

/** Renames one media item. Owner only (ugcportal-bdh). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = parseOriginalName(body);
  if (!name.ok) {
    return NextResponse.json({ error: name.message }, { status: 400 });
  }

  // `updateMany` scoped by `{ id, userId }` rather than `update` by id: the
  // gate above read the row in a separate statement, so only a where clause
  // on the write itself rules out a row that was deleted or re-owned in
  // between. The gate decides the status code; this decides what changes.
  const { count } = await prisma.media.updateMany({
    where: { id, userId: access.userId },
    data: { originalName: name.value },
  });

  if (count === 0) {
    // Lost the race with a concurrent delete — the row the caller was
    // authorized for no longer exists.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // No re-read: the only column touched is the one just validated, and
  // Media has no DB-derived fields (no updatedAt, no triggers) that a
  // second round trip would reveal.
  return NextResponse.json({ ...access.media, originalName: name.value });
}

/** Deletes one media item and its stored object. Owner only (ugcportal-bdh). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  // Same reasoning as PATCH: the `userId` in the where clause is what makes
  // the ownership check hold at the moment of the write, not just at the
  // moment of the read.
  const { count } = await prisma.media.deleteMany({
    where: { id, userId: access.userId },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Row first, object second. The inverse order would leave a row pointing
  // at bytes that are already gone if the DB call then failed, and the user
  // would have no way to retry it. This way a failed storage call leaves an
  // orphaned object — invisible to the user, cleanable out of band — which
  // is the same trade POST makes when it compensates a failed DB write.
  // Logged, not surfaced: the delete the caller asked for did happen.
  await getS3Client()
    .send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: access.media.key }))
    .catch((error: unknown) => {
      console.error(
        `Deleted media ${id} but failed to remove object ${access.media.key} from storage`,
        error,
      );
    });

  return new NextResponse(null, { status: 204 });
}
