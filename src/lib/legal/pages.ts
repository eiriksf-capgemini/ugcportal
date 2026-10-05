import { LICENCE_PAGE } from "@/app/licence/content";
import { PRIVACY_PAGE } from "@/app/privacy/content";
import type { LegalPage } from "@/lib/legal/publishable";

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
 * cost once: each loader builds the page's rendered PROSE from the live
 * LEGAL_* contact for whatever request calls it. The footer renders on
 * EVERY page, and most of those pages are neither /privacy nor /licence —
 * the two requests that already build that prose regardless — so reaching
 * for a loader there would add a whole extra prose build, once per
 * request, to every page that has nothing to do with either loader. A
 * page's OWN render still goes through its own loader, so its content,
 * page and readiness come from one call and cannot disagree with each
 * other; this list is for a caller elsewhere — the boot check, or the
 * footer's `linkBlockedInProduction` guard (src/lib/legal/publishable.ts)
 * — that only needs `legalReadiness([page], env)` to ask whether a page is
 * safe to serve or link, without rendering its text at all.
 */
export const LEGAL_PAGES: readonly LegalPage[] = [PRIVACY_PAGE, LICENCE_PAGE];
