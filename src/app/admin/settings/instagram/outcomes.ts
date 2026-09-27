// Messages for the fixed outcome codes the OAuth callback redirects with.
// Resale-rights codes moved to ../rights/outcomes.ts with the gate itself
// (ugcportal-vsm): connecting an account no longer decides anything about
// resale rights.
// Deliberately not the provider's own `error_description`, which is
// attacker-influencable and would be reflected into the page.
const OUTCOME_MESSAGES: Record<string, string> = {
  denied: "Instagram authorisation was cancelled. Nothing was connected.",
  invalid_state:
    "That connect link expired or didn't match this browser session. Start again.",
  missing_code: "Instagram didn't return an authorisation code. Start again.",
  exchange_failed:
    "Couldn't complete the connection with Instagram. Check the server logs and try again.",
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
