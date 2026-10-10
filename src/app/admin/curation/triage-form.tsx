import { Button } from "@/components/ui/button";
import { INLINE_LINK_CLASS } from "@/components/ui/inline-link";
import type { AttestationAnswers } from "@/lib/attestation";
import { compareTriageFactToAttestation } from "@/lib/curation-attestation";
import {
  type StoredTriageAnswers,
  TRIAGE_ANSWER_NO,
  TRIAGE_ANSWER_UNANSWERED,
  TRIAGE_ANSWER_YES,
  triageAnswerValue,
} from "@/lib/curation-triage";
import { TRIAGE_FACTS } from "@/lib/resale-rights";
import { RIGHTS_SETTINGS_PATH } from "@/lib/routes";

/**
 * The per-upload triage form (ugcportal-vq3z).
 *
 * A separate module from page.tsx so it can be rendered on its own in a test,
 * for exactly the reason the resale-rights decision form states: this is an
 * EDIT form over security-relevant fields, and a field that renders without
 * its current value silently clears that value on the next submit. Here the
 * dangerous direction is a stored `true` rendering as "Not answered" — the
 * admin re-submits, the column goes back to null, and an upload that was
 * blocked for depicting a minor becomes blocked for a different reason that
 * someone could "fix" by answering `no`. triage-form.test.tsx asserts every
 * registered fact round-trips both booleans.
 *
 * The questions are rendered straight off TRIAGE_FACTS — the registry the
 * gate itself iterates — so the questions an admin is asked and the questions
 * that actually block cannot drift apart, and a rights layer added later is
 * asked here without anyone remembering. Same choice, and same reason, as the
 * read-only list on the resale-rights screen.
 */

/**
 * The stored answers this form round-trips: `StoredTriageAnswers` for an
 * upload that has a MediaListing row, `null` for one that does not.
 *
 * The FULL record, not a partial, and that is load-bearing rather than
 * precise-for-its-own-sake: it is what forces the page's Prisma select to
 * carry every registered column, so the round-trip bug described above
 * cannot arrive by way of a forgotten `select` key. See
 * TRIAGE_ANSWER_SELECT in src/lib/curation-triage.ts.
 */
export type TriageFormAnswers = StoredTriageAnswers;

const SELECT_CLASS =
  "mt-1 block w-full rounded-md border border-input bg-surface-3 p-2 text-sm text-ink";

export function CurationTriageForm({
  mediaId,
  answers,
  attestation = null,
  action,
}: {
  /**
   * The upload being triaged. Identity from the page, not a choice the form
   * offers — the same reason the decision form takes `uploaderUserId` rather
   * than rendering a picker.
   */
  mediaId: string;
  answers: TriageFormAnswers | null;
  /**
   * The uploader's own rights declaration (ugcportal-15r), or `null` when
   * nobody has attested to anything for this upload — ugcportal-vlnn K1/K3.
   * Optional, defaulting to `null`, so a caller that predates this bead
   * still compiles rather than being forced to thread a value it does not
   * have.
   */
  attestation?: AttestationAnswers | null;
  /**
   * The server action that records the triage. Passed in rather than imported
   * here so this module can be rendered in a test without a running action
   * runtime, and so the test can observe exactly what the form submits.
   */
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="mediaId" value={mediaId} />
      <p className="text-xs text-muted-foreground">
        The triage is recorded against you by name, with the time you recorded
        it. Every question has to be answered: leaving one blank is not a
        &ldquo;no&rdquo;, and an unanswered question blocks the sale. What each
        answer then requires — a clearance, a release file, or nothing at all
        because the answer is final — is listed on the{" "}
        <a className={INLINE_LINK_CLASS} href={RIGHTS_SETTINGS_PATH}>
          resale rights
        </a>{" "}
        screen, which reads the same registry this form does. Where the
        uploader&rsquo;s own attestation answers the same question, it is
        shown underneath — it is a starting point for this field, not a
        substitute for your own judgment of the file.
      </p>
      {TRIAGE_FACTS.map((fact) => {
        const stored = answers?.[fact.field] ?? null;
        const comparison = compareTriageFactToAttestation(
          fact.field,
          attestation,
        );
        /*
          The admin flag DEFAULTS to the uploader's answer (ugcportal-vlnn
          K1), but only when nothing has been recorded yet: `stored` wins
          whenever it is not null, so re-opening an already-triaged question
          always shows what was actually recorded, never a reconstruction of
          it — the exact failure this form's own docstring warns about. `??`
          is safe here specifically because `stored` is `boolean | null`,
          never `false | undefined`: a stored `false` short-circuits the `??`
          and is kept, it is never read as "nothing recorded" and replaced by
          the uploader's answer.
        */
        const defaultAnswer =
          stored ?? (comparison.kind === "answered" ? comparison.value : null);
        return (
          <label key={fact.field} className="block text-xs font-medium">
            {fact.question}
            {/*
              text-muted-foreground, not text-ink-muted (ugcportal-7g2o): this
              form's only render site (src/app/admin/curation/page.tsx) wraps
              it in `<div className="rounded-lg border border-border p-3
              text-sm">` with no bg-* class of its own, so it renders on the
              plain page canvas (--background) — --color-ink-muted measures
              1.9003:1 there (src/lib/design/ink-muted-usage.test.ts), below
              body text's 4.5:1. --muted-foreground is the token tuned for
              exactly this surface (contrast.ts's
              muted-foreground-on-background pairing).
            */}
            {comparison.kind === "answered" ? (
              <span className="block font-normal text-muted-foreground">
                Uploader attested: {comparison.value ? "Yes" : "No"}
              </span>
            ) : comparison.kind === "no_attestation" ? (
              <span className="block font-normal text-muted-foreground">
                No attestation on file for this upload.
              </span>
            ) : null}
            <select
              name={fact.field}
              /*
                The stored answer, or the uploader's own as a starting point,
                or "Not answered" when there is neither. NOT a `no` default:
                "not asked" and "asked, answer no" are different states and
                only one of them sells (ugcportal-qn3), so a form that opened
                on `no` would turn the act of looking at an upload into an
                assertion that there is nobody identifiable in it.
              */
              defaultValue={triageAnswerValue(defaultAnswer)}
              className={SELECT_CLASS}
            >
              <option value={TRIAGE_ANSWER_UNANSWERED}>Not answered</option>
              <option value={TRIAGE_ANSWER_YES}>Yes</option>
              <option value={TRIAGE_ANSWER_NO}>No</option>
            </select>
          </label>
        );
      })}
      <Button type="submit" size="sm">
        Record triage
      </Button>
    </form>
  );
}
