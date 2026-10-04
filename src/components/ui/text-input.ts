/**
 * The shared styling for a plain HTML text input/textarea, used wherever
 * this app renders one directly rather than through a form library —
 * src/app/upload/upload-form.tsx's alt-text and caption fields, and
 * src/components/site/contact-mailto-form.tsx's subject and message
 * fields. One constant, not the same long class string written out in
 * both files, so the two cannot drift apart (round-3 review of
 * ugcportal-qnq9.7).
 */
export const TEXT_INPUT_CLASS =
  "mt-2 block w-full rounded-md border border-line-strong bg-surface-1 px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
