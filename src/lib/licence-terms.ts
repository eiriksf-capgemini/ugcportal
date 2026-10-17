/**
 * The rules for a per-item licence grant (ugcportal-74w.1): how long it may
 * be, what counts as no grant at all, and the one thing it may never say.
 *
 * A PURE MODULE, for the same reason src/lib/pricing.ts is one: the admin
 * price form and the write path both need the bound, and the form is a React
 * component that must not pull `@/lib/prisma` into its module graph. This
 * file imports nothing and reads no row.
 *
 * WRITTEN ONLY BY `recordPrice` (src/lib/curation-price-write.ts), behind
 * the sale gate, and SHOWN TO A BUYER ONLY THROUGH `publicOffer`
 * (src/lib/sellable-media.ts), which asks the gate first. The repository
 * scan that asserts the single writer, and that every other reader asks the
 * gate or is on its written-down allowlist, is
 * src/lib/licence-terms-signal.test.ts. Nothing here names the
 * column, deliberately: this module answers "is this text acceptable", never
 * "what does this item grant".
 */

/**
 * The longest grant a listing may carry, in UTF-16 code units after line
 * endings are normalised — the same unit a browser's `maxLength` counts, so
 * the form's attribute and this bound agree about where the limit is.
 *
 * 2 000 is a judgement, stated as one. The grant is rendered to every buyer
 * on the item page, inside the offer panel beside the price, so an unbounded
 * column is a layout surface (a wall of text under a photograph) and an
 * abuse surface (a megabyte of text served on every visit). The site-wide
 * licence's own per-use clauses run to a few hundred characters each, and a
 * grant for one photograph — who may use it, where, for how long, with what
 * credit — fits in a few short paragraphs. If an item ever needs more than
 * this, that is a contract to agree in writing, which the offer panel
 * already tells a buyer to do.
 */
export const MAX_LICENCE_TERMS_LENGTH = 2_000;

/**
 * Why a grant was refused. Both are properties of the text alone, so both
 * are decided before any row is read.
 */
export type LicenceTermsRefusal = "too_long" | "instagram_url";

export type LicenceTermsCheck =
  | { ok: true; value: string | null }
  | { ok: false; refusal: LicenceTermsRefusal };

/**
 * Code points a buyer cannot see, removed from the comparison text by CLASS
 * rather than by a hand list (round 1 of PR #297 found eleven invisible
 * characters a list of six had missed):
 *
 * - `\p{Default_Ignorable_Code_Point}` — Unicode's own set of code points a
 *   renderer shows as nothing when it has no glyph for them: zero-width
 *   space, joiners, word joiner, the byte-order mark, the soft hyphen, the
 *   bidi marks, embeddings and isolates (U+200E-U+200F, U+202A-U+202E,
 *   U+2066-U+2069), the invisible operators (U+2061-U+2064), the combining
 *   grapheme joiner (U+034F), the Mongolian vowel separator (U+180E), the
 *   Hangul fillers (U+115F, U+1160, U+3164, U+FFA0, which are LETTERS by
 *   category and only this property catches), the variation selectors and
 *   the tag characters (U+E0000 block).
 * - `\p{Cf}` (format) and `\p{Cc}` (control) — the rest of those two
 *   categories, for example the interlinear annotation marks U+FFF9-U+FFFB.
 * - `\p{Mn}` and `\p{Me}` (combining marks), after a compatibility
 *   DEcomposition, so that an accent over a letter does not turn the letter
 *   into a different one for the comparison: "i\u0301nstagram" is compared
 *   as "instagram".
 * - `\p{Variation_Selector}`, already inside the first two, named anyway.
 *
 * Except `\p{White_Space}`: a line break, tab or space SEPARATES words for a
 * reader, so it is kept as a separator rather than glued over (gluing would
 * read "instagram.com is" as "instagram.comis" and let it through). Note
 * this is the Unicode property, not JavaScript's `\s`, which also counts
 * U+FEFF as space.
 */
const INVISIBLE =
  /(?!\p{White_Space})[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Mn}\p{Me}\p{Variation_Selector}]/gu;

/**
 * The text as a buyer reads it, for comparison only — never what is stored:
 * compatibility-decomposed (NFKD folds full-width "ｉｎｓｔａｇｒａｍ" and the
 * other compatibility forms onto plain letters, the same mapping as NFKC but
 * without recomposing an accent back onto its letter), every
 * {@link INVISIBLE} code point removed, and lower-cased.
 */
function readableSkeleton(text: string): string {
  return text.normalize("NFKD").replace(INVISIBLE, "").toLowerCase();
}

/** Does the text hold nothing a buyer could read — only spaces and invisibles? */
function isBlank(text: string): boolean {
  return readableSkeleton(text).replace(/\p{White_Space}+/gu, "") === "";
}

/**
 * An Instagram host in the skeleton, THE RULE AS WRITTEN:
 *
 * - `instagram`, then any run (possibly empty) of code points that are
 *   neither a letter (`\p{L}`) nor a digit (`\p{N}`), then `com`, and the
 *   `com` not followed by a letter or digit; or
 * - `instagr`, then at least one such non-letter non-digit code point, then
 *   `am`, not followed by a letter or digit (Instagram's short host
 *   `instagr.am`; the separator is required there, or the bare word
 *   "Instagram" would match).
 *
 * The separator is a CLASS, not a list of dots: an ASCII full stop, the
 * ideographic full stop U+3002 and its half-width form U+FF61 (which NFKD
 * leaves as U+3002, not "."), the full-width full stop, a slash, a space, a
 * hyphen or any other punctuation or symbol all separate the same way. A
 * buyer reads "instagram｡com" as the address, and so does a browser's IDNA
 * processing.
 *
 * STATED FALSE POSITIVES, accepted: there is no boundary BEFORE `instagram`
 * or `instagr`, so "notinstagram.com" is refused (a buyer still reads the
 * Instagram name in it); "instagram com" with a plain space and
 * "instagramcom" with none are refused, as is "Instagram. Com." at a
 * sentence end. The refusal names the reason, and the admin rewords.
 *
 * STATED NON-MATCHES, accepted: "Instagram, commercial use excluded" passes
 * (the `com` runs on into a letter); "instagram%2Ecom" passes, because a
 * percent-escape is not decoded here — the "2e" between the words is a
 * digit and a letter, and a buyer does not read the escape as a dot; an
 * `@handle` passes, since it names no host. Look-alike letters from other
 * scripts (a Cyrillic "і") are a confusables problem, not an invisibility
 * one, and are not folded.
 */
const INSTAGRAM_HOST =
  /instagram[^\p{L}\p{N}]*com(?![\p{L}\p{N}])|instagr[^\p{L}\p{N}]+am(?![\p{L}\p{N}])/u;

/** Does this text name an Instagram host, read the way a buyer would read it? */
export function mentionsInstagramHost(text: string): boolean {
  return INSTAGRAM_HOST.test(readableSkeleton(text));
}

/**
 * Normalise and check a submitted grant.
 *
 * - `\r\n` and lone `\r` become `\n` (a textarea submits CRLF), then the
 *   whole is trimmed. Interior line breaks are kept: they are paragraphs,
 *   and the renderer preserves them as text.
 * - Empty, whitespace-only, or nothing but {@link INVISIBLE} code points is
 *   NO GRANT — `{ ok: true, value: null }` — so that "the admin cleared the
 *   field" and "the admin never filled it in" are the same stored state, and
 *   the item page falls back to the site-wide /licence link for both (K2).
 *   Blankness is decided on the same skeleton the Instagram check reads, so
 *   a grant of only zero-width or bidi marks is null, not a heading over an
 *   empty block.
 * - Longer than {@link MAX_LICENCE_TERMS_LENGTH} after normalising is
 *   refused, not truncated: a grant cut off mid-sentence is a different
 *   grant from the one the admin wrote.
 * - Naming an Instagram host is refused (K4).
 */
export function checkLicenceTerms(raw: string): LicenceTermsCheck {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (isBlank(text)) return { ok: true, value: null };
  if (text.length > MAX_LICENCE_TERMS_LENGTH) {
    return { ok: false, refusal: "too_long" };
  }
  if (mentionsInstagramHost(text)) {
    return { ok: false, refusal: "instagram_url" };
  }
  return { ok: true, value: text };
}
