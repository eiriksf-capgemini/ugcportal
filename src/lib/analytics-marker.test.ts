import { describe, expect, it } from "vitest";

import { ANALYTICS_MARKER } from "./analytics-marker";

/**
 * Review round 5, LOW finding 6: ANALYTICS_MARKER is the one shared
 * definition now imported by both analytics-host.grep.test.ts (K6) and
 * e2e/cookie-consent.spec.ts — see each call site's own comment pointing
 * back here.
 */
describe("ANALYTICS_MARKER", () => {
  it("matches the vendor name case-insensitively", () => {
    expect(ANALYTICS_MARKER.test("umami")).toBe(true);
    expect(ANALYTICS_MARKER.test("UMAMI")).toBe(true);
    expect(ANALYTICS_MARKER.test("Umami")).toBe(true);
  });

  it("matches the vendor name embedded in a host or env var name", () => {
    expect(ANALYTICS_MARKER.test("https://stats.example/x?umami")).toBe(true);
    expect(ANALYTICS_MARKER.test("NEXT_PUBLIC_UMAMI_SRC")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(ANALYTICS_MARKER.test("https://stats.example/x?other")).toBe(false);
  });
});
