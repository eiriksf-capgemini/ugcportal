import { SITE_NAME } from "@/lib/site";

/**
 * What an auth error says to the person who hit it (ugcportal-egp).
 *
 * Separate from the page so the copy can be asserted without rendering a
 * server component, and because the page's only job is layout.
 *
 * Auth.js hands us `?error=<type>` where the type is one of a small
 * client-safe set (`isClientError` in @auth/core/errors); anything it deems
 * unsafe to disclose arrives as `Configuration` instead. So this switch is
 * not a guess about the space of errors — it mirrors the three types
 * @auth/core's own error page distinguishes, plus a fallback.
 */
export type AuthErrorCopy = {
  heading: string;
  body: string[];
  /**
   * Whether offering "try signing in again" makes sense.
   *
   * `false` for AccessDenied, and that is the point of this page existing:
   * @auth/core's built-in page puts a Sign in button under "You do not have
   * permission to sign in", which starts the identical journey and refuses
   * it identically. A retry link there is a loop, not a recovery.
   */
  offerRetry: boolean;
};

const PRIVATE_INSTANCE: AuthErrorCopy = {
  heading: "Access denied",
  // Deliberately identical for every refusal. The gate distinguishes an
  // address that is not on the list from one the provider would not vouch
  // for, and from a list nobody has configured yet — the visitor is told
  // none of that, because the difference is only useful to someone probing
  // for which addresses are permitted. The reason is logged server-side.
  body: [
    // Worded to be true of every refusal the gate can produce, which is why
    // it says the sign-in was not permitted rather than that the address is
    // not on a list: the gate also refuses an address it cannot get the
    // provider to vouch for, and an instance nobody has configured yet.
    `${SITE_NAME} is a private instance. Accounts are not open to sign-up, and this sign-in was not permitted.`,
    "Nothing is wrong with your Google or Facebook account, and there is nothing to retry. If you should have access, ask whoever runs this site to grant it.",
  ],
  offerRetry: false,
};

export function authErrorCopy(error: string | undefined): AuthErrorCopy {
  switch (error) {
    case "AccessDenied":
      return PRIVATE_INSTANCE;
    case "Configuration":
      return {
        heading: "Sign-in is misconfigured",
        // No detail: @auth/core substitutes `Configuration` for any error it
        // considers unsafe to disclose, so this is the one case where the
        // page genuinely does not know what happened and must not imply it.
        body: [
          "Sign-in is not working right now because of a problem on this server, not with your account.",
          "The details are in the server log. Please let whoever runs this site know.",
        ],
        offerRetry: false,
      };
    case "Verification":
      return {
        heading: "That sign-in link has expired",
        body: [
          "The link was either already used or too old to use. Links are single-use on purpose.",
        ],
        offerRetry: true,
      };
    default:
      // Includes `error` being absent entirely, which is what someone
      // visiting this URL directly gets. It is not an error state, so it
      // does not claim to be one.
      return {
        heading: "Sign-in did not complete",
        body: [
          "The sign-in did not finish, and this page was not told why. If you were part-way through signing in, starting again usually works.",
        ],
        offerRetry: true,
      };
  }
}

/**
 * `?error=` arrives as whatever was in the query string: absent, once, or
 * repeated. A repeated parameter reaches a server component as an array, and
 * `authErrorCopy(["AccessDenied", "x"] as never)` would fall to the default
 * and quietly offer a retry link on a refusal — so the array case is
 * collapsed here rather than left to the page.
 *
 * A repeated parameter takes the FIRST value, matching how @auth/core builds
 * the URL (it sets exactly one) and refusing to let an appended second value
 * change the answer.
 */
export function singleErrorParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
