import { LICENCE_PAGE } from "@/app/licence/content";
import { PRIVACY_PAGE } from "@/app/privacy/content";
import type { LegalPage } from "@/lib/legal/publishable";

/**
 * The legal pages the boot-time check walks (ugcportal-qnq9.4). One list, so
 * adding a third legal page means adding it here and nowhere else —
 * src/instrumentation.ts and the tests both read this.
 *
 * BOOT-ONLY. A constant of the page records, not a call into the loaders:
 * `loadPrivacy`/`loadLicence` are `cache()`d per request and keyed on their
 * (empty) argument list, and the pages call them with no arguments. Nothing
 * at render time should reach for this list; a render reads its own
 * loader, so the request's content, page and readiness come from one call.
 */
export const LEGAL_PAGES: readonly LegalPage[] = [PRIVACY_PAGE, LICENCE_PAGE];
