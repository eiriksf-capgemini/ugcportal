import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * listPortfolioPieces's defense-in-depth preview re-check (ugcportal-qnq9.16,
 * item 1 of the lows deferred from PR #93's round-6 review).
 *
 * src/lib/portfolio.test.ts deliberately mocks nothing below Prisma, because
 * its own claim is about which rows the real where-clause selects. That is
 * the wrong tool here: `PUBLIC_MEDIA_SCOPE` already filters both preview
 * columns at the query, so no real migration lets a row with a null preview
 * column reach `listPortfolioPieces` today — the round-6 finding's own words
 * were "if a FUTURE schema or query change ever lets [one] slip past the
 * where-clause". Proving the guard exists means simulating exactly that
 * future drift: `prisma.media.findMany` answering with a row the where-
 * clause should have excluded. src/app/api/public/media/route.test.ts's own
 * "steps past an entirely withheld page" tests mock the identical call for
 * the identical reason.
 *
 * `previewKey` specifically (not `previewId`) is what this file's rows carry
 * null, and that is deliberate, not interchangeable with portfolio.test.ts's
 * "no preview" case. `MEDIA_ANONYMOUS_SELECT` never selects `previewKey`, so
 * `toGalleryItem` (src/lib/gallery-items.ts) — which runs on every row
 * regardless of this guard — only ever inspects `previewId`, and already
 * drops a row whose `previewId` is null on its own. A `previewId`-missing
 * row therefore cannot tell this guard apart from no guard at all: both
 * exclude it, for different reasons, and a test built on it would pass
 * whether or not `hasCompletePreview` was ever wired in. `previewKey` is the
 * column only `hasCompletePreview` reads here, so it is the one column that
 * actually distinguishes "the guard ran" from "the guard did not".
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("listPortfolioPieces must not consult the session");
  },
}));

const mediaFindManyMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { media: { findMany: mediaFindManyMock } },
}));

const { listPortfolioPieces } = await import("@/lib/portfolio");

/**
 * Everything `MEDIA_ANONYMOUS_SELECT` projects for one row, shaped the way
 * the real query returns it — `previewKey` included, even though the real
 * select never asks for it, which is exactly the hypothetical this guard
 * exists for: a future select that does.
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "piece-guard",
    kind: "IMAGE",
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    publishedAt: new Date("2026-05-01T00:00:00.000Z"),
    altText: "Alt text",
    caption: "Caption",
    tags: [],
    advertisingDisclosure: null,
    previewId: "pv-piece-guard",
    ...overrides,
  };
}

describe("listPortfolioPieces re-checks the preview columns after the query (K1)", () => {
  beforeEach(() => {
    mediaFindManyMock.mockReset();
  });

  it("excludes a row the where-clause let through with a null previewKey", async () => {
    mediaFindManyMock.mockResolvedValueOnce([row({ previewKey: null })]);

    const pieces = await listPortfolioPieces();

    expect(pieces.map((p) => p.id)).not.toContain("piece-guard");
  });

  it("K5: includes the identical row once previewKey is restored, proving the exclusion above is not the query returning nothing", async () => {
    mediaFindManyMock.mockResolvedValueOnce([
      row({ previewKey: "previews/uploader/piece-guard.webp" }),
    ]);

    const pieces = await listPortfolioPieces();

    expect(pieces.map((p) => p.id)).toContain("piece-guard");
  });
});
