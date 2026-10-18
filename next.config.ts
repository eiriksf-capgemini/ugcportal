import type { NextConfig } from "next";

/**
 * Anti-framing and referrer headers sent on every response (ugcportal-7ex5).
 *
 * Deliberately only frame-ancestors in the Content-Security-Policy: no
 * script-src/style-src/default-src, so nothing here can block the site's own
 * scripts or styles. A full CSP is a separate decision (consent-gated
 * analytics loader). Strict-Transport-Security is the TLS proxy's.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  // Emits a self-contained `.next/standalone` build (server + only the
  // production node_modules actually reachable at runtime) so the
  // production Docker image doesn't need the full node_modules tree or
  // the Next.js CLI. See Dockerfile.
  output: "standalone",

  // Deliberately NOT raising experimental.serverActions.bodySizeLimit.
  //
  // An earlier revision of ugcportal-0ss raised it to 21mb so that a 20 MB
  // evidence file could reach an admin-only server action. That setting is
  // global and the framework enforces it before any action code — including
  // requireAdmin — runs, so it would have let an anonymous caller make the
  // server buffer 21 MB against *any* action id, including the sign-in
  // actions. A denial-of-service surface opened by a fix for an admin-only
  // feature.
  //
  // File upload now goes to a route handler instead
  // (src/app/api/admin/rights/decision/route.ts), which reads its
  // body through readCappedFormData in src/lib/request-body.ts and so owns
  // its own limit without moving anyone else's. Keep it that way: if a
  // server action ever needs a large body, give it a route handler.
};

export default nextConfig;
