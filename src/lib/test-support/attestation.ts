import {
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  type AttestationAnswers,
} from "@/lib/attestation";

/**
 * A complete, clean rights attestation (ugcportal-15r) for a fixture.
 *
 * DATA ONLY, no Prisma call, and that is deliberate rather than minimal:
 * `src/lib/attestation-write-paths.test.ts` asserts that exactly one
 * non-test file under `src/` writes a `MediaAttestation`, and a helper that
 * called `prisma.mediaAttestation.create` would be a second one — true, and
 * only excusable by an allowlist entry, which is how a scan like this starts
 * meaning less than it says. Callers pass the returned object as `data`
 * themselves, from their own test file, which the scan excludes.
 *
 * "CLEAN" MEANS EVERY YES/NO ANSWERED `false` AND AUTHORSHIP `AUTHOR` — the
 * one combination the gate sells on. Every negative case in the suite is this
 * minus one thing, so a failure says which answer did the blocking. Note what
 * that implies and why it is safe: `false` here is an ANSWER, written into a
 * `NOT NULL` column by a fixture that chose it. It is not the same state as
 * no attestation at all, and `resale-rights.test.ts` asserts the gate tells
 * those two apart (ugcportal-15r K4).
 *
 * Derived from `ATTESTATION_QUESTIONS` rather than written out, so a tenth
 * question does not silently default to `undefined` here and fail every
 * fixture in the suite with `attestation_incomplete`.
 */
export function completeAttestationAnswers(
  overrides: Partial<AttestationAnswers> = {},
): AttestationAnswers {
  const answers: Record<string, boolean | string> = { authorship: "AUTHOR" };
  for (const { field } of ATTESTATION_QUESTIONS) {
    // Every question answers "no" except the uploader's own age, where "no"
    // is the blocking answer and "yes" is the clean one. Written as an
    // explicit exception rather than by giving the registry a "clean value",
    // because a per-question default in the registry would be a second place
    // deciding what a safe answer is.
    answers[field] = field === "uploaderIsAdult";
  }
  return { ...(answers as AttestationAnswers), ...overrides };
}

/** The same answers plus the columns a row needs, ready to pass as `data`. */
export function completeAttestationRow(
  mediaId: string,
  attestedByUserId: string,
  overrides: Partial<AttestationAnswers> & { attestationVersion?: string } = {},
) {
  const { attestationVersion, ...answerOverrides } = overrides;
  return {
    mediaId,
    attestedByUserId,
    attestationVersion: attestationVersion ?? CURRENT_ATTESTATION_VERSION,
    ...completeAttestationAnswers(answerOverrides),
  };
}
