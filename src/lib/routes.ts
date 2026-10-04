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
 * The public about and portfolio pages (ugcportal-qnq9.7). English route
 * names, matching the Decisions table's language rule — unlike
 * ugcportal-qnq9.4's /personvern and /lisens, which keep their Norwegian
 * names despite English content (see that bead's own title).
 *
 * `ABOUT_PATH` is also the header's link target (ugcportal-14k9, concurrent
 * with this bead) — named here so that bead imports the same constant
 * rather than a hand-typed "/about" that could drift from this route if it
 * were ever renamed.
 */
export const ABOUT_PATH = "/about";
export const PORTFOLIO_PATH = "/portfolio";

/**
 * The "Get in touch" section on /about, as a fragment anchor (ugcportal-akv6).
 * ContactSection (src/components/site/contact-section.tsx) carries the
 * matching `id="contact"`; named here, like every other route in this
 * module, so the footer's "Contact" link cannot hand-type "/about#contact"
 * a second time and drift from it if the section ever moves.
 */
export const ABOUT_CONTACT_PATH = `${ABOUT_PATH}#contact`;

/**
 * /llms.txt (ugcportal-o7l), per https://llmstxt.org. The route lives at
 * src/app/llms.txt/route.ts — a literal directory name, not a dynamic
 * segment, so this is the one and only path it answers at. Named here,
 * like every other route in this module, so the footer (ugcportal-akv6)
 * cannot hand-type "/llms.txt" a second time and drift from it.
 */
export const LLMS_TXT_PATH = "/llms.txt";

/**
 * The multipart field POST /api/media reads the subject tags out of
 * (ugcportal-jsc), named here because the browser writes it and the route
 * reads it and a field name spelled twice is one that eventually differs —
 * silently, because an unrecognised multipart part is simply ignored rather
 * than refused.
 *
 * The VALUE is sent as one repeated field, not as a JSON array in a single
 * part: `form.append(MEDIA_TAGS_FIELD, name)` per tag, read back with
 * `getAll`. That is what a multipart form is for, and it avoids a second
 * parser (and a second set of "what if this is not valid JSON" answers)
 * inside a handler that already has enough of them.
 */
export const MEDIA_TAGS_FIELD = "tags";

/**
 * The multipart fields POST /api/media reads alt text and the caption out of
 * (ugcportal-gwr). Unlike MEDIA_TAGS_FIELD each is sent at most once per
 * upload — one description per file, not a repeated field — so the route
 * reads them with `get()` rather than `getAll()`.
 */
export const MEDIA_ALT_TEXT_FIELD = "altText";
export const MEDIA_CAPTION_FIELD = "caption";

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
 * and the config cannot drift.
 *
 * THIS PATH MUST STAY OUTSIDE EVERY AUTH GATE, and that is an invariant this
 * repo has to keep rather than one the library enforces. @auth/core never
 * fetches the page and cannot know whether it is gated; its only related
 * check compares the current request's `callbackUrl` QUERY PARAMETER against
 * `pages.error` (index.js:93-96), and only on the config-error branch. Gate
 * this page and a refused visitor gets a real loop — 302 to /auth/error, the
 * gate sends them to sign in, the sign-in is refused, 302 to /auth/error —
 * with nothing detecting it (PR #45 review, round 3).
 */
export const AUTH_ERROR_PATH = "/auth/error";

/**
 * The privacy statement and the licence text (ugcportal-qnq9.4).
 *
 * English paths, not /personvern and /lisens: the site's language is English
 * (docs/ugc-research.md, decisions table), and a route a reader cannot
 * pronounce is one they will not find. Norwegian law still governs the
 * CONTENT — see the pages themselves. Named here so the footer
 * (ugcportal-akv6) and the pages cannot drift apart.
 */
export const PRIVACY_PATH = "/privacy";
export const LICENCE_PATH = "/licence";

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
