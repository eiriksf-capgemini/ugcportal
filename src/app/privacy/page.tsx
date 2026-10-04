import {
  LegalFacts,
  LegalPageFrame,
  LegalParagraphs,
  LegalSection,
  legalMetadata,
} from "@/components/legal/legal-page";
import { assertPublishable } from "@/lib/legal/publishable";
import { PRIVACY_PATH } from "@/lib/routes";

import {
  PRIVACY_CATEGORIES,
  PRIVACY_CONTROLLER,
  PRIVACY_COOKIES,
  PRIVACY_INTRO,
  PRIVACY_NOT_DONE,
  PRIVACY_RIGHTS,
  PRIVACY_TRANSFERS,
  privacyTexts,
  retentionText,
} from "./content";

export const metadata = legalMetadata("Privacy");

/**
 * The privacy statement (ugcportal-qnq9.4). All text lives in ./content.ts;
 * this file only lays it out. See that module's header for the editing rule.
 *
 * Renders for anyone, signed in or not, and reads nothing — no session, no
 * database — so it cannot fail for a visitor in any way the text does not
 * describe. The one deliberate failure: in production, while a contact
 * placeholder remains, `assertPublishable` throws rather than serve a
 * statement with no identifiable controller (GDPR Art. 13(1)(a)).
 */
export default function PrivacyPage() {
  assertPublishable({ path: PRIVACY_PATH, texts: privacyTexts() });

  return (
    <LegalPageFrame title="Privacy" intro={PRIVACY_INTRO}>
      <LegalSection
        id={PRIVACY_CONTROLLER.id}
        testId={`privacy-section-${PRIVACY_CONTROLLER.id}`}
        title={PRIVACY_CONTROLLER.title}
      >
        <LegalParagraphs paragraphs={PRIVACY_CONTROLLER.paragraphs} />
      </LegalSection>

      <h2 className="mt-12 text-xl font-medium tracking-tight text-foreground">
        What is collected, and why
      </h2>
      {PRIVACY_CATEGORIES.map((category) => (
        <LegalSection
          key={category.id}
          id={category.id}
          testId={`privacy-category-${category.id}`}
          title={category.title}
        >
          <LegalParagraphs paragraphs={category.what} />
          <LegalFacts
            facts={[
              { label: "Why", value: category.purpose },
              { label: "Legal basis", value: category.legalBasis },
              { label: "Who else sees it", value: category.recipients },
              {
                label: "How long",
                value: retentionText(category.retention),
                testId: `privacy-retention-${category.id}`,
              },
              { label: "Who can read it", value: category.access },
            ]}
          />
        </LegalSection>
      ))}

      <LegalSection
        id={PRIVACY_TRANSFERS.id}
        testId={`privacy-section-${PRIVACY_TRANSFERS.id}`}
        title={PRIVACY_TRANSFERS.title}
      >
        <LegalParagraphs paragraphs={PRIVACY_TRANSFERS.paragraphs} />
      </LegalSection>

      <LegalSection
        id={PRIVACY_COOKIES.id}
        testId={`privacy-section-${PRIVACY_COOKIES.id}`}
        title={PRIVACY_COOKIES.title}
      >
        <LegalParagraphs paragraphs={PRIVACY_COOKIES.paragraphs} />
      </LegalSection>

      <LegalSection
        id={PRIVACY_NOT_DONE.id}
        testId={`privacy-section-${PRIVACY_NOT_DONE.id}`}
        title={PRIVACY_NOT_DONE.title}
      >
        <ul className="mt-3 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {PRIVACY_NOT_DONE.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <LegalParagraphs paragraphs={[PRIVACY_NOT_DONE.closing]} />
      </LegalSection>

      <LegalSection
        id={PRIVACY_RIGHTS.id}
        testId={`privacy-section-${PRIVACY_RIGHTS.id}`}
        title={PRIVACY_RIGHTS.title}
      >
        <LegalParagraphs paragraphs={PRIVACY_RIGHTS.paragraphs} />
      </LegalSection>
    </LegalPageFrame>
  );
}
