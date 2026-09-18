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

const MAX_SIZE_BYTES: Record<MediaKind, number> = {
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
  const kind = MIME_TO_KIND[file.type];
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
