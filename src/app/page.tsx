import type { ReactElement } from "react";

import { Gallery } from "@/components/gallery/gallery";
import { GalleryUnavailable } from "@/components/gallery/gallery-unavailable";
import { EmptyState } from "@/components/home/empty-state";
import { Hero } from "@/components/home/hero";
import { isGenuinelyEmptyPage, toGalleryItems, type GalleryItem } from "@/lib/gallery-items";
import { listPortfolioPieces } from "@/lib/portfolio";
import {
  listPublicMedia,
  publicMediaListingUrl,
  type PublicMediaResult,
} from "@/lib/public-media";
import { hasSignedInUser } from "@/lib/session";
import { resolveSessionOrAnonymous } from "@/lib/session-or-anonymous";

/**
 * The hero plus `GalleryUnavailable`, the fragment both the thrown-failure
 * branch and the `ok: false` branch below render (round-1 review, low
 * finding: this used to be written out twice). Still two call sites, not
 * one shared early return, because the two failures reach this point by
 * different control flow (`catch` vs. an `if`) for reasons that comment
 * explains — only the JSX itself was duplicated, not the branching.
 */
function unavailable(signedIn: boolean, portfolioPieces: GalleryItem[]): ReactElement {
  return (
    <>
      <Hero signedIn={signedIn} portfolioPieces={portfolioPieces} />
      <GalleryUnavailable />
    </>
  );
}

/**
 * The hero's photographic tiles (ugcportal-qqnt.4 K1) degrade to an empty
 * array — which `<HeroVisual>` itself renders as nothing at all, ugcportal-
 * a3hj K2 — rather than crashing `Home()`'s render, the same resilience
 * `resolveSessionOrAnonymous` gives the session read just below — a dropped
 * database connection reading curated portfolio pieces is a real
 * possibility on the SAME database `listPublicMedia` and
 * `resolveSessionOrAnonymous` already guard against independently, not a
 * hypothetical one invented for symmetry.
 *
 * Not wrapped in `cache()`/a `WeakSet` dedupe the way that module's own
 * session read is: this function has exactly one caller (`Home` below),
 * where the session read has three (this page, AuthStatus, UploadNavLink)
 * that can all independently hit the identical rejected promise in one
 * render — there is nothing here for a second layer to dedupe.
 */
async function resolveHeroPortfolioPieces(): Promise<GalleryItem[]> {
  try {
    return await listPortfolioPieces();
  } catch (error) {
    console.error(
      "[src/app/page.tsx] the hero's portfolio-preview read failed; falling back to the neutral placeholder tiles",
      error,
    );
    return [];
  }
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
   * `resolveSessionOrAnonymous()` (src/lib/session-or-anonymous.ts,
   * ugcportal-8df3) is the one shared fail-safe: it awaits the raw
   * `getSession()` and degrades a rejection to `null` (the real anonymous
   * shape) rather than letting it crash this render — so `sessionPromise`
   * here is a `Promise<Session | null>` that never rejects, and both
   * branches below just `await` it, cheaply, as many times as they need to,
   * then ask `hasSignedInUser` the same question every other caller asks.
   *
   * Kicked off here and awaited only once the listing below has settled —
   * NOT serialised in between the two, so the session round trip overlaps
   * the listing one, the same "independent reads should not block on each
   * other" reasoning src/components/upload-nav-link.tsx and
   * src/components/auth-status.tsx apply for THEIR OWN, independent calls
   * to the SAME `resolveSessionOrAnonymous()` — all three share one adapter
   * round trip (via `getSession`'s own `cache()`) and, since ugcportal-8df3,
   * one fail-safe and one logged line between them too (see that module's
   * own comment: inside one real render `cache()` runs the fail-safe's own
   * body exactly once, so the other two callers never even reach its
   * `catch` — they receive that one call's already-settled result).
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
  const sessionPromise = resolveSessionOrAnonymous();
  /*
   * Kicked off here too, alongside `sessionPromise`, rather than awaited
   * immediately — the same "independent reads should not block on each
   * other" reasoning as that promise's own comment, now for a THIRD,
   * independent read (the session, the listing, and this) instead of two.
   */
  const portfolioPiecesPromise = resolveHeroPortfolioPieces();

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
    return unavailable(hasSignedInUser(await sessionPromise), await portfolioPiecesPromise);
  }

  const signedIn = hasSignedInUser(await sessionPromise);

  if (!result.ok) {
    return unavailable(signedIn, await portfolioPiecesPromise);
  }

  /*
   * The front page's own "living empty state" (ugcportal-6dvg K1/K2),
   * src/components/home/empty-state.tsx, rendered INSTEAD of `<Gallery>`
   * under the SAME EXPRESSION `<Gallery>`'s own internal `GalleryEmpty`
   * (src/components/gallery/gallery.tsx) uses — both calls now go through
   * the shared `isGenuinelyEmptyPage` (src/lib/gallery-items.ts;
   * ugcportal-3wcd consolidated gallery.tsx's own inline copy onto it too)
   * rather than either site hand-copying the boolean expression.
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
   * where they would not.
   */
  const isGenuinelyEmpty = isGenuinelyEmptyPage(
    result.page.items,
    result.page.hasMore,
  );

  /*
   * ONE read, shared by the hero (ugcportal-qqnt.4 K1) and the living empty
   * state's own portfolio sample (ugcportal-qqnt.5) — not two. `<Hero>`
   * needs `listPortfolioPieces()` on EVERY render regardless of gallery
   * state (`portfolioPiecesPromise` above, kicked off unconditionally,
   * already the single fetch this page makes), so `<EmptyState>` reuses
   * that SAME already-resolved array rather than issuing a second,
   * redundant Prisma query for the identical rows — the one thing the
   * ORIGINAL version of this line (before the hero also needed this data)
   * optimised for ("read only on the branch that can use it") no longer
   * applies now that the hero's own read already pays that cost on every
   * branch; sharing the one result is strictly cheaper than reintroducing
   * a second query just to preserve that no-longer-relevant optimisation.
   * `EmptyState` stays a plain, synchronous component (see its own comment
   * for why) and still only ever SEES this array on the genuinely-empty
   * branch (the ternary below, unchanged) — an on-screen gallery never
   * reads it either way.
   */
  const portfolioPieces = await portfolioPiecesPromise;

  return (
    <>
      <Hero signedIn={signedIn} portfolioPieces={portfolioPieces} />
      {isGenuinelyEmpty ? (
        <EmptyState pieces={portfolioPieces} />
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
