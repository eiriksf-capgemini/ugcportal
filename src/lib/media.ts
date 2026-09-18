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

// Upper bound for the whole multipart request, used to reject oversized
// uploads from the Content-Length header before buffering the body.
export const MAX_UPLOAD_BYTES =
  Math.max(...Object.values(MAX_SIZE_BYTES)) + 5 * 1024 * 1024;

// Signature checks against the actual bytes, so a mismatched or spoofed
// Content-Type (fully client-controlled) can't smuggle a file past the
// declared-type check above.
const MAGIC_CHECKS: Array<{ kind: MediaKind; matches: (buf: Buffer) => boolean }> = [
  {
    kind: "IMAGE",
    matches: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47,
  },
  {
    kind: "IMAGE",
    matches: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    kind: "IMAGE",
    matches: (buf) => buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8",
  },
  {
    kind: "IMAGE",
    matches: (buf) =>
      buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP",
  },
  {
    // Covers both mp4 and quicktime — both are ISO base media containers
    // with an `ftyp` box at offset 4.
    kind: "VIDEO",
    matches: (buf) => buf.length >= 8 && buf.toString("ascii", 4, 8) === "ftyp",
  },
  {
    kind: "VIDEO",
    matches: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x1a &&
      buf[1] === 0x45 &&
      buf[2] === 0xdf &&
      buf[3] === 0xa3,
  },
];

export function sniffKind(buffer: Buffer): MediaKind | null {
  return MAGIC_CHECKS.find((check) => check.matches(buffer))?.kind ?? null;
}

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
