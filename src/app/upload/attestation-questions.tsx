"use client";

import { useId } from "react";

import {
  ATTESTATION_AUTHORSHIP_QUESTION,
  ATTESTATION_QUESTIONS,
  type AttestationDraft,
  attestationDraftError,
  unansweredAttestationFields,
} from "./attestation-fields";

/**
 * The uploader's own rights attestation (ugcportal-15r): the nine questions,
 * as one block of controls.
 *
 * TWO CALLERS, ONE BLOCK (ugcportal-gkax). The upload form asks them for the
 * next files; the queue row of an upload stored without them asks them for
 * that one file afterwards (`AttestExistingUpload`). Moved out of
 * upload-form.tsx rather than copied, so the second surface cannot come to
 * ask a different set of questions, or ask them as checkboxes. What differs
 * between the two is only what the block SAYS it applies to — the legend,
 * the paragraph under it, the refusal sentence's ending — and the marker
 * attribute tests find it by, so those are props.
 *
 * WHY THE UPLOADER AND NOT AN ADMIN. docs/legal/manual-upload-rights-review.md
 * §3.1: every per-upload rights fact the sellability gate reads today is an
 * admin's assertion about a file the admin did not make. An admin looking at a
 * landscape cannot know whether the person who uploaded it took it. These nine
 * questions are the only place anyone asks the one person who can know.
 *
 * YES/NO RADIOS, NOT CHECKBOXES, and that is this component's single most
 * load-bearing decision. A checkbox has two states and the resting one is
 * "no" — so a question nobody read would be stored as a warranty that, for
 * instance, nobody under 18 is shown. ugcportal-15r K4 is exactly that
 * conflation ("not asked" and "answered no" must stay distinguishable), and
 * this is where it is either preserved or lost: a pair of radios with neither
 * selected has a third state, and `unansweredAttestationFields` reports it.
 * The same reason the wire format spells `yes`/`no` out rather than relying on
 * a part being present (see ATTESTATION_YES in src/lib/attestation.ts).
 *
 * THE QUESTIONS ARE MAPPED, NOT WRITTEN OUT. `ATTESTATION_QUESTIONS` is the
 * single list the server's parser, the gate's completeness check and the legal
 * document test all read too, so a question added to the schema and the parser
 * cannot be missing here — and one rendered here cannot be unstored.
 *
 * EACH QUESTION IS ITS OWN `<fieldset>` with a `<legend>`, nested inside the
 * block's outer one. A `<legend>` is what associates a name with a SET of form
 * controls, and each yes/no pair is such a set; `aria-label` on the inputs
 * would name the options ("yes") without ever naming what is being answered.
 * The two radios in a pair share a `name`, which is what makes them one group
 * for the keyboard.
 *
 * `refused` is a PROP rather than state watched here, exactly like
 * `AltTextFields`' `attemptedFilenames`: "has the visitor tried and failed"
 * belongs to the thing that tried — `addFiles` in the parent — not to a
 * control watching its own value. Marking nine questions red before anyone has
 * done anything would be the alternative.
 */
export function AttestationFields({
  draft,
  refused,
  onAuthorshipChange,
  onAnswerChange,
  legend,
  intro,
  refusalEnding,
  marker,
}: {
  draft: AttestationDraft;
  refused: boolean;
  onAuthorshipChange: (value: string) => void;
  onAnswerChange: (
    field: (typeof ATTESTATION_QUESTIONS)[number]["field"],
    value: boolean,
  ) => void;
  /** What the block is about, e.g. "Your rights in these files". */
  legend: string;
  /** The paragraph under the legend: what the answers apply to. */
  intro: string;
  /** Passed to `attestationDraftError`: what an incomplete draft blocks. */
  refusalEnding?: string;
  /**
   * The `data-*` attribute the block's outer fieldset carries, so a test
   * (and only a test) can tell the upload form's block from a queue row's.
   */
  marker: "data-upload-attestation" | "data-attest-existing-upload";
}) {
  const groupId = useId();
  const errorId = useId();
  // Computed with the SAME functions `addFiles` gated on, so what is marked
  // and what blocked cannot disagree — the rule AltTextFields follows for
  // `altTextFieldError`.
  const unanswered = new Set(unansweredAttestationFields(draft));
  const error = refused ? attestationDraftError(draft, refusalEnding) : null;

  return (
    <fieldset
      className="mt-6"
      {...{ [marker]: "" }}
      aria-describedby={errorId}
    >
      <legend className="text-sm font-medium text-foreground">
        {legend}
        <span aria-hidden="true"> *</span>
        <span className="sr-only"> (every question required)</span>
      </legend>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">{intro}</p>

      <fieldset className="mt-4" data-attestation-question={
        ATTESTATION_AUTHORSHIP_QUESTION.field
      }>
        <legend className="max-w-prose text-sm text-foreground">
          {ATTESTATION_AUTHORSHIP_QUESTION.question}
          {unanswered.has(ATTESTATION_AUTHORSHIP_QUESTION.field) && refused ? (
            <span className="ml-2 text-xs text-destructive">Not answered</span>
          ) : null}
        </legend>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          {ATTESTATION_AUTHORSHIP_QUESTION.why}
        </p>
        <div className="mt-2 flex flex-col gap-1">
          {ATTESTATION_AUTHORSHIP_QUESTION.options.map((option) => (
            <label
              key={option.value}
              className="flex items-center gap-2 text-sm text-foreground"
            >
              <input
                type="radio"
                name={`${groupId}-${ATTESTATION_AUTHORSHIP_QUESTION.field}`}
                value={option.value}
                checked={draft.authorship === option.value}
                onChange={() => onAuthorshipChange(option.value)}
                className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {ATTESTATION_QUESTIONS.map(({ field, question, why }) => (
        <fieldset key={field} className="mt-4" data-attestation-question={field}>
          <legend className="max-w-prose text-sm text-foreground">
            {question}
            {unanswered.has(field) && refused ? (
              <span className="ml-2 text-xs text-destructive">Not answered</span>
            ) : null}
          </legend>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">{why}</p>
          <div className="mt-2 flex gap-5">
            {[
              { label: "Yes", value: true },
              { label: "No", value: false },
            ].map((option) => (
              <label
                key={option.label}
                className="flex items-center gap-2 text-sm text-foreground"
              >
                <input
                  type="radio"
                  name={`${groupId}-${field}`}
                  value={option.label.toLowerCase()}
                  checked={draft.answers[field] === option.value}
                  onChange={() => onAnswerChange(field, option.value)}
                  className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      {/* Rendered unconditionally, empty when there is nothing wrong — the
          same rule the alt-text error and the tag cap message follow, so it
          is announced rather than silently inserted. */}
      <p id={errorId} role="alert" className="mt-3 text-xs text-destructive">
        {error ?? ""}
      </p>
    </fieldset>
  );
}
