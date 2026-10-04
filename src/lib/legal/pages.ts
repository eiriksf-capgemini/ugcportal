import { licenceTexts } from "@/app/licence/content";
import { privacyTexts } from "@/app/privacy/content";
import type { LegalPage } from "@/lib/legal/publishable";
import { LICENCE_PATH, PRIVACY_PATH } from "@/lib/routes";

/**
 * The legal pages the boot-time placeholder check walks (ugcportal-qnq9.4).
 * One list, so adding a third legal page means adding it here and nowhere
 * else — src/instrumentation.ts and the tests both read this.
 */
export function legalPages(): LegalPage[] {
  return [
    { path: PRIVACY_PATH, texts: privacyTexts() },
    { path: LICENCE_PATH, texts: licenceTexts() },
  ];
}
