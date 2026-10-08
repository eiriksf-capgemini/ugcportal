import type { AttestationAnswers, AttestationBooleanField } from "@/lib/attestation";
import type { TriageFactField } from "@/lib/resale-rights";

/**
 * Where the admin's triage flag and the uploader's own attestation (ugcportal-15r)
 * answer the same question, for ugcportal-vlnn: rendering the uploader's
 * answer beside the admin's flag on the curation screen, defaulting the
 * admin's flag to it, and warning where the two disagree.
 *
 * NOT EVERY TRIAGE FACT HAS A MATCH. The attestation never asks about alcohol
 * — TRIAGE_FACTS' own comment on `depictsAlcohol` and `wineAccessory` is
 * explicit that this is a judgment about what the picture looks like, which
 * only the admin can make, not a fact the uploader could truthfully attest to
 * either way. A triage fact with no entry here has no uploader column and can
 * never disagree with anything, by construction rather than by a comparison
 * that happens to come back false.
 *
 * This is the only place that pairs a TriageFactField with an
 * AttestationBooleanField. Both `page.tsx` and `triage-form.tsx` read it, so
 * the two cannot come to disagree about which question is "the same
 * question" on two different screens.
 */
export const TRIAGE_FACT_ATTESTATION_FIELD: Readonly<
  Partial<Record<TriageFactField, AttestationBooleanField>>
> = {
  depictsPeople: "showsIdentifiablePeople",
  depictsMinors: "showsMinors",
  containsMusic: "containsMusicNotOwned",
  thirdPartyCreator: "otherCreativeContributor",
  sponsoredContent: "brandOrSponsorship",
};

/**
 * What the uploader's attestation has to say about one triage fact, as a
 * discriminated union rather than a `boolean | null` — the shape that would
 * let "the uploader answered no" and "there is nothing to compare" collapse
 * into the same falsy value further down the pipe.
 *
 * - `not_applicable`: this triage fact has no attestation counterpart
 *   (TRIAGE_FACT_ATTESTATION_FIELD has no entry for it). The attestation was
 *   never asked this question, attested or not, so there is nothing to show
 *   or to disagree with.
 * - `no_attestation`: the fact HAS a counterpart, but this upload has no
 *   attestation row at all — `Media.attestation` is null, ugcportal-15r's own
 *   "nobody asked the uploader anything" state. This is the state K3 exists
 *   to keep distinct from `answered: false`.
 * - `answered`: the upload has an attestation, and this is what it says.
 */
export type UploaderTriageComparison =
  | { kind: "not_applicable" }
  | { kind: "no_attestation" }
  | { kind: "answered"; value: boolean };

/**
 * Compares one TRIAGE_FACTS field against the uploader's stored attestation,
 * if there is one.
 *
 * `attestation` is the FULL `AttestationAnswers` shape or `null` — never a
 * single pre-extracted boolean — so this function is the one place that
 * reads MediaAttestation.* for this purpose, and the one place a future
 * caller has to update if the mapping above changes.
 */
export function compareTriageFactToAttestation(
  field: TriageFactField,
  attestation: AttestationAnswers | null,
): UploaderTriageComparison {
  const attestationField = TRIAGE_FACT_ATTESTATION_FIELD[field];
  if (!attestationField) {
    return { kind: "not_applicable" };
  }
  if (!attestation) {
    return { kind: "no_attestation" };
  }
  return { kind: "answered", value: attestation[attestationField] };
}

/**
 * Whether the admin's recorded flag disagrees with the uploader's own
 * answer, for the warning K2 asks for.
 *
 * Fires ONLY when both sides have an actual answer to compare: `adminAnswer`
 * must not be null (an untriaged question has not disagreed with anything —
 * it has not been answered yet) and `comparison.kind` must be `"answered"`
 * (an upload that was never attested, or a fact the attestation never asks
 * about, has nothing to disagree with either). Neither side is defaulted to
 * `false` to make this comparison work; a fact missing either answer simply
 * does not warn.
 */
export function triageDisagreesWithAttestation(
  adminAnswer: boolean | null,
  comparison: UploaderTriageComparison,
): boolean {
  return (
    adminAnswer !== null &&
    comparison.kind === "answered" &&
    comparison.value !== adminAnswer
  );
}
