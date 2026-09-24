import { randomBytes } from "node:crypto";

// The OAuth `state` is kept in a cookie and compared on the way back: a
// classic double-submit check, so a forged callback from another site can't
// bind an attacker-controlled Instagram account to this admin's settings.
export const STATE_COOKIE = "ig_oauth_state";

// Scoped to the two routes that use it so it isn't attached to every request,
// and short-lived because an authorisation redirect that takes longer than
// this is more likely replayed than slow.
export const STATE_COOKIE_PATH = "/api/admin/instagram";
export const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function stateCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    // `lax` rather than `strict`: the cookie has to survive Instagram's
    // top-level redirect back to the callback, which `strict` would drop.
    sameSite: "lax" as const,
    path: STATE_COOKIE_PATH,
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  };
}
