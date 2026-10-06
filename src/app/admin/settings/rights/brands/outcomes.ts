/**
 * Messages for the fixed `?error=`/`?brand=` codes the brand-alcohol route
 * redirects with (ugcportal-mqh8), the same shape as the resale-rights
 * `outcomes.ts` one level up and for the same reason: a closed set, so
 * nothing attacker-influencable is ever reflected into the page.
 */
const OUTCOME_MESSAGES: Record<string, string> = {
  brand_not_found:
    "That brand no longer exists, so there was nothing to record. The list has been refreshed.",
  brand_id_missing:
    "No brand was named in that request, so nothing was recorded.",
  brand_actor_not_admin:
    "Your admin role was revoked since you signed in, so nothing was recorded.",
};

/**
 * Resolve a `?error=` value to a message. `hasOwn` rather than a bare index,
 * the same reason the sibling module gives: so `?error=toString` cannot
 * resolve to an inherited Function, which React refuses to render as a
 * child.
 */
export function brandOutcomeMessage(error: unknown): string | undefined {
  return typeof error === "string" && Object.hasOwn(OUTCOME_MESSAGES, error)
    ? OUTCOME_MESSAGES[error]
    : undefined;
}
