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

// --- originalName: one implementation, two call sites -----------------------
//
// `originalName` is the only user-controlled string we store and later render,
// and it reaches the DB by two different doors: the upload in POST /api/media
// (taken from `file.name`) and the rename in PATCH /api/media/[id]. A check
// that lives on only one of them is theatre — an attacker simply uploads a
// file already called what they would otherwise have renamed it to. Hence one
// denylist and one bound, here, consumed by both.

// Display-only label, so the bound is about keeping the field printable and
// the row small rather than about any filesystem limit — the object's real
// storage key is derived separately at upload time and is never editable.
//
// Counted in code points rather than UTF-16 units so that truncating can
// never split a surrogate pair and leave half a character behind. The two
// functions below have to agree on what "255" counts, or a sanitized name
// could still fail validation.
export const MAX_ORIGINAL_NAME_LENGTH = 255;

// Characters that would survive into every UI rendering the name and lie
// about what it says: C0 and C1 controls, DEL, and the bidi marks and
// overrides. The last group is why this is wider than it looks —
// "invoice\u202Egnp.exe" renders as "invoice exe.png", the exact deception
// it exists to stop. Zero-width joiners are deliberately left alone; emoji
// filenames are legitimate and don't reorder text.
const UNSAFE_NAME_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const UNSAFE_NAME_CHARS_GLOBAL = new RegExp(UNSAFE_NAME_CHARS, "gu");

// Used when sanitizing leaves nothing behind — a name made entirely of
// stripped characters or whitespace. Better than an empty string, which
// renders as a blank row in any listing.
const FALLBACK_ORIGINAL_NAME = "untitled";

export type OriginalNameValidation =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Strict form, for a *rename*: the client is deliberately submitting this
 * exact string as the new name, so anything wrong with it is worth saying out
 * loud, and rejecting costs the caller nothing but a retry.
 */
export function validateOriginalName(value: unknown): OriginalNameValidation {
  if (typeof value !== "string") {
    return { ok: false, message: "Field 'originalName' must be a string" };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Field 'originalName' must not be empty" };
  }
  if (Array.from(trimmed).length > MAX_ORIGINAL_NAME_LENGTH) {
    return {
      ok: false,
      message: `Field 'originalName' must be at most ${MAX_ORIGINAL_NAME_LENGTH} characters`,
    };
  }
  if (UNSAFE_NAME_CHARS.test(trimmed)) {
    return {
      ok: false,
      message:
        "Field 'originalName' must not contain control or text-direction characters",
    };
  }

  return { ok: true, value: trimmed };
}

/**
 * Lenient form, for an *upload*: the name is incidental metadata riding along
 * with a body that may already be hundreds of megabytes, and the user often
 * didn't choose it (a phone's picker names the file, not them). Failing the
 * whole transfer over a cosmetic problem with a label is disproportionate, so
 * this repairs rather than rejects.
 *
 * The asymmetry with validateOriginalName is deliberate and is only about how
 * the caller is *told*: what reaches the database is held to exactly the same
 * standard by both paths. That equivalence is pinned by a test —
 * validateOriginalName(sanitizeOriginalName(x)) is ok for every x.
 */
export function sanitizeOriginalName(value: string): string {
  const stripped = value.replace(UNSAFE_NAME_CHARS_GLOBAL, "").trim();
  // Truncate by code point, then trim again: cutting mid-string can expose
  // trailing whitespace that wasn't at the edge before.
  const truncated = Array.from(stripped)
    .slice(0, MAX_ORIGINAL_NAME_LENGTH)
    .join("")
    .trim();

  return truncated.length > 0 ? truncated : FALLBACK_ORIGINAL_NAME;
}
