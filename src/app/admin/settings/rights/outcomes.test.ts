import { describe, expect, it } from "vitest";

import {
  BLOCKER_MESSAGES,
  outcomeMessage,
} from "@/app/admin/settings/rights/outcomes";

describe("outcomeMessage", () => {
  it("resolves every code the decision handler can redirect with", () => {
    for (const code of [
      "rights_reason_required",
      "rights_invalid_valid_until",
      "rights_evidence_too_large",
      "rights_evidence_failed",
      "rights_uploader_not_found",
      "rights_actor_not_admin",
      "rights_holder_missing",
      "rights_conflict",
    ]) {
      expect(outcomeMessage(code)).toBeTypeOf("string");
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

  it("speaks about uploaders and uploads, not connected accounts", () => {
    // The screen this renders on lists people who uploaded files. A message
    // still saying "this account" would send an admin to a screen that no
    // longer decides anything (ugcportal-vsm).
    for (const message of Object.values(BLOCKER_MESSAGES)) {
      expect(message).not.toMatch(/\baccount\b/i);
    }
  });
});
