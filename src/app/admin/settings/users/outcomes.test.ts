import { describe, expect, it } from "vitest";

import { roleOutcomeMessage } from "@/app/admin/settings/users/outcomes";

describe("roleOutcomeMessage", () => {
  it("resolves every code the role-change action redirects with", () => {
    for (const code of ["last_admin", "user_not_found"]) {
      expect(roleOutcomeMessage(code)).toBeTypeOf("string");
    }
  });

  it("returns undefined for inherited Object members", () => {
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(roleOutcomeMessage(key)).toBeUndefined();
    }
  });

  it("returns undefined for an unknown code or a non-string", () => {
    expect(roleOutcomeMessage("nope")).toBeUndefined();
    expect(roleOutcomeMessage(undefined)).toBeUndefined();
    expect(roleOutcomeMessage(["last_admin"])).toBeUndefined();
  });
});
