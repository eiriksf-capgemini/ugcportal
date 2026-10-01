import {
  MAX_ALT_TEXT_LENGTH,
  MAX_CAPTION_LENGTH,
  validateAltText,
  validateCaption,
} from "@/lib/media-rules";

/**
 * What the alt-text and caption fields draw, and what counts as blocking
 * (ugcportal-gwr).
 *
 * Its own module for the reason `tag-selection.ts` is one: the repo's vitest
 * runs in a node environment with no DOM, so anything reachable only through
 * a React event handler is, in practice, untested. `upload-form.tsx` holds
 * state wiring; the decision of what counts as a blocking error lives here,
 * where a test can drive it directly.
 *
 * BATCH-LEVEL, NOT PER-FILE, FOR NOW. Like the subject-tag picker, these two
 * fields apply to "files you add next" rather than to one file at a time —
 * this page has no staging step, a drop starts uploading immediately (see
 * upload-form.tsx's own note on why the tag picker is rendered first), and
 * giving every file its own alt text without one would be a materially larger
 * change than this bead's render half needs. For a single file — the common
 * case — this is exactly right; for a multi-file drop, every file in that
 * batch gets the SAME alt text and caption, which is a real usability
 * limitation worth a follow-up bead (per-file alt text), not a correctness
 * gap: K1/K2 still hold because the stored text is never empty and never a
 * filename.
 */

/**
 * ALT TEXT IS REQUIRED TO ADD FILES ON THIS PAGE — a stronger rule than the
 * server's own (POST /api/media accepts an upload with no alt text at all;
 * only POST /api/media/[id]/publish refuses to publish without one, see that
 * route). The server's rule is the one K1 is actually about, and is enforced
 * there regardless of what this page does.
 *
 * This page adds its own, stricter gate because it is — today — the ONLY way
 * alt text ever reaches a Media row: there is no post-upload editing surface
 * (ugcportal-1wz is not built yet), so a file added here without alt text
 * would have no path to ever becoming publishable. Asking for it up front,
 * before the upload is sent, is also simply better placed than refusing it
 * after the bytes are already stored.
 *
 * Returns the message to show, or null when the field is fine to proceed with.
 * Blank is checked SEPARATELY from `validateAltText`'s own checks (length,
 * character class) because that function deliberately treats blank as "not
 * supplied yet" — correct for the server, which must accept it — rather than
 * as an error; this page's stronger requirement has to say so itself.
 */
export function altTextFieldError(value: string): string | null {
  if (value.trim() === "") {
    return "Add alt text before choosing files.";
  }
  const validation = validateAltText(value);
  return validation.ok ? null : validation.message;
}

/** The caption has no requiredness rule — only `validateCaption`'s own. */
export function captionFieldError(value: string): string | null {
  const validation = validateCaption(value);
  return validation.ok ? null : validation.message;
}

export { MAX_ALT_TEXT_LENGTH, MAX_CAPTION_LENGTH };
