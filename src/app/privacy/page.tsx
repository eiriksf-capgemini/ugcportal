import type { Metadata } from "next";

import {
  LegalFacts,
  LegalPageFrame,
  LegalParagraphs,
  LegalProse,
  LegalSection,
  legalMetadata,
} from "@/components/legal/legal-page";
import { assertPublishable, legalReadiness } from "@/lib/legal/publishable";

import { loadPrivacy, retentionText } from "./content";

/**
 * The privacy statement (ugcportal-qnq9.4). All text lives in ./content.ts;
 * this file only lays it out. See that module's header for the editing rule.
 *
 * Reads the LEGAL_* variables at request time (src/lib/legal/contact.ts) and
 * nothing else — no session, no database — so it cannot fail for a visitor
 * in any way the text does not describe. The one deliberate failure: in
 * production, while a variable is unset or a placeholder remains,
 * `assertPublishable` throws rather than serve a statement with no
 * identifiable controller (GDPR Art. 13(1)(a)). Draft status comes from the
 * same reading plus the sign-off constant, so the notice, the meta marker
 * and the guard cannot disagree.
 */

export function generateMetadata(): Metadata {
  return legalMetadata("Privacy", legalReadiness([loadPrivacy().page]).draft);
}

export default function PrivacyPage() {
  const { content, page } = loadPrivacy();
  assertPublishable(page);
  const { draft } = legalReadiness([page]);

  return (
    <LegalPageFrame title="Privacy" intro={content.intro} draft={draft}>
      <LegalProse section={content.controller} testIdPrefix="privacy-section" />

      <h2 className="mt-12 text-xl font-medium tracking-tight text-foreground">
        What is collected, and why
      </h2>
      {content.categories.map((category) => (
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

      <LegalProse section={content.transfers} testIdPrefix="privacy-section" />
      <LegalProse section={content.cookies} testIdPrefix="privacy-section" />
      <LegalProse section={content.notDone} testIdPrefix="privacy-section" />
      <LegalProse section={content.rights} testIdPrefix="privacy-section" />
    </LegalPageFrame>
  );
}
