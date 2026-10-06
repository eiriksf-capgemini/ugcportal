import { describe, expect, it } from "vitest";

import { siteVerification } from "@/lib/site-verification";

/**
 * K4 (ugcportal-qnq9.12): Search Console and Pinterest verification must be
 * meta tags only — this is the pure function half of that claim; the e2e
 * half (no third-party request, no script element) is
 * e2e/site-verification.spec.ts.
 *
 * `env` fixtures cast through `NodeJS.ProcessEnv`, same convention as
 * src/lib/legal/publishable.test.ts's own `PROD`/`DEV` constants: a test
 * fixture naming only the handful of keys a case cares about, not the real
 * `process.env`'s full required shape.
 */
function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("siteVerification", () => {
  it("returns undefined when neither variable is set", () => {
    expect(siteVerification(env({}))).toBeUndefined();
  });

  it("returns undefined for a blank (whitespace-only) value, same as unset", () => {
    expect(
      siteVerification(
        env({ GOOGLE_SITE_VERIFICATION: "   ", PINTEREST_SITE_VERIFICATION: "" }),
      ),
    ).toBeUndefined();
  });

  it("sets only google when only the Google variable is set", () => {
    const result = siteVerification(env({ GOOGLE_SITE_VERIFICATION: "abc123" }));
    expect(result).toEqual({ google: "abc123" });
  });

  it("sets only Pinterest's meta tag name under `other` when only that variable is set", () => {
    const result = siteVerification(env({ PINTEREST_SITE_VERIFICATION: "pin-xyz" }));
    expect(result).toEqual({ other: { "p:domain_verify": "pin-xyz" } });
  });

  it("sets both when both are configured", () => {
    const result = siteVerification(
      env({
        GOOGLE_SITE_VERIFICATION: "abc123",
        PINTEREST_SITE_VERIFICATION: "pin-xyz",
      }),
    );
    expect(result).toEqual({
      google: "abc123",
      other: { "p:domain_verify": "pin-xyz" },
    });
  });

  it("trims surrounding whitespace", () => {
    const result = siteVerification(env({ GOOGLE_SITE_VERIFICATION: "  abc123  " }));
    expect(result).toEqual({ google: "abc123" });
  });
});
