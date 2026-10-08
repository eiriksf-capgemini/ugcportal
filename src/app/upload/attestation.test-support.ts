import {
  ATTESTATION_AUTHORSHIP_QUESTION,
  ATTESTATION_QUESTIONS,
  type AttestationBooleanField,
} from "@/lib/attestation";

/**
 * Answers every rights question on a mounted `UploadForm` (ugcportal-15r),
 * for the jsdom tests whose subject is something else entirely — the retry
 * clock, the focus handoff, the stale alt-text refusal.
 *
 * WHY THIS EXISTS RATHER THAN EACH TEST TICKING ITS OWN NINE RADIOS. Those
 * tests all need a file to actually queue, and `addFiles` refuses before it
 * queues anything while the attestation is incomplete. Nine `querySelector`
 * calls copied into four files would be four places to edit when a tenth
 * question lands — and three of them would be edited, which is how this kind
 * of helper ends up existing anyway, late and inconsistently.
 *
 * DRIVEN THROUGH THE REAL CONTROLS, not by reaching into React state: these
 * are the same `click()`s a visitor makes, so a test that calls this is still
 * proving the form can actually be completed. `completedAttestation` and
 * `parseAttestation` are tested directly elsewhere.
 *
 * `act` is passed in rather than imported, because the caller owns the React
 * act environment and importing a second copy of `react` here would risk a
 * different module instance.
 */
export function answerAttestation(
  container: ParentNode,
  act: (callback: () => void) => void,
  answers: Partial<Record<AttestationBooleanField, boolean>> = {},
): void {
  const click = (field: string, value: string) => {
    const radio = container.querySelector<HTMLInputElement>(
      `[data-attestation-question="${field}"] input[value="${value}"]`,
    );
    if (radio === null) {
      throw new Error(`no "${value}" control for attestation question ${field}`);
    }
    act(() => {
      radio.click();
    });
  };

  click(ATTESTATION_AUTHORSHIP_QUESTION.field, "AUTHOR");
  for (const { field } of ATTESTATION_QUESTIONS) {
    // Every question "no" except the uploader's own age, where "no" is the
    // blocking answer — the same one combination the server-side fixtures
    // use, for the same reason.
    const answer = answers[field] ?? field === "uploaderIsAdult";
    click(field, answer ? "yes" : "no");
  }
}
