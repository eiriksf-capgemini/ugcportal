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
 * `Home()` now also reads `getSession()` (via the shared fail-safe,
 * src/lib/session-or-anonymous.ts, ugcportal-8df3) for the front page's
 * hero, on every branch including this file's failed-listing one — a
 * visitor is still owed an answer to "what is this site" when the gallery
 * fails to load. Left unmocked, that would pull next-auth's real module
 * graph, including `next/server`, into this node test run. `null`, the true
 * anonymous case every test below already simulates by never seeding a
 * session. `@/lib/session-or-anonymous` itself is NOT mocked — its real
 * implementation runs against this mocked `getSession`, which is what lets
 * this file assert on the fail-safe's own behaviour (the single log line)
 * rather than assuming it.
 *
 * `mockSession.rejects` (round-1 review, CONFIRMED medium): a SEPARATE
 * controllable flag, parallel to `mockListing` below, so the "a failed
 * session read never crashes the page" describe block can make `getSession`
 * reject without a second mock module — `Home()` reads this at render time,
 * same as `mockListing.current`.
 *
 * `mockSession.rejectionPromise` (ugcportal-8df3): when `rejects` is true,
 * every call returns the SAME rejected promise instance rather than a fresh
 * one each time. This mirrors what the real `getSession()` actually
 * guarantees in production — it is `cache()`-memoized per request
 * (src/lib/auth.ts), so `Home()`, `AuthStatus()` and `UploadNavLink()` all
 * await the identical promise for one request. That sharing is one of TWO
 * mechanisms that independently make the shared fail-safe log once per
 * request inside a real render (round-2 review of this PR, finding 2 — an
 * earlier version of this comment called it "the premise the dedupe
 * depends on", as if it were the only route; see src/lib/session-or-
 * anonymous.ts's own comment for the other one, `cache()` wrapping the
 * fail-safe itself, and for why only the sharing this mock reproduces is
 * exercisable outside a render at all). Without this, three
 * independently-rejecting promises below would also be a legitimate test of
 * "each caller survives a rejection", but could never prove "exactly once
 * per request" the way THIS mock can, since nothing would be shared for
 * the `WeakSet` dedupe to key on.
 * Created lazily, not eagerly at module scope, and reset to `null` in
 * `afterEach`, so a test that leaves `rejects` false never allocates an
 * unused rejected promise (which Node would otherwise warn about as
 * unhandled the moment a test run ends without ever awaiting it).
 */
const mockSession = vi.hoisted(
  () =>
    ({ rejects: false, rejectionPromise: null }) as {
      rejects: boolean;
      rejectionPromise: Promise<never> | null;
    },
);
vi.mock("@/lib/auth", () => ({
  getSession: () => {
    if (!mockSession.rejects) return Promise.resolve(null);
    mockSession.rejectionPromise ??= Promise.reject(
      new Error("getSession() failed (simulated)"),
    );
    return mockSession.rejectionPromise;
  },
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
// Only for the "assembled shell" describe block further down this file —
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
  mockSession.rejectionPromise = null;
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
 * branches, since `resolveSessionOrAnonymous()` (src/lib/session-or-
 * anonymous.ts) is called from inside the `catch` that exists for a failed
 * LISTING too, not only from the success path.
 *
 * "Home() in isolation" (round-2 review, low finding — an earlier version
 * of this describe block's own title claimed "the page", which overclaims
 * what is actually exercised here): `renderHome()` below calls `Home()`
 * directly, never the assembled app (`AppShell` plus `AuthStatus` plus
 * `UploadNavLink`, every real page's actual tree). See the "assembled shell"
 * describe block further down this file for that part of the claim.
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
    expect(consoleError.mock.calls[0][0]).toContain(
      "the shared session read",
    );
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
    expect(consoleError.mock.calls[0][0]).toContain(
      "the shared session read",
    );
  });
});

/**
 * ugcportal-6dvg round-2 review, CONFIRMED medium; fixed by ugcportal-8df3.
 *
 * `getSession()` is `cache()`-memoized per request (src/lib/auth.ts), and
 * AppShell renders `Home()` alongside TWO other independent readers of that
 * SAME memoized promise — `AuthStatus` (src/components/auth-status.tsx) and
 * `UploadNavLink` (src/components/upload-nav-link.tsx). Before ugcportal-8df3
 * all three called `getSession()` directly and unguarded, so a rejection
 * crashed them even on a request where `Home()` itself recovered cleanly —
 * confirmed on a real dev server: `/` answered HTTP 500. All three now go
 * through `resolveSessionOrAnonymous()` (src/lib/session-or-anonymous.ts),
 * the one shared fail-safe.
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
 * A render-shaped test here would therefore fail for the WRONG reason —
 * evidence of an unrelated, pre-existing harness limitation, not of this
 * claim. Calling the three async functions directly — the same way React
 * actually invokes them, as `AppShell`'s independent sibling children, none
 * of them awaiting another's result first — isolates the real claim
 * instead.
 *
 * This describe block is the tripwire this file used to carry as
 * `it.fails("ugcportal-8df3 (not fixed here): ...")` (see git history for
 * its original form): that marker ran today and genuinely failed, proving
 * the gap was real rather than aspirational, and was ALWAYS meant to be
 * converted to an ordinary, non-inverted test the day the fix landed rather
 * than left as a permanently-inverted assertion — see its own comment,
 * preserved below, for why `it.fails` rather than `test.todo` in the first
 * place.
 *
 * TWO LIMITS ON WHAT "fixed" MEANS HERE, carried over from that marker's own
 * comment (round-3 review, low finding — stated plainly rather than left
 * implicit):
 *
 * 1. This file's own top-level `vi.mock("@/lib/auth", ...)` replaces the
 *    WHOLE module, `getSession` included — so this test is evidence that
 *    ugcportal-8df3 was fixed the way `resolveSessionOrAnonymous` actually
 *    does it: each CALLER (`Home`, `AuthStatus`, `UploadNavLink`) wrapping
 *    its own call through the shared fail-safe, not a change inside the
 *    real `getSession()`/`auth()` (src/lib/auth.ts) that this mock would
 *    hide from the test.
 * 2. `mockSession.rejectionPromise` (see that mock's own comment above)
 *    makes all three calls below share the identical rejected promise,
 *    MIRRORING what a real request's `cache()`-memoized `getSession()`
 *    hands its callers. src/lib/session-or-anonymous.ts's own comment
 *    states the measured facts this test's claim rests on in full (round-1/
 *    round-2/round-3/round-4 review of this PR — each round corrected the
 *    previous one's overclaim, so deferred to rather than re-approximated
 *    here, which is exactly where the drift kept creeping back in): inside
 *    a real render the two dedupe layers there (the `WeakSet`, and
 *    `cache()` wrapping `resolveSessionOrAnonymous` itself) are REDUNDANT
 *    with each other — either alone is already sufficient, for the two
 *    separate reasons that module's comment gives for each layer. Outside
 *    a render — which is what calling `Home`, `AuthStatus` and
 *    `UploadNavLink` directly, below, actually is, since this harness has
 *    no way to put them behind one real render (see the unnumbered
 *    paragraph above this list, "NOT exercised through
 *    `renderToStaticMarkup(...)`") — NEITHER layer dedupes anything for the
 *    real implementation: `cache()` falls through uncached, and the real
 *    `getSession()` falls through too and hands back an unshared promise
 *    per call. This test exercises the `WeakSet` specifically, by giving it
 *    outside a render the one thing it needs (a shared promise) via the
 *    mock above standing in for what `cache()` gives for free inside one.
 *    The `cache()` path itself — the mechanism production actually
 *    runs on inside a real render — was verified separately, live, on a
 *    dev server (round-1 review of this PR: one line for `/`, one for
 *    `/about`); this test is evidence the `WeakSet` dedupe mechanism works,
 *    not evidence of which layer production relies on.
 */
describe("the assembled shell: AuthStatus and UploadNavLink survive a rejected getSession() the same way Home() does", () => {
  it("all three resolve to signed-out markup, the hero's CTA points at sign-in, and the request logs exactly once", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSession.rejects = true;

    const [homeResult, authResult, navResult] = await Promise.allSettled([
      Home(),
      AuthStatus(),
      UploadNavLink(),
    ]);

    expect(homeResult.status, "Home() must resolve, not reject").toBe(
      "fulfilled",
    );
    expect(authResult.status, "AuthStatus() must resolve, not reject").toBe(
      "fulfilled",
    );
    expect(
      navResult.status,
      "UploadNavLink() must resolve, not reject",
    ).toBe("fulfilled");

    // `homeResult`/`authResult` are known-fulfilled by the assertions above,
    // but TypeScript's `PromiseSettledResult` union does not narrow on a
    // separate `expect(...).toBe("fulfilled")` call — hence the explicit
    // guards below, which also fail with a clearer message than a bare
    // `.value` access on a rejected result would.
    if (homeResult.status !== "fulfilled") throw homeResult.reason;
    if (authResult.status !== "fulfilled") throw authResult.reason;
    if (navResult.status !== "fulfilled") throw navResult.reason;

    const homeMarkup = renderToStaticMarkup(homeResult.value);
    expect(homeMarkup).toContain("Sign in to upload");

    const authMarkup = renderToStaticMarkup(authResult.value);
    expect(authMarkup).toContain("Google");
    expect(authMarkup).toContain("Facebook");
    expect(authMarkup).not.toContain("Sign out");

    // UploadNavLink() renders `null` (no `<nav>` at all) for a signed-out
    // visitor — see that component's own "all-or-nothing" comment — so
    // resolving to `null` IS the signed-out markup here, not a crash.
    expect(navResult.value).toBeNull();

    // Exactly one log for the whole request, not three. This proves the
    // `WeakSet` dedupe in src/lib/session-or-anonymous.ts fires correctly
    // against a shared rejected promise (`mockSession.rejectionPromise`'s
    // comment above explains why this mock, not a render, is what gives it
    // one to key on) — it is NOT proof of the `cache()` path that real
    // production actually relies on inside a render, which that module's
    // own comment is explicit is verified live, on a dev server, instead.
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][0]).toContain(
      "the shared session read",
    );
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): proves the shared
   * log line's content really does distinguish "not yet signed in" from a
   * failed read, rather than merely asserting on something both messages
   * would satisfy. If this test's assertion were weakened to anything both
   * a successful anonymous render AND a failed read would log, this would
   * never fail — so a successful anonymous render (`mockSession.rejects =
   * false`) must not log at all.
   */
  it("logs nothing when getSession() answers null outright (the real anonymous case, not a failure)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSession.rejects = false;

    await Promise.all([Home(), AuthStatus(), UploadNavLink()]);

    expect(consoleError).not.toHaveBeenCalled();
  });
});
