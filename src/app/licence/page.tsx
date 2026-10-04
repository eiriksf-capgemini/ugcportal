import {
  LegalPageFrame,
  LegalParagraphs,
  LegalSection,
  legalMetadata,
} from "@/components/legal/legal-page";
import { assertPublishable } from "@/lib/legal/publishable";
import { LICENCE_PATH } from "@/lib/routes";

import { LICENCE_INTRO, LICENCE_SECTIONS, licenceTexts } from "./content";

export const metadata = legalMetadata("Licence");

/**
 * The licence text (ugcportal-qnq9.4). All text lives in ./content.ts; this
 * file only lays it out. Same production guard as /privacy: a licence page
 * telling people to e-mail "[CONTACT EMAIL]" is not published.
 */
export default function LicencePage() {
  assertPublishable({ path: LICENCE_PATH, texts: licenceTexts() });

  return (
    <LegalPageFrame title="Licence" intro={LICENCE_INTRO}>
      {LICENCE_SECTIONS.map((section) => (
        <LegalSection
          key={section.id}
          id={section.id}
          testId={`licence-section-${section.id}`}
          title={section.title}
        >
          <LegalParagraphs paragraphs={section.paragraphs} />
        </LegalSection>
      ))}
    </LegalPageFrame>
  );
}
