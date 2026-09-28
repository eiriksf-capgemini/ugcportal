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

// The public gallery feed (ugcportal-r1d) and the preview bytes it points at
// (ugcportal-a2l). Named here rather than spelled inline because ugcportal-71y
// reaches for both from three places — the server-rendered first page, the
// browser's next-page fetch, and the `src` of every tile — and a path typed
// three times is a path that eventually differs once.
export const PUBLIC_MEDIA_PATH = "/api/public/media";
export const MEDIA_PREVIEW_PATH = "/api/media/preview";

/**
 * Where Auth.js sends a failed sign-in (ugcportal-egp).
 *
 * Wired as `pages.error` in src/lib/auth.ts, which replaces @auth/core's
 * built-in error page for every auth error — not only the AccessDenied a
 * refused sign-in produces. Lives here rather than being inlined so the page
 * and the config cannot drift, and because @auth/core refuses to use a
 * `pages.error` that itself requires authentication: this path must stay
 * outside every auth gate.
 */
export const AUTH_ERROR_PATH = "/auth/error";

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
 * The delivery URL for a watermarked preview, keyed on its OPAQUE handle
 * (ugcportal-a2l).
 *
 * The ONLY media URL any surface may build. `previewId` and nothing else,
 * ever. `Media.key` — the ungated original — is never selected into a
 * response (MEDIA_OWNER_SELECT in src/lib/media-access.ts) and has no route
 * in front of it. `previewKey` must not reach the markup either: it is
 * `previews/{userId}/{uuid}.webp`, so a URL built from it publishes the
 * uploader's account id to every visitor's address bar and every access log
 * in between — the exact capability the `previewId` indirection exists to
 * remove. There is no client-side way back from `previewId` to the key,
 * which is the point.
 *
 * Encoded rather than interpolated raw: today's ids are UUIDs from the
 * watermark service, so nothing needs escaping, but this function does not
 * get to assume that about every id the column will ever hold.
 */
export function mediaPreviewPath(previewId: string): string {
  return `${MEDIA_PREVIEW_PATH}/${encodeURIComponent(previewId)}`;
}

/** The listing parameters GET /api/public/media reads out of its query string. */
export type PublicMediaListingParams = { limit?: number; cursor?: string };

/**
 * The public feed as a same-origin path plus query.
 *
 * Lives in THIS module — which imports nothing — rather than next to
 * `listPublicMedia`, and that placement is load-bearing rather than tidy. The
 * gallery is a client component and calls this from the browser; importing it
 * from src/lib/public-media.ts would pull that module's graph (media-access,
 * and through it @/lib/auth and @/lib/prisma) into a "use client" boundary.
 *
 * One builder for both callers, so the browser cannot ask for `?after=` while
 * the server reads `?cursor=` — a mismatch that does not error, it just serves
 * page one forever.
 */
export function publicMediaListingPath(
  params: PublicMediaListingParams = {},
): string {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor !== undefined) query.set("cursor", params.cursor);
  const search = query.toString();
  return search === "" ? PUBLIC_MEDIA_PATH : `${PUBLIC_MEDIA_PATH}?${search}`;
}
