/**
 * Site-level strings, in one place so the header wordmark, the document title
 * and the footer cannot drift apart.
 *
 * SITE_NAME is a placeholder: no brand has been chosen. Change it here and
 * every surface follows.
 */
export const SITE_NAME = "UGC Portal";

/**
 * The public meta description (src/app/layout.tsx), and the one string on
 * this site that a search engine quotes verbatim (also src/app/llms.txt).
 *
 * REWORDED FROM "Food, wine and drink, technology and books, photographed."
 * under ugcportal-qnq9.3 K5. That sentence promoted the DRINK on a site that
 * will take money, which is what alkoholloven § 9-2 forbids: alcohol must not
 * appear in advertising for other products, and a meta description is the
 * site's own advertisement for itself. The subject this site actually chose
 * is the ACCESSORY — empty glasses, coolers, wine-tool apps
 * (docs/ugc-research.md Decisions table, §3.1a) — so the copy now names that
 * instead.
 *
 * "wine accessories", NOT "wine", and the two words are not interchangeable
 * here: the shorter one reads as the drink in exactly the context the ban is
 * about. SITE_TAGLINE below already made this choice and says so; this string
 * is the one that had not caught up. src/lib/site.alcohol-copy.test.ts holds
 * both of them, and the about copy, to the same denylist.
 */
export const SITE_DESCRIPTION =
  "Food, wine accessories, technology and books, photographed.";

/**
 * The header's one-sentence tagline (ugcportal-14k9).
 *
 * Deliberately not SITE_DESCRIPTION itself, and deliberately not reusing its
 * wording: the gallery heading would otherwise repeat the header's own
 * sentence in different words, which src/lib/design/dual-meaning-usage.test.ts
 * and src/app/page.test.tsx between them keep it from doing. The two now agree
 * on the SUBJECT — ugcportal-qnq9.3 K5 reworded SITE_DESCRIPTION to the
 * accessory — while remaining two different sentences. This string names the
 * same four subjects, under ugcportal-qnq9.3 K5's framing
 * for the wine angle this site has actually chosen — empty glasses, coolers,
 * wine-tool apps — which is an ACCESSORY, not the drink alkoholloven § 9-2
 * bans from appearing in anything commercial. "Wine accessories", not "wine"
 * or "wine and drink", is what keeps this sentence on the right side of that
 * line regardless of what SITE_DESCRIPTION says at any given moment.
 */
export const SITE_TAGLINE =
  "Original photography of food, wine accessories, technology and books.";

/**
 * The About and Portfolio pages' copy (ugcportal-qnq9.7, §5.3), folded in
 * here rather than kept in a separate site-copy.ts (round-1 review) — this
 * module is already "site-level strings, in one place", and a second module
 * for a second kind of site-level string was a split with no reader.
 *
 * DRAFT COPY, written to satisfy §5.3's content requirements — "2-3
 * sentences on who you are, what you make and your themes", "what you
 * offer: short videos, photo sets, reviews" — and the Decisions table's
 * theme and language rules (English; wine accessories, never alcohol as the
 * subject). This is copy Eirik should read and may want to rewrite; nothing
 * here is asserted as final.
 */

/**
 * 2-3 sentences: who makes this, what is made, and the themes (food, books,
 * home technology, and wine accessories — glasses, coolers, apps — never
 * alcohol itself as the subject, per the Decisions table's "Wine angle" row
 * and §3's alcohol-advertising rule).
 */
export const INTRO_PARAGRAPHS = [
  "We're a two-person home studio making short videos, photo sets and honest reviews about food, books and home technology — including wine accessories like glasses, coolers and the apps that go with them. We never feature alcohol itself, only the gear and rituals around it.",
  "Every sample on this page started as something we made ourselves, with products we already owned — shot on a phone and a tripod, in daylight, at our own kitchen table.",
];

export type OfferItem = { title: string; description: string };

/** §5.3: "What you offer: short videos, photo sets, reviews." */
export const WHAT_WE_OFFER: OfferItem[] = [
  {
    title: "Short videos",
    description: "Vertical clips, 15–30 seconds, shot on location.",
  },
  {
    title: "Photo sets",
    description: "A handful of images telling one story, from one shoot.",
  },
  {
    title: "Reviews",
    description: "An honest first impression of a product we've actually used.",
  },
];

export const CONTACT_INTRO =
  "Want to work together, or just say hello? Send us a message below.";

/**
 * K5: states what is collected and why BEFORE submission, and links to the
 * privacy statement (PRIVACY_PATH, src/lib/routes.ts). That link resolved
 * nowhere when this was written; ugcportal-qnq9.4 has since published the page
 * (src/app/privacy/page.tsx), so it now resolves.
 */
export const CONTACT_NOTICE =
  "Submitting this form opens your own email client with your message pre-filled, and sends it to our inbox directly — this site never receives or stores anything you type here. We only ever see what your email provider shows us: your name, your email address, and your message.";
