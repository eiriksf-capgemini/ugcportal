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
const mockListing = vi.hoisted(() => ({
  current: {
    ok: false as const,
    status: 400 as const,
    error: "Invalid cursor",
  } as
    | { ok: false; status: 400; error: string }
    | {
        ok: true;
        page: {
          items: unknown[];
          hasMore: boolean;
          nextCursor: string | null;
        };
      },
}));

vi.mock("@/lib/public-media", () => ({
  listPublicMedia: vi.fn(async () => mockListing.current),
  publicMediaListingUrl: () => "http://listing.internal/api/public/media",
}));

const { default: Home } = await import("@/app/page");

const FAILED_LISTING = {
  ok: false as const,
  status: 400 as const,
  error: "Invalid cursor",
};

async function renderHome(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

afterEach(() => {
  vi.restoreAllMocks();
  // So a test that swaps `current` (K3 below) cannot leak into whichever
  // test runs after it — every test starts from the same default answer.
  mockListing.current = FAILED_LISTING;
});

describe("K1/K4 — a failed listing never renders as an empty gallery", () => {
  it("does not render the empty-gallery reassurance", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const markup = await renderHome();

    // The exact claim this bead exists to stop: a failed fetch must never be
    // told to the visitor as "the gallery is genuinely empty".
    expect(markup).not.toContain("the gallery is genuinely empty");
    expect(markup).not.toContain("Nothing is published yet.");
  });

  it("renders a state that is distinguishable, in the markup, from the empty state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const markup = await renderHome();

    expect(markup).toContain('data-gallery-state="error"');
    expect(markup).not.toContain('data-gallery-state="empty"');
  });
});

describe("K2 — the failure is logged server-side", () => {
  it("logs the status and error listMedia reported", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderHome();

    expect(errorSpy).toHaveBeenCalledWith(
      "[gallery] public media listing failed",
      expect.objectContaining({ status: 400, error: "Invalid cursor" }),
    );
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
