import type { Metadata } from "next";

import { LegalPageFrame, LegalProse, legalMetadata } from "@/components/legal/legal-page";
import { assertPublishable } from "@/lib/legal/publishable";

import { loadLicence } from "./content";

/**
 * The licence text (ugcportal-qnq9.4). All text lives in ./content.ts; this
 * file only lays it out. Same reading, guard and draft logic as /privacy —
 * see that page's header.
 */

/** Per request, never prerendered — same reason as /privacy. */
export const dynamic = "force-dynamic";

/**
 * Reflects the same per-request readiness the body reads; only the body
 * throws — see the note on /privacy's generateMetadata.
 */
export function generateMetadata(): Metadata {
  return legalMetadata("Licence", loadLicence().readiness.draft);
}

export default function LicencePage() {
  const { content, readiness } = loadLicence();
  assertPublishable(readiness);

  return (
    <LegalPageFrame title="Licence" intro={content.intro} draft={readiness.draft}>
      {content.sections.map((section) => (
        <LegalProse key={section.id} section={section} testIdPrefix="licence-section" />
      ))}
    </LegalPageFrame>
  );
}
