// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  CONSENT_COOKIE_NAME,
  parseConsentChoice,
  readStoredConsent,
  writeStoredConsent,
} from "./consent";

/**
 * jsdom environment: readStoredConsent/writeStoredConsent touch
 * document.cookie, which does not exist under vitest's default "node"
 * environment (see vitest.config.ts).
 */

function clearCookie(): void {
  document.cookie = `${CONSENT_COOKIE_NAME}=; Max-Age=0; Path=/`;
}

beforeEach(() => {
  clearCookie();
});

describe("parseConsentChoice", () => {
  it("accepts exactly 'granted'", () => {
    expect(parseConsentChoice("granted")).toBe("granted");
  });

  it("accepts exactly 'denied'", () => {
    expect(parseConsentChoice("denied")).toBe("denied");
  });

  it("refuses to default an unrecognised value to either real choice (null, not a fallback)", () => {
    // ugcportal-3wgp's whole premise: "no choice yet" must not be inferred
    // as consent in either direction. A reader who typed `raw as
    // ConsentChoice` instead of validating would make this pass "granted"
    // or "denied" straight through regardless of what the cookie actually
    // held — this fails on exactly that mutation.
    expect(parseConsentChoice("yes")).toBeNull();
    expect(parseConsentChoice("true")).toBeNull();
    expect(parseConsentChoice("GRANTED")).toBeNull();
  });

  it("treats absent/empty as no choice", () => {
    expect(parseConsentChoice(undefined)).toBeNull();
    expect(parseConsentChoice(null)).toBeNull();
    expect(parseConsentChoice("")).toBeNull();
  });
});

describe("readStoredConsent / writeStoredConsent round-trip", () => {
  it("reads null before anything is written (the default: optional things OFF)", () => {
    expect(readStoredConsent()).toBeNull();
  });

  it("round-trips 'granted'", () => {
    writeStoredConsent("granted");
    expect(readStoredConsent()).toBe("granted");
  });

  it("round-trips 'denied'", () => {
    writeStoredConsent("denied");
    expect(readStoredConsent()).toBe("denied");
  });

  it("a later write overwrites an earlier one, rather than appending a second cookie", () => {
    writeStoredConsent("granted");
    writeStoredConsent("denied");
    expect(readStoredConsent()).toBe("denied");
    // Sanity on the mechanism itself: exactly one cookie with this name.
    const occurrences = document.cookie.split("; ").filter((entry) =>
      entry.startsWith(`${CONSENT_COOKIE_NAME}=`),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("does not read some other cookie's value off a name collision in the raw header", () => {
    document.cookie = "other_cookie=granted; Path=/";
    expect(readStoredConsent()).toBeNull();
  });
});
