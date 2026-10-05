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
 * LOGGED ONCE PER REQUEST, not once per caller (round-2 review of this PR,
 * finding 1 — an earlier version of this comment, itself a round-1
 * correction, still had this wrong: it said the `WeakSet` only matters
 * OUTSIDE a render, which overclaims what the `WeakSet` does there — see
 * the measured facts below). There are two dedupe layers here, and inside
 * a real React Server Component render they are REDUNDANT with each other
 * — either alone is already sufficient, because `getSession()` is itself
 * `cache()`-memoized per request (src/lib/auth.ts): within one render,
 * `Home`, `AuthStatus` and `UploadNavLink` all calling
 * `resolveSessionOrAnonymous()` reach a `getSession()` that hands back the
 * SAME promise regardless of anything below. That alone is enough for the
 * `WeakSet` to dedupe the log even with the outer `cache()` wrapper
 * removed; separately, the outer `cache()` wrapping THIS function is
 * enough on its own, with the `WeakSet` check forced open, to collapse all
 * three callers to exactly ONE execution of the body below for the whole
 * render. Confirmed live on a dev server (round-1 review): a rejected
 * session read produced exactly one logged line for `/` and exactly one
 * for `/about`.
 *
 * OUTSIDE an active render — a plain, direct call, which is the one thing
 * this repo's own test harness has to make (`renderToStaticMarkup` cannot
 * resolve nested async Server Components; see src/app/page.error.test.tsx's
 * comment) — NEITHER layer dedupes anything for the real implementation.
 * `cache()` transparently falls through to an uncached call there
 * (confirmed empirically, the same way src/lib/auth.ts's own comment on
 * `getSession` documents for that function), so the outer wrapper stops
 * collapsing calls; and the REAL `getSession()`, called the same way, ALSO
 * falls through to an uncached call and hands back a fresh, unshared
 * promise every time, so the `WeakSet` has no shared key to dedupe on
 * either. Three direct calls to the real implementation outside a render
 * would therefore log three times, not one.
 *
 * This file's own test suite (page.error.test.tsx's "assembled shell"
 * describe block) exercises the `WeakSet` specifically, not the `cache()`
 * path: its mock makes `getSession()` hand three direct calls the SAME
 * promise — reproducing, by hand, what a real render's `cache()` gives for
 * free — which is the one case outside a render where the `WeakSet` has
 * something to key on. The `cache()` path (the mechanism that actually
 * carries the guarantee inside a real render) is verified only live, on a
 * dev server, not by any test in this repo — this harness cannot put
 * `Home`, `AuthStatus` and `UploadNavLink` behind one real render to
 * exercise it directly.
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
