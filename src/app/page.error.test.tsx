import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The home page's OTHER branch (ugcportal-0dh): `listPublicMedia` answering
 * `ok: false`.
 *
 * Every other test of this page (page.test.tsx, page.tags.test.tsx) runs the
 * real `listMedia` against a real database, because K1-K4 there are claims
 * about which rows reach the DOM. This file is not that — `listMedia` only
 * ever answers `ok: false` for a malformed `?cursor=`, and the URL
 * `publicMediaListingUrl()` builds for the server-rendered first page never
 * carries one, so there is no fixture that reaches this branch honestly. It
 * is forced here by mocking `@/lib/public-media` directly, which is the
 * branch this file exists to pin rather than a weaker substitute for it.
 *
 * K2 (the failure is logged server-side) is NOT covered here, on purpose.
 * The logging lives inside the real `listPublicMedia` (src/lib/public-media.ts),
 * and this file mocks that whole module away — a test here asserting
 * `console.error` was called would only be proving the MOCK calls it, which
 * is circular. `src/lib/public-media.logging.test.ts` exercises the real
 * function directly, including its throttle.
 *
 * `mockListing.current` is read by the mock's implementation on every call,
 * not just once at module load, so a test can swap what `listPublicMedia`
 * answers next without `vi.resetModules()`/`vi.doMock()` — `Home()` reads it
 * at RENDER time, not at import time, so re-rendering after mutating
 * `current` is enough. An earlier version of this file used `vi.doMock()` for
 * the one test that needed a different answer, with no matching
 * `vi.doUnmock()` afterwards — harmless only because that was the last test
 * in the file; a test appended after it would have silently inherited the
 * override instead of this file's own top-level mock.
 */

/**
 * `@/lib/auth`, mocked where previously nothing here was (ugcportal-6dvg):
 * `Home()` now also reads `getSession()` for the front page's hero, on every
 * branch including this file's failed-listing one — a visitor is still owed
 * an answer to "what is this site" when the gallery fails to load. Left
 * unmocked, that would pull next-auth's real module graph, including
 * `next/server`, into this node test run. `null`, the true anonymous case
 * every test below already simulates by never seeding a session.
 *
 * `mockSession.rejects` (round-1 review, CONFIRMED medium): a SEPARATE
 * controllable flag, parallel to `mockListing` below, so the "a failed
 * session read never crashes the page" describe block can make `getSession`
 * reject without a second mock module — `Home()` reads this at render time,
 * same as `mockListing.current`.
 */
const mockSession = vi.hoisted(() => ({ rejects: false }));
vi.mock("@/lib/auth", () => ({
  getSession: () =>
    mockSession.rejects
      ? Promise.reject(new Error("getSession() failed (simulated)"))
      : Promise.resolve(null),
}));

// The one spelling of "a malformed cursor" this file needs, shared by the
// mock's default answer and the reset in `afterEach` below. A second literal
// of the same shape (an earlier version of this file had one) is a fixture
// that can drift from the mock it is meant to restore.
const FAILED_LISTING = vi.hoisted(() => ({
  ok: false as const,
  status: 400 as const,
  error: "Invalid cursor",
}));

const mockListing = vi.hoisted(() => ({
  current: FAILED_LISTING as
    | { ok: false; status: 400; error: string }
    | {
        ok: true;
        page: {
          items: unknown[];
          hasMore: boolean;
          nextCursor: string | null;
        };
      },
  // A SEPARATE flag rather than folding "throws" into `current`'s union:
  // throwing is not a value `listPublicMedia` can return, so it has no
  // business being a case of the type that describes what it DOES return.
  throws: false,
}));

vi.mock("@/lib/public-media", () => ({
  listPublicMedia: vi.fn(async () => {
    if (mockListing.throws) {
      throw new Error("listPublicMedia threw (simulated)");
    }
    return mockListing.current;
  }),
  publicMediaListingUrl: () => "http://listing.internal/api/public/media",
}));

const { default: Home } = await import("@/app/page");
// Only for the `it.fails` shell-session-gap marker further down this file —
// both independently call the same mocked `@/lib/auth` module above.
const { AuthStatus } = await import("@/components/auth-status");
const { UploadNavLink } = await import("@/components/upload-nav-link");

async function renderHome(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

afterEach(() => {
  vi.restoreAllMocks();
  // So a test that swaps `current` (K3 below) or sets `throws` (the thrown-
  // failure test below) cannot leak into whichever test runs after it —
  // every test starts from the same default answer.
  mockListing.current = FAILED_LISTING;
  mockListing.throws = false;
  mockSession.rejects = false;
});

describe("K1/K4 — a failed listing never renders as an empty gallery", () => {
  it("does not render the empty-gallery reassurance", async () => {
    const markup = await renderHome();

    // The exact claim this bead exists to stop: a failed fetch must never be
    // told to the visitor as "the gallery is genuinely empty".
    expect(markup).not.toContain("the gallery is genuinely empty");
    expect(markup).not.toContain("Nothing is published yet.");
  });

  it("renders a state that is distinguishable, in the markup, from the empty state", async () => {
    const markup = await renderHome();

    expect(markup).toContain('data-gallery-state="error"');
    expect(markup).not.toContain('data-gallery-state="empty"');
  });
});

describe("K1/K4 — a THROWN failure is treated the same as ok: false", () => {
  /**
   * `listPublicMedia` can fail by throwing outright (a dropped database
   * connection, say) rather than ever returning an `ok: false` result — see
   * that function's own comment in src/lib/public-media.ts. From this page's
   * point of view that must be the SAME failure as `ok: false`: still no
   * "genuinely empty" claim, still the distinguishable error state, still no
   * uncaught rejection reaching Next's generic error boundary.
   */
  it("renders GalleryUnavailable rather than crashing or claiming emptiness", async () => {
    mockListing.throws = true;

    const markup = await renderHome();

    expect(markup).toContain('data-gallery-state="error"');
    expect(markup).not.toContain('data-gallery-state="empty"');
    expect(markup).not.toContain("the gallery is genuinely empty");
    expect(markup).not.toContain("Nothing is published yet.");
  });
});

describe("K3 — this harness can also produce the genuinely-empty branch", () => {
  /**
   * The copy and the `data-gallery-state="empty"` attribute are pinned
   * against the REAL database in page.test.tsx's own K1 ("shows an empty
   * state, not a broken grid, when nothing is published") — repeating that
   * here, against a mock, would be the same claim proven twice by two
   * different means rather than two different claims. What this test proves
   * instead, and what nothing else does, is that THIS file's mock can answer
   * `ok: true` at all: every test above it only ever renders the `ok: false`
   * branch, so none of them is evidence that `data-gallery-state="error"`
   * and the absence of `"empty"` is actually conditional on the mocked
   * result, rather than a hardcoded shape this harness could only ever
   * produce one way.
   */
  it("renders the empty, not the error, state when the mock answers ok: true", async () => {
    mockListing.current = {
      ok: true,
      page: { items: [], hasMore: false, nextCursor: null },
    };

    const markup = await renderHome();

    expect(markup).toContain('data-gallery-state="empty"');
    expect(markup).not.toContain('data-gallery-state="error"');
  });
});

/**
 * ugcportal-6dvg, round-1 review, CONFIRMED medium: a `getSession()`
 * rejection must degrade to the anonymous case (the hero's "Sign in to
 * upload"), never crash `Home()`'s OWN render — on BOTH of this file's
 * branches, since `resolveSignedIn` (src/app/page.tsx) is called from
 * inside the `catch` that exists for a failed LISTING too, not only from
 * the success path.
 *
 * "Home() in isolation" (round-2 review, low finding — an earlier version
 * of this describe block's own title claimed "the page", which overclaims
 * what is actually exercised here): `renderHome()` below calls `Home()`
 * directly, never the assembled app (`AppShell` plus `AuthStatus` plus
 * `UploadNavLink`, every real page's actual tree). See the separate
 * `it.fails` marker further down this file for the part of this claim that
 * does NOT yet hold once those three are assembled together.
 */
describe("Home() in isolation: a failed session read never crashes its render", () => {
  it("Home() in isolation: falls back to the anonymous hero when getSession() rejects and the listing itself also failed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSession.rejects = true;
    // The default `mockListing.current` (reset in `afterEach` above) is
    // already the failed-listing case — explicit here for the reader.
    mockListing.current = FAILED_LISTING;

    const markup = await renderHome();

    expect(markup).toContain("Sign in to upload");
    expect(markup).toContain('data-gallery-state="error"');
    // Round-2 review, low finding: the logged line was created but never
    // actually asserted before this — a silent failure mode (the fallback
    // working, but with nothing for an operator to find) could have shipped
    // unnoticed.
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][0]).toContain("the home page's getSession()");
  });

  it("Home() in isolation: falls back to the anonymous hero when getSession() rejects but the listing succeeds, and the gallery branch renders normally", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSession.rejects = true;
    mockListing.current = {
      ok: true,
      page: { items: [], hasMore: false, nextCursor: null },
    };

    const markup = await renderHome();

    expect(markup).toContain("Sign in to upload");
    expect(markup).toContain('data-gallery-state="empty"');
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][0]).toContain("the home page's getSession()");
  });
});

/**
 * ugcportal-6dvg round-2 review, CONFIRMED medium, deliberately NOT fixed
 * in this PR (that work is bead ugcportal-8df3 — see src/app/page.tsx's own
 * `resolveSignedIn` comment for the full scope note).
 *
 * `getSession()` is `cache()`-memoized per request (src/lib/auth.ts), and
 * AppShell renders `Home()` alongside TWO other independent readers of that
 * SAME memoized promise — `AuthStatus` (src/components/auth-status.tsx) and
 * `UploadNavLink` (src/components/upload-nav-link.tsx) — each still calling
 * `await getSession()` completely unguarded. A rejection crashes them even
 * on a request where `Home()` itself, fixed above, recovers cleanly —
 * confirmed on a real dev server: `/` answers HTTP 500.
 *
 * NOT exercised through `renderToStaticMarkup(AppShell({children: ...}))`,
 * deliberately: `AppShell` renders real, unresolved `<UploadNavLink />` and
 * `<AuthStatus />` elements internally (it does not accept them as props),
 * and this renderer cannot resolve a nested async Server Component reached
 * while walking an already-rendering tree AT ALL — confirmed empirically,
 * it throws "A component suspended while responding to synchronous input"
 * the moment it meets one, regardless of whether `getSession()` ever
 * rejects (see src/components/app-shell.nav.test.tsx's own comment, which
 * is why that file stubs both components out rather than executing them).
 * A render-shaped test here would therefore fail for the WRONG reason even
 * once ugcportal-8df3 ships its fix, which is worse than no test at all —
 * it would look like continuing proof of this exact gap while actually
 * being evidence of an unrelated, pre-existing harness limitation. Calling
 * the three async functions directly — the same way React actually invokes
 * them, as `AppShell`'s independent sibling children, none of them awaiting
 * another's result first — isolates the real claim instead.
 *
 * `it.fails`, not `test.todo`: this runs today and genuinely fails (the
 * assertions below are false right now), proving the gap is real rather
 * than aspirational. The day ugcportal-8df3 gives `AuthStatus`/
 * `UploadNavLink` the same fail-safe `Home()` already has, all three
 * promises start resolving, the assertions below all pass, the test body
 * stops throwing, and `it.fails` itself then reports "expected the test to
 * fail, but it passed" — forcing this marker to be revisited and converted
 * to a real, non-inverted test rather than silently going stale.
 *
 * TWO LIMITS ON WHAT "flips" MEANS HERE (round-3 review, low finding —
 * stated plainly rather than left implicit):
 *
 * 1. This file's own top-level `vi.mock("@/lib/auth", ...)` replaces the
 *    WHOLE module, `getSession` included. If ugcportal-8df3 is fixed inside
 *    the REAL `getSession()`/`auth()` (src/lib/auth.ts) rather than inside
 *    `AuthStatus`/`UploadNavLink` themselves, this test's mock would still
 *    export the same rejecting stub it always has, and this tripwire would
 *    NOT flip — it would keep failing (correctly, by `it.fails`'s own
 *    accounting) for a fix this file cannot see at all. It only self-flips
 *    if ugcportal-8df3 follows the same shape `resolveSignedIn` already
 *    does for `Home()`: each CALLER wrapping its own `await getSession()`.
 * 2. This mock's `getSession` is a plain arrow function, not wrapped in
 *    `cache()` the way the real one is — so `Home()`, `AuthStatus()` and
 *    `UploadNavLink()` below each get their OWN independently-rejecting
 *    promise, not the one SHARED memoized promise production code actually
 *    has them all await. That still proves the claim this test exists to
 *    make ("an unguarded `await getSession()` crashes its caller"), since
 *    the failure mode is the missing guard, not the sharing — but it is
 *    not a literal reproduction of the cache()-memoization mechanism the
 *    bug report (and src/app/page.tsx's own `resolveSignedIn` comment)
 *    describes, and a reader should not assume this test exercises that
 *    specific part.
 */
it.fails(
  "ugcportal-8df3 (not fixed here): AuthStatus and UploadNavLink do not yet survive a rejected getSession() the way Home() does",
  async () => {
    // Spied and silenced, same as the two sibling tests above — `Home()`
    // logs on its own guarded path; `AuthStatus()`/`UploadNavLink()` do not
    // log at all today (they have no catch to log from), so this is here
    // for output cleanliness and consistency, not an assertion on a call
    // count that would itself change shape once ugcportal-8df3 lands.
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSession.rejects = true;

    const [homeResult, authResult, navResult] = await Promise.allSettled([
      Home(),
      AuthStatus(),
      UploadNavLink(),
    ]);

    expect(homeResult.status, "Home() is fixed and must resolve").toBe(
      "fulfilled",
    );
    expect(authResult.status).toBe("fulfilled");
    expect(navResult.status).toBe("fulfilled");
  },
);
