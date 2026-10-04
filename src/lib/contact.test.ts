import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTACT_EMAIL_PLACEHOLDER,
  contactMailtoHref,
  isBareEmailAddress,
  resolveContactEmail,
} from "@/lib/contact";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveContactEmail", () => {
  it("returns the placeholder when CONTACT_EMAIL is unset", () => {
    vi.stubEnv("CONTACT_EMAIL", "");
    expect(resolveContactEmail()).toBe(CONTACT_EMAIL_PLACEHOLDER);
  });

  it("returns the configured address", () => {
    vi.stubEnv("CONTACT_EMAIL", "hello@example.com");
    expect(resolveContactEmail()).toBe("hello@example.com");
  });

  it("trims the configured address", () => {
    vi.stubEnv("CONTACT_EMAIL", "  hello@example.com  ");
    expect(resolveContactEmail()).toBe("hello@example.com");
  });

  // env.example's own "shipped blank" shape (`AUTH_GOOGLE_ID=`) is the
  // precedent for treating whitespace-only as not configured, same as an
  // empty string — a `.env` copied without every field filled in should not
  // read as "a real value already exists".
  it("treats a whitespace-only CONTACT_EMAIL as not configured", () => {
    vi.stubEnv("CONTACT_EMAIL", "   ");
    expect(resolveContactEmail()).toBe(CONTACT_EMAIL_PLACEHOLDER);
  });
});

describe("contactMailtoHref", () => {
  it("builds a mailto: link with both the address and the subject encoded", () => {
    expect(contactMailtoHref("hello@example.com", { subject: "Hello there" })).toBe(
      "mailto:hello%40example.com?subject=Hello%20there",
    );
  });

  // The round-1 review finding this test exists for: a space must become
  // %20, never the form-urlencoded "+" a GET-method <form action="mailto:">
  // would have produced, which real mail clients do not decode back to a
  // space.
  it("encodes a space in the subject as %20, never as +", () => {
    const href = contactMailtoHref("hello@example.com", {
      subject: "Hello from your portfolio page",
    });
    expect(href).toContain("Hello%20from%20your%20portfolio%20page");
    expect(href).not.toContain("+");
  });

  it("encodes a space in the body as %20 too, and joins subject and body with &", () => {
    const href = contactMailtoHref("hello@example.com", {
      subject: "Hello there",
      body: "Nice work on the wine coolers",
    });
    expect(href).toBe(
      "mailto:hello%40example.com?subject=Hello%20there&body=Nice%20work%20on%20the%20wine%20coolers",
    );
  });

  it("omits a parameter that is undefined or empty, rather than emitting an empty value", () => {
    expect(contactMailtoHref("hello@example.com", { subject: "Hi" })).not.toContain(
      "body=",
    );
    expect(
      contactMailtoHref("hello@example.com", { subject: "Hi", body: "" }),
    ).not.toContain("body=");
  });

  it("builds a bare mailto: with no query string when nothing is given", () => {
    expect(contactMailtoHref("hello@example.com", {})).toBe(
      "mailto:hello%40example.com",
    );
  });

  // Round-2 review reversed round-1's choice here: the address is now
  // percent-encoded too, as defence in depth alongside
  // checkContactEmailConfiguration's boot-time rejection of a malformed
  // CONTACT_EMAIL (src/instrumentation.ts) — see this function's own
  // comment for why a warning-only boot check is not enough on its own.
  it("percent-encodes the @ in the address", () => {
    const href = contactMailtoHref(CONTACT_EMAIL_PLACEHOLDER, { subject: "x" });
    expect(href).toContain("mailto:REPLACE-BEFORE-LAUNCH%40example.invalid?");
    expect(href).not.toContain(`mailto:${CONTACT_EMAIL_PLACEHOLDER}`);
  });

  it("keeps the resulting href well-formed even if a malformed address slips through", () => {
    // The exact shape checkContactEmailConfiguration warns about but does
    // not block: a boot-time warning is advisory, not enforced, so this
    // function cannot assume it was heeded.
    const href = contactMailtoHref("Jane Doe <jane@example.com>", {});
    expect(href).not.toMatch(/[\s<>]/);
  });
});

describe("isBareEmailAddress", () => {
  it("accepts an ordinary address", () => {
    expect(isBareEmailAddress("jane@example.com")).toBe(true);
  });

  it("rejects a 'Display Name <address>' value", () => {
    expect(isBareEmailAddress("Jane Doe <jane@example.com>")).toBe(false);
  });

  it("rejects any value containing whitespace", () => {
    expect(isBareEmailAddress("jane doe@example.com")).toBe(false);
  });

  it("rejects a bare angle bracket with no surrounding name", () => {
    expect(isBareEmailAddress("<jane@example.com>")).toBe(false);
  });

  // Round-4 review: the first version of this check accepted anything
  // without whitespace or an angle bracket, which is not the same claim as
  // "looks like an email address".
  it("rejects plain text with no @ at all", () => {
    expect(isBareEmailAddress("not-an-email")).toBe(false);
  });

  it("rejects a domain with no dot", () => {
    expect(isBareEmailAddress("jane@example")).toBe(false);
  });

  it("rejects an empty local part", () => {
    expect(isBareEmailAddress("@example.com")).toBe(false);
  });

  it("rejects an empty domain", () => {
    expect(isBareEmailAddress("jane@")).toBe(false);
  });

  it("rejects a doubled @", () => {
    expect(isBareEmailAddress("jane@@example.com")).toBe(false);
  });

  it("accepts a subdomain", () => {
    expect(isBareEmailAddress("jane@mail.example.com")).toBe(true);
  });
});
