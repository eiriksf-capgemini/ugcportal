import { Button } from "@/components/ui/button";
import {
  ACCEPTED_CHECKLIST_VERSIONS,
  CURRENT_CHECKLIST_VERSION,
  RESALE_RIGHTS_ROUTES,
  RESALE_RIGHTS_STATUSES,
} from "@/lib/resale-rights";

import { toDateInputValue } from "./dates";

/**
 * The resale-rights decision form (ugcportal-0ss).
 *
 * A separate module from page.tsx so it can be rendered on its own in a
 * test. That is not tidiness: this form is an *edit* form for a record whose
 * fields are security-relevant, and a field that renders without its current
 * value silently clears that value on the next submit. `validUntil` is the
 * dangerous one — losing it turns a time-limited clearance into a perpetual
 * one, the only way this feature can fail open. See decision-form.test.tsx,
 * which asserts every field round-trips.
 */

export type DecisionFormReview = {
  status: string;
  route: string | null;
  validUntil: Date | null;
  conditions: string | null;
  checklistVersion: string;
  clearedOwnerUserId: string | null;
};

/** A user this clearance could name as the rights holder. */
export type RightsHolderOption = {
  id: string;
  name: string | null;
  email: string | null;
};

export function ResaleRightsDecisionForm({
  instagramAccountId,
  review,
  rightsHolders,
  action,
}: {
  instagramAccountId: string;
  review: DecisionFormReview | null;
  /** Users whose uploads a clearance could cover. */
  rightsHolders: RightsHolderOption[];
  /**
   * The URL of the route handler that records the decision — a string, not
   * a server action. The evidence file needs a body limit that belongs to
   * one endpoint rather than to every server action in the app; see
   * src/app/api/admin/instagram/rights-decision/route.ts.
   */
  action: string;
}) {
  const storedVersion = review?.checklistVersion ?? null;
  const versionRetired = Boolean(
    storedVersion && !ACCEPTED_CHECKLIST_VERSIONS.has(storedVersion),
  );

  /**
   * The recorded rights holder is always an option, even when the caller's
   * list doesn't contain them.
   *
   * The list is capped (the page renders it per account), so a holder
   * outside that slice would otherwise render no matching <option>; the
   * browser submits the first one, which is blank, and the handler
   * faithfully reads that as "clear it". Editing an unrelated field would
   * then erase whose rights were cleared and make the account unsellable.
   *
   * Handled here rather than only in the page because it is a property of
   * the *control* — a select whose stored value is missing from its options
   * is lossy no matter who assembled the list.
   */
  const recordedHolder = review?.clearedOwnerUserId ?? null;
  const holderOptions =
    recordedHolder && !rightsHolders.some((one) => one.id === recordedHolder)
      ? [
          { id: recordedHolder, name: null, email: null },
          ...rightsHolders,
        ]
      : rightsHolders;

  return (
    // encType is required: without it the browser posts
    // application/x-www-form-urlencoded and the evidence file arrives as a
    // bare filename string.
    <form
      action={action}
      method="post"
      encType="multipart/form-data"
      className="mt-3 space-y-3"
    >
      <input type="hidden" name="instagramAccountId" value={instagramAccountId} />
      <p className="text-xs text-muted-foreground">
        The decision is recorded against you by name. The current checklist is
        version {CURRENT_CHECKLIST_VERSION} (
        docs/legal/instagram-resale-rights-checklist.md).
      </p>
      {storedVersion ? (
        <p
          className={
            versionRetired
              ? "text-xs font-medium text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          This account was last reviewed against version {storedVersion}
          {versionRetired
            ? " — a retired version, so nothing from it is sellable until it is reviewed again."
            : "."}
        </p>
      ) : null}
      <label className="block text-xs font-medium">
        Status
        <select
          name="status"
          defaultValue={review?.status ?? "UNREVIEWED"}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
        >
          {RESALE_RIGHTS_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium">
        Route (how the rights were obtained)
        <select
          name="route"
          defaultValue={review?.route ?? ""}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
        >
          <option value="">not recorded</option>
          {RESALE_RIGHTS_ROUTES.map((route) => (
            <option key={route} value={route}>
              {route}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium">
        Rights holder — whose uploads this clearance covers
        <select
          name="clearedOwnerUserId"
          defaultValue={review?.clearedOwnerUserId ?? ""}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
        >
          <option value="">not recorded</option>
          {holderOptions.map((holder) => (
            <option key={holder.id} value={holder.id}>
              {holder.name ?? holder.email ?? holder.id}
            </option>
          ))}
        </select>
        <span className="mt-1 block font-normal text-muted-foreground">
          Only this user&apos;s own uploads can be sold under the clearance.
          A CLEARED decision with nobody named here sells nothing.
        </span>
      </label>
      <label className="block text-xs font-medium">
        Valid until (optional — the clearance stops counting at the start of
        this day, UTC)
        {/*
          defaultValue is not cosmetic. Submitting this form writes every
          field, so rendering the date empty while a clearance has one would
          clear the expiry on any unrelated edit — quietly converting a
          time-limited clearance into a perpetual one.
        */}
        <input
          type="date"
          name="validUntil"
          defaultValue={toDateInputValue(review?.validUntil ?? null)}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
        />
      </label>
      <label className="block text-xs font-medium">
        Conditions from Part D (optional)
        <textarea
          name="conditions"
          rows={2}
          defaultValue={review?.conditions ?? ""}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
        />
      </label>
      <label className="block text-xs font-medium">
        {/*
          Deliberately never pre-filled with the previous reason: a decision
          is being made now, and inheriting last time's justification would
          put words in the reviewer's mouth in an audit record.
        */}
        Reason (required, recorded in the audit trail)
        <textarea
          name="reason"
          rows={2}
          required
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
        />
      </label>
      <label className="block text-xs font-medium">
        Evidence file (optional — stored privately, never with sellable media)
        <input type="file" name="evidence" className="mt-1 block w-full text-sm" />
      </label>
      {review ? (
        // Unchecked by default, and deliberately not a field that
        // round-trips: the stored version is preserved by *not* writing it.
        // Ticking this is an assertion about work the reviewer has just
        // done, so it starts false on every render — an assertion that
        // persisted from last time would be the same silent re-validation
        // this control exists to prevent.
        <label className="flex items-start gap-2 text-xs font-medium">
          <input
            type="checkbox"
            name="restampChecklist"
            value="yes"
            className="mt-0.5"
          />
          <span>
            I have just worked this account through checklist version{" "}
            {CURRENT_CHECKLIST_VERSION}. Leave unticked to keep the recorded
            version ({storedVersion}) — an edit to the fields above does not
            count as a re-review.
          </span>
        </label>
      ) : null}
      <Button type="submit" size="sm">
        Record decision
      </Button>
    </form>
  );
}
