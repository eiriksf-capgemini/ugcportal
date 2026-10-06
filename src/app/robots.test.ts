import { describe, expect, it } from "vitest";

import robots from "@/app/robots";

describe("robots() (ugcportal-qnq9.12)", () => {
  it("allows everything and points at /sitemap.xml on the configured origin", () => {
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
    expect(result.sitemap).toMatch(/^https?:\/\/[^/]+\/sitemap\.xml$/);
  });
});
