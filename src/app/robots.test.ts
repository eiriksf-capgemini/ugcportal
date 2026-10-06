import { afterEach, describe, expect, it, vi } from "vitest";

import robots from "@/app/robots";

describe("robots() (ugcportal-qnq9.12)", () => {
  it("allows everything and points at /sitemap.xml on the configured origin", () => {
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
    expect(result.sitemap).toMatch(/^https?:\/\/[^/]+\/sitemap\.xml$/);
  });
});

/**
 * Review round 1, finding 1 (MEDIUM, CONFIRMED): `siteOrigin()` now returns
 * `null` in production when AUTH_URL is unset or malformed. `robots.ts`'s
 * own job is to OMIT `sitemap` rather than publish
 * `http://localhost:3000/sitemap.xml` — a URL no public crawler can reach,
 * with nothing in the response itself saying why.
 */
describe("robots() when there is no configured origin (review round 1, finding 1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits the sitemap field in production when AUTH_URL is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "");
    const result = robots();
    expect(result.sitemap).toBeUndefined();
    // allow: "/" names no host, so it stands regardless of origin.
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
  });

  it("omits the sitemap field in production when AUTH_URL is malformed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "not a url");
    const result = robots();
    expect(result.sitemap).toBeUndefined();
  });

  it("still includes the sitemap field outside production, via the localhost fallback", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_URL", "");
    const result = robots();
    expect(result.sitemap).toBe("http://localhost:3000/sitemap.xml");
  });
});
