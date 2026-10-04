import { describe, expect, it } from "vitest";

import { isEmailShaped } from "@/lib/email-shape";

/**
 * Shared by src/lib/sign-in-policy.ts and src/lib/contact.ts (round-5
 * review) — see this module's own comment for why the two used to drift.
 */
describe("isEmailShaped", () => {
  it("accepts an ordinary address", () => {
    expect(isEmailShaped("jane@example.com")).toBe(true);
  });

  it("accepts a subdomain", () => {
    expect(isEmailShaped("jane@mail.example.com")).toBe(true);
  });

  // The round-5 review finding this test exists for: neither this module's
  // predecessor in sign-in-policy.ts nor the one in contact.ts rejected
  // this before they were unified.
  it("rejects a trailing dot in the domain", () => {
    expect(isEmailShaped("owner@example.com.")).toBe(false);
  });

  it("rejects a leading dot in the domain", () => {
    expect(isEmailShaped("owner@.example.com")).toBe(false);
  });

  it("rejects two dots in a row in the domain", () => {
    expect(isEmailShaped("owner@example..com")).toBe(false);
  });

  it("rejects a domain with no dot at all", () => {
    expect(isEmailShaped("owner@example")).toBe(false);
  });

  it("rejects an empty local part", () => {
    expect(isEmailShaped("@example.com")).toBe(false);
  });

  it("rejects an empty domain", () => {
    expect(isEmailShaped("owner@")).toBe(false);
  });

  it("rejects any value containing whitespace", () => {
    expect(isEmailShaped("jane doe@example.com")).toBe(false);
  });

  it("rejects a display-name-and-angle-bracket value", () => {
    expect(isEmailShaped("Jane Doe <jane@example.com>")).toBe(false);
  });

  it("rejects a bare angle bracket with no surrounding name", () => {
    expect(isEmailShaped("<jane@example.com>")).toBe(false);
  });

  it("rejects a doubled @", () => {
    expect(isEmailShaped("jane@@example.com")).toBe(false);
  });

  it("rejects plain text with no @ at all", () => {
    expect(isEmailShaped("not-an-email")).toBe(false);
  });
});
