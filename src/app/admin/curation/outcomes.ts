import { CLEARANCE_WRITE_REFUSALS } from "@/lib/curation-clearance-write";
import { TRIAGE_WRITE_REFUSALS } from "@/lib/curation-triage-write";

/**
 * Messages for the fixed outcome codes this screen's server actions
 * redirect with (ugcportal-vq3z, extended by ugcportal-qfy9). Same shape as
 * the users and Instagram settings screens' outcomes: a closed set of codes,
 * never text taken from the request.
 */

/**
 * Every code `?error=` may carry: the refusals each of the two writes can
 * return, plus the one the triage action decides before it gets there.
 *
 * Composed from TRIAGE_WRITE_REFUSALS and CLEARANCE_WRITE_REFUSALS rather
 * than hand-listed, so a refusal added to either write path cannot reach
 * this screen with no message. The `Record` below is typed over this union,
 * so `tsc` — not a test, and not review — refuses a new refusal that
 * nobody has written a sentence for. The two sets are disjoint by naming
 * convention (`clearance_…`) rather than by accident; a collision would
 * silently give one refusal the other's sentence.
 */
export const TRIAGE_OUTCOME_CODES = [
  ...TRIAGE_WRITE_REFUSALS,
  ...CLEARANCE_WRITE_REFUSALS,
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
  clearance_actor_not_admin:
    "Only a current admin can clear a rights layer, and your account is not one. Nothing was recorded — a clearance names the person who stands behind it, and the gate re-reads that person’s role every time it runs.",
  clearance_layer_not_clearable:
    "That rights layer is not one a clearance settles, so nothing was recorded. Alcohol is the case this mostly means: the standard is what the picture looks like, so no signature makes it sellable — the fix is a different photograph.",
  clearance_reason_blank:
    "A clearance needs a reason, and a blank one is not a reason. Nothing was recorded — a clearance with no justification is read as settling nothing, so it would leave the layer blocked while looking cleared.",
  clearance_listing_not_found:
    "That upload has not been triaged yet, so there is no record to attach a clearance to. Record the triage first; the layers a “yes” needs are the ones you can then clear.",
  clearance_already_recorded:
    "That layer already has a clearance, and nothing was changed. One layer carries one justification, so a second would leave the gate choosing between two answers to the same question — revising one is a separate, deliberate act that does not exist yet.",
  alcohol_with_commercial_links:
    "That upload already carries a commercial link, and nothing commercial may sit on a picture showing alcohol (alkoholloven § 9-2). Nothing was recorded — not even your other answers, because a half-recorded triage would put your name on a set you did not finish. Detach the item’s commercial links first, then answer the alcohol question.",
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
