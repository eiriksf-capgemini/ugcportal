import { randomUUID } from "node:crypto";

import type { MediaKind } from "@/generated/prisma/enums";
import {
  LONE_SURROGATE,
  MAX_SIZE_BYTES,
  UNSAFE_TEXT_CHARS,
  validateUpload,
} from "@/lib/media-rules";

/**
 * The accepted types, the per-kind caps and the check that applies them now
 * live in src/lib/media-rules.ts, and are re-exported here.
 *
 * They moved for one reason: ugcportal-n3c's upload page runs the same rules
 * in the browser, and this module imports `node:crypto`, which a client
 * bundle cannot resolve. Splitting the rules into a dependency-free module is
 * what lets the client run the server's own `validateUpload` instead of a
 * copy of its numbers — see the header of that file.
 *
 * The re-export is not a courtesy to existing importers, though it is that
 * too: `@/lib/media` remains the address of "everything about media", so the
 * split is invisible to every server-side caller and nothing had to change.
 */
export {
  ACCEPTED_MIME_TYPES,
  LONE_SURROGATE,
  MAX_SIZE_BYTES,
  UNSAFE_TEXT_CHARS,
  hasUnsafeText,
  kindForDeclaredType,
  validateUpload,
} from "@/lib/media-rules";
export type { UploadValidationResult } from "@/lib/media-rules";

// Upper bound for the whole multipart request, used to reject oversized
// uploads from the Content-Length header before buffering the body.
export const MAX_UPLOAD_BYTES =
  Math.max(...Object.values(MAX_SIZE_BYTES)) + 5 * 1024 * 1024;

// Exported so the watermark concurrency gate can price a queued upload
// (ugcportal-e86): waiting for a preview slot holds this many bytes of
// request body alive, and the gate's memory arithmetic has to account for
// it. Kept derived from MAX_SIZE_BYTES so the two cannot drift.
export const MAX_IMAGE_UPLOAD_BYTES = MAX_SIZE_BYTES.IMAGE;

/**
 * The size cap {@link validateUpload} *will* apply to a file declaring
 * `mimeType`, or null when it will refuse that type at any size.
 *
 * Exists so the upload route can apply that cap to the request **stream**,
 * before the body has been materialised, instead of only to the `File` it
 * already paid to build (ugcportal-05b).
 *
 * That is only sound if the two answers are the same answer, so this does not
 * consult the tables itself — it asks `validateUpload`, with a size chosen so
 * that the type is the only thing it can possibly refuse for. Anything else
 * is a second implementation of the same rule, and the first version of this
 * function proved the point: it normalised the media type by splitting off
 * Content-Type parameters, which `validateUpload` does not do. `File.type`
 * really does carry parameters on this runtime, so
 * `video/mp4; codecs="avc1.42E01E"` was given a 200 MB stream cap and then
 * refused with a 415 by validateUpload — the read-to-the-maximum-then-reject
 * pattern this bead exists to remove, available to anyone who appends a
 * parameter. The doc even claimed the two were provably identical while that
 * was true.
 *
 * Returns null, rather than a fallback number, for a type validateUpload will
 * not accept: such an upload is refused at *any* size, so what the caller
 * should do with it is a policy decision (see uploadReadLimitBytes) rather
 * than a cap.
 */
export function declaredUploadCapBytes(
  mimeType: string | null | undefined,
): number | null {
  if (typeof mimeType !== "string") return null;
  // size 1 is deliberately neither 0 (which validateUpload refuses as empty)
  // nor above any cap, so `ok` is a statement about the type alone.
  const validation = validateUpload({ type: mimeType, size: 1 });
  return validation.ok ? MAX_SIZE_BYTES[validation.kind] : null;
}

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

// The denylist itself now lives in src/lib/media-rules.ts and is imported at
// the top of this file — ONE copy, because tag names (ugcportal-jsc) became
// its second writer and the gallery's render-side drop its third. It moved
// rather than being duplicated for the same reason the upload rules did: that
// module has no runtime imports, so a "use client" component can load it,
// while this one imports `node:crypto` and cannot be bundled for the browser
// at all. See the note over UNSAFE_TEXT_CHARS there for what each character
// class covers and why zero-width JOINER is deliberately absent.
//
// Both names are re-exported above, so every existing reader of
// `@/lib/media` is unchanged.
//
// The GLOBAL variants stay here, because only the sanitizing path needs them
// and building them from the shared patterns is what stops the stripping form
// and the testing form drifting apart.
const UNSAFE_NAME_CHARS_GLOBAL = new RegExp(UNSAFE_TEXT_CHARS, "gu");
const LONE_SURROGATE_GLOBAL = new RegExp(LONE_SURROGATE, "g");

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
  if (UNSAFE_TEXT_CHARS.test(trimmed)) {
    return {
      ok: false,
      message:
        "Field 'originalName' must not contain control or text-direction characters",
    };
  }
  // Separate check, separate message: this one is about the string being
  // well-formed UTF-16 at all, not about which characters it chose.
  if (LONE_SURROGATE.test(trimmed)) {
    return {
      ok: false,
      message: "Field 'originalName' must be valid text",
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
  const stripped = value
    .replace(UNSAFE_NAME_CHARS_GLOBAL, "")
    // Dropped rather than replaced with U+FFFD: a visible replacement glyph
    // would be a worse answer than simply not showing the broken unit, and
    // leaving it in would break the sanitize -> validate invariant below.
    .replace(LONE_SURROGATE_GLOBAL, "")
    .trim();
  // Truncate by code point, then trim again: cutting mid-string can expose
  // trailing whitespace that wasn't at the edge before.
  const truncated = Array.from(stripped)
    .slice(0, MAX_ORIGINAL_NAME_LENGTH)
    .join("")
    .trim();

  return truncated.length > 0 ? truncated : FALLBACK_ORIGINAL_NAME;
}

/**
 * The object-storage prefix every watermarked preview is written under.
 *
 * One definition, because two places now depend on it pointing at the same
 * shelf: POST /api/media builds keys with it, and the delivery route
 * (GET /api/media/preview/[previewId], ugcportal-a2l) refuses to fetch any
 * object whose key does not start with it. Those two are a producer and a
 * gate on the same layout, and a gate that has its own private copy of the
 * layout is a gate that silently stops matching the day the producer moves.
 *
 * Originals live under `media/` (see POST /api/media), so this prefix is what
 * separates "the watermarked copy anyone may be shown" from "the paid
 * original" (ugcportal-5d6) at the storage layer.
 *
 * Deliberately NOT enforced by mediaPreviewColumns below — see the note in
 * that function about why it checks blankness and not shape. This constant is
 * the layout; that function is about the two columns never disagreeing.
 */
export const PREVIEW_KEY_PREFIX = "previews/";

/**
 * The preview's output format, as the two facts anything outside the
 * watermark service needs about it: what to call the object, and what to
 * label the bytes.
 *
 * These live here rather than in src/lib/watermark.ts, and that placement is
 * the whole point. `watermark.ts` imports `sharp`, which pulls libvips and a
 * ~40 MB native binary into the module graph of anything that touches it. It
 * had exactly one non-test importer — the upload route, which genuinely needs
 * to encode images. The delivery route needs neither: it forwards bytes
 * somebody else encoded, and it is the hot path. Importing an image-processing
 * library to read a ten-character string is a cost with no matching benefit,
 * and it is invisible in review because an unused import looks free. Measured
 * on the Next build trace: importing the content type from `watermark.ts`
 * pulled 86 sharp/libvips files into the preview route's file trace, native
 * `.node` binary included.
 *
 * `watermark.ts` re-exports both, so it remains the one place a reader looks
 * for "everything about previews" and no existing importer changed.
 *
 * The split is by dependency weight, not by topic: these two are *facts about
 * the artefact* (its name and its type), which a consumer needs; the quality,
 * dimensions and pixel budget next to them in `watermark.ts` are *inputs to
 * producing it*, which only the producer needs. They sit beside
 * PREVIEW_KEY_PREFIX above because all three describe the stored object rather
 * than how it was made.
 */
export const PREVIEW_CONTENT_TYPE = "image/webp";
export const PREVIEW_FILE_EXTENSION = ".webp";

/**
 * The two preview columns, as one value that cannot be half-set.
 *
 * `previewKey` is the watermarked object's storage path; `previewId` is the
 * opaque handle the public feed exposes in its place, because the path embeds
 * the uploader's account id (ugcportal-r1d). They are two columns expressing
 * one fact — "this row has a watermarked preview" — and both listings filter
 * on both, so a row with only one of them set is invisible in *every* feed,
 * including its own owner's library, with no repair path short of a manual
 * backfill.
 *
 * Until now that invariant rested on a single `prisma.media.create` remembering
 * to write both. A second writer is already foreseeable — ugcportal-ct0's
 * Instagram sync inserts Media rows it did not upload — so the pairing is made
 * unexpressible-when-wrong here instead of documented and hoped for. The union
 * return type is the mechanism: there is no member with a string key and a null
 * id, so `{ previewKey: someKey, previewId: null }` is not a value this
 * function can produce, and spreading its result into `data` is the only
 * blessed way to write the columns.
 *
 * Not a database CHECK constraint, which would be the stronger answer, for two
 * verified reasons: SQLite cannot add one to an existing table at all
 * (`ALTER TABLE … ADD CONSTRAINT` is a parse error — it needs a full 12-step
 * table rebuild), and Prisma's schema language cannot express one for sqlite,
 * so it would be invisible to the datamodel and show up as permanent
 * `migrate diff` drift. If the pairing ever needs enforcing at the storage
 * layer, that is a deliberate table rebuild, not a line in this file.
 */
export type MediaPreviewColumns =
  | { previewKey: string; previewId: string }
  | { previewKey: null; previewId: null };

export function mediaPreviewColumns(
  previewKey: string | null,
): MediaPreviewColumns {
  if (previewKey === null) {
    // No watermarked preview — today, every VIDEO (ugcportal-pmb owns poster
    // frames). Both columns null, so the row is consistently "no preview"
    // rather than half-present.
    return { previewKey: null, previewId: null };
  }

  if (previewKey.trim() === "") {
    // A blank path is not "no preview", and must not be quietly treated as
    // either that or a working one.
    //
    // Null is the only encoding of "this row has no preview". A blank string
    // is a *different* thing: a caller that meant to build a key and produced
    // nothing. Returning the null pair would hide that bug and, worse, strand
    // whatever object the caller had already written to storage. Returning
    // `{ previewKey: "", previewId: <uuid> }` — which this used to do — is
    // worse still: `"" !== null`, so the row satisfies every downstream check
    // that exists. Both listings' `not: null` filters pass it, the defensive
    // hasCompletePreview() in src/lib/media-listing.ts passes it, and the 409
    // guard in POST /api/media/[id]/publish passes it, so the row publishes
    // and serves as though it had a working preview that resolves to nothing.
    //
    // So: throw. This is a programming error in the caller, not a data
    // condition, and it is unreachable from the one caller that exists today
    // (POST /api/media builds `previews/{userId}/{randomUUID()}{ext}`, which
    // is never blank). It is here for the second writer this helper's contract
    // is aimed at — ugcportal-ct0's Instagram sync — where a missing remote
    // asset could plausibly produce an empty string rather than a null.
    //
    // Deliberately only a blankness check, not a shape check: requiring a
    // `previews/` prefix would couple this helper to a storage layout that is
    // allowed to change, and the failure it would catch is not the one that
    // slips past every downstream guard.
    throw new Error(
      "mediaPreviewColumns: previewKey must be a non-blank path or null",
    );
  }

  // Deliberately unrelated to `previewKey`, to `key`, and to the uploader: an
  // opaque handle that can be transformed back into the thing it stands for is
  // not opaque. Same reasoning as the uncorrelated preview UUID in
  // ugcportal-44q, one field further out.
  return { previewKey, previewId: randomUUID() };
}
