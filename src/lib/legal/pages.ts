import { loadLicence } from "@/app/licence/content";
import { loadPrivacy } from "@/app/privacy/content";
import type { LegalPage } from "@/lib/legal/publishable";

/**
 * The legal pages the boot-time check walks (ugcportal-qnq9.4). One list, so
 * adding a third legal page means adding it here and nowhere else —
 * src/instrumentation.ts and the tests both read this. Built from `env`
 * rather than process.env so a test can hand it a fixture.
 */
export function legalPages(env: NodeJS.ProcessEnv = process.env): LegalPage[] {
  return [loadPrivacy(env).page, loadLicence(env).page];
}
