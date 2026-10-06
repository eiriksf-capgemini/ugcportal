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
  // No `brand_actor_not_admin` here, UNLIKE the sibling resale-rights
  // module's `rights_actor_not_admin` one level up. A non-admin is answered
  // the plain JSON 403 `requireAdminAccess` returns directly —
  // the same shape every other admin API route in this product uses for
  // "not an admin" (POST /api/admin/curation/[id]/price,
  // POST /api/admin/rights/decision), not a redirect — because the page
  // this route's form lives on already refuses a non-admin at render
  // (`notFound()`), so there is no legitimate path by which a signed-in
  // non-admin is ever looking at the form to retype after an error. The
  // sibling route's redirect exists because its write
  // (`setResaleRightsStatus`) re-checks the actor's role itself, after an
  // evidence upload that gives a revoked admin's role time to change
  // mid-request; this route has no such multi-step write to re-check inside.
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
