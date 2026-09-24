import type { SellabilityBlocker } from "@/lib/resale-rights";

// Messages for the fixed outcome codes the OAuth callback redirects with.
// Deliberately not the provider's own `error_description`, which is
// attacker-influencable and would be reflected into the page.
const OUTCOME_MESSAGES: Record<string, string> = {
  denied: "Instagram authorisation was cancelled. Nothing was connected.",
  invalid_state:
    "That connect link expired or didn't match this browser session. Start again.",
  missing_code: "Instagram didn't return an authorisation code. Start again.",
  exchange_failed:
    "Couldn't complete the connection with Instagram. Check the server logs and try again.",
  // Resale-rights decisions (ugcportal-0ss).
  rights_reason_required:
    "Say why. Every resale-rights decision is recorded with a reason, so the next reader knows what was decided and on what basis.",
  rights_invalid_valid_until:
    "That's not a date we could read. Leave it blank for a clearance with no end date.",
  rights_evidence_too_large:
    "That evidence file is too large (20 MB maximum). Upload the signed instrument itself rather than a scan of the whole folder.",
  rights_evidence_failed:
    "The evidence file couldn't be stored, so nothing was recorded. Check the server logs and try again.",
  rights_account_not_found:
    "That account is no longer connected. The list has been refreshed.",
  rights_actor_not_admin:
    "Your admin role was revoked since you signed in, so the decision wasn't recorded.",
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
 * Why an account isn't currently clear to sell from, in words. Keyed by
 * SellabilityBlocker (src/lib/resale-rights.ts) — `Record` rather than
 * `Partial<Record>` on purpose, so adding a blocker stops this file
 * compiling until someone writes the sentence for it.
 */
export const BLOCKER_MESSAGES: Record<SellabilityBlocker, string> = {
  no_review: "Not reviewed. Nothing from this account can be sold.",
  status_not_cleared: "Not cleared. Nothing from this account can be sold.",
  clearance_expired:
    "The clearance has run out. Re-review the account to sell from it again.",
  reviewer_not_admin:
    "The reviewer of record is no longer an admin, so the clearance no longer counts.",
  checklist_version_retired:
    "Cleared against a retired version of the checklist. Re-review against the current one.",
  triage_incomplete: "This post has not been triaged yet.",
  model_release_missing:
    "This post shows people and has no model release on file.",
  third_party_layer_uncleared:
    "Music, a third-party creator or a sponsorship is involved and has not been cleared for this post.",
  not_owner_supplied_original:
    "No owner-uploaded original is linked, and only the owner's own file may be sold.",
};
