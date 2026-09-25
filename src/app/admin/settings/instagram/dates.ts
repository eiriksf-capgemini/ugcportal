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

const UTC_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

// The smallest step back from the expiry instant. The gate refuses at
// `validUntil <= now`, so one millisecond earlier is the last moment a sale
// is allowed, and the day containing it is the last sellable day.
const ONE_MILLISECOND = 1;

/**
 * How a clearance's expiry is described on screen.
 *
 * "Valid until 31 Dec" was ambiguous in the direction that favours the
 * admin: the gate refuses at `validUntil <= now`, so a clearance stamped
 * 31 Dec stops working at midnight *entering* the 31st, and the last day
 * anything can be sold is the 30th. An admin reading "valid until 31 Dec"
 * reasonably believes they have that day. Both facts are stated rather than
 * leaving the reader to work out which reading applies.
 */
export function formatClearanceExpiry(date: Date): string {
  const lastSellableDay = new Date(date.getTime() - ONE_MILLISECOND);
  return `${UTC_DATE_TIME.format(date)} UTC — last sellable day ${UTC_DATE.format(lastSellableDay)}`;
}

/**
 * An instant, in UTC and labelled as such.
 *
 * UTC rather than the server's zone for the same reason as everything else
 * here: it sits next to values that are UTC by construction, and an
 * unlabelled local timestamp beside a labelled UTC one is the drift this
 * module exists to prevent.
 */
export function formatReviewTimestamp(date: Date): string {
  return `${UTC_DATE_TIME.format(date)} UTC`;
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
