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

/** The canonical public origin, from AUTH_URL (Auth.js's own source of truth). */
export function expectedOrigin(): string | null {
  const configured = process.env.AUTH_URL;
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
