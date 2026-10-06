/**
 * Same-origin check for route handlers that a browser posts to directly.
 *
 * Server actions get this from the framework; route handlers do not. It is a
 * second lock rather than the only one — the session cookie is SameSite=Lax,
 * so a cross-site POST arrives with no credentials and `requireAdmin`
 * already refuses it. This exists for the day that cookie policy changes, a
 * subdomain appears, or a handler is reached some way nobody predicted.
 *
 * The expected origin comes from **configuration, not from the request**.
 * `request.url` is what the server received, which behind a TLS-terminating
 * proxy — what the standalone Docker image assumes — is
 * `http://<internal-host>:3000` while the browser sends the public
 * `https://<host>`. Deriving the expectation from the request would refuse
 * every legitimate post in production while passing every test that uses one
 * host for both. src/lib/instagram.ts makes the same argument about
 * `isCallbackSecure`, for the same reason.
 */

/**
 * The canonical public origin, from AUTH_URL (Auth.js's own source of truth).
 *
 * `env` is a parameter, same convention as `src/lib/legal/contact.ts` and
 * `src/lib/legal/publishable.ts`, so a test can exercise an unset or
 * malformed value without mutating the real `process.env.AUTH_URL` (which
 * `isSameOriginRequest`'s own existing tests still do directly — this
 * parameter is additive, not a change to that behaviour).
 */
export function expectedOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.AUTH_URL;
  if (!configured) {
    return null;
  }
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

/**
 * The origin used to build fully-qualified public URLs: the sitemap, the
 * robots file's `sitemap` field, and a per-item page's canonical link
 * (ugcportal-qnq9.12).
 *
 * Returns `null` in two cases now, not one — review round 1 finding 1.
 * Outside production, an unset or malformed AUTH_URL still falls back to
 * AUTH_URL's own documented local default (env.example:
 * `AUTH_URL=http://localhost:3000`): a crawler-facing route is not optional
 * the way an auth redirect is, so `npm run dev`/`next build` without
 * AUTH_URL configured still produces a working sitemap/canonical link to
 * inspect, with no Origin/Host header to fall back to the way
 * `isSameOriginRequest` does above.
 *
 * IN PRODUCTION, THE FALLBACK IS REFUSED. A real deployment that is missing
 * or has a broken AUTH_URL must not silently publish `http://localhost:3000`
 * on every per-item canonical link, in `/sitemap.xml`, and in
 * `/robots.txt`'s `sitemap` field — that is a wrong URL on a surface built
 * to be read by every crawler at once, with nothing in the response itself
 * to say so. `null` here means every caller must omit the URL rather than
 * guess at a substitute; see `checkSiteOriginConfigured` below for the
 * boot-time half of this (the equivalent of `checkLegalPagesPublishable`,
 * src/lib/legal/publishable.ts, for this configuration gap), and
 * src/app/sitemap.ts / src/app/robots.ts / src/app/media/[previewId]/page.tsx
 * for what each surface does with `null`.
 */
export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const origin = expectedOrigin(env);
  if (origin) return origin;
  return env.NODE_ENV === "production" ? null : "http://localhost:3000";
}

/**
 * The boot-time check for `siteOrigin()`'s configuration (review round 1
 * finding 1), same convention as `checkLegalPagesPublishable`
 * (src/lib/legal/publishable.ts): warn in EVERY environment while AUTH_URL
 * is unset or unparseable, so a misconfigured deployment is caught at the
 * first log line rather than by a crawler (or a human reading page source)
 * finding `http://localhost:3000` on a canonical link, or finding the
 * sitemap/robots surfaces quietly omitting URLs in production.
 *
 * Called from `registerNodeOnlyChecks` (src/instrumentation-node.ts); see
 * that module's own comment for why boot checks live there rather than in
 * src/instrumentation.ts directly.
 */
export function checkSiteOriginConfigured(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (expectedOrigin(env) !== null) {
    return null;
  }
  return env.NODE_ENV === "production"
    ? "[origin] AUTH_URL is not set or is not a valid URL, so a real public origin " +
        "cannot be built. Production will NOT publish http://localhost:3000 on the " +
        "per-item canonical link, /sitemap.xml or /robots.txt's sitemap field — it " +
        "omits those URLs instead, which is safer but means this deployment has no " +
        "working sitemap or canonical links until AUTH_URL is set. See env.example."
    : "[origin] AUTH_URL is not set or is not a valid URL, so the per-item canonical " +
        "link, /sitemap.xml and /robots.txt's sitemap field fall back to " +
        "http://localhost:3000 outside production. See env.example.";
}

/**
 * Whether this request may be treated as same-origin.
 *
 * A **present but mismatched** Origin is refused. A **missing** Origin is
 * allowed, deliberately: no browser omits `Origin` on a cross-origin POST,
 * so its absence cannot be an attacker's cross-site form — while some
 * clients do omit it on same-origin posts, and refusing those would be an
 * outage rather than a defence. `Sec-Fetch-Site` is consulted when present,
 * since it says directly what the Origin comparison is trying to infer.
 *
 * If AUTH_URL is unset there is no expectation to check against, so the
 * Origin comparison is skipped and Sec-Fetch-Site carries what it can. That
 * is the dev default; production sets AUTH_URL because OAuth needs it.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    return false;
  }

  const origin = request.headers.get("origin");
  const expected = expectedOrigin();
  if (!origin || !expected) {
    return true;
  }
  return origin === expected;
}
