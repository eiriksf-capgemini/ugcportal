/**
 * K4 guard (ugcportal-dmne): "the accent is applied so widely it stops
 * being an accent" must never happen — more than one terracotta-filled
 * primary call-to-action per rendered page defeats the whole point of an
 * accent colour.
 *
 * `bg-terracotta-600` is reserved EXCLUSIVELY for button.tsx's
 * `default-accent` variant (the hero's one primary CTA, and — per this
 * bead's own scope and the 2026-10-02 handoff note, "terracotta accent
 * scope - CTA only, never on sign-in buttons" — the only place that
 * variant may ever be used). Nothing else in this bead's own surfaces uses
 * that exact fill: the for-sale badge and the highlighted offer price
 * (src/components/media/purchase-offer.tsx) use
 * `terracotta-100`/`terracotta-900` instead, deliberately, so this exact
 * class name cannot be confused with either of them. Counting literal
 * occurrences of this one class name in rendered markup is therefore an
 * unambiguous count of "how many terracotta-filled primary controls are on
 * this page" — not a proxy or a guess.
 */
export const TERRACOTTA_PRIMARY_CTA_FILL_CLASS = "bg-terracotta-600";

/**
 * `\b...\b`, not a plain substring search: `bg-terracotta-600` has no
 * longer real sibling utility this could be confused with today (there is
 * no `bg-terracotta-6000` anything), but a word boundary is the same cheap
 * insurance `tokenAlphaKey`/`backgroundTokenIdentity`-style exact-match
 * reasoning elsewhere in this design-system gate already applies, for the
 * same reason.
 */
const FILL_CLASS_PATTERN = new RegExp(`\\b${TERRACOTTA_PRIMARY_CTA_FILL_CLASS}\\b`, "g");

/** How many terracotta-filled primary controls (K4) appear in this rendered markup. */
export function countTerracottaPrimaryControls(markup: string): number {
  return (markup.match(FILL_CLASS_PATTERN) ?? []).length;
}
