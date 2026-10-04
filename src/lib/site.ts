/**
 * Site-level strings, in one place so the header wordmark, the document title
 * and the footer cannot drift apart.
 *
 * SITE_NAME is a placeholder: no brand has been chosen. Change it here and
 * every surface follows.
 */
export const SITE_NAME = "UGC Portal";

export const SITE_DESCRIPTION =
  "Food, wine and drink, technology and books, photographed.";

/**
 * The header's one-sentence tagline (ugcportal-14k9).
 *
 * Deliberately not SITE_DESCRIPTION itself, and deliberately not reusing its
 * wording: SITE_DESCRIPTION still says "wine and drink", which is
 * ugcportal-qnq9.3's reword to make (that bead owns the public meta
 * description, landing concurrently with this one). This string is written
 * fresh, naming the same four subjects, under ugcportal-qnq9.3 K5's framing
 * for the wine angle this site has actually chosen — empty glasses, coolers,
 * wine-tool apps — which is an ACCESSORY, not the drink alkoholloven § 9-2
 * bans from appearing in anything commercial. "Wine accessories", not "wine"
 * or "wine and drink", is what keeps this sentence on the right side of that
 * line regardless of what SITE_DESCRIPTION says at any given moment.
 */
export const SITE_TAGLINE =
  "Original photography of food, wine accessories, technology and books.";
