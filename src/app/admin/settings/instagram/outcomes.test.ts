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
