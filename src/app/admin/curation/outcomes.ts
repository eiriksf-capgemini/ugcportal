import { TRIAGE_WRITE_REFUSALS } from "@/lib/curation-triage-write";

/**
 * Messages for the fixed outcome codes the triage action redirects with
 * (ugcportal-vq3z). Same shape as the users and Instagram settings screens'
 * outcomes: a closed set of codes, never text taken from the request.
 */

/**
 * Every code `?error=` may carry: the refusals the write itself can return,
 * plus the one the action decides before it gets there.
 *
 * Composed from TRIAGE_WRITE_REFUSALS rather than hand-listed, so a refusal
 * added to the write path cannot reach this screen with no message. The
 * `Record` below is typed over this union, so `tsc` — not a test, and not
 * review — refuses a new refusal that nobody has written a sentence for.
 */
export const TRIAGE_OUTCOME_CODES = [
  ...TRIAGE_WRITE_REFUSALS,
  "unanswered",
] as const;

export type TriageOutcomeCode = (typeof TRIAGE_OUTCOME_CODES)[number];

const OUTCOME_MESSAGES: Record<TriageOutcomeCode, string> = {
  unanswered:
    "Every question has to be answered before the triage can be recorded. Leaving one blank is not a “no” — an unanswered question blocks the sale, and recording a half-filled triage would put your name on answers you did not give.",
  media_not_found:
    "That upload no longer exists, so there is nothing to triage. The list has been refreshed.",
  no_preview:
    "That upload has no watermarked preview yet, so it cannot be put into the curation flow. Nothing was recorded — curating it now would mean offering the unprotected original.",
};

/**
 * Resolve a `?error=` value to a message. Uses `hasOwn` rather than a bare
 * index so `?error=toString` can't resolve to an inherited Function, which
 * is truthy and which React then refuses to render as a child — the same
 * trap the users screen's `roleOutcomeMessage` documents.
 */
export function triageOutcomeMessage(error: unknown): string | undefined {
  return typeof error === "string" && Object.hasOwn(OUTCOME_MESSAGES, error)
    ? OUTCOME_MESSAGES[error as TriageOutcomeCode]
    : undefined;
}
