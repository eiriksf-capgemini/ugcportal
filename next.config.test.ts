import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("next.config headers (ugcportal-7ex5)", () => {
  it("sends the anti-framing and referrer headers on every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    const h = Object.fromEntries(rules[0].headers.map((x) => [x.key, x.value]));
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("adds no CSP directive that could block the site's own scripts or styles", async () => {
    const rules = await nextConfig.headers!();
    const csp = rules[0].headers.find((x) => x.key === "Content-Security-Policy")!;
    const directives = csp.value.split(";").map((d) => d.trim().split(/\s+/)[0]);
    expect(directives).toEqual(["frame-ancestors"]);
  });
});
