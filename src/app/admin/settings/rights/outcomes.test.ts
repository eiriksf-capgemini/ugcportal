import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCKER_MESSAGES,
  outcomeMessage,
} from "@/app/admin/settings/rights/outcomes";
import { TRIAGE_FACTS } from "@/lib/resale-rights";

/**
 * The decision handler's own source, read so the test below can name the
 * codes it actually redirects with (ugcportal-aqw).
 *
 * READ RATHER THAN RETYPED, because the hand-written list this replaced was
 * already wrong. `rights_invalid_covers_uploads_before` was added to the
 * handler and to `OUTCOME_MESSAGES` without being added here, and the test's
 * own name — "every code the decision handler can redirect with" — went on
 * claiming a completeness it no longer had. A list that has to be edited in
 * step with another file is the sibling-omission family; derived, it cannot
 * drift.
 */
const DECISION_ROUTE_SOURCE = readFileSync(
  resolve(process.cwd(), "src/app/api/admin/rights/decision/route.ts"),
  "utf8",
);

describe("outcomeMessage", () => {
  it("resolves every code the decision handler can redirect with", () => {
    // Every `rights_*` string literal in the handler. The success path uses
    // a different query parameter (`rights=recorded`) and the 403s return
    // JSON prose, so this prefix picks out exactly the error codes.
    const codes = [
      ...new Set(
        [...DECISION_ROUTE_SOURCE.matchAll(/"(rights_[a-z_]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    ].sort();

    // The scan found the handler and parsed something, so the loop below is
    // not vacuously green on an empty list — the failure a path typo or a
    // changed literal style would otherwise produce.
    expect(codes).toContain("rights_invalid_covers_uploads_before");
    expect(codes.length).toBeGreaterThanOrEqual(9);

    for (const code of codes) {
      // Keyed so a failure names the code that has no message.
      expect({ code, message: outcomeMessage(code) }).toEqual({
        code,
        message: expect.any(String),
      });
    }
  });

  it("returns undefined for inherited Object members", () => {
    // `?error=toString` would otherwise resolve to an inherited Function,
    // which is truthy and which React then refuses to render as a child.
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(outcomeMessage(key)).toBeUndefined();
    }
  });

  it("returns undefined for an unknown code or a non-string", () => {
    expect(outcomeMessage("nope")).toBeUndefined();
    expect(outcomeMessage(undefined)).toBeUndefined();
    expect(outcomeMessage(["denied"])).toBeUndefined();
  });
});

describe("BLOCKER_MESSAGES", () => {
  it("has a sentence for every sellability blocker", () => {
    // The Record type makes a missing key a compile error; this checks the
    // values are real sentences rather than empty strings.
    for (const message of Object.values(BLOCKER_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });

  /**
   * THE ONE PLACE that checks every registered triage fact's blocker has
   * wording (ugcportal-qn3). Here rather than beside TRIAGE_FACTS because
   * this is where the wording map is; a test next to the registry could
   * only inspect `fact.blocker` itself, which proves nothing a type
   * does not already.
   *
   * `tsc` covers the static half: BLOCKER_MESSAGES is a total `Record`
   * over SellabilityBlocker, and `blocker` is typed to that union. What
   * is left for runtime is the half a type cannot see — a key present but
   * empty, or the Record widened to a Partial by a later hand. Each of
   * those lands on a layer added later arriving with an undefined lookup
   * in front of an admin instead of a sentence.
   */
  it("has a sentence for every triage fact's blocker", () => {
    // Over the facts that CAN block. A `settledBy: "recorded"` entry names
    // no blocker — `tsc` refuses one that does — so there is no wording for
    // it to be missing, and the `blocker === undefined` skip below is the
    // only reading of that under which this loop still asserts something
    // about every fact that has one. The counterpart assertion, that such a
    // fact really does reach the gate, is "blocks the whole upload while it
    // is unanswered" in src/lib/resale-rights.test.ts.
    const blocking = TRIAGE_FACTS.filter((fact) => fact.blocker !== undefined);
    expect(blocking.length).toBeGreaterThan(0);

    for (const fact of blocking) {
      const blocker = fact.blocker!;
      expect(
        Object.hasOwn(BLOCKER_MESSAGES, blocker),
        `${fact.layer} names the blocker ${blocker}, which has no wording`,
      ).toBe(true);
      expect(
        BLOCKER_MESSAGES[blocker].length,
        `${fact.layer}'s blocker ${blocker} has no real sentence`,
      ).toBeGreaterThan(10);
    }
  });

  it("speaks about uploaders and uploads, not connected accounts", () => {
    // The screen this renders on lists people who uploaded files. A message
    // still saying "this account" would send an admin to a screen that no
    // longer decides anything (ugcportal-vsm).
    for (const message of Object.values(BLOCKER_MESSAGES)) {
      expect(message).not.toMatch(/\baccount\b/i);
    }
  });
});
