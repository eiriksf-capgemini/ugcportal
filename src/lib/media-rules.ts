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

// --- text safety: one denylist, now three readers ---------------------------
//
// These two patterns started life in src/lib/media.ts guarding `originalName`,
// the only user-controlled string the product stored and later rendered. Tag
// names (ugcportal-jsc) are the second, so the denylist moved HERE rather than
// being copied — and this is the module that can hold it, for exactly the
// reason the header above gives: it has no runtime imports, so a "use client"
// component can load it, while src/lib/media.ts imports `node:crypto` and
// cannot be bundled for the browser at all.
//
// src/lib/media.ts re-exports both, so every existing server-side reader is
// unchanged and "everything about media" is still one address.

/**
 * Characters that would survive into every UI rendering the string and lie
 * about what it says: C0 and C1 controls, DEL, the bidi marks and overrides,
 * and the invisibles that render as nothing at all. The bidi group is why this
 * is wider than it looks — a right-to-left override in the middle of
 * "invoicegnp.exe" renders it as "invoice exe.png", the exact deception it
 * exists to stop.
 *
 * The invisible group (soft hyphen, ZWSP, line/paragraph separators, word
 * joiner, Hangul filler, BOM) is denied rather than merely trimmed because a
 * string built only from them is not empty by length yet renders as blank.
 *
 * Zero-width JOINER (U+200D) is deliberately absent: emoji sequences need it,
 * and it neither reorders nor hides text.
 */
export const UNSAFE_TEXT_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2028\u2029\u2060\u2066-\u2069\u3164\uFEFF]/;

/**
 * Unpaired surrogates cannot join the class above: at code-unit level every
 * astral character (so every emoji) is MADE of surrogates, and a naive
 * [\uD800-\uDFFF] would reject exactly the strings that comment promises to
 * allow. Only the unpaired ones are a problem, and they are a real one. JSON
 * permits a lone high surrogate; it is neither a control nor a bidi character,
 * and the @libsql/client driver this repo uses silently substitutes U+FFFD on
 * write, so a handler that echoes what was submitted disagrees with what a
 * later read returns. A strict-UTF-8 driver would throw instead, turning the
 * same input into a 500.
 */
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * True when a string carries anything from either class above.
 *
 * The predicate, not just the two patterns, because there are now four
 * readers — the rename validator, the tag validator, the gallery's
 * render-side drop and the upload page's tag picker — and "test both, and
 * remember neither is global" is precisely the two-line ritual that gets
 * copied with one line missing.
 */
export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_CHARS.test(value) || LONE_SURROGATE.test(value);
}

// --- tag limits (ugcportal-jsc) ---------------------------------------------
//
// THE NUMBERS LIVE HERE, THE RULES DO NOT. The distinction is the one this
// module was created for (see the header): the browser must not carry a
// second copy of a validation rule the server owns, but it may — and should —
// share the server's own CONSTANT, the same way the upload page runs the
// server's `validateUpload` rather than a matching copy of MAX_SIZE_BYTES.
//
// They cannot stay in src/lib/tags.ts, which imports the Prisma client and so
// cannot be bundled for the browser at all. That module re-exports both, so
// every server-side reader is unchanged and "everything about tags" is still
// one address.

/**
 * How many tags one item may carry.
 *
 * Six rather than unbounded for two reasons that pull the same way. A tile in
 * a four-column grid has room for a couple of short labels and no more, so a
 * twenty-tag item is a layout problem before it is a data problem; and every
 * permitted account can write these (ugcportal-egp decides which accounts
 * those are), so an unbounded list is an unbounded write.
 *
 * Four subject areas are in use, so six leaves room to be wrong about that
 * without leaving room to abuse it.
 *
 * READ BY THE BROWSER AS WELL AS THE SERVER, and that is the point of it
 * being here. `parseTagNames` refuses a seventh tag *after* POST /api/media
 * has buffered the entire multipart body — so a picker that let seven be
 * ticked would spend a whole video upload to earn a 400, once per file and
 * again on every retry. The picker stops at this number instead; the server
 * still enforces it, because a disabled checkbox is not a security control.
 */
export const MAX_TAGS_PER_ITEM = 6;

/**
 * Longest tag name, in CODE POINTS rather than UTF-16 units — the same
 * counting `MAX_ORIGINAL_NAME_LENGTH` uses, so a name is never truncated
 * through the middle of a surrogate pair.
 *
 * Short on purpose: this string is rendered as a chip under a thumbnail, and
 * the longest of the four subjects in use ("Wine & drink") is twelve.
 */
export const MAX_TAG_NAME_LENGTH = 32;

// --- alt text and caption (ugcportal-gwr) -----------------------------------
//
// Accessibility/discoverability text on a Media row. Both numbers live here,
// not the rule that makes the first one REQUIRED — that is "required to
// publish", a product decision enforced once, at POST
// /api/media/[id]/publish, which is server-only (it reads the owner's row)
// and must not be reimplemented client-side. What the upload form DOES need
// is the shared length/character rule, so a caption that is already too long
// or carries a bidi override is refused the same way client-side as it would
// be server-side — the same relationship `MAX_TAGS_PER_ITEM` already has to
// `parseTagNames`.

/**
 * Longest alt text, in CODE POINTS — the same counting MAX_ORIGINAL_NAME_LENGTH
 * and MAX_TAG_NAME_LENGTH use, so truncating or measuring can never split a
 * surrogate pair.
 *
 * 125 rather than a rounder number: it is Eirik's own call for this bead, sized
 * to keep alt text a description rather than a caption-length essay — a screen
 * reader reads the whole string aloud on every encounter, so there is a real
 * cost to length that a visual caption does not have.
 *
 * STRICT REJECTION ABOVE THE LIMIT, not truncation. Alt text is text someone
 * typed into a form field on purpose, immediately before submitting it — the
 * same position `validateOriginalName`'s rename path is in, and that path
 * REJECTS rather than repairs for exactly the same reason: unlike an
 * incidental filename a phone's camera chose, there is no "theirs, but
 * slightly mangled" version of a sentence someone wrote and meant. Silently
 * cutting it at code point 125 would store a sentence nobody wrote and the
 * one person who could tell has already moved on past the form.
 */
export const MAX_ALT_TEXT_LENGTH = 125;

/** Longest caption, in code points. Generous relative to alt text on purpose:
 * a caption is read on demand, not announced unconditionally, so the cost of
 * length is the ordinary one a visual caption always had.
 */
export const MAX_CAPTION_LENGTH = 500;

export type TextFieldValidation =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Shared shape for both fields below: absent or blank is accepted as "none"
 * (`value: ""`) — REQUIREDNESS is a separate, server-only rule (the publish
 * gate), not something this function decides — and anything present is held
 * to the same denylist every other user-typed string in this product goes
 * through (`hasUnsafeText`, above), plus its own length cap.
 *
 * `allowNewlines` exists for exactly one caller: the caption field is
 * rendered as a multi-row `<textarea>` (ugcportal-gwr, review round 1,
 * finding 6), which invites the Enter key the way a single-line `<input>`
 * never does. `UNSAFE_TEXT_CHARS`' control-character range includes `\n`
 * and `\r`, so without this an ordinary two-line caption was refused
 * outright, with a message that does not even mention line breaks. Alt text
 * stays on the strict denylist unchanged — it is a single-line field, so a
 * literal newline in it is already a sign something is wrong, the same
 * reasoning `validateOriginalName` applies to a filename.
 *
 * The exemption is applied to a COPY used only for the denylist check, never
 * to the value this function returns or to the length count: a caption's
 * length is still measured with its newlines included, and what reaches the
 * database is the string the user actually typed, not one with its line
 * breaks silently removed.
 */
function validateBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  allowNewlines = false,
): TextFieldValidation {
  if (value === null || value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, message: `Field '${field}' must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: "" };
  if (Array.from(trimmed).length > maxLength) {
    return {
      ok: false,
      message: `Field '${field}' must be at most ${maxLength} characters`,
    };
  }
  const checked = allowNewlines ? trimmed.replace(/\r\n|\r|\n/g, "") : trimmed;
  if (hasUnsafeText(checked)) {
    return {
      ok: false,
      message: `Field '${field}' must not contain control or text-direction characters`,
    };
  }
  return { ok: true, value: trimmed };
}

/** Validates (never requires) alt text. See MAX_ALT_TEXT_LENGTH. */
export function validateAltText(value: unknown): TextFieldValidation {
  return validateBoundedText(value, "altText", MAX_ALT_TEXT_LENGTH);
}

/**
 * Validates the optional caption. See MAX_CAPTION_LENGTH.
 *
 * `allowNewlines: true` — see `validateBoundedText`'s own note on why this is
 * the one field that gets it.
 */
export function validateCaption(value: unknown): TextFieldValidation {
  return validateBoundedText(value, "caption", MAX_CAPTION_LENGTH, true);
}
