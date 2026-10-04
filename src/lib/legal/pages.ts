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
 * a call into either page's own loader. `loadPrivacy`/`loadLicence`
 * additionally build the page's rendered PROSE from the live LEGAL_*
 * contact on every call, which is real work a caller that only wants
 * READINESS (not content) should not pay for on every render. A page's OWN
 * render still goes through its own loader, so its content, page and
 * readiness come from one call and cannot disagree with each other; this
 * list is for a caller elsewhere — the boot check, or the footer's
 * `linkBlockedInProduction` guard (src/lib/legal/publishable.ts) — that
 * only needs `legalReadiness([page], env)` to ask whether a page is safe
 * to serve or link, without rendering its text at all.
 */
export const LEGAL_PAGES: readonly LegalPage[] = [PRIVACY_PAGE, LICENCE_PAGE];
