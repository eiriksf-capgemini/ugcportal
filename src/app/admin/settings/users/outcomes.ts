// Messages for the fixed outcome codes the role-change action redirects
// with. Same shape as the Instagram settings screen's outcomes: a closed set
// of codes, never text taken from the request.
const OUTCOME_MESSAGES: Record<string, string> = {
  last_admin:
    "That's the only admin left. Promote someone else first, then demote this account — otherwise nobody can reach the admin screens.",
  user_not_found: "That user no longer exists. The list has been refreshed.",
};

/**
 * Resolve a `?error=` value to a message. Uses `hasOwn` rather than a bare
 * index so `?error=toString` can't resolve to an inherited Function, which
 * is truthy and which React then refuses to render as a child.
 */
export function roleOutcomeMessage(error: unknown): string | undefined {
  return typeof error === "string" && Object.hasOwn(OUTCOME_MESSAGES, error)
    ? OUTCOME_MESSAGES[error]
    : undefined;
}
