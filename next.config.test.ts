import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("next.config headers (ugcportal-7ex5)", () => {
  it("sends the anti-framing and referrer headers on every path", async () => {
    const rules = await nextConfig.headers!();
    // Whole-object match: a has/missing/basePath/locale condition added to the
    // rule would narrow which requests get the headers, and must fail here.
    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]);
  });
});
