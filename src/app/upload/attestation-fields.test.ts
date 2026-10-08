import { describe, expect, it } from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import {
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  type AttestationBooleanField,
} from "@/lib/attestation";
import {
  type AttestationDraft,
  attestationDraftError,
  completedAttestation,
  emptyAttestationDraft,
  setAttestationAnswer,
  setAttestationAuthorship,
  unansweredAttestationFields,
} from "./attestation-fields";

/**
 * ugcportal-15r K1 and K4 on the browser side: an unanswered question is not
 * a `no`, and nothing sendable exists until every one of them is answered.
 *
 * These decisions live in their own module precisely so they can be driven
 * here rather than only through a React event handler — see the module's own
 * docstring. This is the one test that can fail if the "resting state is not
 * an answer" rule is weakened.
 */

function answerAll(
  overrides: Partial<Record<AttestationBooleanField, boolean>> = {},
): AttestationDraft {
  let draft = setAttestationAuthorship(
    emptyAttestationDraft(),
    MediaAuthorship.AUTHOR,
  );
  for (const { field } of ATTESTATION_QUESTIONS) {
    draft = setAttestationAnswer(
      draft,
      field,
      overrides[field] ?? field === "uploaderIsAdult",
    );
  }
  return draft;
}

describe("a fresh draft answers nothing", () => {
  it("starts with every question unanswered, including authorship", () => {
    expect(unansweredAttestationFields(emptyAttestationDraft())).toEqual([
      "authorship",
      ...ATTESTATION_QUESTIONS.map(({ field }) => field),
    ]);
  });

  it("is not sendable", () => {
    expect(completedAttestation(emptyAttestationDraft())).toBeNull();
  });

  it("does not silently read as a `no` to anything", () => {
    /*
     * THE CLIENT HALF OF K4. A checkbox-shaped control would start every
     * question at `false`, and "false" is a warranty — including, on this
     * form, a warranty that nobody under 18 is shown. This asserts the
     * resting state is the third state, not the negative one.
     */
    const draft = emptyAttestationDraft();
    for (const { field } of ATTESTATION_QUESTIONS) {
      expect(draft.answers[field], field).toBeUndefined();
      expect(draft.answers[field], field).not.toBe(false);
    }
    expect(draft.authorship).toBeNull();
  });
});

describe("one question at a time", () => {
  it("is sendable only once the last one is answered", () => {
    /*
     * Walked rather than asserted at the two ends, so a rule that only
     * required SOME answers would fail at whichever step it started
     * accepting. The order is the registry's, with authorship first.
     */
    let draft = emptyAttestationDraft();
    expect(completedAttestation(draft)).toBeNull();

    draft = setAttestationAuthorship(draft, MediaAuthorship.AUTHOR);
    expect(completedAttestation(draft)).toBeNull();

    ATTESTATION_QUESTIONS.forEach(({ field }, index) => {
      draft = setAttestationAnswer(draft, field, false);
      const remaining = ATTESTATION_QUESTIONS.length - index - 1;
      expect(
        completedAttestation(draft),
        `after ${field}, ${remaining} to go`,
      ).toEqual(remaining === 0 ? expect.anything() : null);
      expect(unansweredAttestationFields(draft)).toHaveLength(remaining);
    });
  });

  for (const { field } of ATTESTATION_QUESTIONS) {
    it(`refuses to send while ${field} is unanswered`, () => {
      // One case per question, generated: a completeness check written as
      // `answers.length > 0` would pass a single hand-picked case.
      const draft = answerAll();
      const missing: AttestationDraft = {
        ...draft,
        answers: Object.fromEntries(
          Object.entries(draft.answers).filter(([key]) => key !== field),
        ),
      };

      expect(unansweredAttestationFields(missing)).toEqual([field]);
      expect(completedAttestation(missing)).toBeNull();
      expect(attestationDraftError(missing)).toMatch(
        /Answer the remaining rights question before choosing files\./,
      );
    });
  }

  it("refuses to send while only authorship is unanswered", () => {
    const draft: AttestationDraft = { ...answerAll(), authorship: null };

    expect(unansweredAttestationFields(draft)).toEqual(["authorship"]);
    expect(completedAttestation(draft)).toBeNull();
  });

  it("refuses an authorship value outside the closed set", () => {
    const draft = setAttestationAuthorship(answerAll(), "something-else");

    expect(unansweredAttestationFields(draft)).toContain("authorship");
    expect(completedAttestation(draft)).toBeNull();
  });
});

describe("a complete draft", () => {
  it("carries every answer through, unchanged", () => {
    const draft = answerAll({ showsMinors: true, aiGenerated: true });

    const submission = completedAttestation(draft);

    expect(submission).not.toBeNull();
    expect(submission!.version).toBe(CURRENT_ATTESTATION_VERSION);
    expect(submission!.answers.authorship).toBe(MediaAuthorship.AUTHOR);
    expect(submission!.answers.showsMinors).toBe(true);
    expect(submission!.answers.aiGenerated).toBe(true);
    // The rest are the `false` the fixture set, not "whatever was lying
    // around": a mapper that wrote the same value into every field would
    // pass the two above and fail here.
    expect(submission!.answers.containsMusicNotOwned).toBe(false);
    expect(submission!.answers.showsIdentifiablePeople).toBe(false);
    expect(submission!.answers.uploaderIsAdult).toBe(true);
  });

  it("stamps the version the browser actually rendered", () => {
    expect(completedAttestation(answerAll())!.version).toBe(
      CURRENT_ATTESTATION_VERSION,
    );
  });

  it("has nothing left to report", () => {
    expect(attestationDraftError(answerAll())).toBeNull();
    expect(unansweredAttestationFields(answerAll())).toEqual([]);
  });
});

describe("the message counts what is actually missing", () => {
  it("says how many when there is more than one", () => {
    expect(attestationDraftError(emptyAttestationDraft())).toBe(
      `Answer the remaining ${ATTESTATION_QUESTIONS.length + 1} rights questions before choosing files.`,
    );
  });

  it("drops the count as questions are answered", () => {
    let draft = setAttestationAuthorship(
      emptyAttestationDraft(),
      MediaAuthorship.AUTHOR,
    );
    draft = setAttestationAnswer(draft, "showsMinors", false);

    expect(attestationDraftError(draft)).toContain(
      `remaining ${ATTESTATION_QUESTIONS.length - 1} rights questions`,
    );
  });
});

describe("setting an answer does not disturb the others", () => {
  it("keeps every previous answer when a later one changes", () => {
    // The shape of the state is `{...answers, [field]: value}`, which is
    // easy to write as `{[field]: value}` by accident — and that bug would
    // be invisible to a test that only ever set one field.
    const draft = setAttestationAnswer(answerAll(), "aiGenerated", true);

    expect(unansweredAttestationFields(draft)).toEqual([]);
    expect(draft.answers.aiGenerated).toBe(true);
    expect(draft.answers.showsMinors).toBe(false);
    expect(draft.authorship).toBe(MediaAuthorship.AUTHOR);
  });

  it("lets an answer be changed from yes back to no", () => {
    const yes = setAttestationAnswer(answerAll(), "showsMinors", true);
    const no = setAttestationAnswer(yes, "showsMinors", false);

    expect(completedAttestation(no)!.answers.showsMinors).toBe(false);
  });

  it("does not mutate the draft it was given", () => {
    const before = answerAll();
    setAttestationAnswer(before, "showsMinors", true);

    expect(before.answers.showsMinors).toBe(false);
  });
});
