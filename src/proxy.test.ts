import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { CURRENT_PATH_HEADER } from "@/lib/routes";

import { proxy } from "./proxy";

/**
 * ugcportal-t0y round 3 finding 2. `NextResponse.next({ request: { headers }
 * })` doesn't put the injected headers directly on the returned response —
 * Next's own request pipeline reapplies them to the request it hands
 * onward, encoded as `x-middleware-request-<key>` response headers plus an
 * `x-middleware-override-headers` manifest (confirmed by reading
 * node_modules/next/dist/server/web/spec-extension/response.js rather than
 * assumed — the header names kept the historical "middleware" spelling even
 * though Next 16 renamed the file convention to `proxy`), so that's what
 * this asserts against rather than a header this proxy never actually sets
 * on its own response.
 */
function injectedPathname(response: Response): string | null {
  const overridden = response.headers.get("x-middleware-override-headers");
  if (!overridden?.split(",").includes(CURRENT_PATH_HEADER)) {
    return null;
  }
  return response.headers.get(`x-middleware-request-${CURRENT_PATH_HEADER}`);
}

describe("proxy (ugcportal-t0y)", () => {
  it("stamps the request's own pathname, for /upload", () => {
    const request = new NextRequest("https://example.test/upload");

    const response = proxy(request);

    expect(injectedPathname(response)).toBe("/upload");
  });

  it("stamps a different pathname for a different route, not a fixed value", () => {
    // The fixture mutation: if this proxy ever hard-coded "/upload"
    // instead of reading request.nextUrl.pathname, the test above would
    // still pass. A second route with a different expected value is what
    // makes that failure mode visible.
    const request = new NextRequest("https://example.test/admin/settings/users");

    const response = proxy(request);

    expect(injectedPathname(response)).toBe("/admin/settings/users");
  });

  it("ignores the query string", () => {
    const request = new NextRequest("https://example.test/upload?ref=email");

    const response = proxy(request);

    expect(injectedPathname(response)).toBe("/upload");
  });
});
