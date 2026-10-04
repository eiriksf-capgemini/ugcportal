/**
 * The English copy for the About and Portfolio pages (ugcportal-qnq9.7,
 * §5.3), in one module so both pages render the identical intro/offer/contact
 * text rather than two copies that can drift apart, and so a reviewer (or
 * Eirik) can read every sentence this bead ships in one place.
 *
 * DRAFT COPY, written to satisfy §5.3's content requirements — "2-3 sentences
 * on who you are, what you make and your themes", "what you offer: short
 * videos, photo sets, reviews" — and the Decisions table's theme and language
 * rules (English; wine accessories, never alcohol as the subject). This is
 * copy Eirik should read and may want to rewrite; nothing here is asserted as
 * final, see the PR description for the exact text this bead ships.
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
 * privacy statement. The route name (`/personvern`) matches
 * ugcportal-qnq9.4's bead title exactly, even though that page's own content
 * is English (Decisions table) — see that bead for why the path keeps its
 * Norwegian name. ugcportal-qnq9.4 has not merged at the time this bead was
 * written, so this link 404s until it does; flagged in the PR description
 * rather than hidden.
 */
export const PRIVACY_PATH = "/personvern";

export const CONTACT_NOTICE =
  "Submitting this form opens your own email client with your message pre-filled, and sends it to our inbox directly — this site never receives or stores anything you type here. We only ever see what your email provider shows us: your name, your email address, and your message.";
