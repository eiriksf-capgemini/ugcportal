import type { ReactElement } from "react";

import { Gallery } from "@/components/gallery/gallery";
import { GalleryUnavailable } from "@/components/gallery/gallery-unavailable";
import { EmptyState } from "@/components/home/empty-state";
import { Hero } from "@/components/home/hero";
import { getSession } from "@/lib/auth";
import { isGenuinelyEmptyPage, toGalleryItems } from "@/lib/gallery-items";
import {
  listPublicMedia,
  publicMediaListingUrl,
  type PublicMediaResult,
} from "@/lib/public-media";
import { hasSignedInUser } from "@/lib/session";

/**
 * Wraps a `getSession()` call so a REJECTION never reaches a caller inside
 * `Home()` (round-1 review, CONFIRMED medium; round-2 review: scope note
 * below).
 *
 * `getSession()` can reject — a dropped database connection reading the
 * session row, the same class of failure `listPublicMedia` already has to
 * survive below — and before this existed, `await sessionPromise` was
 * unguarded on EVERY branch of `Home()`, including inside the `catch` block
 * that exists specifically to degrade a LISTING failure gracefully into
 * `GalleryUnavailable`. A rejected session read there would have thrown
 * again, inside that catch, past the one boundary this page has — crashing
 * `Home()`'s OWN render over a session-read failure the gallery data wasn't
 * even what failed. Degrading to the anonymous case (`signedIn: false`) is
 * the same choice this page already makes for an actual anonymous visitor,
 * so a visitor whose session merely couldn't be checked sees `Home()` render
 * exactly what it renders for one — the hero's call to action falling back
 * to "Sign in to upload" — never a broken `Home()` — at the cost of one
 * logged line an operator can act on.
 *
 * SCOPE, STATED PLAINLY (round-2 review, CONFIRMED medium): this only
 * protects `Home()`'s OWN render. `getSession()` is `cache()`-memoized per
 * request (src/lib/auth.ts), so src/components/auth-status.tsx and
 * src/components/upload-nav-link.tsx — rendered by `AppShell` as
 * `Home()`'s siblings on every real page, including this one — call the
 * SAME underlying promise independently and UNGUARDED. A rejection there
 * still crashes them, and therefore the whole assembled page (confirmed on
 * a real dev server: `/` answers HTTP 500), even on a request where this
 * function below works exactly as intended. That gap is real, is not fixed
 * by this function, and is tracked as its own bead, ugcportal-8df3 — see
 * this file's own `it.fails` regression marker (page.error.test.tsx) for
 * where that is kept visible rather than silently assumed closed.
 *
 * Called immediately on the raw `getSession()` call, not on an already-
 * created `sessionPromise` variable awaited later: an `async` function's
 * body runs synchronously up to its first `await`, so `resolveSignedIn(
 * getSession())` attaches this `try`/`await` to the promise in the SAME
 * tick `getSession()` creates it — there is no window where the raw,
 * unhandled promise could log Node's own "unhandled rejection" warning
 * before anything caught it. `const sessionPromise = getSession();` followed
 * by a LATER `resolveSignedIn(sessionPromise)` (this file's own round-1
 * shape) left exactly that window open, for however long
 * `listPublicMedia` took to settle in between (round-2 review, low
 * finding).
 */
async function resolveSignedIn(
  sessionPromise: ReturnType<typeof getSession>,
): Promise<boolean> {
  try {
    return hasSignedInUser(await sessionPromise);
  } catch (error) {
    console.error(
      "[src/app/page.tsx] the home page's getSession() call failed; treating this visitor as signed out",
      error,
    );
    return false;
  }
}

/**
 * The hero plus `GalleryUnavailable`, the fragment both the thrown-failure
 * branch and the `ok: false` branch below render (round-1 review, low
 * finding: this used to be written out twice). Still two call sites, not
 * one shared early return, because the two failures reach this point by
 * different control flow (`catch` vs. an `if`) for reasons that comment
 * explains — only the JSX itself was duplicated, not the branching.
 */
function unavailable(signedIn: boolean): ReactElement {
  return (
    <>
      <Hero signedIn={signedIn} />
      <GalleryUnavailable />
    </>
  );
}

/**
 * The public gallery (ugcportal-71y), and the whole of the home page.
 *
 * It renders into the app shell's single <main> (src/components/app-shell.tsx)
 * rather than building a frame of its own.
 *
 * The first page is read HERE, on the server, straight through
 * `listPublicMedia` — the same scope and the same projection GET
 * /api/public/media serves, from the same module, so there is no second
 * definition of "what is public" to drift. Not an HTTP fetch of our own
 * endpoint: that would cost a round trip through our own web server to reach a
 * function already in this process, and it would need an absolute origin the
 * server does not reliably know. The browser uses the HTTP endpoint for every
 * page AFTER the first, where it has no other option.
 */

/**
 * Never prerendered, never cached.
 *
 * Two independent reasons, and both have to hold:
 *
 *   - Correctness. This is the same argument the `no-store` header on
 *     GET /api/public/media makes at length: unpublishing has to take effect.
 *     A statically generated home page keeps showing a withdrawn photograph to
 *     everyone until something happens to rebuild it, and nothing reports a
 *     problem. A visibility control a cache can outlive is not one.
 *   - Buildability. Without this, `next build` tries to prerender `/`, which
 *     means running a Prisma query at build time against a database the build
 *     environment has no reason to have. That failure at least announces
 *     itself; the first one does not.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  /*
   * `resolveSignedIn` wraps the raw `getSession()` call IMMEDIATELY (see its
   * own comment for why that timing matters), so `sessionPromise` here is
   * already a `Promise<boolean>` that never rejects — both branches below
   * just `await` it, cheaply, as many times as they need to.
   *
   * Kicked off here and awaited only once the listing below has settled —
   * NOT serialised in between the two, so the session round trip overlaps
   * the listing one, the same "independent reads should not block on each
   * other" reasoning src/components/upload-nav-link.tsx and
   * src/components/auth-status.tsx already apply for THEIR OWN,
   * independent reads of the same cached session — see `resolveSignedIn`'s
   * own comment for why this page's fix does not yet extend to those two
   * (ugcportal-8df3).
   *
   * This is a DIFFERENT session read from the one src/app/page.test.tsx's
   * own `vi.mock("@/lib/auth", ...)` guards against: that mock stubs plain
   * `auth()` to throw specifically to assert the LISTING never varies by who
   * is asking (see that file's comment) — `listPublicMedia` and `<Gallery>`
   * below never touch this value. It exists only so the front page's hero
   * (ugcportal-6dvg K1) can point its one call to action at sign-in or at
   * /upload, which is why that same test file's mock also now stubs
   * `getSession` (not `auth`) to answer as an anonymous visitor.
   *
   * Resolved here, in Home() itself, rather than inside `<Hero>` as an async
   * Server Component of its own: `renderToStaticMarkup` cannot resolve a
   * nested async Server Component reached while walking an already-rendering
   * tree — confirmed empirically on this exact renderer (see
   * src/components/upload-nav-link.tsx's own comment, point 2) — and this
   * page's own test files all drive it through exactly
   * `renderToStaticMarkup(await Home())`. `<Hero>` is therefore a plain,
   * synchronous component taking the resolved boolean as a prop.
   */
  const sessionPromise = resolveSignedIn(getSession());

  /*
   * `listMedia` only reports `ok: false` for a malformed `?cursor=`, and the
   * URL above carries no cursor — so that branch is not expected to run. It
   * is written out rather than asserted away because "not expected" is not
   * "cannot": the alternative is a non-null assertion that turns a future
   * change to that contract into a crash on the home page.
   *
   * `listPublicMedia` can also THROW outright — a dropped database
   * connection, say — rather than ever returning an `ok: false` result.
   * Catching that here, rather than letting it reach Next's own error
   * boundary (there is none configured for this route yet, so it would be
   * the framework's generic one), is what makes this the SAME failure as
   * `ok: false` from this page's point of view: both render
   * `GalleryUnavailable` rather than two different kinds of broken page for
   * what an operator experiences as one incident. `listPublicMedia` has
   * already logged either case — see that function's own comment for why
   * one shared, throttled log line beats one per caller and per failure
   * mode.
   *
   * A failed listing used to be substituted with an empty page here
   * (ugcportal-0dh), which routed straight into `GalleryEmpty` — telling the
   * visitor the gallery was "genuinely empty" on the one path where that is
   * not known to be true, and leaving no trace of the failure anywhere a
   * human could find it. `listPublicMedia` not answering is distinguishable
   * from it answering with nothing; the two must stay that way all the way
   * to the rendered page, so both branches below return before `Gallery`
   * ever sees anything rather than inside it.
   */
  let result: PublicMediaResult;
  try {
    result = await listPublicMedia(publicMediaListingUrl());
  } catch {
    return unavailable(await sessionPromise);
  }

  const signedIn = await sessionPromise;

  if (!result.ok) {
    return unavailable(signedIn);
  }

  /*
   * The front page's own "living empty state" (ugcportal-6dvg K1/K2),
   * src/components/home/empty-state.tsx, rendered INSTEAD of `<Gallery>`
   * under the SAME EXPRESSION `<Gallery>`'s own internal `GalleryEmpty`
   * (src/components/gallery/gallery.tsx) uses, via the shared
   * `isGenuinelyEmptyPage` (src/lib/gallery-items.ts) rather than a second
   * hand-copied boolean expression — see that function's own comment for
   * the one place gallery.tsx's own copy could not also be swapped onto it
   * without exceeding this bead's scope.
   *
   * NOT a guarantee the two decisions "cannot disagree" (round-2 review,
   * low finding — an earlier version of this comment overclaimed exactly
   * that): this call passes the RAW values from `result.page` —
   * `result.page.items` (every row the listing returned, unfiltered) and
   * `result.page.hasMore` as reported — while `<Gallery>` below receives
   * `toGalleryItems(result.page.items)` (rows the lightbox/grid can
   * actually use; a row missing a usable preview is dropped) as
   * `initialItems`, and derives its OWN internal `hasMore` as
   * `initialHasMore && initialCursor !== null` (src/components/gallery/
   * gallery.tsx), not `initialHasMore` alone. Same expression, different
   * inputs that happen to agree whenever the feed's own data is healthy —
   * a listing that reported `hasMore: true` with a `null` cursor, or a
   * page of rows that were all individually unusable, is exactly the case
   * where they would not. Recorded on ugcportal-3wcd rather than left as
   * an assumption only this comment stated.
   */
  const isGenuinelyEmpty = isGenuinelyEmptyPage(
    result.page.items,
    result.page.hasMore,
  );

  return (
    <>
      <Hero signedIn={signedIn} />
      {isGenuinelyEmpty ? (
        <EmptyState />
      ) : (
        <Gallery
          initialItems={toGalleryItems(result.page.items)}
          initialCursor={result.page.nextCursor}
          initialHasMore={result.page.hasMore}
        />
      )}
    </>
  );
}
