import { Button } from "@/components/ui/button";
import {
  CURRENT_CHECKLIST_VERSION,
  RESALE_RIGHTS_ROUTES,
  RESALE_RIGHTS_STATUSES,
} from "@/lib/resale-rights";

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
};

/**
 * Format a Date for `<input type="date">`, which accepts only `YYYY-MM-DD`.
 *
 * UTC, matching how the action parses it back (`new Date("YYYY-MM-DD")` is
 * midnight UTC), so a value written by the server and read back by the
 * browser is the same instant rather than one shifted by the viewer's
 * timezone.
 */
export function toDateInputValue(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

export function ResaleRightsDecisionForm({
  instagramAccountId,
  review,
  action,
}: {
  instagramAccountId: string;
  review: DecisionFormReview | null;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="instagramAccountId" value={instagramAccountId} />
      <p className="text-xs text-muted-foreground">
        Worked through checklist version {CURRENT_CHECKLIST_VERSION} (
        docs/legal/instagram-resale-rights-checklist.md). The decision is
        recorded against you by name.
      </p>
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
      <Button type="submit" size="sm">
        Record decision
      </Button>
    </form>
  );
}
