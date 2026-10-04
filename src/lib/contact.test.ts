import { describe, expect, it } from "vitest";

import {
  CONTACT_EMAIL_PLACEHOLDER,
  contactMailtoHref,
  resolveContactEmail,
} from "@/lib/contact";

describe("resolveContactEmail", () => {
  it("returns the placeholder in development with nothing configured", () => {
    expect(resolveContactEmail({ NODE_ENV: "development" })).toBe(
      CONTACT_EMAIL_PLACEHOLDER,
    );
  });

  it("returns the placeholder in test with nothing configured", () => {
    expect(resolveContactEmail({ NODE_ENV: "test" })).toBe(
      CONTACT_EMAIL_PLACEHOLDER,
    );
  });

  it("returns the configured address whatever NODE_ENV is", () => {
    expect(
      resolveContactEmail({
        NODE_ENV: "development",
        CONTACT_EMAIL: "hello@example.com",
      }),
    ).toBe("hello@example.com");
    expect(
      resolveContactEmail({
        NODE_ENV: "production",
        CONTACT_EMAIL: "hello@example.com",
      }),
    ).toBe("hello@example.com");
  });

  it("trims the configured address", () => {
    expect(
      resolveContactEmail({
        NODE_ENV: "development",
        CONTACT_EMAIL: "  hello@example.com  ",
      }),
    ).toBe("hello@example.com");
  });

  // K6's "never ship an undisclosed fake" instinct applied to this bead's own
  // placeholder: a whitespace-only CONTACT_EMAIL is env.example's own
  // "shipped blank" shape (`AUTH_GOOGLE_ID=` is the precedent), and must read
  // as "not configured" rather than as a real, empty-looking address.
  it("treats a whitespace-only CONTACT_EMAIL as not configured", () => {
    expect(
      resolveContactEmail({ NODE_ENV: "development", CONTACT_EMAIL: "   " }),
    ).toBe(CONTACT_EMAIL_PLACEHOLDER);
  });

  it("throws in production with nothing configured — the one case this guard exists for", () => {
    expect(() => resolveContactEmail({ NODE_ENV: "production" })).toThrow(
      /CONTACT_EMAIL is not set/,
    );
  });

  it("throws in production with only whitespace configured", () => {
    expect(() =>
      resolveContactEmail({ NODE_ENV: "production", CONTACT_EMAIL: "   " }),
    ).toThrow(/CONTACT_EMAIL is not set/);
  });

  it("defaults to process.env when no argument is given", () => {
    // Not asserting a value — this only proves the default parameter reads
    // the real process.env rather than silently requiring a caller to pass
    // one. The test harness runs with NODE_ENV=test, so this must not throw.
    expect(() => resolveContactEmail()).not.toThrow();
  });
});

describe("contactMailtoHref", () => {
  it("builds a mailto: link with the subject encoded and the address left alone", () => {
    expect(contactMailtoHref("hello@example.com", "Hello there")).toBe(
      "mailto:hello@example.com?subject=Hello%20there",
    );
  });

  it("does not percent-encode the @ in the address", () => {
    const href = contactMailtoHref(CONTACT_EMAIL_PLACEHOLDER, "x");
    expect(href).toContain(`mailto:${CONTACT_EMAIL_PLACEHOLDER}?`);
    expect(href).not.toContain("%40");
  });
});
