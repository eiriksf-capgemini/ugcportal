import { describe, expect, it } from "vitest";

import { outcomeMessage } from "@/app/admin/settings/instagram/outcomes";

describe("outcomeMessage", () => {
  it("resolves every code the callback can redirect with", () => {
    for (const code of [
      "denied",
      "invalid_state",
      "missing_code",
      "exchange_failed",
    ]) {
      expect(outcomeMessage(code)).toBeTypeOf("string");
    }
  });

  it("no longer answers for resale-rights codes", () => {
    // They moved to ../rights/outcomes.ts with the gate (ugcportal-vsm).
    // Asserted so the two modules cannot quietly both claim a code and
    // disagree about what it means.
    for (const code of [
      "rights_reason_required",
      "rights_actor_not_admin",
      "rights_uploader_not_found",
    ]) {
      expect(outcomeMessage(code)).toBeUndefined();
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
