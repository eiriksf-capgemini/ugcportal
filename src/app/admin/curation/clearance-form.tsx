import { ClearanceBasis, type RightsLayer } from "@/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { BASIS_LAYER } from "@/lib/resale-rights";

/**
 * The per-layer clearance form (ugcportal-qfy9).
 *
 * ONE FORM PER LAYER, and that is the bead rather than a layout choice. A
 * single form with a multi-select, or a "clear everything still blocking"
 * button, would let one act of judgement settle several unrelated questions
 * at once — a purchased music licence standing in for an answer about an
 * identifiable person. Each form carries its own hidden `layer` and its own
 * reason box, so the justification the admin types is attached to the layer
 * they were looking at and to no other.
 *
 * A separate module from page.tsx so it can be rendered on its own in a
 * test, the same reason the triage form gives — and here the thing worth
 * asserting in isolation is exactly the hidden field: a form that submitted
 * the wrong `layer`, or that shared one field across several rendered
 * forms, would record a clearance against a layer nobody cleared.
 *
 * NOT AN EDIT FORM, unlike the triage form next door. There is no stored
 * reason to round-trip: the write refuses a second row for a layer that
 * already has one, and a box pre-filled with the existing reason would
 * invite an overwrite that cannot happen.
 *
 * THE MUSIC FORM ALSO ASKS FOR A BASIS (ugcportal-hx2), and offers only the
 * two the write accepts: a licence (with a pointer to its evidence) or the
 * uploader's own original score. "Deliver it muted" is not an option, and
 * the help text says why — the file a buyer receives is the raw original, so
 * muting is a promise nothing in this product keeps. The write refuses it by
 * name anyway (`clearance_basis_muted_delivery`), because this action is
 * reachable by POSTing its id with no form at all.
 *
 * The evidence box is rendered beside the select rather than revealed when
 * LICENCE is picked: this is a server component with no client script, and a
 * box hidden by CSS could keep a value the admin can no longer see, which the
 * write would then refuse for an original score with no visible cause. Its
 * label says it is for a licence only.
 */

/**
 * The bases the MUSIC form offers, in order. MUTED_DELIVERY is a member of
 * the enum and is deliberately absent: it exists so the gate can be tested
 * against a row carrying it, not so an admin can choose it.
 */
const OFFERED_BASES: readonly { value: ClearanceBasis; label: string }[] = [
  { value: ClearanceBasis.LICENCE, label: "Licence for the track" },
  {
    value: ClearanceBasis.ORIGINAL_SCORE,
    label: "Uploader’s own original score",
  },
];

const TEXTAREA_CLASS =
  "mt-1 block w-full rounded-md border border-input bg-surface-3 p-2 text-sm text-ink";

export function CurationClearanceForm({
  mediaId,
  layer,
  question,
  action,
}: {
  /**
   * The upload being cleared. Identity from the page, not a choice the form
   * offers — the same reason the triage form takes `mediaId`.
   */
  mediaId: string;
  /** The ONE layer this form settles. */
  layer: RightsLayer;
  /** The registry's own wording of the question this layer answers. */
  question: string;
  /**
   * The server action that records the clearance. Passed in rather than
   * imported here so this module can be rendered in a test without a
   * running action runtime, and so the test can observe exactly what the
   * form submits.
   */
  action: (formData: FormData) => void | Promise<void>;
}) {
  const reasonId = `clearance-reason-${layer}`;
  const basisId = `clearance-basis-${layer}`;
  const evidenceId = `clearance-basis-evidence-${layer}`;
  return (
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="mediaId" value={mediaId} />
      <input type="hidden" name="layer" value={layer} />
      <label className="block text-xs font-medium" htmlFor={reasonId}>
        Why is {layer} settled for this upload?
        {/*
          text-muted-foreground, not text-ink-muted (ugcportal-6uc2, phase
          2): this form renders inside page.tsx's "Rights layers" bg-muted
          well, which now reads the paper scale, not the near-black one this
          label used to assume.
        */}
        <span className="mt-1 block font-normal text-muted-foreground">
          {question} This justification covers {layer} and nothing else — every
          other layer still blocks until it has its own.
        </span>
      </label>
      <textarea
        id={reasonId}
        name="reason"
        rows={2}
        /*
          `required` is a convenience, not the rule. The write refuses a
          blank or whitespace-only reason itself
          (`clearance_reason_blank`), because a browser attribute is not
          enforcement: this action is reachable by POSTing its id with no
          form at all.
        */
        required
        className={TEXTAREA_CLASS}
      />
      {layer === BASIS_LAYER ? (
        <>
          {/*
            The help sentence below is kept on ONE source line on purpose:
            `grep -n -i muted` on this file is how ugcportal-hx2 K3 is
            checked, and it should return the whole sentence.
          */}
          <label className="block text-xs font-medium" htmlFor={basisId}>
            What does the music clearance rest on?
            <span className="mt-1 block font-normal text-muted-foreground">
              Delivering the video muted is not a clearance basis: the file a buyer receives is the raw original with its sound intact, so a licence or the uploader’s own score is the only way music is cleared.
            </span>
          </label>
          {/*
            `required` is a convenience here too: the write refuses a
            missing basis itself (`clearance_basis_missing`). The empty
            first option is what makes "nothing chosen" a state the browser
            can see, rather than the first basis being submitted by default
            for an admin who never looked at the box.
          */}
          <select
            id={basisId}
            name="basis"
            required
            defaultValue=""
            className={TEXTAREA_CLASS}
          >
            <option value="" disabled>
              Choose a basis
            </option>
            {OFFERED_BASES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label className="block text-xs font-medium" htmlFor={evidenceId}>
            Licence evidence
            <span className="mt-1 block font-normal text-muted-foreground">
              For a licence only: where the licence is — a file key or a
              document reference. Leave it empty for an original score.
            </span>
          </label>
          <input
            id={evidenceId}
            name="basisEvidence"
            type="text"
            className={TEXTAREA_CLASS}
          />
        </>
      ) : null}
      <Button type="submit" size="sm">
        Clear {layer}
      </Button>
    </form>
  );
}
