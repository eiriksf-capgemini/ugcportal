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
 */
vi.mock("@/lib/public-media", () => ({
  listPublicMedia: vi.fn(async () => ({
    ok: false as const,
    status: 400 as const,
    error: "Invalid cursor",
  })),
  publicMediaListingUrl: () => "http://listing.internal/api/public/media",
}));

async function renderHome(): Promise<string> {
  const { default: Home } = await import("@/app/page");
  return renderToStaticMarkup(await Home());
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
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

describe("K3 — a genuinely empty gallery still gets the reassuring copy", () => {
  it("renders GalleryEmpty's reassurance when the listing succeeds with nothing", async () => {
    vi.resetModules();
    vi.doMock("@/lib/public-media", () => ({
      listPublicMedia: vi.fn(async () => ({
        ok: true as const,
        page: { items: [], hasMore: false, nextCursor: null },
      })),
      publicMediaListingUrl: () => "http://listing.internal/api/public/media",
    }));

    const markup = await renderHome();

    expect(markup).toContain("Nothing is published yet.");
    expect(markup).toContain(
      "Nothing is hidden from you — the gallery is genuinely empty.",
    );
    expect(markup).toContain('data-gallery-state="empty"');
    expect(markup).not.toContain('data-gallery-state="error"');
  });
});
