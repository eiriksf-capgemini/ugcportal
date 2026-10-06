import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkSiteOriginConfigured,
  expectedOrigin,
  isSameOriginRequest,
  siteOrigin,
} from "@/lib/origin";

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

  it("reads from the given env parameter rather than process.env, when passed one", () => {
    expect(
      expectedOrigin(
        { NODE_ENV: "test", AUTH_URL: "https://from-param.example/x" } as NodeJS.ProcessEnv,
      ),
    ).toBe("https://from-param.example");
    // The real process.env.AUTH_URL set by beforeEach must be ignored once an
    // explicit env is given — otherwise this "parameter" would be decorative.
    expect(expectedOrigin({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBeNull();
  });
});

/**
 * Review round 1, finding 1 (MEDIUM, CONFIRMED): `siteOrigin()` silently fell
 * back to `http://localhost:3000` whenever AUTH_URL was unset or malformed,
 * with no boot warning and no direct test of the fallback — even though it
 * now feeds three crawler-facing, correctness-sensitive surfaces this bead
 * adds (the per-item canonical link, the sitemap, and robots.txt's `sitemap`
 * field). Fixed two ways: `siteOrigin` itself now refuses the fallback in
 * production (returns `null`, so a caller must omit the URL rather than
 * publish a wrong one), and `checkSiteOriginConfigured` is the boot-time
 * warning (wired into src/instrumentation-node.ts), the same convention
 * `checkLegalPagesPublishable` already uses for an unset LEGAL_* variable.
 *
 * `env` passed explicitly throughout, same convention as
 * src/lib/legal/publishable.test.ts's `PROD`/`DEV` constants — exercises the
 * production branch without mutating the real `process.env`.
 */
function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

const UNSET_AUTH_URL = env({ NODE_ENV: "development" });
const MALFORMED_AUTH_URL = env({ NODE_ENV: "development", AUTH_URL: "not a url" });
const VALID_AUTH_URL = env({
  NODE_ENV: "development",
  AUTH_URL: "https://ugc.example/callback",
});

describe("siteOrigin", () => {
  it("is the real origin when AUTH_URL is set and valid, in any environment", () => {
    expect(siteOrigin(VALID_AUTH_URL)).toBe("https://ugc.example");
    expect(siteOrigin({ ...VALID_AUTH_URL, NODE_ENV: "production" })).toBe(
      "https://ugc.example",
    );
  });

  it("falls back to http://localhost:3000 outside production when AUTH_URL is unset", () => {
    expect(siteOrigin(UNSET_AUTH_URL)).toBe("http://localhost:3000");
  });

  it("falls back to http://localhost:3000 outside production when AUTH_URL is malformed", () => {
    expect(siteOrigin(MALFORMED_AUTH_URL)).toBe("http://localhost:3000");
  });

  it("is null in production when AUTH_URL is unset — never localhost on a public surface", () => {
    expect(siteOrigin({ ...UNSET_AUTH_URL, NODE_ENV: "production" })).toBeNull();
  });

  it("is null in production when AUTH_URL is malformed — never localhost on a public surface", () => {
    expect(siteOrigin({ ...MALFORMED_AUTH_URL, NODE_ENV: "production" })).toBeNull();
  });
});

describe("checkSiteOriginConfigured", () => {
  it("is null (nothing to warn about) when AUTH_URL is set and valid, in any environment", () => {
    expect(checkSiteOriginConfigured(VALID_AUTH_URL)).toBeNull();
    expect(
      checkSiteOriginConfigured({ ...VALID_AUTH_URL, NODE_ENV: "production" }),
    ).toBeNull();
  });

  it("warns, naming AUTH_URL, when it is unset — outside production", () => {
    const warning = checkSiteOriginConfigured(UNSET_AUTH_URL);
    expect(warning).not.toBeNull();
    expect(warning).toContain("AUTH_URL");
    expect(warning).toContain("localhost:3000");
  });

  it("warns, naming AUTH_URL, when it is malformed", () => {
    const warning = checkSiteOriginConfigured(MALFORMED_AUTH_URL);
    expect(warning).not.toBeNull();
    expect(warning).toContain("AUTH_URL");
  });

  it("in production, warns that URLs are OMITTED rather than that they fall back to localhost", () => {
    const warning = checkSiteOriginConfigured({ ...UNSET_AUTH_URL, NODE_ENV: "production" });
    const devWarning = checkSiteOriginConfigured(UNSET_AUTH_URL);
    expect(warning).not.toBeNull();
    expect(warning).toContain("AUTH_URL");
    expect(warning).toContain("omits");
    // The two messages must actually differ — a production deployment that
    // is missing AUTH_URL does not get the same (now-inapplicable) sentence
    // a developer sees, which promises a working localhost fallback that
    // `siteOrigin` no longer gives it.
    expect(warning).not.toBe(devWarning);
    expect(devWarning).not.toContain("omits");
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
