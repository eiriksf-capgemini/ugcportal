/**
 * The shared styling for a plain HTML text input/textarea, used wherever
 * this app renders one directly rather than through a form library —
 * src/app/upload/upload-form.tsx's alt-text and caption fields, and
 * src/components/site/contact-mailto-form.tsx's subject and message
 * fields. One constant, not the same long class string written out in
 * both files, so the two cannot drift apart (round-3 review of
 * ugcportal-qnq9.7).
 *
 * ugcportal-6uc2 (phase 2): moved off the near-black scale (`border-line-
 * strong bg-surface-1 ... text-ink`) onto the paper one — `border-input`
 * (now `--paper-line-strong`), `bg-card`/`text-card-foreground` (now
 * `--paper-card` and the dark ink that pairs with it) — so the upload and
 * contact forms stop being near-black fields on an otherwise light page
 * (K2). `bg-card`, not `bg-background`: the field reads as a raised well
 * against the page canvas, the same role `bg-surface-1` played against the
 * near-black canvas before this bead, not as a borderless continuation of
 * the page itself. The admin curation screens' own field classes — not
 * one shared constant: price-form.tsx's FIELD_CLASS, clearance-form.tsx's
 * TEXTAREA_CLASS, triage-form.tsx's SELECT_CLASS, and decision-form.tsx's
 * five inlined copies of the identical class string (round-2 review,
 * CONFIRMED low: this comment used to describe all four as sharing one
 * "FIELD_CLASS", which exists only in price-form.tsx) — are SEPARATE from
 * this one, and unchanged by this bead. All still pair `border-input` with
 * their own `bg-surface-3` fill, which is why those fields keep their
 * near-black look while this one does not; see ugcportal-eeip for the
 * mismatch that leaves.
 */
export const TEXT_INPUT_CLASS =
  "mt-2 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The shared `<label>` styling for one of the plain text inputs above — the
 * same two files, same reasoning (ugcportal-qnq9.16, item 4 of the lows
 * deferred from PR #93's round-6 review: this was left as a verbatim
 * duplicate in both files when `TEXT_INPUT_CLASS` was extracted for the
 * input/textarea itself). A label that follows a PRECEDING field in the
 * same form adds `mt-4` for spacing — compose it at the call site
 * (`` `mt-4 ${TEXT_LABEL_CLASS}` ``) rather than hard-coding a second,
 * spaced variant here.
 *
 * NOT touched by ugcportal-6uc2, and that is a real gap, not an oversight
 * left silent: `text-ink` renders directly on the page canvas here (no
 * bg-surface-* well of its own around the label, unlike TEXT_INPUT_CLASS
 * above), and --color-ink (tuned for the near-black scale, ~#eaeeee) measures
 * roughly 1.1:1 against --paper — functionally invisible. This predates this
 * bead (--color-ink is untouched by it) and is out of this bead's four-token
 * scope, so it is not fixed here; filed as ugcportal-4r0e instead
 * (discovered-from this bead) rather than folded into this PR.
 */
export const TEXT_LABEL_CLASS = "block text-sm font-medium text-ink";
