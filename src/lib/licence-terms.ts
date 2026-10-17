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
 * Why a grant was refused. All three are properties of the text alone, so
 * all three are decided before any row is read.
 */
export type LicenceTermsRefusal = "too_long" | "instagram_url" | "bidi_control";

export type LicenceTermsCheck =
  | { ok: true; value: string | null }
  | { ok: false; refusal: LicenceTermsRefusal };

/**
 * Code points a buyer cannot see, removed from the comparison text by CLASS
 * rather than by a hand list, so that a kind nobody listed is caught as long
 * as it is in one of these classes:
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
 * Except `\p{White_Space}`. The only White_Space code points inside the
 * classes above are the line-break and tab controls U+0009-U+000D and U+0085
 * (all `\p{Cc}`; measured over every code point under Node 24's Unicode
 * data); a plain space is in none of them and was never stripped.
 * A line break or tab SEPARATES words for a reader, so it is kept as a
 * separator rather than glued over: gluing would read "instagram.com\nis" as
 * "instagram.comis" and let it through. Note this is the Unicode property,
 * not JavaScript's `\s`, which also counts U+FEFF as space.
 *
 * Stripping is right for the INSTAGRAM comparison only while stripped code
 * points change nothing about the ORDER a buyer reads. Bidi controls do
 * change it, which is why they are refused outright (see
 * {@link BIDI_CONTROL}) rather than relied on being stripped here.
 */
const INVISIBLE =
  /(?!\p{White_Space})[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Mn}\p{Me}\p{Variation_Selector}]/gu;

/**
 * The text as a buyer reads it, in stored order, for comparison only — never
 * what is stored:
 * compatibility-decomposed (NFKD folds full-width "ｉｎｓｔａｇｒａｍ" and the
 * other compatibility forms onto plain letters, the same mapping as NFKC but
 * without recomposing an accent back onto its letter), every
 * {@link INVISIBLE} code point removed, and lower-cased.
 */
function readableSkeleton(text: string): string {
  return text.normalize("NFKD").replace(INVISIBLE, "").toLowerCase();
}

/**
 * Every code point with the Unicode `Bidi_Control` property: U+061C,
 * U+200E-U+200F, U+202A-U+202E and U+2066-U+2069. These REORDER what a buyer
 * sees: `"See \u202Emoc.margatsni\u202C"` is stored in one order and
 * displayed as "See instagram.com". The skeleton above compares the stored
 * (logical) order, so it cannot see an address that only exists in the
 * displayed (visual) order.
 *
 * So a grant carrying one is REFUSED, not stripped and not stored. That is
 * the fail-closed direction: a grant that needs a bidi override to read
 * correctly is not one this site can show a buyer and be sure what they read,
 * and stripping would store something other than what the admin typed. Right-
 * to-left SCRIPT is not refused — Hebrew or Arabic letters with no control
 * among them are accepted, and the browser orders them by itself.
 */
const BIDI_CONTROL = /\p{Bidi_Control}/u;

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

/**
 * Does this text name an Instagram host, read with what a buyer cannot see
 * removed? In STORED order: an address that appears only once bidi controls
 * reorder the text is not found here, which is why `checkLicenceTerms`
 * refuses every bidi control as well.
 */
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
 * - Naming an Instagram host is refused (K4), on the skeleton.
 * - Carrying any {@link BIDI_CONTROL} code point is refused (K4): the
 *   skeleton compares stored order and a buyer reads displayed order, and a
 *   bidi control is what makes the two differ. A grant of ONLY bidi controls
 *   (and spaces or invisibles) is blank first, and so null, not refused.
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
  if (BIDI_CONTROL.test(text)) {
    return { ok: false, refusal: "bidi_control" };
  }
  return { ok: true, value: text };
}
