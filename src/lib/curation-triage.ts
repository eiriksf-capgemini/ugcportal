import { TRIAGE_FACTS, type TriageFactField } from "@/lib/resale-rights";

/**
 * The vocabulary the curation triage form and the server action that records
 * it share (ugcportal-vq3z).
 *
 * PURE ON PURPOSE — no `@/lib/prisma` import. The write itself lives in
 * src/lib/curation-triage-write.ts, which is the single chokepoint every
 * triage write goes through; this module holds only values and types — the
 * two answer tokens, the Prisma `select` and row type for the stored
 * answers, the parser, and the stored-answer-to-form-value mapping — so the
 * form component can be imported and rendered in a test without standing up
 * a database.
 *
 * The field name a question is submitted under IS the MediaListing column it
 * is stored in, read off TRIAGE_FACTS. That is not shorthand: a separate
 * form-name-to-column map is a second list to keep in step with the registry,
 * and the registry is the mechanism (see "THE TRIAGE-FACT MECHANISM" in
 * src/lib/resale-rights.ts). A fact added there is asked, parsed and written
 * with nothing to remember here.
 */

/**
 * The two answers that record a fact, and the one that does not.
 *
 * `""` — the empty string — is how a `<select>` submits its "Not answered"
 * option, and it is the DEFAULT for an untriaged question rather than a `no`.
 * "Not asked" and "asked, answer no" are different states and only one of
 * them sells (ugcportal-qn3); a form that defaulted to `no` would turn the
 * act of opening it into an assertion that there is no identifiable person in
 * the photograph.
 */
export const TRIAGE_ANSWER_YES = "yes";
export const TRIAGE_ANSWER_NO = "no";
export const TRIAGE_ANSWER_UNANSWERED = "";

/**
 * Prisma `select` for the stored triage answers, and the type a reader of
 * them has.
 *
 * Written out rather than spread from the registry for the reason
 * MEDIA_GATE_SELECT gives one module over: Prisma infers the row type from
 * the literal, so a computed object would lose it. It is not left to memory
 * either — `StoredTriageAnswers` below requires EVERY registered field, so a
 * key missing here fails `tsc` at the call site that hands the result to the
 * form, and "selects exactly the registered triage facts" in
 * curation-triage.test.ts asserts these keys are TRIAGE_FACTS' fields
 * exactly, no more and no fewer.
 *
 * The omission this closes is specific and silent: a fact left out of the
 * select reads as `undefined` on the row, the form renders it as "Not
 * answered", and the admin's next submit writes `null` over a stored answer
 * nobody meant to clear.
 */
export const TRIAGE_ANSWER_SELECT = {
  depictsPeople: true,
  depictsMinors: true,
  containsMusic: true,
  thirdPartyCreator: true,
  sponsoredContent: true,
  depictsAlcohol: true,
  wineAccessory: true,
} as const;

/**
 * The stored answers for one upload: one nullable boolean per registered
 * fact, where `null` means nobody has answered it.
 *
 * A FULL record, not a partial, and that is what makes TRIAGE_ANSWER_SELECT
 * above self-checking.
 */
export type StoredTriageAnswers = Readonly<
  Record<TriageFactField, boolean | null>
>;

/**
 * One answer per registered triage fact. A FULL record, not a partial: the
 * write refuses a half-filled triage rather than stamping an admin's name and
 * the current time onto a record where some questions are still blank, which
 * would make the signature say something the admin did not do. The gate would
 * block such a row anyway (`triage_incomplete`), so this is the honesty of the
 * audit trail rather than a second safety net.
 */
export type TriageAnswers = Readonly<Record<TriageFactField, boolean>>;

export type TriageAnswerParse =
  | { ok: true; answers: TriageAnswers }
  | { ok: false; unanswered: readonly TriageFactField[] };

/**
 * Read one answer per registered fact out of a submitted form.
 *
 * Iterates TRIAGE_FACTS rather than the form's own keys, which is the
 * fail-closed direction twice over: a question the registry asks and the form
 * omitted is reported as unanswered rather than skipped, and a key the form
 * carries that the registry does not know about is never looked at, so
 * nothing outside the registry can reach the write. Only the two exact answer
 * tokens count — anything else, including a tampered value, reads as
 * unanswered, which refuses.
 */
export function parseTriageAnswers(formData: FormData): TriageAnswerParse {
  const answers: Partial<Record<TriageFactField, boolean>> = {};
  const unanswered: TriageFactField[] = [];

  for (const fact of TRIAGE_FACTS) {
    const raw = formData.get(fact.field);
    if (raw === TRIAGE_ANSWER_YES) {
      answers[fact.field] = true;
    } else if (raw === TRIAGE_ANSWER_NO) {
      answers[fact.field] = false;
    } else {
      unanswered.push(fact.field);
    }
  }

  if (unanswered.length > 0) {
    return { ok: false, unanswered };
  }
  /*
    The one assertion in this module, and it is sound in the direction that
    matters. `answers` has a key for every entry in TRIAGE_FACTS, because the
    loop above either set one or pushed onto `unanswered` and returned. What
    `tsc` cannot see is whether TRIAGE_FACTS covers every TriageFactField —
    that is a runtime fact about the registry, pinned by "registers exactly
    one fact per RightsLayer, no more and no fewer" in resale-rights.test.ts.
    If it ever did not, the missing column would simply not be written and
    would stay null, which BLOCKS; and recordTriageFacts re-checks
    completeness against the registry before it writes anything, so an
    incomplete object cannot reach Prisma even if a future caller builds one
    by hand.
  */
  return { ok: true, answers: answers as TriageAnswers };
}

/**
 * The `<select>` value for a stored answer: the two tokens for a real
 * boolean, "Not answered" for `null` and for anything else.
 *
 * `=== true` / `=== false` rather than a truthiness test, matching
 * `isTriaged` in src/lib/resale-rights.ts: `null` and `undefined` are
 * different values and a column typed `Boolean?` read through a hand-written
 * query can hold neither, so everything that is not one of the two booleans
 * lands on the "nobody has answered this" side.
 */
export function triageAnswerValue(stored: boolean | null | undefined): string {
  if (stored === true) return TRIAGE_ANSWER_YES;
  if (stored === false) return TRIAGE_ANSWER_NO;
  return TRIAGE_ANSWER_UNANSWERED;
}
