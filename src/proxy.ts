import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { CURRENT_PATH_HEADER } from "@/lib/routes";

/**
 * Threads the current request's pathname to Server Components via a request
 * header (ugcportal-t0y round 3 finding 2).
 *
 * src/components/upload-nav-link.tsx needs to know whether it is already
 * rendering on /upload, to mark its own link `aria-current="page"` — the
 * conventional expectation for a nav landmark's active item. The App Router
 * gives a layout no first-class way to ask that: `params` only carries a
 * DYNAMIC segment's own value, and the shell that link lives in
 * (src/components/app-shell.tsx) is rendered from the ROOT layout
 * (src/app/layout.tsx), wrapping every route, with no segment of its own to
 * read. Middleware sees the real request URL ahead of all of that, so it is
 * the one place in the App Router that can hand a page's own path down to a
 * Server Component at all.
 *
 * The matcher below skips _next's own static/internal paths and the
 * favicon — this only needs to run for requests a page Server Component
 * will actually render.
 *
 * Named (and filed) `proxy`/`src/proxy.ts`, not `middleware`/
 * `src/middleware.ts`: Next.js 16 renamed the convention — same file
 * conventions and API, `middleware.ts` still works but is deprecated and
 * logs a warning on every build (`npx @next/codemod@canary
 * middleware-to-proxy`) — and this repo is already on 16.3.5, so there is
 * no reason to ship on the deprecated name on day one.
 */
export function proxy(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CURRENT_PATH_HEADER, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
