import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { validateOriginalName } from "@/lib/media";
import { requireOwnedMedia, toPublicMedia } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { getBucketName, getS3Client } from "@/lib/s3";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

// A rename carries no file, so the body is one short JSON object: a name at
// the full MAX_ORIGINAL_NAME_LENGTH with every character escaped still fits
// several times over. App Router puts no default cap on the request body, so
// without this an owner could make the server buffer gigabytes before the
// length check in validateOriginalName ever runs.
const MAX_PATCH_BODY_BYTES = 4096;

type NameResult = { ok: true; value: string } | { ok: false; message: string };

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads and JSON-parses the request body, never holding more than `limit`
 * bytes of it.
 *
 * The Content-Length check is only a cheap early-out, and deliberately not
 * the enforcement: the header is absent on a chunked request and can be
 * malformed, in which case `Number()` yields NaN and `NaN > limit` is
 * false. Trusting it alone would wave through exactly the unbounded
 * buffering the cap exists to prevent. The read loop is what actually
 * enforces the bound — it stops at the first chunk that takes the running
 * total past `limit` and cancels the stream, so a sender that lies about
 * (or omits) its length gets a 413 rather than memory.
 */
async function readJsonBody(
  request: Request,
  limit: number,
): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > limit) {
        // Swallowed deliberately: cancel() can reject when the connection
        // is already gone, and the shared catch below answers 400. The cap
        // has been decided by this point, so letting a failed teardown
        // rewrite a correct 413 into "malformed JSON" would report the
        // wrong thing about a request we already understand.
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: "Request body too large" };
      }

      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // A truncated or reset connection is the client's problem, not a 500.
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
}

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

  // The name itself is checked by the shared validator in src/lib/media.ts,
  // which the upload path calls too — see the note there on why one
  // implementation is the whole point.
  const { originalName } = body as { originalName?: unknown };
  return validateOriginalName(originalName);
}

/**
 * Removes one stored object, swallowing and logging any failure.
 *
 * try/catch around the whole body rather than a `.catch()` on the send:
 * getS3Client() and getBucketName() both go through requireEnv() and throw
 * synchronously on a missing variable, so a promise-level catch would let a
 * misconfigured environment turn an already-committed delete into a 500 —
 * and lose the orphan log, the only record of the leaked key.
 */
async function deleteObjectBestEffort(
  mediaId: string,
  objectKey: string,
  role: string,
): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getBucketName(), Key: objectKey }),
    );
  } catch (cause: unknown) {
    // Logged, not surfaced: the delete the caller asked for did happen.
    console.error("[media] failed to remove object after delete", {
      mediaId,
      key: objectKey,
      role,
      cause,
    });
  }
}

/** Renames one media item. Owner only (ugcportal-bdh). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await readJsonBody(request, MAX_PATCH_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const name = parseOriginalName(body.value);
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
  //
  // Projected through toPublicMedia rather than spread: the gate reads the
  // whole row because DELETE needs the storage keys, and echoing that row
  // verbatim would hand `key` — the ungated original (ugcportal-5d6) — to
  // the client, the one column POST and GET go out of their way never to
  // return.
  return NextResponse.json(
    toPublicMedia({ ...access.media, originalName: name.value }),
  );
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

  // Row first, objects second. The inverse order would leave a row pointing
  // at bytes that are already gone if the DB call then failed, and the user
  // would have no way to retry it. This way a failed storage call leaves an
  // orphaned object — invisible to the user, cleanable out of band — which
  // is the same trade POST makes when it compensates a failed DB write.
  //
  // Both objects, not just the original: since ugcportal-44q an image also
  // has a watermarked preview, and the row is the only thing that knows its
  // previewKey. Dropping the row without deleting it would strand an object
  // nothing can ever name again — storage that grows with ordinary use and
  // user-derived content that outlives the "delete" that was meant to
  // remove it.
  //
  // Independently best-effort: each key is attempted and logged on its own,
  // so a failure on the original doesn't skip the preview or vice versa.
  await Promise.all(
    [
      { key: access.media.key, role: "original" },
      { key: access.media.previewKey, role: "preview" },
    ]
      .filter((target): target is { key: string; role: string } =>
        Boolean(target.key),
      )
      .map((target) => deleteObjectBestEffort(id, target.key, target.role)),
  );

  return new NextResponse(null, { status: 204 });
}
