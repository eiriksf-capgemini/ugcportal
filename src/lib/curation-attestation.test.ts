import { describe, expect, it } from "vitest";

import type { AttestationAnswers } from "@/lib/attestation";
import {
  TRIAGE_FACT_ATTESTATION_FIELD,
  compareTriageFactToAttestation,
  triageDisagreesWithAttestation,
} from "@/lib/curation-attestation";
import { TRIAGE_FACTS } from "@/lib/resale-rights";
import { completeAttestationAnswers } from "@/lib/test-support/attestation";

/**
 * The pure comparison ugcportal-vlnn K1/K2/K3 render against, isolated from
 * any markup so a rendering regression and a logic regression fail in
 * different files and say different things.
 */

const MAPPED_FIELDS = TRIAGE_FACTS.filter(
  (fact) => TRIAGE_FACT_ATTESTATION_FIELD[fact.field] !== undefined,
).map((fact) => fact.field);

const UNMAPPED_FIELDS = TRIAGE_FACTS.filter(
  (fact) => TRIAGE_FACT_ATTESTATION_FIELD[fact.field] === undefined,
).map((fact) => fact.field);

describe("TRIAGE_FACT_ATTESTATION_FIELD", () => {
  it("maps at least one triage fact to an attestation question", () => {
    expect(MAPPED_FIELDS.length).toBeGreaterThan(0);
  });

  it("leaves the alcohol-judgment facts unmapped, by name", () => {
    // Pinned by name rather than just "some facts are unmapped": these two
    // are unmapped for a reason (TRIAGE_FACTS' own comment on them), not by
    // omission, and a future registry change silently mapping one of them
    // should fail this test rather than pass it.
    expect(UNMAPPED_FIELDS).toEqual(
      expect.arrayContaining(["depictsAlcohol", "wineAccessory"]),
    );
  });
});

describe("compareTriageFactToAttestation", () => {
  it("reports not_applicable for a fact the attestation never asks about, regardless of the attestation", () => {
    const attestation = completeAttestationAnswers();
    for (const field of UNMAPPED_FIELDS) {
      expect(compareTriageFactToAttestation(field, attestation)).toEqual({
        kind: "not_applicable",
      });
      expect(compareTriageFactToAttestation(field, null)).toEqual({
        kind: "not_applicable",
      });
    }
  });

  it("reports no_attestation for a mapped fact when there is no attestation row", () => {
    for (const field of MAPPED_FIELDS) {
      expect(compareTriageFactToAttestation(field, null)).toEqual({
        kind: "no_attestation",
      });
    }
  });

  it("reports the uploader's actual answer for a mapped fact, true and false both", () => {
    for (const field of MAPPED_FIELDS) {
      const attestationField = TRIAGE_FACT_ATTESTATION_FIELD[field]!;
      const yes = completeAttestationAnswers({
        [attestationField]: true,
      } as Partial<AttestationAnswers>);
      const no = completeAttestationAnswers({
        [attestationField]: false,
      } as Partial<AttestationAnswers>);
      expect(compareTriageFactToAttestation(field, yes)).toEqual({
        kind: "answered",
        value: true,
      });
      expect(compareTriageFactToAttestation(field, no)).toEqual({
        kind: "answered",
        value: false,
      });
    }
  });
});

describe("triageDisagreesWithAttestation", () => {
  it("never disagrees when the admin hasn't answered yet", () => {
    expect(
      triageDisagreesWithAttestation(null, { kind: "answered", value: true }),
    ).toBe(false);
    expect(
      triageDisagreesWithAttestation(null, { kind: "answered", value: false }),
    ).toBe(false);
  });

  it("never disagrees when there is nothing to compare against", () => {
    expect(
      triageDisagreesWithAttestation(true, { kind: "no_attestation" }),
    ).toBe(false);
    expect(
      triageDisagreesWithAttestation(false, { kind: "no_attestation" }),
    ).toBe(false);
    expect(
      triageDisagreesWithAttestation(true, { kind: "not_applicable" }),
    ).toBe(false);
  });

  it("disagrees only when both sides have an answer and they differ", () => {
    expect(
      triageDisagreesWithAttestation(true, { kind: "answered", value: false }),
    ).toBe(true);
    expect(
      triageDisagreesWithAttestation(false, { kind: "answered", value: true }),
    ).toBe(true);
    expect(
      triageDisagreesWithAttestation(true, { kind: "answered", value: true }),
    ).toBe(false);
    expect(
      triageDisagreesWithAttestation(false, {
        kind: "answered",
        value: false,
      }),
    ).toBe(false);
  });
});
