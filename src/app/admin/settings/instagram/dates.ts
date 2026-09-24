/**
 * The two ways a resale-rights `validUntil` reaches a screen: formatted for
 * reading, and formatted into the edit form's date input.
 *
 * They live together because they have to agree. `validUntil` is a date-only
 * decision stored as midnight UTC, and the gate compares it as an instant —
 * so rendering the summary in the server's timezone while the form renders
 * it in UTC shows an admin two different expiry dates for the same clearance,
 * a day apart on any server west of UTC. Neither one would be "wrong" on its
 * own; the disagreement is the bug.
 *
 * UTC everywhere is the answer rather than local-everywhere, because the
 * stored value is UTC midnight by construction (`new Date("YYYY-MM-DD")` in
 * the server action) and localising it invents a precision the decision never
 * had.
 */

const UTC_DATE = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/** For display. Reads as a date, and says which clock it is on. */
export function formatClearanceDate(date: Date): string {
  return `${UTC_DATE.format(date)} (UTC)`;
}

/**
 * For `<input type="date">`, which accepts only `YYYY-MM-DD`.
 *
 * Empty string for absent — and for an unparseable Date, which would
 * otherwise throw out of `toISOString` and take down the whole settings page
 * over one bad row.
 */
export function toDateInputValue(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}
