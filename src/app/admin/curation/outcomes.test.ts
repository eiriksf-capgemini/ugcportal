import { describe, expect, it } from "vitest";

import {
  TRIAGE_OUTCOME_CODES,
  triageOutcomeMessage,
} from "@/app/admin/curation/outcomes";
import { CLEARANCE_WRITE_REFUSALS } from "@/lib/curation-clearance-write";
import { TRIAGE_WRITE_REFUSALS } from "@/lib/curation-triage-write";

/**
 * The closed set of outcome codes this screen's two actions may redirect
 * with (ugcportal-vq3z, ugcportal-qfy9), and that nothing else resolves to
 * a message.
 */

describe("TRIAGE_OUTCOME_CODES", () => {
  it("covers every refusal either write path can return", () => {
    // The failure this closes is a refusal added to recordTriageFacts or to
    // recordLayerClearance that redirects with a code this screen has no
    // sentence for, so the admin gets an unchanged page and no explanation.
    // `tsc` already refuses a code with no message; this is the other
    // direction.
    for (const refusal of [
      ...TRIAGE_WRITE_REFUSALS,
      ...CLEARANCE_WRITE_REFUSALS,
    ]) {
      expect(TRIAGE_OUTCOME_CODES).toContain(refusal);
    }
  });

  it("gives the two write paths' refusals disjoint codes", () => {
    /*
      The two sets share one `?error=` namespace. A collision would not
      fail `tsc` and would not fail the coverage case above — it would
      silently render the triage write's sentence for a refused clearance,
      telling an admin their triage was not recorded when what was refused
      was a layer. Asserted rather than left to the `clearance_` prefix
      convention.
    */
    const overlap = (CLEARANCE_WRITE_REFUSALS as readonly string[]).filter(
      (code) => (TRIAGE_WRITE_REFUSALS as readonly string[]).includes(code),
    );
    expect(overlap).toEqual([]);
    // And no code is listed twice, which would make the set's length lie
    // about how many distinct sentences this screen can show.
    expect(new Set(TRIAGE_OUTCOME_CODES).size).toBe(
      TRIAGE_OUTCOME_CODES.length,
    );
  });

  it("gives every code a non-empty message", () => {
    for (const code of TRIAGE_OUTCOME_CODES) {
      const message = triageOutcomeMessage(code);
      expect(message, code).toBeTruthy();
      expect(message?.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("gives every code a DISTINCT message", () => {
    // Two codes sharing one sentence is the same defect as two codes
    // colliding, one step later: the admin is told something true about a
    // refusal that did not happen. Cheap to assert, and it catches the
    // copy-paste that adding five messages at once invites.
    const messages = TRIAGE_OUTCOME_CODES.map((code) =>
      triageOutcomeMessage(code),
    );
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("triageOutcomeMessage", () => {
  it("resolves nothing for a code it does not know", () => {
    expect(triageOutcomeMessage("whatever")).toBeUndefined();
    expect(triageOutcomeMessage("")).toBeUndefined();
  });

  it("resolves nothing for an inherited Object property", () => {
    // `?error=toString` would otherwise resolve to a Function through the
    // prototype chain — truthy, and something React refuses to render as a
    // child. The same trap the users screen's outcomes module documents.
    for (const inherited of [
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
    ]) {
      expect(triageOutcomeMessage(inherited), inherited).toBeUndefined();
    }
  });

  it("resolves nothing for a non-string", () => {
    // `?error=a&error=b` arrives as an array, not a string.
    expect(triageOutcomeMessage(["no_preview"])).toBeUndefined();
    expect(triageOutcomeMessage(undefined)).toBeUndefined();
    expect(triageOutcomeMessage(null)).toBeUndefined();
  });
});
