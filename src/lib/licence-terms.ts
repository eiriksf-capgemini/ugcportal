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
 * Characters that render as nothing, stripped before the Instagram check
 * only — never from what is stored. Without this, "instagram.c\u200Bom" reads
 * as the domain to a buyer and as something else to a regular expression.
 * Zero-width space, non-joiner and joiner, word joiner, the byte-order mark,
 * and the soft hyphen.
 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/**
 * An Instagram host anywhere in the text: `instagram.com` (any case, with or
 * without a scheme or `www.`, and any subdomain, since the match is on the
 * registrable name) and Instagram's own short host `instagr.am`.
 *
 * ugcportal-2eh Option A made Instagram a DISCOVERY aid on this site and
 * nothing more: what a buyer pays for is the owner-uploaded original, never
 * an Instagram post. A grant that pointed at instagram.com would make the
 * post part of what is sold, which is the reading that decision exists to
 * rule out. Matched as a substring rather than as a parsed URL because a
 * buyer reads "instagram.com/p/abc" as a link whether or not it carries a
 * scheme, and a parser that required one would pass exactly that.
 */
const INSTAGRAM_HOST = /instagram\.com|instagr\.am/i;

/** Does this text name an Instagram host, read the way a buyer would read it? */
export function mentionsInstagramHost(text: string): boolean {
  // NFKC folds the full-width and compatibility forms ("ｉｎｓｔａｇｒａｍ．ｃｏｍ")
  // onto ASCII, which a buyer reads as the same address.
  return INSTAGRAM_HOST.test(text.normalize("NFKC").replace(INVISIBLE, ""));
}

/**
 * Normalise and check a submitted grant.
 *
 * - `\r\n` and lone `\r` become `\n` (a textarea submits CRLF), then the
 *   whole is trimmed. Interior line breaks are kept: they are paragraphs,
 *   and the renderer preserves them as text.
 * - Empty or whitespace-only is NO GRANT — `{ ok: true, value: null }` — so
 *   that "the admin cleared the field" and "the admin never filled it in"
 *   are the same stored state, and the item page falls back to the
 *   site-wide /licence link for both (K2).
 * - Longer than {@link MAX_LICENCE_TERMS_LENGTH} after normalising is
 *   refused, not truncated: a grant cut off mid-sentence is a different
 *   grant from the one the admin wrote.
 * - Naming an Instagram host is refused (K4).
 */
export function checkLicenceTerms(raw: string): LicenceTermsCheck {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text === "") return { ok: true, value: null };
  if (text.length > MAX_LICENCE_TERMS_LENGTH) {
    return { ok: false, refusal: "too_long" };
  }
  if (mentionsInstagramHost(text)) {
    return { ok: false, refusal: "instagram_url" };
  }
  return { ok: true, value: text };
}
