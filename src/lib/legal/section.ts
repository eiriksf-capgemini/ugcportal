/**
 * The shapes the legal pages' content modules share (ugcportal-qnq9.4; one
 * type rather than four structurally identical literals, PR #90 round 2).
 */

export type LegalProseSection = {
  /** Stable id — the section's anchor and the suffix of its `data-testid`. */
  id: string;
  title: string;
  paragraphs: readonly string[];
  /**
   * Repository files to RE-READ when reviewing this section's claims.
   *
   * A pointer that re-prompts human review, not a proof (PR #90 round 2,
   * family 1): the test over these checks only that each path still exists,
   * so a rename or deletion fails loudly and forces someone to re-read the
   * sentence against whatever replaced the file. Nothing here verifies that
   * the file still does what the sentence says — that is the bead's K5
   * walk, done by a person, recorded on the bead. Empty for pure policy
   * sentences that describe no behaviour.
   */
  reviewAgainst: readonly string[];
};

/** A prose section whose body is a bulleted list, with the paragraphs after it. */
export type LegalListSection = LegalProseSection & {
  items: readonly string[];
};

/** Every string a section can render, for the placeholder scan and the markup test. */
export function sectionTexts(section: LegalProseSection | LegalListSection): string[] {
  return [
    section.title,
    ...("items" in section ? section.items : []),
    ...section.paragraphs,
  ];
}
