import { describe, expect, it } from "vitest";

import {
  TRIAGE_OUTCOME_CODES,
  triageOutcomeMessage,
} from "@/app/admin/curation/outcomes";
import { TRIAGE_WRITE_REFUSALS } from "@/lib/curation-triage-write";

/**
 * The closed set of outcome codes the triage action may redirect with
 * (ugcportal-vq3z), and that nothing else resolves to a message.
 */

describe("TRIAGE_OUTCOME_CODES", () => {
  it("covers every refusal the write path can return", () => {
    // The failure this closes is a refusal added to recordTriageFacts that
    // redirects with a code this screen has no sentence for, so the admin
    // gets an unchanged page and no explanation. `tsc` already refuses a
    // code with no message; this is the other direction.
    for (const refusal of TRIAGE_WRITE_REFUSALS) {
      expect(TRIAGE_OUTCOME_CODES).toContain(refusal);
    }
  });

  it("gives every code a non-empty message", () => {
    for (const code of TRIAGE_OUTCOME_CODES) {
      const message = triageOutcomeMessage(code);
      expect(message, code).toBeTruthy();
      expect(message?.trim().length, code).toBeGreaterThan(0);
    }
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
