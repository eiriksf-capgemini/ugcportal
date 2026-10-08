import {
  ATTESTATION_AUTHORSHIP_QUESTION,
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  type AttestationAnswers,
  type AttestationBooleanField,
  type AttestationSubmission,
  isMediaAuthorship,
} from "@/lib/attestation";

/**
 * What the rights-attestation control holds, and what counts as answered
 * (ugcportal-15r).
 *
 * Its own module for the reason `alt-text.ts` and `tag-selection.ts` are:
 * this repo's vitest runs in a node environment with no DOM, so a decision
 * reachable only through a React event handler is in practice untested.
 * `upload-form.tsx` holds state wiring; the decisions live here.
 *
 * That is load-bearing here rather than a convention. The decision below —
 * "an unanswered question is not a `no`" — is the whole of ugcportal-15r K4
 * on the client side, and inside a JSX callback it would have shipped with no
 * test that could fail without it.
 *
 * BATCH-LEVEL, NOT PER-FILE, exactly like the alt text and the tag picker
 * beside it, and for the same reason: this page has no staging step, a drop
 * starts uploading immediately, and per-file questions would need one. For a
 * single file — the common case — this is exactly right. For a multi-file
 * drop every file in that batch carries the SAME answers, which is a real
 * limitation and is recorded as such in alt-text.ts's own docstring for the
 * sibling fields. It is not a correctness gap: the answers are the uploader's
 * own, given about files they chose together, and the server stores one row
 * per file either way.
 */

/**
 * The in-progress answers. `null` is UNANSWERED, and it is the initial value
 * of every question.
 *
 * NOT `false`, which is the shape a checkbox would give and the one this must
 * not have: a checkbox starts unchecked and an unchecked box is
 * indistinguishable from a box nobody looked at. The questions here include
 * "someone shown in it is under 18", and a control whose resting state
 * silently answers that is the exact fail-open ugcportal-15r exists to close.
 * Three states, rendered as a yes/no pair of radios with neither selected.
 */
export type AttestationDraft = {
  readonly authorship: string | null;
  readonly answers: Readonly<Partial<Record<AttestationBooleanField, boolean>>>;
};

export function emptyAttestationDraft(): AttestationDraft {
  return { authorship: null, answers: {} };
}

export function setAttestationAuthorship(
  draft: AttestationDraft,
  value: string,
): AttestationDraft {
  return { ...draft, authorship: value };
}

export function setAttestationAnswer(
  draft: AttestationDraft,
  field: AttestationBooleanField,
  value: boolean,
): AttestationDraft {
  return { ...draft, answers: { ...draft.answers, [field]: value } };
}

/**
 * Every question still unanswered, in the order the form asks them, by field
 * name. Empty means the draft is complete.
 *
 * Returned as a LIST rather than a boolean because the form marks each
 * unanswered question individually once an add has been refused — "fill
 * something in" under a nine-question block is not a usable message.
 *
 * `typeof === "boolean"` rather than a presence check on the key, for the
 * same reason `isTriaged` in src/lib/resale-rights.ts is written that way: a
 * key set to `undefined` is present and is not an answer.
 */
export function unansweredAttestationFields(draft: AttestationDraft): string[] {
  const missing: string[] = [];
  if (!isMediaAuthorship(draft.authorship)) {
    missing.push(ATTESTATION_AUTHORSHIP_QUESTION.field);
  }
  for (const { field } of ATTESTATION_QUESTIONS) {
    if (typeof draft.answers[field] !== "boolean") missing.push(field);
  }
  return missing;
}

/**
 * The message to show when an add was refused for an incomplete attestation,
 * or null when there is nothing to refuse.
 *
 * The count is interpolated from `unansweredAttestationFields` rather than
 * written out, so the sentence cannot come to disagree with the rule — the
 * same reason `tagCapMessage` interpolates its own constant.
 */
export function attestationDraftError(draft: AttestationDraft): string | null {
  const missing = unansweredAttestationFields(draft);
  if (missing.length === 0) return null;
  return missing.length === 1
    ? "Answer the remaining rights question before choosing files."
    : `Answer the remaining ${missing.length} rights questions before choosing files.`;
}

/**
 * The draft as something sendable, or null while anything is unanswered.
 *
 * NULL RATHER THAN A PARTIAL, so there is no value of this type that
 * represents a half-answered attestation — a caller cannot send one by
 * forgetting to check. The server refuses an incomplete body anyway
 * (`parseAttestation`), and the gate refuses an incomplete row
 * (`attestation_incomplete`); this is the first of the three, not the only
 * one, and it exists so the refusal happens before the bytes are paid for.
 *
 * Stamped with `CURRENT_ATTESTATION_VERSION` HERE, in the browser, which is
 * the only place that knows which text was actually rendered. See
 * `parseAttestation` for why the server checks that string instead of
 * writing its own.
 */
export function completedAttestation(
  draft: AttestationDraft,
): AttestationSubmission | null {
  if (unansweredAttestationFields(draft).length > 0) return null;
  const authorship = draft.authorship;
  // Re-narrowed rather than asserted: `unansweredAttestationFields` already
  // ran `isMediaAuthorship`, but `tsc` cannot carry that across the call and
  // a cast here would be the one place this module takes its own word for
  // something.
  if (!isMediaAuthorship(authorship)) return null;

  const answers: Record<string, boolean | string> = { authorship };
  for (const { field } of ATTESTATION_QUESTIONS) {
    const value = draft.answers[field];
    if (typeof value !== "boolean") return null;
    answers[field] = value;
  }
  return {
    version: CURRENT_ATTESTATION_VERSION,
    answers: answers as AttestationAnswers,
  };
}

export { ATTESTATION_AUTHORSHIP_QUESTION, ATTESTATION_QUESTIONS };
