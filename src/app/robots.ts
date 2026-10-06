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
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
