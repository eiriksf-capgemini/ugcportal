// Route paths shared across modules that can't import each other freely —
// notably the "use server" actions file, which may only export async
// functions, and src/lib/instagram.ts, which route tests mock wholesale.
export const INSTAGRAM_SETTINGS_PATH = "/admin/settings/instagram";
export const INSTAGRAM_CALLBACK_PATH = "/api/admin/instagram/callback";
export const INSTAGRAM_CONNECT_PATH = "/api/admin/instagram/connect";
export const ADMIN_USERS_PATH = "/admin/settings/users";
// Resale rights (ugcportal-0ss, re-anchored to uploaders by ugcportal-vsm).
// Not under /instagram any more: a connected account confers no right to
// sell anything, and the screen lists uploaders.
export const RIGHTS_SETTINGS_PATH = "/admin/settings/rights";
// A route handler rather than a server action, so the evidence upload can
// have its own body cap instead of raising the global one (ugcportal-0ss).
export const RIGHTS_DECISION_PATH = "/api/admin/rights/decision";

// Manual upload (ugcportal-n3c). Since the Instagram integration was
// deferred, this page is the only door media comes in through.
export const UPLOAD_PATH = "/upload";
export const MEDIA_UPLOAD_PATH = "/api/media";

/**
 * Where to send a visitor who has to sign in first.
 *
 * Auth.js mounts its own provider-picker at `/api/auth/signin`
 * (src/app/api/auth/[...nextauth]/route.ts); there is no first-party sign-in
 * page yet, and inventing one is not this bead's job.
 *
 * `callbackUrl` is encoded, and is only ever a path this module named. A
 * callbackUrl taken from user input is an open redirect — Auth.js does filter
 * it against its own origin, but the filtering is not the reason this is
 * safe; not accepting the input is.
 */
export function signInPath(callbackPath: string): string {
  return `/api/auth/signin?callbackUrl=${encodeURIComponent(callbackPath)}`;
}

/**
 * The watermarked preview's bytes, by opaque handle (ugcportal-a2l).
 *
 * The ONLY media URL any surface may build. `Media.key` — the ungated
 * original — is never selected into a response (MEDIA_OWNER_SELECT in
 * src/lib/media-access.ts) and has no route in front of it; `previewKey` is
 * a storage path embedding the uploader's account id and must not reach the
 * markup either. `previewId` is the handle that carries neither.
 */
export function mediaPreviewPath(previewId: string): string {
  return `/api/media/preview/${encodeURIComponent(previewId)}`;
}
