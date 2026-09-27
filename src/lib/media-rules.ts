/**
 * The upload rules — which media types are accepted, and how big each kind
 * may be — in the one module both the server and the browser can load.
 *
 * WHY THIS IS NOT IN src/lib/media.ts, where the rest of the media helpers
 * live and where this used to sit:
 *
 * ugcportal-n3c put a browser on the other side of POST /api/media. The
 * upload page has to answer two questions before it sends anything — what to
 * put in the file input's `accept`, and whether this file is already doomed —
 * and both answers must be the *server's* answers or the two drift, which is
 * the failure that bead's K4 exists to stop. The strongest way to guarantee
 * that is for the client to run the very same `validateUpload`, rather than a
 * matching copy of its numbers.
 *
 * `src/lib/media.ts` cannot be that module: it imports `node:crypto` for
 * `randomUUID`, so a client component importing it fails to bundle. Splitting
 * the rules out is what makes "the same function" possible at all.
 *
 * This file therefore has no runtime imports at all — the single import below
 * is `import type`, which erases. Adding a Node built-in here, or anything
 * that reaches one, silently re-breaks the client build, so don't.
 *
 * `src/lib/media.ts` re-exports all of it, so server-side callers see no
 * change and there is still one place to look for "everything about media".
 */

import type { MediaKind } from "@/generated/prisma/enums";

const MIME_TO_KIND: Record<string, MediaKind> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/gif": "IMAGE",
  "video/mp4": "VIDEO",
  "video/webm": "VIDEO",
  "video/quicktime": "VIDEO",
};

/**
 * Every media type the server will accept, in the form a file input's
 * `accept` attribute takes.
 *
 * Derived from MIME_TO_KIND rather than listed again: an `accept` list with
 * its own copy of the types is a filter that either offers the user files the
 * API will refuse, or hides files it would have taken.
 */
export const ACCEPTED_MIME_TYPES: readonly string[] = Object.freeze(
  Object.keys(MIME_TO_KIND),
);

/**
 * The declared MIME type's kind, or undefined — and never something off
 * Object.prototype.
 *
 * A plain `MIME_TO_KIND[type]` is a lookup against the wrong set: the media
 * type is fully client-controlled (it is a header on a multipart part, and
 * `new File([], "x", { type: "constructor" }).type` is the string
 * "constructor"), so `MIME_TO_KIND["constructor"]` answers with the Object
 * constructor rather than with undefined, and `!kind` is false for it. What
 * follows then compares against a value that is not a MediaKind at all:
 * `MAX_SIZE_BYTES[kind]` is undefined and `file.size > undefined` is false,
 * so an upload declaring one of a handful of Object.prototype names passed
 * the per-kind size check entirely. It was caught one step later by
 * sniffKind, which reads the actual bytes and cannot return anything but a
 * MediaKind or null — so this was latent rather than exploitable — but the
 * size check was not doing its job, and declaredUploadCapBytes in
 * src/lib/media.ts needs the same table to answer a question sniffKind is in
 * no position to back up: how many bytes to let through before the file
 * exists at all.
 */
export function kindForDeclaredType(mimeType: string): MediaKind | undefined {
  return Object.hasOwn(MIME_TO_KIND, mimeType)
    ? MIME_TO_KIND[mimeType]
    : undefined;
}

export const MAX_SIZE_BYTES: Record<MediaKind, number> = {
  IMAGE: 10 * 1024 * 1024, // 10 MB
  VIDEO: 200 * 1024 * 1024, // 200 MB
};

export type UploadValidationResult =
  | { ok: true; kind: MediaKind }
  | { ok: false; status: number; message: string };

export function validateUpload(file: {
  type: string;
  size: number;
}): UploadValidationResult {
  const kind = kindForDeclaredType(file.type);
  if (!kind) {
    return {
      ok: false,
      status: 415,
      message: `Unsupported file type: ${file.type || "unknown"}`,
    };
  }

  if (file.size <= 0) {
    return { ok: false, status: 400, message: "Empty file" };
  }

  if (file.size > MAX_SIZE_BYTES[kind]) {
    return {
      ok: false,
      status: 413,
      message: `File exceeds maximum size of ${MAX_SIZE_BYTES[kind]} bytes for ${kind.toLowerCase()} uploads`,
    };
  }

  return { ok: true, kind };
}
