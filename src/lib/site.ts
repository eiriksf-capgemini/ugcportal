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
 * privacy statement (PRIVACY_PATH, src/lib/routes.ts). ugcportal-qnq9.4 has
 * not merged at the time this bead was written, so that link 404s until it
 * does; flagged in the PR description rather than hidden.
 */
export const CONTACT_NOTICE =
  "Submitting this form opens your own email client with your message pre-filled, and sends it to our inbox directly — this site never receives or stores anything you type here. We only ever see what your email provider shows us: your name, your email address, and your message.";
