import { LICENCE_PAGE } from "@/app/licence/content";
import { PRIVACY_PAGE } from "@/app/privacy/content";
import type { LegalPage } from "@/lib/legal/publishable";

/**
 * The legal pages the boot-time check walks (ugcportal-qnq9.4). One list, so
 * adding a third legal page means adding it here and nowhere else —
 * src/instrumentation.ts and the tests both read this. A constant, because
 * a page's authored prose does not depend on the environment (round 4).
 */
export const LEGAL_PAGES: readonly LegalPage[] = [PRIVACY_PAGE, LICENCE_PAGE];
