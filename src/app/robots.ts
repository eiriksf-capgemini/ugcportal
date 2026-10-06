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
 *
 * `dynamic = "force-dynamic"` (review round 2, MEDIUM finding, sibling-
 * omission): without it, `siteOrigin()` reading `process.env.AUTH_URL` gives
 * Next no `headers()`/`cookies()`-shaped signal that this route needs a
 * per-request render, so it prerenders `/robots.txt` as a STATIC route at
 * `next build` time instead. That is a real, always-happens defect in this
 * repo's own Dockerfile: the builder stage runs `npm run build` with
 * `AUTH_URL` unset (it sets `AUTH_SECRET`/`AUTH_GOOGLE_*`/`AUTH_FACEBOOK_*`
 * placeholders but never `AUTH_URL`) under `NODE_ENV=production`, so the
 * baked artifact has no `Sitemap:` line, permanently — while
 * `checkSiteOriginConfigured`'s boot warning (src/instrumentation-node.ts)
 * runs at container RUNTIME, where `AUTH_URL` is correctly set, and so never
 * fires for this, giving false confidence that nothing is wrong. Confirmed
 * directly (round 2 review, reproduced again here): `npm run build` with
 * `AUTH_URL` unset and `NODE_ENV=production` produces
 * `.next/server/app/robots.txt.body` containing only `User-Agent: *` /
 * `Allow: /`, no `Sitemap:` line; adding this export flips the route from
 * `○ (Static)` to `ƒ (Dynamic)` in the build's own route table and removes
 * that prerendered `.body` artifact entirely. The same export `sitemap.ts`
 * and `media/[previewId]/page.tsx` already carry for the identical reason —
 * both also call `siteOrigin()` — see `src/lib/origin.route-usage.test.ts`
 * for the guard that now holds all three (and any future caller) to this.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: { userAgent: "*", allow: "/" },
    ...(origin !== null ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
