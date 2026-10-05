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
 * LOGGED ONCE PER REQUEST, not once per caller — and in real production
 * code, `cache()` wrapping this exported function IS the whole mechanism
 * (round-1 review of this PR, finding 1 — an earlier version of this
 * comment claimed the `WeakSet` below did the real work; it does not, see
 * the correction below). `getSession()` is itself `cache()`-memoized per
 * request (src/lib/auth.ts), and wrapping THIS function the same way means
 * that within one real React Server Component render, `Home`, `AuthStatus`
 * and `UploadNavLink` all calling `resolveSessionOrAnonymous()` (no
 * arguments) get `cache()`-deduped to exactly ONE execution of the body
 * below for the whole render — the other two callers receive that one
 * execution's already-settled result directly, so the `catch` block below
 * never runs a second time to consult the `WeakSet` at all. Confirmed live
 * on a dev server (round-1 review): a rejected session read produced
 * exactly one logged line for `/` and exactly one for `/about`.
 *
 * The `WeakSet` is belt-and-braces, not load-bearing, and only matters
 * OUTSIDE an active render — a plain, direct call, which is the one thing
 * this repo's own test harness has to make (`renderToStaticMarkup` cannot
 * resolve nested async Server Components; see src/app/page.error.test.tsx's
 * comment). There, `cache()` transparently falls through to an uncached
 * call (confirmed empirically, the same way src/lib/auth.ts's own comment
 * on `getSession` documents for that function), so each direct call runs
 * the body independently — but the REAL `getSession()`, called the same
 * way, ALSO falls through to an uncached call and hands back a fresh,
 * unshared promise every time. So in genuine production code reached this
 * way, the two rejected `getSession()` promises the `WeakSet` would need to
 * recognise as "the same one" never actually arise: inside a render,
 * `cache()` above already prevents a second execution; outside one, nothing
 * ever shares a promise for the `WeakSet` to key on. The `WeakSet` only
 * does real work in this file's own test suite (page.error.test.tsx's
 * "assembled shell" describe block), which mocks `getSession()` to hand
 * three direct calls the SAME promise — deliberately reproducing what a
 * real render's `cache()` would give them for free, since the harness has
 * no way to put those three calls behind an actual render.
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
