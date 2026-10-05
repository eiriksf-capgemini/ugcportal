import { cache } from "react";

import type { Session } from "next-auth";

import { getSession } from "@/lib/auth";

/**
 * The shell's one fail-safe session read (ugcportal-8df3).
 *
 * `getSession()` can reject — a dropped database connection reading the
 * session row — and before this existed that rejection was unguarded in
 * src/components/auth-status.tsx and src/components/upload-nav-link.tsx,
 * both rendered by `AppShell` as `Home()`'s siblings on EVERY page
 * (src/components/site-header.tsx). A rejection there crashed them, and
 * therefore the whole assembled page, even on a request where the page
 * body itself had its own guard (confirmed on a real dev server: `/`
 * answered HTTP 500 — see src/app/page.tsx's `resolveSignedIn`, which this
 * replaces, and the bead's premise note). This degrades to the same
 * anonymous case a real signed-out visit already renders — never a broken
 * page — at the cost of one logged line an operator can act on.
 *
 * ONE DEFINITION OF "TREAT AS SIGNED OUT": used by AuthStatus, UploadNavLink
 * and Home (src/app/page.tsx) — every caller whose job is to DECORATE the
 * shell with the current session, not to decide whether a protected action
 * is allowed. It must NOT be used by an auth GATE: src/app/upload/page.tsx
 * and `requireAdmin` (src/lib/admin.ts) call the raw `getSession()`
 * directly and let a rejection propagate, because folding "the database
 * didn't answer" into "signed out" there would make a connectivity blip
 * indistinguishable from a legitimate refusal — see the comments on those
 * two call sites for why failing closed means crashing, not redirecting.
 *
 * LOGGED ONCE PER REQUEST, not once per caller. `getSession()` is
 * `cache()`-memoized per request (src/lib/auth.ts), so within one real
 * React Server Component render all three callers above await the exact
 * SAME rejected promise. Catching it independently in each caller would
 * still log three times for one incident, so the dedupe here is keyed on
 * that promise's own identity — a `WeakSet` records which rejected
 * `getSession()` promise has already been logged, and every subsequent
 * `await` of that same (shared) promise returns the anonymous fallback
 * silently. `WeakSet` rather than a plain `Set` with manual eviction: the
 * promise is only ever reachable for the lifetime of the request that
 * created it, so nothing needs to remember to clear this between requests —
 * it is simply unreferenced, and collectible, once the request that
 * produced it ends. Wrapping this function itself in `cache()` on top is a
 * second, cheaper line of defence for the same request-render case (so the
 * body below runs once, not three times, when a render context is active)
 * — but it is not what makes the single-log guarantee hold: outside an
 * active React render (a plain, direct call, as this repo's own test
 * harness has to make — see src/app/page.error.test.tsx's comment on why
 * `renderToStaticMarkup` cannot resolve nested async Server Components),
 * `cache()` transparently falls through to an uncached call (confirmed
 * empirically, the same way src/lib/auth.ts's own comment on `getSession`
 * documents for that function), so the `WeakSet` keyed on the shared
 * `getSession()` promise is the part that is true in BOTH contexts.
 */
const loggedSessionRejections = new WeakSet<Promise<unknown>>();

async function resolveSessionOrAnonymousUncached(): Promise<Session | null> {
  const sessionPromise = getSession();
  try {
    return await sessionPromise;
  } catch (error) {
    if (!loggedSessionRejections.has(sessionPromise)) {
      loggedSessionRejections.add(sessionPromise);
      console.error(
        "[src/lib/session-or-anonymous.ts] the shared session read (used by " +
          "AuthStatus, UploadNavLink and the home page's hero) failed; " +
          "treating this visitor as signed out",
        error,
      );
    }
    return null;
  }
}

export const resolveSessionOrAnonymous = cache(resolveSessionOrAnonymousUncached);
