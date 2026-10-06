import type { MetadataRoute } from "next";

import { siteOrigin } from "@/lib/origin";

/**
 * app/robots.ts (ugcportal-qnq9.12): Next's built-in robots convention,
 * served at `/robots.txt`. No hand-rolled text file.
 *
 * Allows everything and points at the sitemap this same bead adds
 * (src/app/sitemap.ts). There is nothing on this site that needs hiding from
 * a crawler by path: the gate that decides whether an item or a legal page
 * is visible at all is `publishedAt`/`legalReadiness`, enforced at the
 * routes themselves (404, in production refusing to serve), not a
 * `Disallow` rule a crawler is free to ignore anyway.
 *
 * `sitemap` is OMITTED, not defaulted to a guess, when `siteOrigin()` returns
 * `null` (review round 1, finding 1) — in production, that means AUTH_URL is
 * unset or malformed, and pointing at `http://localhost:3000/sitemap.xml`
 * would be worse than pointing at nothing: a URL no public crawler can ever
 * reach, published with no sign anything is wrong. `checkSiteOriginConfigured`
 * (src/lib/origin.ts, wired into src/instrumentation-node.ts) is what reports
 * the actual cause; this file's job is only to not publish a wrong URL.
 * `allow: "/"` still stands either way — it names no host, so it is correct
 * regardless of whether a real origin is configured.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: { userAgent: "*", allow: "/" },
    ...(origin !== null ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
