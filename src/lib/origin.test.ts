import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expectedOrigin, isSameOriginRequest } from "@/lib/origin";

const PUBLIC_ORIGIN = "https://ugc.example";
/** What the app actually receives behind a TLS-terminating proxy. */
const INTERNAL_URL = "http://10.0.0.7:3000/api/admin/thing";

function post(headers: Record<string, string>, url = INTERNAL_URL): Request {
  return new Request(url, { method: "POST", headers });
}

const originalAuthUrl = process.env.AUTH_URL;

beforeEach(() => {
  process.env.AUTH_URL = `${PUBLIC_ORIGIN}/`;
});

afterEach(() => {
  if (originalAuthUrl === undefined) {
    delete process.env.AUTH_URL;
  } else {
    process.env.AUTH_URL = originalAuthUrl;
  }
});

describe("expectedOrigin", () => {
  it("is the origin of AUTH_URL, path and all discarded", () => {
    process.env.AUTH_URL = "https://ugc.example/some/path";
    expect(expectedOrigin()).toBe(PUBLIC_ORIGIN);
  });

  it("is null when AUTH_URL is unset or unparseable", () => {
    delete process.env.AUTH_URL;
    expect(expectedOrigin()).toBeNull();

    process.env.AUTH_URL = "not a url";
    expect(expectedOrigin()).toBeNull();
  });
});

describe("isSameOriginRequest", () => {
  /**
   * The deployment bug this helper exists to avoid: deriving the expectation
   * from `request.url` compares the browser's public origin against the
   * server's internal one, and refuses every legitimate post in production
   * while passing any test that uses one host for both.
   */
  it("accepts the public origin even though the server saw an internal URL", () => {
    expect(isSameOriginRequest(post({ origin: PUBLIC_ORIGIN }))).toBe(true);
  });

  it("refuses an origin that isn't the configured one", () => {
    expect(isSameOriginRequest(post({ origin: "https://evil.example" }))).toBe(
      false,
    );
    // Including the internal one the server happens to be listening on: it
    // is not where the browser talks to us.
    expect(isSameOriginRequest(post({ origin: "http://10.0.0.7:3000" }))).toBe(
      false,
    );
  });

  it("refuses anything the browser labels cross-site or same-site", () => {
    // Sec-Fetch-Site is browser-set and unforgeable from page script, so it
    // is worth honouring even when Origin looks right.
    expect(
      isSameOriginRequest(
        post({ origin: PUBLIC_ORIGIN, "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        post({ origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-site" }),
      ),
    ).toBe(false);
  });

  it("accepts what the browser labels same-origin", () => {
    expect(
      isSameOriginRequest(
        post({ origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
  });

  /**
   * Absent Origin is allowed, deliberately. No browser omits it on a
   * cross-origin POST, so absence cannot be an attacker's cross-site form —
   * whereas refusing it would break clients that omit it same-origin. The
   * session cookie's SameSite=Lax and requireAdmin are what actually stop
   * the cross-site case.
   */
  it("allows a request with no Origin at all", () => {
    expect(isSameOriginRequest(post({}))).toBe(true);
  });

  it("still refuses a no-Origin request the browser calls cross-site", () => {
    expect(isSameOriginRequest(post({ "sec-fetch-site": "cross-site" }))).toBe(
      false,
    );
  });

  it("does not refuse everything when AUTH_URL is unset", () => {
    // Dev without an .env. There is no expectation to compare against, so
    // the Origin comparison is skipped rather than failing closed on a
    // configuration gap that would take the whole screen down.
    delete process.env.AUTH_URL;

    expect(isSameOriginRequest(post({ origin: "http://localhost:3000" }))).toBe(
      true,
    );
    // Sec-Fetch-Site still carries what it can.
    expect(
      isSameOriginRequest(
        post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
  });
});
