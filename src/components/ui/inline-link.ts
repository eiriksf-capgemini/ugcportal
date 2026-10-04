/**
 * The shared styling for an inline text link — an `<a>` inside a sentence
 * of body text, as opposed to a button-like call to action
 * (src/components/ui/button.tsx's own `link` VARIANT is a different thing:
 * it carries that component's base button classes, `inline-flex
 * shrink-0 items-center...`, meant for an element that behaves like a
 * button and merely looks like a link — using it here would both pull in
 * classes an inline text link does not want and drop this one's
 * `focus-visible:outline-2` ring and always-on `underline`, a real visual
 * change this round-5 review finding does not ask for).
 *
 * One constant, not the same long string written out across
 * src/components/site/contact-section.tsx and the three admin settings
 * pages (rights, users, instagram) — round-5 review.
 */
export const INLINE_LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring";
