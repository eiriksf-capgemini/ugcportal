import type { Metadata } from "next";

import { LegalPageFrame, LegalProse, legalMetadata } from "@/components/legal/legal-page";
import { assertPublishable, legalReadiness } from "@/lib/legal/publishable";

import { loadLicence } from "./content";

/**
 * The licence text (ugcportal-qnq9.4). All text lives in ./content.ts; this
 * file only lays it out. Same reading, guard and draft logic as /privacy —
 * see that page's header.
 */

export function generateMetadata(): Metadata {
  return legalMetadata("Licence", legalReadiness([loadLicence().page]).draft);
}

export default function LicencePage() {
  const { content, page } = loadLicence();
  assertPublishable(page);
  const { draft } = legalReadiness([page]);

  return (
    <LegalPageFrame title="Licence" intro={content.intro} draft={draft}>
      {content.sections.map((section) => (
        <LegalProse key={section.id} section={section} testIdPrefix="licence-section" />
      ))}
    </LegalPageFrame>
  );
}
