import { LICENCE_PAGE } from "@/app/licence/content";
import { PRIVACY_PAGE } from "@/app/privacy/content";
import { type LegalPage, legalReadiness, linkBlockedInProduction } from "@/lib/legal/publishable";

/**
 * The legal pages this app knows about (ugcportal-qnq9.4). One list, so
 * adding a third legal page means adding it here and nowhere else —
 * src/instrumentation.ts's boot check, the tests, and (ugcportal-akv6) the
 * footer's link guard all read this.
 *
 * A constant of the page RECORDS (route, authored prose, its digest) — not
 * a call into either page's own loader. `loadPrivacy`/`loadLicence` are
 * each `cache()`d PER REQUEST (round-4 review: that qualifier matters —
 * this does not claim they rebuild on every call within one request,
 * React's `cache()` dedupes that), but a fresh request still pays the full
 * cost once per loader it actually calls: each builds the page's rendered
 * PROSE from the live LEGAL_* contact. The footer calls BOTH loaders on
 * EVERY page, to ask about both /privacy and /licence (round-6 review:
 * the real cost, not "zero and one") — on /privacy itself, that is one
 * cache hit (its own render already called `loadPrivacy`) plus one
 * genuinely avoidable build (`loadLicence`, for a page this request has
 * nothing to do with), and /licence is the mirror image; on every OTHER
 * page neither call is a cache hit, so it is two avoidable prose builds,
 * not one. A page's OWN render still goes through its own loader, so its
 * content, page and readiness come from one call and cannot disagree with
 * each other; this list is for a caller elsewhere — the boot check, or the
 * footer's `linkBlockedInProduction` guard (src/lib/legal/publishable.ts)
 * — that only needs `legalReadiness([page], env)` to ask whether a page is
 * safe to serve or link, without rendering its text at all.
 */
export const LEGAL_PAGES: readonly LegalPage[] = [PRIVACY_PAGE, LICENCE_PAGE];

/**
 * The registered LegalPage for a route a caller wants to link to (moved
 * here from src/components/site-footer.tsx by ugcportal-nf9l, which gave
 * the About page's contact notice the same reason to need it: one function
 * that reads LEGAL_PAGES, rather than each caller re-deriving its own
 * lookup, so a route typo or an unregistered page is caught the same way
 * everywhere). Throws rather than silently treating an unregistered path as
 * safe to link — a link to a legal page that isn't in LEGAL_PAGES is a bug
 * in the caller, not a page that happens to be fine to link.
 */
export function legalPageFor(path: string): LegalPage {
  const page = LEGAL_PAGES.find((candidate) => candidate.path === path);
  if (!page) {
    throw new Error(
      `${path} is not registered in LEGAL_PAGES (src/lib/legal/pages.ts) — a caller cannot judge whether it is safe to link.`,
    );
  }
  return page;
}

/**
 * Whether a link to the given legal page must not render at all, once
 * NODE_ENV is production (ugcportal-akv6 K3). The ONE place this decision
 * is made — read by the footer (src/components/site-footer.tsx) and by the
 * About page's contact notice (src/components/site/contact-section.tsx,
 * ugcportal-nf9l) — so the two cannot disagree about the same route (K2):
 * each reads the SAME `LegalPage` record (via `legalPageFor` above) through
 * the SAME `legalReadiness`/`linkBlockedInProduction` pair
 * (src/lib/legal/publishable.ts), rather than each computing its own
 * opinion that could drift from the other's.
 */
export function legalLinkBlocked(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return linkBlockedInProduction(legalReadiness([legalPageFor(path)]), env);
}
