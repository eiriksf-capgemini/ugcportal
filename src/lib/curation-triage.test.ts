import { describe, expect, it } from "vitest";

import {
  TRIAGE_ANSWER_NO,
  TRIAGE_ANSWER_SELECT,
  TRIAGE_ANSWER_UNANSWERED,
  TRIAGE_ANSWER_YES,
  parseTriageAnswers,
  triageAnswerValue,
} from "@/lib/curation-triage";
import { TRIAGE_FACTS } from "@/lib/resale-rights";

/**
 * The parsing half of the curation triage write path (ugcportal-vq3z), with
 * no database in it: what a submitted form turns into, and what it refuses.
 *
 * Everything here is driven off TRIAGE_FACTS rather than a hand-listed set of
 * column names, which is the point — the registry is the mechanism, and a
 * test that listed the seven facts by hand would keep passing after one was
 * added and left unasked.
 */

const FIELDS = TRIAGE_FACTS.map((fact) => fact.field);

/** A form answering every registered fact `no`. */
function completeForm(
  overrides: Record<string, string> = {},
  omit: readonly string[] = [],
): FormData {
  const data = new FormData();
  for (const field of FIELDS) {
    if (omit.includes(field)) continue;
    data.set(field, TRIAGE_ANSWER_NO);
  }
  for (const [key, value] of Object.entries(overrides)) {
    data.set(key, value);
  }
  return data;
}

describe("TRIAGE_ANSWER_SELECT", () => {
  /*
    The select and the registry have to name the same columns. A key missing
    here is the silent round-trip bug the constant's own docstring describes:
    the form would render that question as "Not answered" and the admin's
    next submit would write null over a stored answer. A key too many is a
    column the gate does not read being presented as if it mattered.
  */
  it("selects exactly the registered triage facts, no more and no fewer", () => {
    expect(Object.keys(TRIAGE_ANSWER_SELECT).sort()).toEqual([...FIELDS].sort());
  });

  it("selects every one of them, rather than switching any off", () => {
    expect(Object.values(TRIAGE_ANSWER_SELECT)).toEqual(FIELDS.map(() => true));
  });
});

describe("parseTriageAnswers", () => {
  it("reads one answer per registered fact", () => {
    const parsed = parseTriageAnswers(completeForm());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Keys, not just values: a parser that returned a subset would satisfy a
    // per-field value assertion for the fields it did return.
    expect(Object.keys(parsed.answers).sort()).toEqual([...FIELDS].sort());
    expect(Object.values(parsed.answers)).toEqual(FIELDS.map(() => false));
  });

  it("distinguishes yes from no on every field independently", () => {
    // One field at a time, so a parser that wrote the same answer to every
    // column — or read the wrong form field — fails rather than passing on a
    // uniform fixture.
    for (const field of FIELDS) {
      const parsed = parseTriageAnswers(
        completeForm({ [field]: TRIAGE_ANSWER_YES }),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      for (const other of FIELDS) {
        expect(parsed.answers[other]).toBe(other === field);
      }
    }
  });

  it("refuses a form that leaves one question blank, naming it", () => {
    for (const field of FIELDS) {
      const parsed = parseTriageAnswers(
        completeForm({ [field]: TRIAGE_ANSWER_UNANSWERED }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.unanswered).toEqual([field]);
    }
  });

  it("refuses a form that omits a question entirely", () => {
    // Not the same input as a blank answer: a tampered or stale form can drop
    // the field rather than submit it empty, and a parser iterating the
    // form's own keys would skip it instead of refusing.
    const parsed = parseTriageAnswers(completeForm({}, [FIELDS[0]]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.unanswered).toEqual([FIELDS[0]]);
  });

  it("refuses an answer that is neither of the two tokens", () => {
    for (const tampered of ["maybe", "true", "1", "YES", " yes"]) {
      const parsed = parseTriageAnswers(
        completeForm({ [FIELDS[0]]: tampered }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.unanswered).toEqual([FIELDS[0]]);
    }
  });

  it("reports every unanswered question, not just the first", () => {
    const parsed = parseTriageAnswers(new FormData());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect([...parsed.unanswered].sort()).toEqual([...FIELDS].sort());
  });

  it("ignores form fields the registry does not name", () => {
    // The columns this screen must not be able to set, submitted anyway.
    // Nothing outside TRIAGE_FACTS may reach the answers object, which is
    // what stops a crafted form from writing a price or an evidence pointer.
    const data = completeForm();
    data.set("priceCents", "1");
    data.set("modelReleaseKey", "releases/forged.pdf");
    data.set("triagedByUserId", "someone-else");
    const parsed = parseTriageAnswers(data);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.answers).sort()).toEqual([...FIELDS].sort());
  });
});

describe("triageAnswerValue", () => {
  it("maps the two booleans to the two answer tokens", () => {
    expect(triageAnswerValue(true)).toBe(TRIAGE_ANSWER_YES);
    expect(triageAnswerValue(false)).toBe(TRIAGE_ANSWER_NO);
  });

  it("maps every not-a-boolean to unanswered", () => {
    expect(triageAnswerValue(null)).toBe(TRIAGE_ANSWER_UNANSWERED);
    expect(triageAnswerValue(undefined)).toBe(TRIAGE_ANSWER_UNANSWERED);
  });

  it("round-trips through parseTriageAnswers", () => {
    // The two halves have to agree: whatever the form renders as the stored
    // value must parse back to that same value, or an admin re-submitting an
    // untouched form changes the record.
    const data = new FormData();
    for (const field of FIELDS) {
      data.set(field, triageAnswerValue(true));
    }
    const parsed = parseTriageAnswers(data);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.values(parsed.answers)).toEqual(FIELDS.map(() => true));
  });
});
