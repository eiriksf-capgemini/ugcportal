import type { SellabilityBlocker } from "@/lib/resale-rights";

/**
 * Messages for the fixed `?error=` codes the resale-rights decision handler
 * redirects with (ugcportal-0ss, re-anchored by ugcportal-vsm). A closed set,
 * so nothing attacker-influencable is ever reflected into the page.
 */
const OUTCOME_MESSAGES: Record<string, string> = {
  rights_reason_required:
    "Say why. Every resale-rights decision is recorded with a reason, so the next reader knows what was decided and on what basis.",
  rights_invalid_valid_until:
    "That's not a date we could read. Leave it blank for a clearance with no end date.",
  rights_evidence_too_large:
    "That evidence file is too large (20 MB maximum). Upload the signed instrument itself rather than a scan of the whole folder.",
  rights_evidence_failed:
    "The evidence file couldn't be stored, so nothing was recorded. Check the server logs and try again.",
  rights_uploader_not_found:
    "That uploader no longer has an account, so there is nothing to clear. The list has been refreshed.",
  rights_actor_not_admin:
    "Your admin role was revoked since you signed in, so the decision wasn't recorded.",
  // Deliberately names both possibilities. Two foreign keys can produce
  // this, and where the driver doesn't say which, advice naming only one
  // would point at the wrong record.
  rights_holder_missing:
    "A user this decision refers to — the uploader, or you as the reviewer — no longer exists, so nothing was recorded. Refresh and try again.",
  rights_conflict:
    "Another decision on this uploader was recorded at the same moment. Check what it says, then record yours again if it's still right.",
};

/**
 * Resolve a `?error=` value to a message. Uses `hasOwn` rather than a bare
 * index so `?error=toString` can't resolve to an inherited Function, which
 * is truthy and which React then refuses to render as a child.
 */
export function outcomeMessage(error: unknown): string | undefined {
  return typeof error === "string" && Object.hasOwn(OUTCOME_MESSAGES, error)
    ? OUTCOME_MESSAGES[error]
    : undefined;
}

/**
 * Why an upload isn't currently sellable, in words. Keyed by
 * SellabilityBlocker (src/lib/resale-rights.ts) — `Record` rather than
 * `Partial<Record>` on purpose, so adding a blocker stops this file
 * compiling until someone writes the sentence for it.
 */
export const BLOCKER_MESSAGES: Record<SellabilityBlocker, string> = {
  no_review: "Not reviewed. Nothing this uploader has uploaded can be sold.",
  status_not_cleared:
    "Not cleared. Nothing this uploader has uploaded can be sold.",
  clearance_expired:
    "The clearance has run out. Re-review the uploader to sell their work again.",
  reviewer_not_admin:
    "The reviewer of record is no longer an admin, so the clearance no longer counts.",
  checklist_version_retired:
    "Cleared against a retired version of the checklist. Re-review against the current one.",
  upload_owner_unknown:
    "This file records no uploader, so there is nobody whose clearance could cover it.",
  not_listed_for_sale:
    "This upload hasn't been put forward for sale, so nobody has triaged what is in it.",
  triage_incomplete: "This upload has not been triaged yet.",
  triage_not_signed_by_admin:
    "Nobody currently holding admin has signed off this upload's triage. Every one of those answers is a statement about someone else's rights, so it needs a name behind it.",
  model_release_missing:
    "This upload shows people and has no model release on file.",
  model_release_unverified:
    "A model release is on file, but no admin has confirmed it covers this use. This is the layer with a named individual behind it.",
  minors_uncleared:
    "Someone under 18 is shown, and no admin has recorded a MINORS clearance. A release signed by a child is not a release: the guardian has to have consented, specifically and in writing, to online commercial publication. Clearing the people layer does not answer this.",
  alcohol_depicted:
    "Alcohol is visible or clearly evoked in this upload, so it cannot be sold or carry a price. Norwegian law bans alcohol from appearing in advertising for other products, and the test is what the picture looks like — a glass that reads as wine is caught whatever it actually held. Nothing clears this one: an empty glass or a cooler shown empty is an accessory, and that is a different answer to the same question.",
  third_party_layer_uncleared:
    "Music, a third-party creator or a sponsorship is involved and has not been cleared for this upload.",
};
