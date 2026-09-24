import { describe, expect, it } from "vitest";

import {
  BLOCKER_MESSAGES,
  outcomeMessage,
} from "@/app/admin/settings/instagram/outcomes";

describe("outcomeMessage", () => {
  it("resolves every code the callback can redirect with", () => {
    for (const code of [
      "denied",
      "invalid_state",
      "missing_code",
      "exchange_failed",
      "rights_reason_required",
      "rights_invalid_valid_until",
      "rights_evidence_too_large",
      "rights_evidence_failed",
      "rights_account_not_found",
      "rights_actor_not_admin",
    ]) {
      expect(outcomeMessage(code)).toBeTypeOf("string");
    }
  });

  it("has a sentence for every sellability blocker", () => {
    // The Record type makes a missing key a compile error; this checks the
    // values are real sentences rather than empty strings.
    for (const message of Object.values(BLOCKER_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it("returns undefined for inherited Object members", () => {
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
