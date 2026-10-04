import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTACT_EMAIL_PLACEHOLDER,
  contactMailtoHref,
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
  it("builds a mailto: link with the subject encoded and the address left alone", () => {
    expect(contactMailtoHref("hello@example.com", { subject: "Hello there" })).toBe(
      "mailto:hello@example.com?subject=Hello%20there",
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
      "mailto:hello@example.com?subject=Hello%20there&body=Nice%20work%20on%20the%20wine%20coolers",
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
      "mailto:hello@example.com",
    );
  });

  it("does not percent-encode the @ in the address", () => {
    const href = contactMailtoHref(CONTACT_EMAIL_PLACEHOLDER, { subject: "x" });
    expect(href).toContain(`mailto:${CONTACT_EMAIL_PLACEHOLDER}?`);
    expect(href).not.toContain("%40");
  });
});
