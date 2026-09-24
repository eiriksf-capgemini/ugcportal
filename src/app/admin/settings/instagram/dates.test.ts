import { describe, expect, it } from "vitest";

import {
  formatClearanceDate,
  toDateInputValue,
} from "@/app/admin/settings/instagram/dates";

/**
 * `validUntil` is a date-only decision stored as midnight UTC. It is shown on
 * the summary card and re-rendered into the edit form directly below it, so
 * the two formatters have to name the same day — on any server, not just one
 * that happens to run in UTC.
 */

// Midnight UTC is the previous *evening* anywhere west of Greenwich, which
// is where a locally-formatted summary silently disagrees with the form.
const MIDNIGHT_UTC = new Date("2027-06-01T00:00:00.000Z");

describe("toDateInputValue", () => {
  it("formats a date the way <input type=date> requires", () => {
    expect(toDateInputValue(MIDNIGHT_UTC)).toBe("2027-06-01");
    expect(toDateInputValue(new Date("2027-06-01T23:30:00.000Z"))).toBe(
      "2027-06-01",
    );
  });

  it("gives an empty string for no date, so the input renders blank", () => {
    expect(toDateInputValue(null)).toBe("");
  });

  it("survives an unparseable date instead of throwing", () => {
    // toISOString would throw on an Invalid Date and take the whole settings
    // page down over one bad row.
    expect(toDateInputValue(new Date("nonsense"))).toBe("");
  });
});

describe("formatClearanceDate", () => {
  it("names the stored day, and says which clock that is", () => {
    expect(formatClearanceDate(MIDNIGHT_UTC)).toBe("1 Jun 2027 (UTC)");
  });

  it("agrees with the form input for the same instant", () => {
    // The actual invariant. If either formatter is changed to use the
    // server's timezone, these stop matching.
    for (const iso of [
      "2027-06-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T00:00:00.000Z",
    ]) {
      const date = new Date(iso);
      const shownDay = Number(formatClearanceDate(date).split(" ")[0]);
      const inputDay = Number(toDateInputValue(date).split("-")[2]);
      expect(shownDay).toBe(inputDay);
    }
  });

  it("does not drift with the viewing timezone, the way a local format would", () => {
    // Demonstrates the bug this replaced: the same instant, formatted in a
    // timezone west of UTC, is the day before.
    const local = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeZone: "America/Los_Angeles",
    });

    expect(local.format(MIDNIGHT_UTC)).toBe("31 May 2027");
    expect(formatClearanceDate(MIDNIGHT_UTC)).toContain("1 Jun 2027");
  });
});
